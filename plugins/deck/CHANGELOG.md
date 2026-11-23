# Changelog

## 0.2.0
- The end-of-turn status-line convention is now a `guide` in the manifest, which CliDeck puts in every agent's instructions as a proper instruction rather than part of a command description (a trial found Haiku ignored it there; Sonnet followed it). Needs a CliDeck that supports manifest `guide` text; older versions ignore it and fall back to the shortened `deck/report` description.
- The open-questions badge's glyph carries the count (`?3`, `9+` above nine), so the sidebar shows how many questions a session has, not just that it has some.

## 0.1.0
- First version: self-reported status (open questions, blocked, done) from an end-of-turn `[deck: ...]` line or `deck/report`, free-form stages with three attention levels (`deck/stage`), recorded open questions, `deck/stages` and `deck/list`, one badge per session, state kept across restarts.
