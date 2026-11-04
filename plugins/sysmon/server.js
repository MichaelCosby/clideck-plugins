'use strict';
const { execFile } = require('child_process');
const { readFileSync } = require('fs');
const os = require('os');

const HISTORY_SECONDS = 15 * 60;

function parseMeminfo(text) {
  const kb = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) * 1024 : null;
  };
  return { memTotal: kb('MemTotal'), memAvailable: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
}

// `vm_stat`: page counts, and the page size in its header line.
function parseVmStat(text) {
  const size = text.match(/page size of (\d+) bytes/);
  const pages = (label) => {
    const match = text.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return {
    pageSize: size ? Number(size[1]) : null,
    anonymous: pages('Anonymous pages'),
    purgeable: pages('Pages purgeable'),
    wired: pages('Pages wired down'),
    compressor: pages('Pages occupied by compressor'),
  };
}

// `sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level`: one value per line.
// "total = 2048.00M  used = 1060.25M  free = 987.75M  (encrypted)", then 1 (normal), 2 (warning) or 4 (critical).
function parseSysctl(text) {
  const bytes = (key) => {
    const match = text.match(new RegExp(`${key} = ([\\d.]+)([KMGT])`));
    return match ? Number(match[1]) * 1024 ** ' KMGT'.indexOf(match[2]) : null;
  };
  const level = Number(String(text).trim().split('\n').pop());
  return {
    swapTotal: bytes('total'),
    swapUsed: bytes('used'),
    pressure: { 1: 'normal', 2: 'warning', 4: 'critical' }[level] || null,
  };
}

// macOS keeps RAM full of cache it can drop at once, so os.freemem() reads near 100% on a healthy Mac. Used is
// what Activity Monitor calls Memory Used: app memory (anonymous less purgeable), wired, and the compressor.
// Swap files are added as needed, so swap's "total" is only what has been allocated so far and a percentage of
// it says little; swap is shown but does not raise alerts. The kernel's own pressure level does.
function macMemory(vmStat, sysctl, memTotal) {
  const vm = parseVmStat(vmStat);
  if (!vm.pageSize || vm.anonymous == null || vm.wired == null) return null;
  const pages = vm.anonymous - (vm.purgeable || 0) + vm.wired + (vm.compressor || 0);
  const memUsed = Math.min(memTotal, Math.max(0, pages * vm.pageSize));
  const sys = parseSysctl(sysctl);
  return {
    approx: false, memTotal, memUsed, ramPct: (memUsed / memTotal) * 100,
    swapTotal: sys.swapTotal, swapUsed: sys.swapUsed,
    swapPct: sys.swapTotal ? (sys.swapUsed / sys.swapTotal) * 100 : null,
    swapAlerts: false, pressure: sys.pressure,
  };
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000 }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

// Linux reports reclaimable cache as available. Elsewhere, with no better source, os.freemem() over-reports use,
// so it is marked approximate.
async function readMemory() {
  if (process.platform === 'linux') {
    try {
      const m = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
      const memUsed = m.memTotal - m.memAvailable;
      const swapUsed = m.swapTotal ? m.swapTotal - m.swapFree : 0;
      return {
        approx: false, memTotal: m.memTotal, memUsed, ramPct: (memUsed / m.memTotal) * 100,
        swapTotal: m.swapTotal, swapUsed, swapPct: m.swapTotal ? (swapUsed / m.swapTotal) * 100 : null,
      };
    } catch {}
  }
  if (process.platform === 'darwin') {
    const [vmStat, sysctl] = await Promise.all([
      run('vm_stat', []),
      run('sysctl', ['-n', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
    ]);
    const memory = vmStat && sysctl ? macMemory(vmStat, sysctl, os.totalmem()) : null;
    if (memory) return memory;
  }
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();
  return { approx: true, memTotal, memUsed, ramPct: (memUsed / memTotal) * 100, swapTotal: null, swapUsed: null, swapPct: null };
}

function listProcesses() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const processes = [];
      for (const line of String(stdout).split('\n')) {
        const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
        if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rss)) processes.push({ pid, ppid, rssKb: rss });
      }
      resolve(processes);
    });
  });
}

// Memory of each live session's whole process tree: the agent plus every tool, shell and server it started.
function sessionUsage(sessions, processes) {
  if (!processes) return [];
  const children = new Map();
  const byPid = new Map();
  for (const p of processes) {
    byPid.set(p.pid, p);
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const rows = [];
  for (const s of sessions) {
    const root = Number(s.pid);
    if (!s.live || !byPid.has(root)) continue;
    let bytes = 0;
    let count = 0;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = byPid.get(pid);
      if (!p) continue;
      bytes += p.rssKb * 1024;
      count++;
      for (const child of children.get(pid) || []) stack.push(child);
    }
    rows.push({ id: s.sessionId, name: s.name || s.sessionId.slice(0, 8), provider: s.provider, bytes, processes: count });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

const RANK = { ok: 0, warning: 1, critical: 2 };

// Why the system is at a level: the worse of RAM, swap (where it counts) and the kernel's memory pressure.
function reasonsOf(stats, warn, critical) {
  const byPercent = (value) => (value >= critical ? 'critical' : value >= warn ? 'warning' : 'ok');
  const reasons = [{ level: byPercent(stats.ramPct ?? 0), text: `RAM is at ${Math.round(stats.ramPct ?? 0)}%` }];
  if (stats.swapAlerts !== false && stats.swapPct != null) {
    reasons.push({ level: byPercent(stats.swapPct), text: `Swap is at ${Math.round(stats.swapPct)}%` });
  }
  if (stats.pressure === 'warning' || stats.pressure === 'critical') {
    reasons.push({ level: stats.pressure, text: `Memory pressure is ${stats.pressure}` });
  }
  return reasons.sort((a, b) => RANK[b.level] - RANK[a.level]);
}

function levelOf(stats, warn, critical) {
  return reasonsOf(stats, warn, critical)[0].level;
}

function createMonitor(api, deps = {}) {
  const read = deps.readMemory || readMemory;
  const processes = deps.listProcesses || listProcesses;
  const now = deps.now || Date.now;
  const history = [];
  let latest = null;
  let level = 'ok';

  const setting = (key, fallback) => {
    const value = Number(api.getSetting(key));
    return Number.isFinite(value) ? value : fallback;
  };

  async function sample() {
    const memory = await read();
    const load = process.platform === 'win32' ? null : os.loadavg();
    const sessions = sessionUsage(await api.getSessions(), await processes());
    const warn = setting('warn-percent', 80);
    const critical = setting('critical-percent', 93);
    latest = { at: now(), ...memory, load, cpus: os.cpus().length, sessions, warn, critical };
    history.push({ at: latest.at, ramPct: memory.ramPct, swapPct: memory.swapPct, load1: load ? load[0] : null });
    const keep = Math.max(20, Math.ceil(HISTORY_SECONDS / setting('interval-sec', 15)));
    if (history.length > keep) history.splice(0, history.length - keep);

    const [reason] = reasonsOf(latest, warn, critical);
    const next = reason.level;
    if (RANK[next] > RANK[level] && api.getSetting('alerts') !== false) {
      const what = reason.text;
      const top = sessions[0] ? ` Largest session: ${sessions[0].name}.` : '';
      api.sendToClients('alert', { level: next, text: `${what}.${top}` });
    }
    level = next;
    return latest;
  }

  return { sample, snapshot: () => ({ latest, history: history.slice(), level }) };
}

async function activate(api) {
  const monitor = createMonitor(api);
  let timer = null;
  const tick = async () => { try { await monitor.sample(); } catch (error) { api.log('sample failed:', error.message); } };
  const start = () => {
    clearInterval(timer);
    const seconds = Math.min(60, Math.max(3, Number(api.getSetting('interval-sec')) || 15));
    timer = setInterval(tick, seconds * 1000);
    timer.unref?.();
  };
  await tick();
  start();
  api.onSettingsChange((settings, previous) => {
    if (settings['interval-sec'] !== previous['interval-sec']) start();
  });
  api.onClientMessage('stats-request', (data, context) => {
    context.reply('stats', { requestId: data?.requestId, ...monitor.snapshot() });
  });
  api.onShutdown(() => clearInterval(timer));
}

module.exports = { activate, createMonitor, levelOf, macMemory, parseMeminfo, parseSysctl, parseVmStat, sessionUsage };
