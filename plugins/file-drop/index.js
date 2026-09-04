const { writeFile, mkdir } = require('fs/promises');
const { tmpdir } = require('os');
const { join, basename, extname } = require('path');
const { randomBytes } = require('crypto');

const DEFAULT_MAX_MB = 25;
const MAX_FILES = 10;

// Screenshots arrive as "Screenshot 2026-09-04 at 10.32.11.png" — spaces break token
// parsing wherever the path ends up, so rename rather than quote. Also strips any
// path separators, so an ingested name can never escape the upload dir.
function safeName(raw) {
  const base = basename(String(raw || '')).replace(/[\\/]/g, '');
  const rawExt = extname(base);
  const cleaned = rawExt.slice(0, 16).replace(/[^A-Za-z0-9.]/g, '');
  // Only keep something that actually looks like an extension — extname('...') is a bare "."
  const ext = /^\.[A-Za-z0-9]+$/.test(cleaned) ? cleaned : '';
  const stem = base.slice(0, base.length - rawExt.length)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 60) || 'file';
  return `${stem}-${randomBytes(4).toString('hex')}${ext}`;
}

module.exports = {
  safeName, // exported for tests

  init(api) {
    const uploadDir = () => {
      const configured = String(api.getSetting('uploadDir') || '').trim();
      return configured || join(tmpdir(), 'clideck-drops');
    };

    api.onFrontendMessage('ingest', async (msg) => {
      const reqId = msg.reqId;
      try {
        if (api.getSetting('enabled') === false) throw new Error('File Drop is disabled');

        const files = Array.isArray(msg.files) ? msg.files.slice(0, MAX_FILES) : [];
        if (!files.length) throw new Error('No files received');

        const maxMb = Number(api.getSetting('maxSizeMb')) || DEFAULT_MAX_MB;
        const maxBytes = maxMb * 1024 * 1024;
        const dir = uploadDir();
        await mkdir(dir, { recursive: true });

        const paths = [];
        for (const f of files) {
          const buf = Buffer.from(String(f.data || ''), 'base64');
          const label = f.name || 'file';
          if (!buf.length) throw new Error(`${label} is empty`);
          if (buf.length > maxBytes) throw new Error(`${label} is larger than ${maxMb}MB`);
          const dest = join(dir, safeName(f.name));
          await writeFile(dest, buf);
          paths.push(dest);
        }

        api.log(`saved ${paths.length} file(s) to ${dir}`);
        api.sendToFrontend('ingested', { reqId, sessionId: msg.sessionId || null, paths });
      } catch (e) {
        api.sendToFrontend('error', { reqId, error: e.message });
      }
    });

    api.onFrontendMessage('getSettings', () => {
      api.sendToFrontend('settings', api.getSettings());
    });
    api.onSettingsChange(() => {
      api.sendToFrontend('settings', api.getSettings());
    });
  }
};
