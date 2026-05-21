'use strict';

const ICON_SNAIL = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="12" r="5.5"/><path d="M13 12a3 3 0 0 1 6 0"/><path d="M10.5 15Q6 16 4 14Q3 12.5 4.5 11.5"/><line x1="4.5" y1="11.5" x2="3" y2="9"/><line x1="4.5" y1="11.5" x2="6" y2="9"/></svg>`;
const FLAME_COLOR = { 'laissez-faire': '#f97316', 'supervised': '#60a5fa' };
function iconRocket(mode) {
  const flame = FLAME_COLOR[mode] || FLAME_COLOR['supervised'];
  return `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C11 4 9 7 9 12v2h6v-2C15 7 13 4 12 2z"/><circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none"/><path d="M9 12L7 17"/><path d="M15 12L17 17"/><path d="M10 14C9 17.5 11 21 12 21C13 21 15 17.5 14 14" fill="${flame}" stroke="${flame}" stroke-width="1"/></svg>`;
}
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
    icon: ICON_SNAIL,
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
  const mode = state?.mode || 'supervised';
  toolbarBtn.innerHTML = (enabled ? iconRocket(mode) : ICON_SNAIL) +
    (enabled && count > 0 ? `<span class="autoapprove-badge">${count > 99 ? '99+' : count}</span>` : '');
  const modeLabel = mode === 'laissez-faire' ? 'laissez-faire' : 'supervised';
  toolbarBtn.title = enabled
    ? `Auto-approve ON (${modeLabel}) — ${count} approved this session (click to disable)`
    : 'Auto-approve OFF — click to enable for this session';
  if (enabled) toolbarBtn.classList.add('autoapprove-on');
}

const style = document.createElement('style');
style.textContent = `
  button[data-plugin-id="claude-autoapprove"] { position: relative; }
  .autoapprove-on { opacity: 1; }
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
