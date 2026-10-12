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
    return { setupOk: setupOk(), enabled: [...enabled.keys()], modes: Object.fromEntries(enabled) };
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

  // Auto-approve stays on for a session across engine restarts, updates and resumes: the signal files are the
  // record. Only files for sessions that no longer exist (deleted while CliDeck was down) are cleared.
  async function start(sessionExists) {
    mkdirSync(signalDir, { recursive: true });
    for (const name of readdirSync(signalDir)) {
      const id = name.replace(/\.approved$/, '');
      if (!(await sessionExists(id))) { remove(join(signalDir, name)); continue; }
      if (name !== id) continue;
      let mode = 'supervised';
      try { mode = readFileSync(join(signalDir, name), 'utf8').trim(); } catch {}
      enabled.set(id, MODES.has(mode) ? mode : 'supervised');
    }
  }

  return { state, installHook, enable, disable, start, enabled, settingsFile, signalDir };
}

function badgeFor(mode) {
  const all = mode === 'laissez-faire';
  return {
    label: all ? 'Auto-approve: all' : 'Auto-approve', icon: '✓',
    title: `Auto-approving Claude's permission checks (${all ? 'laissez-faire' : 'supervised: plan approval and questions still ask you'}). Turn it off from the session menu.`,
  };
}

async function activate(api) {
  const service = createService(api);
  const sessionExists = async (id) => Boolean(await api.getSession(id).catch(() => null));
  await service.start(sessionExists);
  // CliDeck 2.4+ engines take the menu actions and badges here, so every client shows them (the phone app
  // included); the state message tells client.js to leave them to the engine. Older engines get them from
  // client.js, as before.
  const serverSide = typeof api.registerAction === 'function';
  const state = () => ({ ...service.state(), serverActions: serverSide });
  let badged = new Set();
  const publish = () => {
    api.sendToClients('state', state());
    if (!serverSide) return;
    for (const id of badged) if (!service.enabled.has(id)) api.setSessionBadge(id, null);
    for (const [id, mode] of service.enabled) api.setSessionBadge(id, badgeFor(mode));
    badged = new Set(service.enabled.keys());
    api.refreshActions();
  };

  function setup() {
    try {
      service.installHook();
      return { ok: true, text: `Hook added to ${service.settingsFile}. Restart Claude Code sessions to load it, then enable auto-approve.` };
    } catch (error) {
      return { ok: false, text: `Hook install failed: ${error.message}` };
    } finally {
      publish();
    }
  }

  async function toggle(id) {
    const session = id && await api.getSession(id);
    // Turning it off works in a stopped session too; turning it on needs a running Claude Code session.
    if (session && service.enabled.has(id)) {
      const count = service.disable(id);
      publish();
      return { ok: true, text: `Off for ${session.name || 'this session'}. ${count} permission check${count === 1 ? '' : 's'} approved.` };
    }
    if (!session || session.provider !== 'claude-code' || !session.live) {
      return { ok: false, text: 'Auto-approve works only in a running Claude Code session.' };
    }
    const mode = service.enable(id);
    publish();
    return { ok: true, text: `On for ${session.name || 'this session'} (${mode}).` };
  }

  api.onClientMessage('get-state', (_data, context) => context.reply('state', state()));
  api.onClientMessage('setup', (_data, context) => context.reply('result', setup()));
  api.onClientMessage('toggle', async (data, context) => context.reply('result', await toggle(String(data?.sessionId || ''))));

  if (serverSide) {
    // `when` runs once per session for each menu, so the hook check is read at most every few seconds.
    let setupChecked = 0, setupCached = false;
    const setupOk = () => {
      if (Date.now() - setupChecked > 3000) { setupCached = service.state().setupOk; setupChecked = Date.now(); }
      return setupCached;
    };
    const isClaude = (context) => context?.session?.provider === 'claude-code';
    const isOn = (context) => service.enabled.has(context?.session?.id);
    const report = (result) => {
      if (!result.ok) throw new Error(result.text);
      api.toast('success', { id: 'claude-autoapprove', title: 'Auto-approve', body: result.text });
    };
    api.registerAction({
      id: 'setup', label: 'Set up auto-approve', icon: 'plugin', placements: ['session.menu'],
      description: 'Add the Claude Code permission hook this plugin needs.',
      when: (context) => isClaude(context) && !setupOk(),
      run: () => { setupChecked = 0; report(setup()); },
    });
    api.registerAction({
      id: 'enable', label: 'Enable auto-approve', icon: '✓', placements: ['session.menu'],
      when: (context) => isClaude(context) && context.session.live && setupOk() && !isOn(context),
      run: async (context) => report(await toggle(context.session.id)),
    });
    api.registerAction({
      id: 'disable', label: 'Disable auto-approve', icon: '✕', placements: ['session.menu'],
      when: (context) => isClaude(context) && isOn(context),
      run: async (context) => report(await toggle(context.session.id)),
    });
  }
  publish();

  // A stopped session keeps auto-approve for when it resumes; a deleted one (gone from CliDeck) is cleaned up.
  api.onEvent('session.closed', async (event) => {
    const id = event.sessionId;
    if (!id || !service.enabled.has(id) || await sessionExists(id)) return;
    service.disable(id);
    publish();
  });
}

module.exports = { activate, createService, hookCommand };
