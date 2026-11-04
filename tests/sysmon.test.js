'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMonitor, levelOf, macMemory, parseMeminfo, parseSysctl, parseVmStat, sessionUsage } = require('../plugins/sysmon/server');

test('meminfo parsing reads kB fields as bytes', () => {
  const m = parseMeminfo('MemTotal:       16000 kB\nMemAvailable:    4000 kB\nSwapTotal:          0 kB\nSwapFree:           0 kB\n');
  assert.equal(m.memTotal, 16000 * 1024);
  assert.equal(m.memAvailable, 4000 * 1024);
  assert.equal(m.swapTotal, 0);
});

test('session memory counts the whole process tree of live sessions', () => {
  const processes = [
    { pid: 10, ppid: 1, rssKb: 100 }, { pid: 11, ppid: 10, rssKb: 50 }, { pid: 12, ppid: 11, rssKb: 25 },
    { pid: 20, ppid: 1, rssKb: 400 }, { pid: 30, ppid: 1, rssKb: 999 },
  ];
  const rows = sessionUsage([
    { sessionId: 'a', name: 'Lead', provider: 'claude-code', pid: 10, live: true },
    { sessionId: 'b', name: 'Shell', provider: 'shell', pid: 20, live: true },
    { sessionId: 'c', name: 'Stopped', provider: 'codex', pid: 30, live: false },
  ], processes);
  assert.deepEqual(rows.map((r) => [r.name, r.bytes / 1024, r.processes]), [['Shell', 400, 1], ['Lead', 175, 3]]);
  assert.deepEqual(sessionUsage([{ sessionId: 'a', pid: 10, live: true }], null), [], 'no process list, no rows');
});

test('levels follow the worse of RAM and swap', () => {
  assert.equal(levelOf({ ramPct: 50, swapPct: 85 }, 80, 93), 'warning');
  assert.equal(levelOf({ ramPct: 95, swapPct: null }, 80, 93), 'critical');
  assert.equal(levelOf({ ramPct: 10, swapPct: null }, 80, 93), 'ok');
});

test('alerts fire when usage gets worse, once per step, and respect the setting', async () => {
  const sent = [];
  const settings = { 'warn-percent': 80, 'critical-percent': 93, 'interval-sec': 15, alerts: true };
  const api = { getSetting: (k) => settings[k], getSessions: async () => [], sendToClients: (e, d) => sent.push([e, d]) };
  let ram = 50;
  const monitor = createMonitor(api, {
    readMemory: () => ({ approx: false, memTotal: 100, memUsed: ram, ramPct: ram, swapTotal: 0, swapUsed: 0, swapPct: null }),
    listProcesses: async () => [],
  });
  await monitor.sample();
  ram = 85; await monitor.sample(); await monitor.sample();
  ram = 95; await monitor.sample();
  ram = 50; await monitor.sample();
  settings.alerts = false; ram = 95; await monitor.sample();
  assert.deepEqual(sent.map(([, d]) => d.level), ['warning', 'critical']);
  assert.match(sent[0][1].text, /RAM is at 85%/);
  const snap = monitor.snapshot();
  assert.equal(snap.history.length, 6);
  assert.equal(snap.latest.ramPct, 95);
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            401234.
Pages inactive:                          389012.
Pages speculative:                        10234.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          20000.
"Translation faults":                 123456789.
Pages copy-on-write:                    2345678.
Pages zero filled:                     34567890.
Pages reactivated:                       123456.
Pages purged:                             45678.
File-backed pages:                       300000.
Anonymous pages:                         500000.
Pages stored in compressor:              250000.
Pages occupied by compressor:             80000.
Decompressions:                          123456.
Compressions:                            234567.
Pageins:                                 345678.
Pageouts:                                  4567.
Swapins:                                      0.
Swapouts:                                     0.
`;
const SYSCTL = 'total = 2048.00M  used = 1638.50M  free = 409.50M  (encrypted)\n1\n';
const GIB16 = 16 * 1024 ** 3;

test('vm_stat parsing reads the page size and the counts Memory Used is made of', () => {
  assert.deepEqual(parseVmStat(VM_STAT), { pageSize: 16384, anonymous: 500000, purgeable: 20000, wired: 150000, compressor: 80000 });
});

test('sysctl parsing reads swap in its units and the pressure level', () => {
  const s = parseSysctl(SYSCTL);
  assert.equal(s.swapTotal, 2048 * 1024 ** 2);
  assert.equal(s.swapUsed, 1638.5 * 1024 ** 2);
  assert.equal(s.pressure, 'normal');
  assert.equal(parseSysctl('total = 1.00G  used = 0.00M  free = 1.00G  (encrypted)\n4\n').swapTotal, 1024 ** 3);
  assert.equal(parseSysctl('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n4\n').pressure, 'critical');
  assert.equal(parseSysctl('total = 0.00M  used = 0.00M  free = 0.00M\n2\n').pressure, 'warning');
});

test('macOS RAM is app memory plus wired plus compressed, not everything but free pages', () => {
  const m = macMemory(VM_STAT, SYSCTL, GIB16);
  assert.equal(m.approx, false);
  assert.equal(m.memUsed, (500000 - 20000 + 150000 + 80000) * 16384);
  assert.equal(Math.round(m.ramPct), 68);
  assert.equal(m.swapAlerts, false);
  assert.equal(Math.round(m.swapPct), 80);
  assert.equal(macMemory('garbage', SYSCTL, GIB16), null, 'unparseable output falls back');
});

test('on macOS swap never alerts, and the kernel pressure level does', () => {
  const mac = macMemory(VM_STAT, SYSCTL, GIB16);
  assert.equal(levelOf(mac, 80, 93), 'ok', '80% of an allocated-so-far swap is routine on a Mac');
  assert.equal(levelOf({ ...mac, pressure: 'warning' }, 80, 93), 'warning');
  assert.equal(levelOf({ ...mac, pressure: 'critical' }, 80, 93), 'critical');
  assert.equal(levelOf({ ...mac, ramPct: 95 }, 80, 93), 'critical');
});

test('a pressure alert says it is pressure', async () => {
  const sent = [];
  const api = { getSetting: (k) => ({ 'warn-percent': 80, 'critical-percent': 93, 'interval-sec': 15, alerts: true })[k], getSessions: async () => [], sendToClients: (e, d) => sent.push(d) };
  let pressure = 'normal';
  const monitor = createMonitor(api, { readMemory: async () => ({ ...macMemory(VM_STAT, SYSCTL, GIB16), pressure }), listProcesses: async () => [] });
  await monitor.sample();
  pressure = 'critical'; await monitor.sample();
  assert.deepEqual(sent.map((d) => d.level), ['critical']);
  assert.match(sent[0].text, /^Memory pressure is critical\./);
});
