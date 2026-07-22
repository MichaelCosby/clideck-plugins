# sysmon

A [CliDeck](https://github.com/MichaelCosby/clideck) plugin that adds a live RAM, swap, and load-average readout to the toolbar.

## How it works

- The server side polls memory/swap/load stats on an interval (default 15s, configurable 3-60s) and pushes them to connected clients.
- On Linux, RAM usage is computed from `/proc/meminfo`'s `MemTotal`/`MemAvailable` (matching what `free` reports as "used"), not `os.freemem()`, which excludes reclaimable page cache and over-reports usage. Swap comes from `SwapTotal`/`SwapFree`; if no swap is configured, the readout shows "none" instead of 0%.
- On non-Linux platforms, RAM falls back to `os.totalmem()`/`os.freemem()` (marked "(approx)" in the tooltip since it can't distinguish reclaimable cache from real usage), and swap is not reported.
- Load average comes from `os.loadavg()` (1m/5m/15m); unavailable on Windows.
- The toolbar button shows the RAM percentage; hovering shows the full breakdown (RAM, swap, load average). The button turns yellow at the warn threshold and red at the critical threshold (both configurable, based on the higher of RAM% and swap%).

## Install

In CliDeck's Plugins panel:

```
MichaelCosby/clideck-plugins/plugins/sysmon
```

## Settings

- **Refresh interval (seconds)** — how often to poll, 3-60s (default 15)
- **Warn threshold (%)** — turns the readout yellow (default 80)
- **Critical threshold (%)** — turns the readout red (default 93)
