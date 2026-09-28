# Changelog

## 1.0.0
- Rewritten for CliDeck 2.x (plugin API 1). Requires CliDeck 2.x; 1.x keeps using 0.3.0.
- The toolbar button becomes **Set up / Enable / Disable auto-approve** in a Claude Code session's menu, since 2.x plugins cannot add their own buttons. The approval count is shown when you disable it.
- Signal files move to the plugin's private data folder, and the hook takes that folder as its argument instead of a port. Approvals are counted locally instead of over HTTP.
- Setup honours `CLAUDE_CONFIG_DIR` and replaces the 1.x hook entry, so leftover 1.x signal files in `~/.clideck/autoapprove` are no longer read.
- Signal files are also removed when a session closes.

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
