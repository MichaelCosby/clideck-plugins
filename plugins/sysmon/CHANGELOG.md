# Changelog

## 0.1.0
- Initial release. Toolbar readout of RAM, swap, and load average, refreshed on an interval.
- RAM/swap computed from `/proc/meminfo` on Linux (`MemAvailable`-based, matching `free`); approximate `os.freemem()`-based fallback elsewhere, with swap unsupported off Linux.
- Configurable refresh interval (3-60s, default 15s) and warn/critical percent thresholds that color the toolbar readout.
