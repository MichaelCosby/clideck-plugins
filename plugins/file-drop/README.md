# file-drop

A [CliDeck](https://github.com/MichaelCosby/clideck) plugin that gets a screenshot in front of an agent: drop it on a session, paste it, or pick it from a file dialog. The file is uploaded to the **server**, and its path is inserted at the cursor so you can type around it.

Built for the case where the browser is on a different machine than the clideck server. A local clipboard path would be meaningless to the agent; this uploads the bytes and hands back a path the agent can actually read.

## How it works

- **Three ways in.** Drop a file anywhere in the window, paste an image from the clipboard, or use the paperclip button next to the terminal input. All three go through the same upload path.
- **Aiming.** A drop onto a session row in the sidebar goes to *that* session, so you can send a screenshot to a background agent without switching to it. Dropping on the terminal, pasting, and the paperclip all target the active session.
- **Stopped sessions are refused.** A stopped session's row is `.resumable-row`, not `.session-row`; without an explicit check the drop would fall through to the active session and quietly land in a different agent. It shows `dropEffect: none` on hover and a toast on drop.
- **Insertion never submits.** The path is written with a trailing space and no newline — a stray `\r` would send the prompt mid-sentence, which breaks the main use case of typing "look at the screenshot at ⟨drop⟩ and…".
- **Pasting text is left alone.** The paste handler runs in the capture phase but bails whenever the clipboard carries any text, so ordinary pasting into the terminal is untouched. Only an image-only clipboard is intercepted.
- **Filenames are rewritten** on ingest — see below.
- **No target session?** The path goes to your clipboard instead, with a toast.

## Filenames

Uploads are renamed to `<stem>-<8 hex><ext>`:

| Dropped | Written |
|---|---|
| `Screenshot 2026-09-04 at 10.32.11.png` | `Screenshot-2026-09-04-at-10.32.11-7d1dce04.png` |
| `../../etc/passwd` | `passwd-630682e1` |
| pasted image | `pasted-20260904T175701-b16a3447.png` |

Two reasons. **Spaces are removed** so the inserted path never needs quoting — that is what lets it sit bare in a prompt. And **only the basename survives**, so an upload cannot escape the upload directory no matter what the browser sends. The random suffix means repeated drops never collide (and never dedup — they accumulate).

Non-ASCII characters are dropped rather than transliterated (`café.png` → `caf-<hex>.png`), and multi-part extensions split on the last dot (`foo.tar.gz` → `foo.tar-<hex>.gz`).

## Install

In CliDeck's Plugins panel:

```
MichaelCosby/clideck-plugins/plugins/file-drop
```

## Settings

- **Enabled** — turns off drop, paste, and the paperclip button (default on)
- **Upload Directory** — server-side destination. Blank uses `clideck-drops` under the system temp dir, which is cleared on reboot; point it somewhere persistent if you want paths in old transcripts to keep resolving.
- **Max File Size (MB)** — rejected client- and server-side (default 25, max 200)

At most 10 files per drop; extras are dropped with a warning.

## Tests

From the repo root, with a clideck checkout as a sibling directory (or `CLIDECK_REPO` set):

```sh
node --test tests/file-drop-safename.test.js   # filename sanitization
python3 tests/file-drop.browser.py             # end-to-end, needs Playwright
```

The browser test boots a real clideck server against a throwaway `HOME`, installs this plugin into it, and drives Chromium. It asserts on the `input` websocket frames the page sends rather than on shell echo, so it checks the exact contract — right session, right path, no newline. Both skip cleanly if their prerequisites are missing.
