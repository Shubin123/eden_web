// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the ZIP reader used for ROM and system file imports against stored, deflated and
// ZIP64 archives built in memory.

import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { readZipEntries } from '../web/system-files.js';

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

// Writes an archive; with zip64 set every size and offset goes through the ZIP64 records.
function buildZip(files, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, deflate } of files) {
    const nameBytes = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(45), u16(0), u16(method), u32(0), u32(crc),
      u32(body.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    const extra = zip64
      ? Buffer.concat([u16(0x0001), u16(24), u64(data.length), u64(body.length), u64(offset)])
      : Buffer.alloc(0);
    const sat = v => (zip64 ? 0xffffffff : v);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(45), u16(45), u16(0), u16(method), u32(0), u32(crc),
      u32(sat(body.length)), u32(sat(data.length)), u16(nameBytes.length), u16(extra.length),
      u16(0), u16(0), u16(0), u32(0), u32(sat(offset)), nameBytes, extra,
    ]));
    parts.push(local, body);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const cdOffset = offset;
  parts.push(cd);
  if (zip64) {
    const eocd64Offset = cdOffset + cd.length;
    parts.push(
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(files.length), u64(files.length), u64(cd.length), u64(cdOffset),
      u32(0x07064b50), u32(0), u64(eocd64Offset), u32(1));
  }
  const sat16 = v => (zip64 ? 0xffff : v);
  const sat32 = v => (zip64 ? 0xffffffff : v);
  parts.push(u32(0x06054b50), u16(0), u16(0), u16(sat16(files.length)), u16(sat16(files.length)),
    u32(sat32(cd.length)), u32(sat32(cdOffset)), u16(0));
  return new File([Buffer.concat(parts)], 'test.zip');
}

async function readAll(entry) {
  const chunks = [];
  for await (const chunk of await entry.stream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const rom = Buffer.alloc(300000);
for (let i = 0; i < rom.length; i++) rom[i] = (i * 31) ^ (i >> 7);
const keys = Buffer.from('header_key = 00\n');

for (const zip64 of [false, true]) {
  for (const deflate of [false, true]) {
    const zip = buildZip([
      { name: 'Game/', data: Buffer.alloc(0) },
      { name: 'Game/title.nsp', data: rom, deflate },
      { name: 'prod.keys', data: keys, deflate },
    ], { zip64 });
    const label = `${zip64 ? 'zip64' : 'zip'} ${deflate ? 'deflate' : 'stored'}`;
    const entries = await readZipEntries(zip);
    assert.deepEqual(entries.map(e => e.name), ['Game/title.nsp', 'prod.keys'], label);
    assert.equal(entries[0].size, rom.length, label);
    assert.ok((await readAll(entries[0])).equals(rom), `${label}: streamed ROM differs`);
    const blob = await entries[1].blob();
    assert.ok(Buffer.from(await blob.arrayBuffer()).equals(keys), `${label}: keys blob differs`);
  }
}

await assert.rejects(readZipEntries(new File([rom], 'game.zip')), /not a ZIP archive/);

console.log('ZIP reader test passed.');
