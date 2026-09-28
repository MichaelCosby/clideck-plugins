'use strict';
const { mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync, statSync } = require('fs');
const { dirname, join } = require('path');
const os = require('os');

const MODES = new Set(['supervised', 'laissez-faire']);

// Claude Code reads hooks from its config dir; CliDeck launches it with this engine's environment.
function claudeSettingsFile(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'), 'settings.json');
}

function readSettings(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

function isOurHook(hook) {
  return typeof hook?.command === 'string' && hook.command.includes('claude-autoapprove');
}

function hookCommand(pluginDir, signalDir) {
  const slash = (path) => path.replace(/\\/g, '/');
  return `"${slash(process.execPath)}" "${slash(join(pluginDir, 'hook.js'))}" "${slash(signalDir)}"`;
}

function createService(api, env = process.env) {
  const signalDir = join(api.dataDir, 'signals');
  const settingsFile = claudeSettingsFile(env);
  const enabled = new Map(); // sessionId -> mode
  const signal = (id) => join(signalDir, id);
  const counter = (id) => join(signalDir, `${id}.approved`);
  const remove = (path) => { try { unlinkSync(path); } catch {} };

  function setupOk() {
    try {
      const expected = hookCommand(api.dir, signalDir);
      return (readSettings(settingsFile).hooks?.PermissionRequest || [])
        .some((group) => (group.hooks || []).some((hook) => hook.command === expected));
    } catch {
      return false;
    }
  }

  function state() {
    return { setupOk: setupOk(), enabled: [...enabled.keys()] };
  }

  // Replaces any earlier entry from this plugin, including a 1.x one that read ~/.clideck/autoapprove.
  function installHook() {
    const settings = readSettings(settingsFile);
    settings.hooks = settings.hooks || {};
    const groups = (settings.hooks.PermissionRequest || [])
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !isOurHook(hook)) }))
      .filter((group) => group.hooks.length);
    groups.push({ hooks: [{ type: 'command', command: hookCommand(api.dir, signalDir) }] });
    settings.hooks.PermissionRequest = groups;
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }

  function approvedCount(id) {
    try { return statSync(counter(id)).size; } catch { return 0; }
  }

  function disable(id) {
    const count = approvedCount(id);
    enabled.delete(id);
    remove(signal(id));
    remove(counter(id));
    return count;
  }

  function enable(id) {
    const mode = MODES.has(api.getSetting('mode')) ? api.getSetting('mode') : 'supervised';
    writeFileSync(signal(id), mode);
    remove(counter(id));
    enabled.set(id, mode);
    return mode;
  }

  function start() {
    mkdirSync(signalDir, { recursive: true });
    // Nothing is enabled when the plugin starts, so any file left from a previous run is stale.
    for (const name of readdirSync(signalDir)) remove(join(signalDir, name));
  }

  return { state, installHook, enable, disable, start, enabled, settingsFile, signalDir };
}

async function activate(api) {
  const service = createService(api);
  service.start();
  const publish = () => api.sendToClients('state', service.state());

  api.onClientMessage('get-state', (_data, context) => context.reply('state', service.state()));

  api.onClientMessage('setup', (_data, context) => {
    try {
      service.installHook();
      context.reply('result', { ok: true, text: `Hook added to ${service.settingsFile}. Restart Claude Code sessions to load it, then enable auto-approve.` });
    } catch (error) {
      context.reply('result', { ok: false, text: `Hook install failed: ${error.message}` });
    }
    publish();
  });

  api.onClientMessage('toggle', async (data, context) => {
    const id = String(data?.sessionId || '');
    const session = id && await api.getSession(id);
    if (!session || session.provider !== 'claude-code' || !session.live) {
      context.reply('result', { ok: false, text: 'Auto-approve works only in a running Claude Code session.' });
      return;
    }
    const name = session.name || 'this session';
    if (service.enabled.has(id)) {
      const count = service.disable(id);
      context.reply('result', { ok: true, text: `Off for ${name}. ${count} permission check${count === 1 ? '' : 's'} approved.` });
    } else {
      const mode = service.enable(id);
      context.reply('result', { ok: true, text: `On for ${name} (${mode}).` });
    }
    publish();
  });

  api.onEvent('session.closed', (event) => {
    if (event.sessionId && service.enabled.has(event.sessionId)) {
      service.disable(event.sessionId);
      publish();
    }
  });

  api.onShutdown(() => {
    for (const id of [...service.enabled.keys()]) service.disable(id);
  });
}

module.exports = { activate, createService, hookCommand };
