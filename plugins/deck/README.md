# Session Status (deck)

See at a glance which sessions need you. Each session gets one badge in the sidebar and the terminal
header, built from two layers:

1. **What the session says about itself**: open questions, blocked, done.
2. **A stage**: a free-form label any session can set on any other, such as `implementing`,
   `waiting for CI`, `waiting for review` or `ready to close`. CliDeck never reads the words, only the
   level: `--you` (the user must act), `--waiting` (waiting on something outside, such as CI or a
   reviewer) or `--active` (work in progress). The vocabulary belongs in your repo's CLAUDE.md or the
   coordinator's instructions, not in this plugin.

The badge shows the most attention-worthy thing; the tooltip has all of it, with ages:
blocked > stage `--you` > open questions > stage `--waiting` > done > stage `--active`.

## Commands (agents run these as `clideck deck/<command>`)

| Command | Who | What |
|---|---|---|
| `report [--questions N] [--blocked] [--done]` | the session itself | Set its own status. Omitted flags reset. |
| `questions ["q" ...] [--clear]` | the session itself | Record one-line open questions (sidebar menu: **Show open questions**). No arguments lists them. |
| `stage "<label>" --you\|--waiting\|--active [--icon 🧹] [session ...]` | any session | Set a stage on each named session (default: itself). Several targets in one call. `--clear` removes it. |
| `stages [--all] [--json]` | any session | Labels already in use in the project, so agents reuse them. |
| `list [--all] [--json]` | any session | Every session's status in the project. |

Sessions are named by id, id prefix, name (the caller's own project first) or `@project/name`.
`--icon` takes one emoji or one or two characters; without it the level picks a default (❗ ⏳ ⚙). The
sidebar shows only a badge's glyph, so open questions use `?3` (`9+` above nine) to show the count there.

### The end-of-turn line

The cheapest way for an agent to stay current is to end each final message with

```
[deck: questions=2 blocked=no done=no]
```

It costs a few output tokens and no tool call. `questions` is open questions waiting on you, `blocked`
means the agent cannot continue until you answer, and `done` means **all assigned work is finished or
handed off**, not just this turn. A message without the line leaves the last status in place. A new
prompt from you clears *blocked* and *done* (the answer arrived; there is new work) but keeps the
question count until the agent restates it.

The plugin's manifest `guide` puts this convention in the CliDeck instructions of every agent started
while the plugin is enabled (agents already running keep what they started with, and it is absent when
agent guidance is off). It works from there with Sonnet; for the smallest models, or to be sure, also
put it in your repo's CLAUDE.md.

## Notes

- A stage stays until someone changes it; its age is in the tooltip. **Clear status and stage** in the
  session menu removes a stale badge.
- State is kept in the plugin's data directory, survives restarts, and is dropped when a session is
  deleted (a stopped session keeps its marks).
- Needs a CliDeck with server-side badges and actions (2.4 or newer), plus manifest `guide` text for the
  instructions to reach agents (older versions fall back to the command descriptions).
- Any session can set a stage on any other; the tooltip names who did.
