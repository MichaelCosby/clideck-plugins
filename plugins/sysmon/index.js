'use strict';
const { readFileSync } = require('fs');
const os = require('os');

let api = null;
let timer = null;

function parseMeminfo(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) * 1024 : null; // kB -> bytes
  };
  return {
    memTotal: get('MemTotal'),
    memAvailable: get('MemAvailable'),
    swapTotal: get('SwapTotal'),
    swapFree: get('SwapFree'),
  };
}

function readStats() {
  const load = process.platform === 'win32' ? null : os.loadavg();

  if (process.platform === 'linux') {
    try {
      const { memTotal, memAvailable, swapTotal, swapFree } = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
      const memUsed = memTotal - memAvailable;
      const ramPct = memTotal ? (memUsed / memTotal) * 100 : null;
      // SwapTotal is 0 on systems with no swap configured — treat as "no swap", not 0%.
      const swapUsed = swapTotal ? swapTotal - swapFree : 0;
      const swapPct = swapTotal ? (swapUsed / swapTotal) * 100 : null;
      return { ok: true, approx: false, memTotal, memUsed, ramPct, swapTotal, swapUsed, swapPct, load };
    } catch (e) {
      api.log(`Failed to read /proc/meminfo: ${e.message}`);
    }
  }

  // Non-Linux fallback: os.freemem() excludes reclaimable cache (unlike
  // /proc/meminfo's MemAvailable), so this over-reports usage. Swap isn't
  // exposed cross-platform without shelling out to a per-OS command, which
  // we don't do here without a way to verify it — flagged as approximate.
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();
  const ramPct = memTotal ? (memUsed / memTotal) * 100 : null;
  return { ok: true, approx: true, memTotal, memUsed, ramPct, swapTotal: null, swapUsed: null, swapPct: null, load };
}

function poll() {
  const stats = readStats();
  stats.warnPercent = api.getSetting('warnPercent');
  stats.criticalPercent = api.getSetting('criticalPercent');
  api.sendToFrontend('stats', stats);
}

function startTimer(intervalSec) {
  clearInterval(timer);
  const sec = Math.min(60, Math.max(3, Number(intervalSec) || 15));
  timer = setInterval(poll, sec * 1000);
}

exports.init = function init(pluginApi) {
  api = pluginApi;

  poll();
  startTimer(api.getSetting('intervalSec'));

  api.onSettingsChange((key) => {
    if (key === 'intervalSec') startTimer(api.getSetting('intervalSec'));
    else poll();
  });

  api.onFrontendMessage('getStats', () => poll());
  api.onShutdown(() => clearInterval(timer));
};
