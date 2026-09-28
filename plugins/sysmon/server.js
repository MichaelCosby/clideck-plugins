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

// Linux reports reclaimable cache as available; elsewhere os.freemem() over-reports use, so it is marked approximate.
function readMemory() {
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

function levelOf(stats, warn, critical) {
  const worst = Math.max(stats.ramPct ?? 0, stats.swapPct ?? 0);
  if (worst >= critical) return 'critical';
  if (worst >= warn) return 'warning';
  return 'ok';
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
    const memory = read();
    const load = process.platform === 'win32' ? null : os.loadavg();
    const sessions = sessionUsage(await api.getSessions(), await processes());
    const warn = setting('warn-percent', 80);
    const critical = setting('critical-percent', 93);
    latest = { at: now(), ...memory, load, cpus: os.cpus().length, sessions, warn, critical };
    history.push({ at: latest.at, ramPct: memory.ramPct, swapPct: memory.swapPct, load1: load ? load[0] : null });
    const keep = Math.max(20, Math.ceil(HISTORY_SECONDS / setting('interval-sec', 15)));
    if (history.length > keep) history.splice(0, history.length - keep);

    const next = levelOf(latest, warn, critical);
    const rank = { ok: 0, warning: 1, critical: 2 };
    if (rank[next] > rank[level] && api.getSetting('alerts') !== false) {
      const what = (latest.swapPct ?? 0) > latest.ramPct ? `Swap is at ${Math.round(latest.swapPct)}%` : `RAM is at ${Math.round(latest.ramPct)}%`;
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

module.exports = { activate, createMonitor, levelOf, parseMeminfo, sessionUsage };
