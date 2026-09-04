const MAX_FILES = 10;
const PAPERCLIP = '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

let _api = null;
let enabled = true;
let maxMb = 25;
let attachBtn = null;
let hoverEl = null;
let picker = null;
let pickerSession = null;
const pending = new Map(); // reqId → { sessionId } for uploads this client started

function hasFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

// Sidebar rows carry the session id; anywhere else (the terminal itself) falls
// through to whichever session is active.
function sessionRow(target) {
  return target?.closest?.('.session-row') || null;
}

// A stopped session's row is .resumable-row, which has no live pty behind it.
// Without this it would miss .session-row and silently land in whichever
// session happens to be active — a different agent than the one aimed at.
function isStoppedRow(target) {
  return !!target?.closest?.('.resumable-row');
}

function setHover(el) {
  if (hoverEl === el) return;
  hoverEl?.classList.remove('file-drop-target');
  hoverEl = el;
  hoverEl?.classList.add('file-drop-target');
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error(`Could not read ${file.name}`));
    fr.onload = () => {
      const s = String(fr.result);
      const comma = s.indexOf(',');
      resolve(comma === -1 ? '' : s.slice(comma + 1));
    };
    fr.readAsDataURL(file);
  });
}

// Clipboard images arrive as "image.png" (or unnamed), so give them something
// that says where they came from and when.
function pastedName(file, i) {
  const ext = (String(file.type || '').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `pasted-${stamp}${i ? `-${i}` : ''}.${ext}`;
}

async function ingest(fileList, sessionId, nameFor) {
  if (!enabled) return;
  const all = Array.from(fileList || []);
  const files = all.slice(0, MAX_FILES);
  if (!files.length) return;
  if (all.length > MAX_FILES) {
    // Distinct id — the "Uploading…" toast below would otherwise replace it immediately
    _api.toast(`Only the first ${MAX_FILES} files will be uploaded`, { type: 'warn', id: 'file-drop-warn' });
  }

  const tooBig = files.find(f => f.size > maxMb * 1024 * 1024);
  if (tooBig) {
    _api.toast(`${tooBig.name} is larger than ${maxMb}MB`, { type: 'warn', id: 'file-drop' });
    return;
  }

  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pending.set(reqId, { sessionId: sessionId || null });
  _api.toast(files.length > 1 ? `Uploading ${files.length} files…` : `Uploading ${files[0].name}…`, { id: 'file-drop' });

  try {
    const payload = [];
    for (const [i, f] of files.entries()) {
      payload.push({ name: nameFor ? nameFor(f, i) : f.name, data: await readAsBase64(f) });
    }
    _api.send('ingest', { reqId, sessionId: sessionId || null, files: payload });
  } catch (e) {
    pending.delete(reqId);
    _api.toast(e.message, { type: 'error', id: 'file-drop' });
  }
}

async function onIngested(msg) {
  const req = pending.get(msg.reqId);
  if (!req) return; // an upload from another connected client
  pending.delete(msg.reqId);

  const paths = msg.paths || [];
  if (!paths.length) return;
  const joined = paths.join(' ');

  const sid = req.sessionId || _api.getActiveSessionId();
  if (sid) {
    // Trailing space, never a newline — a stray \r would submit the prompt mid-sentence.
    _api.writeToSession(sid, `${joined} `);
    _api.toast(paths.length > 1 ? `Inserted ${paths.length} paths` : 'Path inserted', { type: 'success', id: 'file-drop' });
    return;
  }

  try {
    await navigator.clipboard.writeText(joined);
    _api.toast('No active session — path copied to clipboard', { type: 'success', id: 'file-drop' });
  } catch {
    _api.toast(joined, { type: 'info', duration: 8000 });
  }
}

function installStyles() {
  const style = document.createElement('style');
  style.textContent = `
.session-row.file-drop-target {
  outline: 2px solid var(--color-accent, #6366f1);
  outline-offset: -2px;
  border-radius: 6px;
}`;
  document.head.appendChild(style);
}

function installDropHandlers() {
  document.addEventListener('dragover', (e) => {
    if (!enabled || !hasFiles(e)) return;
    e.preventDefault();
    const stopped = isStoppedRow(e.target);
    if (e.dataTransfer) e.dataTransfer.dropEffect = stopped ? 'none' : 'copy';
    setHover(stopped ? null : sessionRow(e.target));
  });

  // relatedTarget is null when the pointer leaves the window entirely
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) setHover(null);
  });
  document.addEventListener('dragend', () => setHover(null));

  document.addEventListener('drop', (e) => {
    if (!enabled || !hasFiles(e)) return;
    e.preventDefault();
    setHover(null);
    if (isStoppedRow(e.target)) {
      _api.toast('Resume that session before dropping files onto it', { type: 'warn', id: 'file-drop' });
      return;
    }
    const row = sessionRow(e.target);
    ingest(e.dataTransfer.files, row?.dataset.id || _api.getActiveSessionId());
  });
}

function clipboardFiles(data) {
  if (!data) return [];
  const files = Array.from(data.files || []);
  if (files.length) return files;
  return Array.from(data.items || [])
    .filter(it => it.kind === 'file')
    .map(it => it.getAsFile())
    .filter(Boolean);
}

function installPasteHandler() {
  // Capture phase so we settle this before xterm's textarea handler runs.
  document.addEventListener('paste', (e) => {
    if (!enabled) return;
    // Any text on the clipboard means it's a normal paste — leave xterm alone.
    if (e.clipboardData?.getData('text/plain')) return;
    const files = clipboardFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    ingest(files, _api.getActiveSessionId(), pastedName);
  }, true);
}

function installPicker() {
  picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.style.display = 'none';
  picker.addEventListener('change', () => {
    if (picker.files?.length) ingest(picker.files, pickerSession || _api.getActiveSessionId());
    picker.value = '';
    pickerSession = null;
  });
  document.body.appendChild(picker);
}

export function init(api) {
  _api = api;

  api.onMessage('settings', (msg) => {
    enabled = msg.enabled !== false;
    maxMb = Number(msg.maxSizeMb) || 25;
    attachBtn?.setVisible(enabled);
    if (!enabled) setHover(null);
  });
  api.onMessage('error', (msg) => {
    // Broadcast reaches every connected client; only surface our own failures
    if (!pending.has(msg.reqId)) return;
    pending.delete(msg.reqId);
    api.toast(msg.error || 'Upload failed', { type: 'error', id: 'file-drop' });
  });
  api.onMessage('ingested', onIngested);
  api.send('getSettings');

  installStyles();
  installDropHandlers();
  installPasteHandler();
  installPicker();

  attachBtn = api.addTerminalInputButton({
    id: 'attach',
    title: 'Attach file…',
    icon: PAPERCLIP,
    onClick(sessionId) {
      pickerSession = sessionId;
      picker.click();
    },
  });
  // Settings may have arrived before the button existed
  attachBtn.setVisible(enabled);
}
