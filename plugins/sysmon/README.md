# sysmon

A [CliDeck](https://github.com/MichaelCosby/clideck) 2.x plugin that shows how much memory and CPU load your
sessions are using, in a **System monitor** tab next to the terminal.

## What it shows

- **RAM, swap and load average** right now, with a warning or critical label when a threshold is crossed.
- **The last 15 minutes** of memory and load as line charts; hover for the exact values at any moment. The load
  chart marks your core count, so you can see when the machine is oversubscribed.
- **Memory by session**: each running session's agent plus every process it started (shells, test runners,
  dev servers), with its share of RAM. This is the quickest way to find the session that is eating memory.
- **Alerts**: a toast when RAM or swap crosses the warning or critical threshold, even with the tab closed.

Open it from the terminal header's plugin menu: **System monitor**.

On Linux, RAM use comes from `/proc/meminfo` (`MemTotal` minus `MemAvailable`, matching `free`). Elsewhere it
falls back to `os.freemem()`, which counts reclaimable cache as used, so it is marked approximate and swap is
not shown. Per-session memory uses `ps`, so it works on Linux and macOS.

## Install

In CliDeck, **Settings → Plugins → Install plugin → Install from GitHub**:

```
https://github.com/MichaelCosby/clideck-plugins/tree/clideck-2x/plugins/sysmon
```

Plugins installed this way can later be updated with **Update from GitHub** on the plugin's page.

## Settings

- **Sampling interval (seconds)**: how often to sample, 3–60 (default 15)
- **Warning threshold (%)**: RAM or swap use that raises a warning (default 80)
- **Critical threshold (%)**: RAM or swap use that raises a critical alert (default 93)
- **Alert when a threshold is crossed**: toasts on or off (default on)
