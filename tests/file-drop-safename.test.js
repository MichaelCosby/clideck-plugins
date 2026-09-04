const test = require('node:test');
const assert = require('node:assert/strict');
const { safeName } = require('../plugins/file-drop');

test('strips spaces so the path needs no quoting downstream', () => {
  const name = safeName('Screenshot 2026-09-04 at 10.32.11.png');
  assert.match(name, /^Screenshot-2026-09-04-at-10\.32\.11-[0-9a-f]{8}\.png$/);
  assert.doesNotMatch(name, /\s/);
});

test('cannot escape the upload directory', () => {
  for (const evil of ['../../etc/passwd', '..\\..\\windows\\system32', '/etc/shadow', '....//x.png']) {
    const name = safeName(evil);
    assert.doesNotMatch(name, /[\\/]/);
    assert.ok(!name.startsWith('.'), `leading dot in ${name}`);
  }
});

test('keeps the extension and always adds a unique suffix', () => {
  assert.match(safeName('a.png'), /^a-[0-9a-f]{8}\.png$/);
  assert.match(safeName('noext'), /^noext-[0-9a-f]{8}$/);
  assert.notEqual(safeName('a.png'), safeName('a.png'));
});

test('falls back to a usable name for degenerate input', () => {
  assert.match(safeName(''), /^file-[0-9a-f]{8}$/);
  assert.match(safeName('...'), /^file-[0-9a-f]{8}$/);
  assert.doesNotMatch(safeName('!@#$%^&*().png'), /[!@#$%^&*()]/);
});
