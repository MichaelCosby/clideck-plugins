'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { activate, createService, hookCommand } = require('../server');

const pluginDir = join(__dirname, '..');

function runHook(signalDir, sessionId, toolName) {
  const env = { ...process.env, CLIDECK_SESSION_ID: sessionId };
  if (sessionId === null) delete env.CLIDECK_SESSION_ID;
  const result = spawnSync(process.execPath, [join(pluginDir, 'hook.js'), signalDir], {
    input: JSON.stringify({ tool_name: toolName }), env, encoding: 'utf8',
  });
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.decision.behavior : 'prompt';
}

test('the hook approves only for sessions with a signal file, honouring the mode', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'autoapprove-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runHook(dir, 's1', 'Bash'), 'prompt', 'off: no signal file');
  fs.writeFileSync(join(dir, 's1'), 'supervised');
  assert.equal(runHook(dir, 's1', 'Bash'), 'allow');
  assert.equal(runHook(dir, 's1', 'ExitPlanMode'), 'prompt', 'supervised keeps plan approval interactive');
  assert.equal(runHook(dir, 's1', 'AskUserQuestion'), 'prompt');
  fs.writeFileSync(join(dir, 's1'), 'laissez-faire');
  assert.equal(runHook(dir, 's1', 'ExitPlanMode'), 'allow');
  assert.equal(fs.statSync(join(dir, 's1.approved')).size, 2, 'each approval is counted');
  assert.equal(runHook(dir, null, 'Bash'), 'prompt', 'inert outside CliDeck');
  assert.equal(runHook(dir, '../s1', 'Bash'), 'prompt', 'an unsafe session id is ignored');
});

test('setup, enable and disable, without touching unrelated hooks', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'autoapprove-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'claude');
  fs.mkdirSync(configDir);
  const settingsFile = join(configDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    model: 'keep-me',
    hooks: {
      PermissionRequest: [
        { hooks: [{ type: 'command', command: '"/usr/bin/node" "/old/plugins/claude-autoapprove/hook.js" 4000' }] },
        { hooks: [{ type: 'command', command: '/usr/local/bin/other-hook' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'notify-done' }] }],
    },
  }));
  const settings = { mode: 'laissez-faire' };
  const api = { dataDir: join(root, 'data'), dir: pluginDir, getSetting: (key) => settings[key] };
  const service = createService(api, { CLAUDE_CONFIG_DIR: configDir });

  fs.mkdirSync(service.signalDir, { recursive: true });
  fs.writeFileSync(join(service.signalDir, 'stale'), 'supervised');
  await service.start(async () => false);
  assert.deepEqual(fs.readdirSync(service.signalDir), [], 'signals for sessions that no longer exist are cleared');

  assert.equal(service.state().setupOk, false);
  service.installHook();
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const commands = saved.hooks.PermissionRequest.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(commands, ['/usr/local/bin/other-hook', hookCommand(pluginDir, service.signalDir)], 'the 1.x entry is replaced, others kept');
  assert.equal(saved.model, 'keep-me');
  assert.equal(saved.hooks.Stop[0].hooks[0].command, 'notify-done');
  assert.equal(service.state().setupOk, true);

  assert.equal(service.enable('s1'), 'laissez-faire');
  assert.deepEqual(service.state().enabled, ['s1']);
  assert.equal(runHook(service.signalDir, 's1', 'Bash'), 'allow');
  assert.equal(runHook(service.signalDir, 's1', 'Edit'), 'allow');
  assert.equal(service.disable('s1'), 2, 'disabling reports how many checks were approved');
  assert.deepEqual(fs.readdirSync(service.signalDir), []);
  assert.equal(runHook(service.signalDir, 's1', 'Bash'), 'prompt');
});

test('auto-approve survives a restart for sessions that still exist, with their mode', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'autoapprove-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { mode: 'laissez-faire' };
  const api = { dataDir: join(root, 'data'), dir: pluginDir, getSetting: (key) => settings[key] };
  const first = createService(api, { CLAUDE_CONFIG_DIR: join(root, 'claude') });
  await first.start(async () => true);
  first.enable('kept');
  settings.mode = 'supervised';
  first.enable('gone');
  fs.appendFileSync(join(first.signalDir, 'kept.approved'), '...');

  // The engine restarts (an update): 'gone' was deleted meanwhile, 'kept' was only stopped.
  const second = createService(api, { CLAUDE_CONFIG_DIR: join(root, 'claude') });
  await second.start(async (id) => id === 'kept');
  assert.deepEqual(second.state().enabled, ['kept']);
  assert.deepEqual(second.state().modes, { kept: 'laissez-faire' });
  assert.equal(runHook(second.signalDir, 'kept', 'Bash'), 'allow', 'the resumed session is still auto-approved');
  assert.equal(runHook(second.signalDir, 'gone', 'Bash'), 'prompt');
  assert.deepEqual(fs.readdirSync(second.signalDir).sort(), ['kept', 'kept.approved']);
  assert.equal(second.disable('kept'), 4, 'the approval count carries over too');
});

// A stand-in for the engine's server plugin API, with the server-side actions of CliDeck 2.4+.
function fakeEngine(root, sessions, { serverActions = true } = {}) {
  const engine = { actions: new Map(), badges: new Map(), toasts: [], sent: [], refreshes: 0, handlers: new Map() };
  engine.api = {
    dataDir: join(root, 'data'), dir: pluginDir, getSetting: () => 'supervised',
    getSession: async (id) => sessions[id] || null,
    sendToClients: (event, data) => engine.sent.push([event, data]),
    onClientMessage: (event, fn) => engine.handlers.set(event, fn),
    onEvent: () => {},
    ...(serverActions && {
      registerAction: (action) => { engine.actions.set(action.id, action); return () => engine.actions.delete(action.id); },
      refreshActions: () => { engine.refreshes += 1; },
      setSessionBadge: (id, badge) => { if (badge) engine.badges.set(id, badge); else engine.badges.delete(id); },
      toast: (kind, options) => engine.toasts.push([kind, options.body]),
    }),
  };
  engine.offered = (session) => [...engine.actions.values()]
    .filter((action) => action.when({ surface: 'session', session }))
    .map((action) => action.id);
  return engine;
}

test('on engines with server actions, the menu and badges come from the server part', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'autoapprove-actions-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sessions = {
    c1: { id: 'c1', provider: 'claude-code', name: 'Builder', live: true },
    x1: { id: 'x1', provider: 'codex', name: 'Other', live: true },
  };
  const engine = fakeEngine(root, sessions);
  await activate(engine.api);
  assert.equal(engine.sent.at(-1)[1].serverActions, true, 'client.js is told to leave the menu to the engine');
  assert.deepEqual(engine.offered(sessions.c1), ['setup']);
  assert.deepEqual(engine.offered(sessions.x1), [], 'nothing for other agents');

  await engine.actions.get('setup').run({ session: sessions.c1 });
  assert.match(engine.toasts.at(-1)[1], /Hook added/);
  assert.deepEqual(engine.offered(sessions.c1), ['enable']);

  await engine.actions.get('enable').run({ session: sessions.c1 });
  assert.deepEqual(engine.toasts.at(-1), ['success', 'On for Builder (supervised).']);
  assert.equal(engine.badges.get('c1').label, 'Auto-approve');
  assert.deepEqual(engine.offered(sessions.c1), ['disable']);
  assert.ok(engine.refreshes > 0, 'the engine is asked to re-check the menu');

  // Stopped sessions keep it, and it can be turned off there; it can't be turned on for one.
  sessions.c1.live = false;
  assert.deepEqual(engine.offered(sessions.c1), ['disable']);
  await engine.actions.get('disable').run({ session: sessions.c1 });
  assert.match(engine.toasts.at(-1)[1], /^Off for Builder\. 0 permission checks approved\./);
  assert.equal(engine.badges.has('c1'), false);
  assert.deepEqual(engine.offered(sessions.c1), [], 'a stopped session cannot be enabled');
  await assert.rejects(engine.actions.get('enable').run({ session: sessions.x1 }), /only in a running Claude Code session/);
});

test('on older engines the server part only answers client.js, as before', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'autoapprove-old-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = fakeEngine(root, {}, { serverActions: false });
  await activate(engine.api);
  assert.equal(engine.sent.at(-1)[1].serverActions, false);
  assert.ok(engine.handlers.has('toggle') && engine.handlers.has('setup') && engine.handlers.has('get-state'));
});
