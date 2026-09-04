# Changelog

## 0.1.0
- Initial release. Upload a screenshot or file to the clideck server and insert its path at the cursor, via drag-and-drop, clipboard paste, or a paperclip button next to the terminal input.
- Dropping on a sidebar session row targets that session, so a screenshot can be sent to a background agent without switching to it; dropping on the terminal, pasting, and the paperclip target the active session.
- Drops onto a stopped (resumable) session are refused with a toast and `dropEffect: none`, rather than silently falling through to whichever session is active.
- Paths are inserted with a trailing space and never a newline, so the prompt is not submitted mid-sentence.
- Paste is intercepted only when the clipboard carries no text; ordinary text pastes are left to the terminal. Pasted images are named `pasted-<timestamp>`.
- Uploads are renamed to strip spaces (no quoting needed downstream) and reduced to their basename (an upload cannot escape the upload directory), with a random suffix to avoid collisions.
- Configurable upload directory (default `clideck-drops` under the system temp dir), max file size (default 25MB), and an enable toggle. Limit of 10 files per drop.
- Falls back to copying the path to the clipboard when there is no session to insert into.
