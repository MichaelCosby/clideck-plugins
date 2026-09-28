'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createService, hookCommand } = require('../server');

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

test('setup, enable and disable, without touching unrelated hooks', (t) => {
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
  service.start();
  assert.deepEqual(fs.readdirSync(service.signalDir), [], 'stale signals from a previous run are cleared');

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
