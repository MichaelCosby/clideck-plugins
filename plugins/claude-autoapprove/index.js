'use strict';
const { mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

const APPROVE_DIR = join(os.homedir(), '.clideck', 'autoapprove');
const SETTINGS_FILE = join(os.homedir(), '.claude', 'settings.json');

const approveEnabled = new Set();
const approveCounts = new Map();
const approveModes = new Map();
let setupOk = false;
let api = null;

function signalPath(id) {
  return join(APPROVE_DIR, id);
}

function stateFor(sessionId) {
  return { sessionId, enabled: approveEnabled.has(sessionId), count: approveCounts.get(sessionId) || 0, mode: approveModes.get(sessionId) || null, setupOk };
}

function toggleSession(sessionId) {
  if (approveEnabled.has(sessionId)) {
    approveEnabled.delete(sessionId);
    approveCounts.delete(sessionId);
    approveModes.delete(sessionId);
    try { unlinkSync(signalPath(sessionId)); } catch {}
  } else {
    const mode = api.getSetting('mode') || 'supervised';
    try { writeFileSync(signalPath(sessionId), mode); } catch (e) {
      api.log(`Failed to create signal file: ${e.message}`);
      return;
    }
    approveEnabled.add(sessionId);
    approveCounts.set(sessionId, 0);
    approveModes.set(sessionId, mode);
  }
  api.sendToFrontend('state', stateFor(sessionId));
}

function checkSetup(pluginDir) {
  try {
    if (!existsSync(SETTINGS_FILE)) return false;
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const groups = settings.hooks?.PermissionRequest || [];
    const hookPath = join(pluginDir, 'hook.js');
    return groups.some(g => (g.hooks || []).some(h => h.command?.includes(hookPath)));
  } catch {
    return false;
  }
}

function installHook(pluginDir) {
  const hookPath = join(pluginDir, 'hook.js').replace(/\\/g, '/');
  const nodePath = process.execPath.replace(/\\/g, '/');
  const port = process.env.CLIDECK_PORT || '4000';
  const command = `"${nodePath}" "${hookPath}" ${port}`;

  let settings = {};
  try { if (existsSync(SETTINGS_FILE)) settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch {}

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PermissionRequest) settings.hooks.PermissionRequest = [];

  // Remove stale entries from this plugin
  settings.hooks.PermissionRequest = settings.hooks.PermissionRequest.filter(
    g => !(g.hooks || []).some(h => h.command?.includes('claude-autoapprove'))
  );
  settings.hooks.PermissionRequest.push({ hooks: [{ type: 'command', command }] });

  try {
    const dir = join(os.homedir(), '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
    setupOk = true;
    api.sendToFrontend('setupResult', { success: true });
  } catch (e) {
    api.sendToFrontend('setupResult', { success: false, error: e.message });
  }
}

exports.init = function init(pluginApi) {
  api = pluginApi;

  mkdirSync(APPROVE_DIR, { recursive: true });

  // Startup scan: remove signal files for sessions that no longer exist
  const activeSessions = new Set(api.getSessions().map(s => s.id));
  try {
    for (const name of readdirSync(APPROVE_DIR)) {
      if (!activeSessions.has(name)) {
        try { unlinkSync(join(APPROVE_DIR, name)); } catch {}
      }
    }
  } catch {}

  setupOk = checkSetup(api.pluginDir);
  if (!setupOk) api.sendToFrontend('needsSetup', {});

  // Telemetry endpoint — hook fires this after approving, non-blocking
  api.expose('approve', ({ clideck_id }) => {
    const id = clideck_id || '';
    if (id && approveEnabled.has(id)) {
      approveCounts.set(id, (approveCounts.get(id) || 0) + 1);
      api.sendToFrontend('state', stateFor(id));
    }
    return {};
  });

  api.onFrontendMessage('toggle', msg => toggleSession(msg.sessionId));
  api.onFrontendMessage('getState', msg => api.sendToFrontend('state', stateFor(msg.sessionId || '')));
  api.onFrontendMessage('setup', () => installHook(api.pluginDir));

  api.onShutdown(() => {
    for (const id of approveEnabled) {
      try { unlinkSync(signalPath(id)); } catch {}
    }
  });
};
