# claude-autoapprove — agent context

## What this plugin does

Per-session toggle in CliDeck to auto-approve Claude Code `PermissionRequest` hooks. When a session has auto-approve on, the hook approves all tool use without prompting. The toggle is surfaced as a toolbar button in the CliDeck UI.

## File roles

| File | Role |
|------|------|
| `hook.js` | Claude Code `PermissionRequest` hook script. Runs as a child process on every tool-use permission check. Reads `CLIDECK_SESSION_ID` from env, checks for a signal file, outputs the allow decision to stdout, then fires a non-blocking telemetry POST. |
| `index.js` | Server-side plugin (Node.js, runs inside CliDeck). Manages signal files, handles toggle/state/setup messages from the frontend, registers the `/hook/autoapprove` HTTP route for telemetry, cleans up on shutdown. |
| `client.js` | Frontend plugin (ES module, runs in the browser). Renders the toolbar button, tracks active session via MutationObserver, handles state/setup messages from the server. |
| `clideck-plugin.json` | Plugin manifest — id, name, version, description, icon. No `install` field (zero npm dependencies). |

## Key design decisions

- **Filesystem signal, not API call** — the hook checks `~/.clideck/autoapprove/<CLIDECK_SESSION_ID>` so it works with zero latency and no network dependency.
- **Inert outside CliDeck** — the hook exits immediately if `CLIDECK_SESSION_ID` is absent, so it has no effect when Claude Code runs outside of CliDeck.
- **Telemetry is fire-and-forget** — the HTTP POST to `/hook/autoapprove` is non-blocking; the hook doesn't wait for it.

## CliDeck plugin API surface used

- `api.addRoute('POST', path, fn)` — registers the telemetry HTTP endpoint
- `api.onFrontendMessage(event, fn)` / `api.sendToFrontend(event, data)` — toggle/state/setup messaging
- `api.getSessions()` — used at startup to identify orphan signal files
- `api.onShutdown(fn)` — cleans up signal files on server exit
- `api.pluginDir` — used to build the absolute path to `hook.js` when writing the Claude Code settings hook

## Signal file lifecycle

| Event | Action |
|-------|--------|
| Toggle on | `writeFileSync(~/.clideck/autoapprove/<id>, '')` |
| Toggle off | `unlinkSync(...)` |
| Server shutdown | Delete all files for enabled sessions |
| Plugin init (startup) | Scan dir, delete files whose IDs are not in active sessions |

## CliDeck version dependency

Requires the `addRoute` plugin API (added in the `feat/github-plugin-install` branch / merged to main after commit `138917b`). Will not load on older CliDeck versions.
