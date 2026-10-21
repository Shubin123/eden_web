// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { mountRom } from '../web/rom-file.js';

const block = 4 * 1024 * 1024;
const input = Uint8Array.from({ length: block * 2 + 19 }, (_, i) => i * 13 % 251);
const FS = {
  ErrnoError: class extends Error {},
  create() { return this.node = { stream_ops: {}, node_ops: {} }; },
};
const rom = (parts, size = input.length) => ({
  name: 'game.nsp', size,
  stream: async () => new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } }),
});
for (const parts of [
  [input],
  [input.subarray(0, block), input.subarray(block, block * 2), input.subarray(block * 2)],
  [input.subarray(0, 17), input.subarray(17, block + 9), input.subarray(block + 9)],
]) {
  let progress = 0;
  assert.equal(await mountRom(FS, '/roms/game.nsp', rom(parts), n => { progress = n; }), input.length);
  assert.equal(FS.node.usedBytes, input.length);
  assert.equal(progress, input.length);
  for (const [position, length] of [[0, 73], [block - 5, 18], [block * 2 - 8, 50], [input.length, 11], [input.length + 9, 5]]) {
    const target = new Uint8Array(length + 4).fill(255);
    const n = FS.node.stream_ops.read(null, target, 2, length, position);
    assert.deepEqual(target.subarray(2, 2 + n), input.subarray(position, position + length));
    assert.equal(n, Math.max(0, Math.min(length, input.length - position)));
    assert.equal(target[1], 255);
    assert.equal(target[2 + n], 255);
  }
  assert.throws(() => FS.node.stream_ops.write(), FS.ErrnoError);
}
await assert.rejects(mountRom(FS, '/roms/bad.nsp', rom([input], input.length + 1)), /truncated/);
let cancelled = false;
const failure = { name: 'bad.nsp', size: -1, stream: async () => new ReadableStream({
  pull(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; },
}) };
await assert.rejects(mountRom(FS, '/roms/bad.nsp', failure, () => { throw new Error('write failure'); }), /write failure/);
assert.equal(cancelled, true);
console.log('ROM block reads, boundaries, EOF, truncation and cancellation OK');
