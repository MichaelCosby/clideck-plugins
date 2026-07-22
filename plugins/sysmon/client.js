'use strict';

let api = null;
let toolbarBtn = null;

function fmtBytes(n) {
  if (n == null) return '?';
  const gib = n / (1024 ** 3);
  return `${gib.toFixed(1)} GiB`;
}

function fmtPct(pct) {
  return pct == null ? '—' : `${Math.round(pct)}%`;
}

function severity(stats) {
  const warn = Number(stats.warnPercent ?? 80);
  const crit = Number(stats.criticalPercent ?? 93);
  const worst = Math.max(stats.ramPct ?? 0, stats.swapPct ?? 0);
  if (worst >= crit) return 'critical';
  if (worst >= warn) return 'warn';
  return 'ok';
}

function render(stats) {
  if (!toolbarBtn || !stats) return;

  toolbarBtn.classList.remove('sysmon-ok', 'sysmon-warn', 'sysmon-critical');
  toolbarBtn.classList.add(`sysmon-${severity(stats)}`);

  toolbarBtn.textContent = fmtPct(stats.ramPct);

  const lines = [
    `RAM: ${fmtPct(stats.ramPct)} (${fmtBytes(stats.memUsed)} / ${fmtBytes(stats.memTotal)})${stats.approx ? ' (approx)' : ''}`,
    stats.swapPct == null ? 'Swap: none' : `Swap: ${fmtPct(stats.swapPct)} (${fmtBytes(stats.swapUsed)} / ${fmtBytes(stats.swapTotal)})`,
    stats.load ? `Load avg: ${stats.load.map(n => n.toFixed(2)).join(' / ')} (1m / 5m / 15m)` : 'Load avg: unavailable',
  ];
  toolbarBtn.title = lines.join('\n');
}

export function init(pluginApi) {
  api = pluginApi;

  toolbarBtn = api.addToolbarButton({ title: 'System monitor', icon: '', onClick: () => api.send('getStats') });
  toolbarBtn.classList.add('sysmon-btn');
  toolbarBtn.style.width = 'auto';
  toolbarBtn.style.padding = '0 8px';
  toolbarBtn.style.fontVariantNumeric = 'tabular-nums';

  api.onMessage('stats', render);
}

const style = document.createElement('style');
style.textContent = `
  .sysmon-btn { font-size: 11px; font-weight: 600; }
  .sysmon-ok { color: #94a3b8; }
  .sysmon-warn { color: #f59e0b !important; }
  .sysmon-critical { color: #f87171 !important; }
`;
document.head.appendChild(style);
