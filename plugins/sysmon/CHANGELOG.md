# Changelog

## 2.1.0
- macOS: RAM use now matches Activity Monitor's Memory Used (app memory, wired and compressed, from `vm_stat`) instead of `os.freemem()`, which counted cache as used and read near 100% on a healthy Mac.
- macOS: the kernel's memory pressure level is shown on the RAM tile and raises warning and critical alerts.
- macOS: swap is read from `sysctl vm.swapusage` and shown in GiB. It never raises an alert, because macOS grows swap as needed and a percentage of it is routine.

## 2.0.0
- Rewritten for CliDeck 2.x (plugin API 1). Requires CliDeck 2.x; 1.x keeps using 0.1.0.
- The toolbar readout is replaced by a **System monitor** tab, opened from the terminal header's plugin menu: RAM, swap and load tiles, 15 minutes of memory and load history with hover readouts, and memory per session counting each agent's child processes.
- Toasts when RAM or swap crosses the warning or critical threshold, even with the tab closed (can be turned off).
- Setting keys renamed for the 2.x API: `interval-sec`, `warn-percent`, `critical-percent`; previous values are not carried over.

## 0.1.0
- Initial release. Toolbar readout of RAM, swap, and load average, refreshed on an interval.
- RAM/swap computed from `/proc/meminfo` on Linux (`MemAvailable`-based, matching `free`); approximate `os.freemem()`-based fallback elsewhere, with swap unsupported off Linux.
- Configurable refresh interval (3-60s, default 15s) and warn/critical percent thresholds that color the toolbar readout.
