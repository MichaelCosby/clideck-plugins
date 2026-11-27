# Changelog

## 0.2.1
- The done badge uses the ✅ emoji instead of a plain ✓, so it stands out and is not confused with other plugins’ check marks.

## 0.2.0
- The end-of-turn status-line convention is now a `guide` in the manifest, which CliDeck puts in every agent's instructions as a proper instruction rather than part of a command description (a trial found Haiku ignored it there; Sonnet followed it). Needs a CliDeck that supports manifest `guide` text; older versions ignore it and fall back to the shortened `status/report` description.
- The open-questions badge's glyph carries the count (`?3`, `9+` above nine), so the sidebar shows how many questions a session has, not just that it has some.

## 0.1.0
- First version: self-reported status (open questions, blocked, done) from an end-of-turn `[status: ...]` line or `status/report`, free-form stages with three attention levels (`status/stage`), recorded open questions, `status/stages` and `status/list`, one badge per session, state kept across restarts.
