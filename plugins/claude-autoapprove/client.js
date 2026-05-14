'use strict';

const ICON_LOCKED = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const ICON_UNLOCKED = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-3.46"/></svg>`;
const ICON_WARN = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`;

let api = null;
let toolbarBtn = null;
let currentSessionId = null;
let needsSetup = false;
const sessionState = new Map(); // sessionId → { enabled, count }

export function init(pluginApi) {
  api = pluginApi;

  toolbarBtn = api.addToolbarButton({
    title: 'Auto-approve',
    icon: ICON_LOCKED,
    onClick: handleClick,
  });

  api.onMessage('state', msg => {
    sessionState.set(msg.sessionId, { enabled: msg.enabled, count: msg.count, setupOk: msg.setupOk });
    if (!msg.setupOk) needsSetup = true;
    if (msg.sessionId === currentSessionId) renderButton(msg);
  });

  api.onMessage('needsSetup', () => {
    needsSetup = true;
    renderButton(currentSessionId ? sessionState.get(currentSessionId) : null);
  });

  api.onMessage('setupResult', msg => {
    if (msg.success) {
      needsSetup = false;
      api.toast('Auto-approve hook installed. Restart Claude Code sessions to activate it.', {
        title: 'Auto-approve ready',
        duration: 6000,
      });
      renderButton(currentSessionId ? sessionState.get(currentSessionId) : null);
    } else {
      api.toast(`Hook install failed: ${msg.error}`, { type: 'error', duration: 0 });
    }
  });

  // Detect active session changes via MutationObserver on the session list
  const list = document.getElementById('session-list');
  if (list) {
    new MutationObserver(mutations => {
      for (const m of mutations) {
        const el = m.target;
        if (el.dataset?.id && el.classList.contains('active-session')) {
          onActiveSessionChanged(el.dataset.id);
          break;
        }
      }
    }).observe(list, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  const initial = api.getActiveSessionId();
  if (initial) onActiveSessionChanged(initial);
}

function handleClick() {
  if (needsSetup) {
    api.send('setup');
    if (toolbarBtn) {
      toolbarBtn.title = 'Installing hook…';
      toolbarBtn.classList.add('autoapprove-busy');
    }
    return;
  }
  if (!currentSessionId) return;
  api.send('toggle', { sessionId: currentSessionId });
}

function onActiveSessionChanged(id) {
  if (id === currentSessionId) return;
  currentSessionId = id;
  const cached = sessionState.get(id);
  if (cached) {
    renderButton(cached);
  } else {
    renderButton(null);
    api.send('getState', { sessionId: id });
  }
}

function renderButton(state) {
  if (!toolbarBtn) return;
  toolbarBtn.classList.remove('autoapprove-on', 'autoapprove-busy');

  if (needsSetup) {
    toolbarBtn.innerHTML = ICON_WARN;
    toolbarBtn.title = 'Auto-approve: setup needed — click to install hook';
    toolbarBtn.classList.add('autoapprove-warn');
    return;
  }
  toolbarBtn.classList.remove('autoapprove-warn');

  const enabled = state?.enabled;
  const count = state?.count || 0;
  toolbarBtn.innerHTML = (enabled ? ICON_UNLOCKED : ICON_LOCKED) +
    (enabled && count > 0 ? `<span class="autoapprove-badge">${count > 99 ? '99+' : count}</span>` : '');
  toolbarBtn.title = enabled
    ? `Auto-approve ON — ${count} approved this session (click to disable)`
    : 'Auto-approve OFF — click to enable for this session';
  if (enabled) toolbarBtn.classList.add('autoapprove-on');
}

const style = document.createElement('style');
style.textContent = `
  button[data-plugin-id="claude-autoapprove"] { position: relative; }
  .autoapprove-on { color: #60a5fa !important; }
  .autoapprove-warn { color: #f59e0b !important; }
  .autoapprove-busy { opacity: 0.5; pointer-events: none; }
  .autoapprove-badge {
    position: absolute;
    top: -4px; right: -4px;
    background: #3b82f6;
    color: white;
    font-size: 9px;
    font-weight: 700;
    border-radius: 9999px;
    min-width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 3px;
    line-height: 1;
    pointer-events: none;
  }
`;
document.head.appendChild(style);
