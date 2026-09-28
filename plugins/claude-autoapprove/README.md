# claude-autoapprove

A [CliDeck](https://github.com/MichaelCosby/clideck) 2.x plugin that adds a per-session toggle to auto-approve
Claude Code permission checks.

When enabled for a session, Claude Code's `PermissionRequest` hook approves tool use automatically, with no
prompts. Turn it off and normal permission behavior resumes immediately.

## How it works

- Right-click a Claude Code session in the sidebar (or open its ▾ menu):
  - **Set up auto-approve** appears until the Claude Code hook is installed.
  - **Enable auto-approve** turns it on for that session, in the mode currently set in the plugin's settings.
  - **Disable auto-approve** turns it off and tells you how many permission checks were approved.
- **Supervised** mode (default) still prompts for plan approval (`ExitPlanMode`) and direct questions
  (`AskUserQuestion`). **Laissez-faire** approves everything.
- Auto-approve is inert outside CliDeck: the hook only acts when `CLIDECK_SESSION_ID` is set and that session
  has been enabled.

Each enabled session has a signal file in the plugin's private data folder. The hook checks that file
synchronously, with no network call, so it adds no latency to tool use.

## Install

In CliDeck, **Settings → Plugins → Install plugin → Install from GitHub**:

```
https://github.com/MichaelCosby/clideck-plugins/tree/clideck-2x/plugins/claude-autoapprove
```

Then choose **Set up auto-approve** from a Claude Code session's menu. It adds the hook to the `settings.json`
of the Claude Code profile CliDeck launches (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), leaving your other hooks
and settings alone, and replaces any hook from the 1.x version of this plugin. Restart running Claude Code
sessions to load it.

## Cleanup

Signal files are removed when you disable auto-approve, when a session closes, when CliDeck shuts down, and
when the plugin starts (anything left over from a crash).
