# clideck-plugins

Community plugins for [CliDeck](https://github.com/MichaelCosby/clideck).

## Installing a plugin

The `main` branch holds the plugins for **CliDeck 2.x**; the CliDeck 1.x versions are on the `v1` branch.

In CliDeck, go to **Settings → Plugins → Install plugin**, and under **Install from GitHub** enter the plugin's
folder, for example:

```
https://github.com/MichaelCosby/clideck-plugins/tree/main/plugins/sysmon
```

Plugins installed this way get **Update from GitHub** on their settings page.

## Plugins

| Plugin | Description |
|--------|-------------|
| [claude-autoapprove](plugins/claude-autoapprove) | Per-session toggle to auto-approve Claude Code permission checks |
| [sysmon](plugins/sysmon) | System monitor tab: RAM, swap, load history, and memory per session |
