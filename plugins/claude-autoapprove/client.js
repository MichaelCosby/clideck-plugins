// Runs in CliDeck's client Worker, which has no page access, so the toggle lives in the session menu.
export function activate(api) {
  let state = { setupOk: false, enabled: [] };
  const isClaude = (context) => context?.session?.provider === 'claude-code';
  const isOn = (context) => state.enabled.includes(context?.session?.id);

  const offState = api.onMessage('state', (next) => { if (next) state = next; });
  const offResult = api.onMessage('result', (result) => {
    api.toast(result?.ok ? 'success' : 'error', { id: 'claude-autoapprove', title: 'Auto-approve', body: String(result?.text || '') });
  });
  api.send('get-state');

  const toggle = (context) => api.send('toggle', { sessionId: context.session.id });
  const actions = [
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

  return () => { offState(); offResult(); actions.forEach((off) => off()); };
}
