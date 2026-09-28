// Runs in CliDeck's client Worker: it registers the stats tab and relays threshold alerts as toasts.
export function activate(api) {
  const workspace = api.registerWorkspace({
    id: 'stats',
    title: 'System monitor',
    src: '/plugins/sysmon/public/index.html',
  });
  const action = api.registerAction({
    id: 'open',
    label: 'System monitor',
    icon: 'waveform',
    description: 'RAM, swap, load and memory per session.',
    placements: ['toolbar'],
    when: (context) => Boolean(context && context.session),
    run: (context) => api.openWorkspace('stats', { sessionId: context.session.id }),
  });
  const offAlert = api.onMessage('alert', (alert) => {
    const critical = alert && alert.level === 'critical';
    api.toast(critical ? 'error' : 'warn', {
      id: 'sysmon-alert',
      title: critical ? 'Memory critical' : 'Memory warning',
      body: String((alert && alert.text) || ''),
      duration: critical ? 0 : 8000,
    });
  });
  return () => { workspace(); action(); offAlert(); };
}
