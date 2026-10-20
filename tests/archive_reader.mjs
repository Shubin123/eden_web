// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the libarchive decoder (web/runtime/eden_archive.js) against archives made with bsdtar
// and xz. Formats whose tool is missing are skipped.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readSync, fstatSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../web/runtime/eden_archive.js', import.meta.url));
assert.ok(existsSync(runtime), 'missing web/runtime/eden_archive.js (run npm run sync)');
const { default: createEdenArchive } = await import(runtime);

const has = (tool) => {
  try { execFileSync(tool, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
};

let fd = -1;
const mod = await createEdenArchive({
  readAt(offset, ptr, length) { return readSync(fd, mod.HEAPU8, ptr, length, offset); },
});

// Returns [{ name, data }] for every regular file in the archive.
function extract(file) {
  fd = openSync(file, 'r');
  const reader = mod._ea_open(fstatSync(fd).size);
  const buffer = mod._malloc(1 << 20);
  const files = [];
  try {
    for (;;) {
      const status = mod._ea_next(reader);
      if (status < 0) throw new Error(mod.UTF8ToString(mod._ea_error(reader)));
      if (status === 0) break;
      if (!mod._ea_entry_is_file(reader)) continue;
      const parts = [];
      for (let n; (n = mod._ea_read(reader, buffer, 1 << 20)) > 0;) {
        parts.push(Buffer.from(mod.HEAPU8.subarray(buffer, buffer + n)));
      }
      files.push({ name: mod.UTF8ToString(mod._ea_entry_name(reader)), data: Buffer.concat(parts) });
    }
  } finally {
    mod._ea_close(reader);
    mod._free(buffer);
    closeSync(fd);
  }
  return files;
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'eden-archive-'));
try {
  const rom = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 2654435761) >>> 24;
  writeFileSync(path.join(dir, 'game.nsp'), rom);
  writeFileSync(path.join(dir, 'prod.keys'), 'header_key = 00\n');

  const cases = [];
  if (has('bsdtar')) {
    for (const [ext, args] of [
      ['7z', ['--format', '7zip']],
      ['zip', ['--format', 'zip']],
      ['tar', []],
      ['tar.gz', ['-z']],
      ['tar.bz2', ['-j']],
      ['tar.xz', ['-J']],
      ['tar.zst', ['--zstd']],
    ]) {
      cases.push([ext, () => execFileSync('bsdtar', ['-cf', `a.${ext}`, ...args, 'game.nsp', 'prod.keys'], { cwd: dir })]);
    }
  }
  if (has('xz')) {
    cases.push(['nsp.xz (raw)', () => execFileSync('xz', ['-kf', 'game.nsp'], { cwd: dir })]);
  }
  assert.ok(cases.length > 0, 'bsdtar or xz is needed to build test archives');

  for (const [label, make] of cases) {
    make();
    const file = label.endsWith('(raw)') ? 'game.nsp.xz' : `a.${label}`;
    const files = extract(path.join(dir, file));
    const game = label.endsWith('(raw)') ? files[0] : files.find(f => f.name === 'game.nsp');
    assert.ok(game, `${label}: game.nsp not found`);
    assert.ok(game.data.equals(rom), `${label}: extracted game differs`);
    console.log(`ok ${label}`);
  }

  // A file that is not an archive is read as a raw stream, never as an error.
  writeFileSync(path.join(dir, 'plain.bin'), 'not an archive');
  assert.equal(extract(path.join(dir, 'plain.bin'))[0].data.toString(), 'not an archive');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('Archive decoder test passed.');
