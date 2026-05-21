# Changelog

## 0.3.0
- Replaced lock icon with a **snail** (off) / **rocket** (on) icon scheme. Snail signals manual approval; rocket signals auto-approve is active.
- Rocket flame color indicates mode: **blue** for supervised, **orange** for laissez-faire.

## 0.2.0
- Added **supervised** / **laissez-faire** mode setting. Supervised (default) lets `ExitPlanMode` and `AskUserQuestion` fall through to Claude Code's normal permission handling, keeping the user in the loop at meaningful decision points. Laissez-faire approves everything without exception.
- Mode is written into the sentinel file at toggle-on time, so each session can independently run in a different mode from the global setting.
- Toolbar icon now shows a colored dot inside the lock body when active: blue for supervised, red for laissez-faire.
- Tooltip names the active mode.

## 0.1.0
- Initial release. Per-session toggle to auto-approve all Claude Code permission requests within a clideck session. Installs a `PermissionRequest` hook into `~/.claude/settings.json`. Approval count badge on the toolbar button. Inert outside of clideck sessions.
