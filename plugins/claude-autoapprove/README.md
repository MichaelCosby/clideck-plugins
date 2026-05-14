# claude-autoapprove

A [CliDeck](https://github.com/MichaelCosby/clideck) plugin that adds a per-session toggle to auto-approve Claude Code permission checks.

When enabled for a session, Claude Code's `PermissionRequest` hook approves all tool use automatically — no prompts. Toggle it off and normal permission behavior resumes immediately.

## How it works

- A lock icon appears in the CliDeck toolbar, reflecting the active session's state
- Clicking it toggles auto-approve on or off for that session
- When on, a badge on the button counts how many approvals have been auto-granted
- Auto-approve is intentionally inert outside of CliDeck — it only activates when `CLIDECK_SESSION_ID` is present in the environment

The signal is a file in `~/.clideck/autoapprove/<session-id>`. The hook checks for this file synchronously with no network dependency, so it adds no latency to tool use.

## Install

In CliDeck's Plugins panel:

```
MichaelCosby/clideck-plugins/plugins/claude-autoapprove
```

Then click the lock icon in the toolbar and choose **Auto Setup** to configure the Claude Code hook, or add it manually:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/path/to/node\" \"/path/to/.clideck/plugins/claude-autoapprove/hook.js\" 4000"
          }
        ]
      }
    ]
  }
}
```

Replace the node path, hook path, and port with the values shown during Auto Setup.

## Cleanup

Signal files are removed automatically:
- When you toggle auto-approve off
- When CliDeck shuts down cleanly
- When CliDeck starts up (orphan files from any previous crash are removed)
