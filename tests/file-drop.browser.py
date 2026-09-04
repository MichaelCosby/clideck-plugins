#!/usr/bin/env python3
"""Browser smoke test for the File Drop plugin.

Boots a real clideck server against an isolated HOME, drives Chromium, and
asserts on the `input` frames the page sends over its websocket — that is the
actual contract (right session id, right path, no newline), and it avoids
depending on shell echo timing.

Needs a clideck checkout to run the server from: set CLIDECK_REPO, or keep one
as a sibling directory (../clideck). The plugin is copied into the throwaway
HOME's plugin dir, so it is exercised exactly as an installed plugin.

Run: python3 tests/file-drop.browser.py
Skips (exit 0) if Playwright or the clideck checkout is unavailable.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_SRC = HERE.parent / "plugins" / "file-drop"
REPO = Path(os.environ.get("CLIDECK_REPO") or HERE.parent.parent / "clideck")
PNG = [137, 80, 78, 71, 13, 10, 26, 10]
DROP_NAME = "Test Shot 2026-09-04 at 10.32.11.png"

if not (REPO / "server.js").is_file():
    print(f"SKIP: no clideck checkout at {REPO} (set CLIDECK_REPO)")
    sys.exit(0)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP: playwright not installed (pip install playwright)")
    sys.exit(0)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_server(port, proc, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early (code {proc.returncode})")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("server did not become ready")


class Checks:
    def __init__(self):
        self.failures = []
        self.passes = 0

    def check(self, ok, label, detail=""):
        if ok:
            self.passes += 1
            print(f"  ok  {label}")
        else:
            self.failures.append(label)
            print(f"  FAIL {label}{(' — ' + detail) if detail else ''}")

    def eq(self, actual, expected, label):
        self.check(actual == expected, label, f"got {actual!r}, want {expected!r}")


def main():
    port = free_port()
    home = tempfile.mkdtemp(prefix="clideck-test-home-")
    uploads = tempfile.mkdtemp(prefix="clideck-test-uploads-")
    # Install the plugin the way a user would, into the throwaway HOME
    shutil.copytree(PLUGIN_SRC, Path(home) / ".clideck" / "plugins" / "file-drop")
    env = {**os.environ, "HOME": home, "CLIDECK_PORT": str(port)}
    proc = subprocess.Popen(
        ["node", "server.js"], cwd=REPO, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    c = Checks()

    try:
        wait_for_server(port, proc)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 900})

            sent = []
            page.on("websocket", lambda ws: ws.on("framesent", lambda f: sent.append(f)))

            def inputs():
                out = []
                for f in sent:
                    try:
                        m = json.loads(f)
                    except Exception:
                        continue
                    if m.get("type") == "input":
                        out.append(m)
                return out

            def next_input(before, timeout=10):
                deadline = time.time() + timeout
                while time.time() < deadline:
                    got = inputs()
                    if len(got) > before:
                        return got[before]
                    page.wait_for_timeout(100)
                raise AssertionError("no input frame was sent")

            page.goto(f"http://127.0.0.1:{port}/", wait_until="domcontentloaded")
            page.wait_for_selector("#session-list", timeout=15000)
            # First-run "agent needs setup" toasts sit over the sidebar and eat clicks
            page.add_style_tag(content="#tmx-toasts { pointer-events: none !important; }")

            # Control channel: create sessions and point the plugin at a temp upload dir
            page.evaluate(
                """async ({ uploads }) => {
                  const ws = new WebSocket(`ws://${location.host}`);
                  await new Promise(r => ws.addEventListener('open', r, { once: true }));
                  ws.send(JSON.stringify({ type: 'plugin.settings.update',
                    pluginId: 'file-drop', key: 'uploadDir', value: uploads }));
                  ws.send(JSON.stringify({ type: 'create', name: 'alpha' }));
                  await new Promise(r => setTimeout(r, 400));
                  ws.send(JSON.stringify({ type: 'create', name: 'beta' }));
                  await new Promise(r => setTimeout(r, 400));
                  window.__ctl = ws;
                }""",
                {"uploads": uploads},
            )
            page.wait_for_function("document.querySelectorAll('.session-row').length >= 2", timeout=15000)

            rows = page.eval_on_selector_all(
                ".session-row",
                "els => els.map(e => ({ id: e.dataset.id, name: e.querySelector('.name')?.textContent }))",
            )
            c.check(len(rows) >= 2, "two sessions exist", f"rows={rows}")

            # Make the first row active; the second is our background target.
            page.click(f'.session-row[data-id="{rows[0]["id"]}"]')
            page.wait_for_selector(".term-wrap.active", timeout=10000)
            active_id, background_id = rows[0]["id"], rows[1]["id"]

            def make_dt():
                return page.evaluate_handle(
                    """({ bytes, name }) => {
                        const dt = new DataTransfer();
                        dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
                        return dt;
                    }""",
                    {"bytes": PNG, "name": DROP_NAME},
                )

            # --- 1. drop on the terminal -> active session ---
            before = len(inputs())
            page.dispatch_event(".term-wrap.active", "drop", {"dataTransfer": make_dt()})
            msg = next_input(before)
            c.eq(msg["id"], active_id, "drop on terminal routes to the active session")
            path1 = msg["data"].strip()
            c.check(msg["data"].endswith(" "), "insertion ends with a space")
            c.check("\r" not in msg["data"] and "\n" not in msg["data"],
                    "insertion contains no newline", repr(msg["data"]))
            c.check(" " not in path1, "inserted path has no spaces", path1)
            c.check(path1.startswith(uploads), "file landed in the configured upload dir", path1)
            c.check(Path(path1).is_file(), "file exists on disk", path1)
            if Path(path1).is_file():
                c.eq(list(Path(path1).read_bytes()), PNG, "bytes survive the round trip")

            focused = page.evaluate(
                "() => { const a = document.activeElement; return a ? a.tagName + '/' + a.className : 'none'; }"
            )
            c.check("xterm" in focused.lower() or focused.startswith("TEXTAREA"),
                    "focus stays in the terminal after a drop", focused)

            # --- 2. drop on a background session row ---
            before = len(inputs())
            page.dispatch_event(f'.session-row[data-id="{background_id}"]', "drop", {"dataTransfer": make_dt()})
            msg = next_input(before)
            c.eq(msg["id"], background_id, "drop on a background row routes to that session")
            c.check(page.evaluate(f"() => document.querySelector('.session-row[data-id=\"{active_id}\"]')"
                                  ".classList.contains('active-session')"),
                    "background drop does not steal the active session")

            # --- 3. drop on a stopped (resumable) session is refused ---
            # A real resumable row needs an agent session token, which a smoke test
            # can't produce, so mirror the markup the app builds (terminals.js:1380).
            page.evaluate(
                """() => {
                  const row = document.createElement('div');
                  row.className = 'group resumable-row flex items-center gap-2 px-2.5 py-2';
                  row.dataset.resumableId = 'stopped-1';
                  row.innerHTML = '<span class="resumable-name">gamma</span>';
                  document.getElementById('session-list').appendChild(row);
                }"""
            )
            files_before = len(list(Path(uploads).iterdir()))
            before = len(inputs())
            page.dispatch_event('.resumable-row[data-resumable-id="stopped-1"]', "drop",
                                {"dataTransfer": make_dt()})
            page.wait_for_timeout(1500)
            c.eq(len(inputs()), before, "drop on a stopped session sends no input")
            c.eq(len(list(Path(uploads).iterdir())), files_before,
                 "drop on a stopped session uploads nothing")
            toast = page.evaluate("() => document.getElementById('tmx-toasts')?.innerText || ''")
            c.check("Resume" in toast, "stopped drop explains why it was refused", repr(toast[:120]))

            # --- 4. pasting an image uploads it; pasting text does not ---
            def paste(js_items):
                page.evaluate(
                    """({ bytes, items }) => {
                        const dt = new DataTransfer();
                        for (const it of items) {
                          if (it.kind === 'text') dt.setData('text/plain', it.value);
                          else dt.items.add(new File([new Uint8Array(bytes)], it.value,
                                                     { type: 'image/png' }));
                        }
                        document.querySelector('.term-wrap.active').dispatchEvent(
                          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                    }""",
                    {"bytes": PNG, "items": js_items},
                )

            before = len(inputs())
            paste([{"kind": "file", "value": "image.png"}])
            msg = next_input(before)
            c.eq(msg["id"], active_id, "pasted image goes to the active session")
            pasted = msg["data"].strip()
            c.check(Path(pasted).name.startswith("pasted-"),
                    "pasted image gets a pasted-* name", Path(pasted).name)
            c.check(Path(pasted).is_file(), "pasted image lands on disk", pasted)

            files_before = len(list(Path(uploads).iterdir()))
            before = len(inputs())
            paste([{"kind": "text", "value": "just some text"}])
            page.wait_for_timeout(1200)
            c.eq(len(inputs()), before, "pasting text is left to the terminal")
            c.eq(len(list(Path(uploads).iterdir())), files_before, "pasting text uploads nothing")

            # --- 5. paperclip button opens a picker and inserts ---
            picked = Path(uploads) / "picked shot.png"
            picked.write_bytes(bytes(PNG))
            btn = '.terminal-input-action[data-plugin-id="file-drop"]'
            c.check(page.locator(btn).count() > 0, "paperclip button is registered")
            before = len(inputs())
            with page.expect_file_chooser() as fc:
                # dispatch rather than click: xterm's screen layer overlaps the button
                page.dispatch_event(btn, "click")
            fc.value.set_files(str(picked))
            msg = next_input(before)
            c.eq(msg["id"], active_id, "picker inserts into the active session")
            c.check(" " not in msg["data"].strip(), "picked path has no spaces", msg["data"])

            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(uploads, ignore_errors=True)

    print(f"\n{c.passes} passed, {len(c.failures)} failed")
    if c.failures:
        for f in c.failures:
            print(f"  - {f}")
        sys.exit(1)


if __name__ == "__main__":
    main()
