// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the save archive writer and how imported archive paths map onto Eden's save folders.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readZipEntries, writeZip } from '../web/system-files.js';
import { savePathFor } from '../web/recovery.js';

const files = [
  { name: 'nand/user/save/0000000000000000/0123456789ABCDEF0123456789ABCDEF/010013C00E930000/user1.dat', data: new Uint8Array([1, 2, 3]) },
  { name: 'nand/system/save/8000000000000010/su/avators/profiles.dat', data: new Uint8Array(70_000).map((_, i) => i * 7) },
  { name: 'nand/user/save/empty.bin', data: new Uint8Array() },
];
const zip = writeZip(files);
const file = new File([zip], 'saves.zip');
const entries = await readZipEntries(file);
assert.deepEqual(entries.map(e => e.name), files.map(f => f.name));
for (const [i, entry] of entries.entries()) {
  assert.deepEqual(new Uint8Array(await (await entry.blob()).arrayBuffer()), files[i].data);
}

// The archive must also be valid for other tools (CRCs, headers).
const dir = await mkdtemp(path.join(tmpdir(), 'eden-saves-'));
try {
  const zipPath = path.join(dir, 'saves.zip');
  await writeFile(zipPath, new Uint8Array(await zip.arrayBuffer()));
  execFileSync('unzip', ['-tq', zipPath]);
  execFileSync('unzip', ['-q', zipPath, '-d', path.join(dir, 'out')]);
  assert.deepEqual(new Uint8Array(await readFile(path.join(dir, 'out', files[1].name))), files[1].data);
} finally {
  await rm(dir, { recursive: true, force: true });
}

const profile = '0123456789ABCDEF0123456789ABCDEF';
assert.equal(savePathFor('eden/nand/user/save/0000000000000000/AA/0100F2C0115B6000/progress.sav', profile),
  'nand/user/save/0000000000000000/AA/0100F2C0115B6000/progress.sav');
assert.equal(savePathFor('NAND\\System\\save\\8000000000000010\\su\\avators\\profiles.dat', null),
  'nand/system/save/8000000000000010/su/avators/profiles.dat');
assert.equal(savePathFor('0100f2c0115b6000/slot/0.sav', profile),
  `nand/user/save/0000000000000000/${profile}/0100F2C0115B6000/slot/0.sav`);
assert.equal(savePathFor('__MACOSX/0100F2C0115B6000/._0.sav', profile), null);
assert.equal(savePathFor('0100F2C0115B6000/.DS_Store', profile), null);
assert.equal(savePathFor('readme.txt', profile), null);
assert.throws(() => savePathFor('0100F2C0115B6000/../../keys/prod.keys', profile), /unsafe/);
assert.throws(() => savePathFor('0100F2C0115B6000/0.sav', undefined), /No user profile/);

console.log('save archives OK');
