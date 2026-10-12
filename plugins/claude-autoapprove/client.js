// Runs in CliDeck's client Worker, which has no page access, so the toggle lives in the session menu.
// On engines that take plugin actions server-side, server.js declares the menu and badges itself (so the phone
// app shows them too) and says so in its state; this client then only shows the results of older-style runs.
export function activate(api) {
  let state = { setupOk: false, enabled: [] };
  const isClaude = (context) => context?.session?.provider === 'claude-code';
  const isOn = (context) => state.enabled.includes(context?.session?.id);

  // Sessions where auto-approve is on wear a badge in their header and sidebar row (CliDeck 2.4+ hosts).
  let badged = new Set();
  const paintBadges = () => {
    if (typeof api.setSessionBadge !== 'function') return;
    const on = new Set(state.serverActions ? [] : state.enabled);
    for (const id of badged) if (!on.has(id)) api.setSessionBadge(id, null);
    for (const id of on) {
      const mode = state.modes?.[id] === 'laissez-faire' ? 'laissez-faire' : 'supervised';
      api.setSessionBadge(id, {
        label: mode === 'laissez-faire' ? 'Auto-approve: all' : 'Auto-approve', icon: '✓',
        title: `Auto-approving Claude's permission checks (${mode}${mode === 'supervised' ? ': plan approval and questions still ask you' : ''}). Turn it off from the session menu.`,
      });
    }
    badged = on;
  };

  const toggle = (context) => api.send('toggle', { sessionId: context.session.id });
  let actions = [];
  const registerActions = () => {
    if (actions.length) return;
    actions = [
      api.registerAction({
        id: 'setup', label: 'Set up auto-approve', icon: 'plugin', placements: ['session.menu'],
        description: 'Add the Claude Code permission hook this plugin needs.',
        when: (context) => isClaude(context) && !state.setupOk,
        run: () => api.send('setup'),
      }),
      api.registerAction({
        id: 'enable', label: 'Enable auto-approve', icon: '✓', placements: ['session.menu'],
        when: (context) => isClaude(context) && context.session.live && state.setupOk && !isOn(context),
        run: toggle,
      }),
      api.registerAction({
        id: 'disable', label: 'Disable auto-approve', icon: '✕', placements: ['session.menu'],
        when: (context) => isClaude(context) && isOn(context),
        run: toggle,
      }),
    ];
  };
  const unregisterActions = () => { actions.forEach((off) => off()); actions = []; };

  const offState = api.onMessage('state', (next) => {
    if (!next) return;
    state = next;
    if (state.serverActions) unregisterActions(); else registerActions();
    paintBadges();
  });
  const offResult = api.onMessage('result', (result) => {
    api.toast(result?.ok ? 'success' : 'error', { id: 'claude-autoapprove', title: 'Auto-approve', body: String(result?.text || '') });
  });
  api.send('get-state');

  return () => { offState(); offResult(); unregisterActions(); };
}
