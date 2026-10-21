// SPDX-License-Identifier: GPL-3.0-or-later

const BLOCK_BYTES = 4 * 1024 * 1024;

// MEMFS grows contiguous arrays and repeatedly copies the entire game. Keep ROMs in
// fixed blocks instead; native fread/pread still use the normal Emscripten FS path.
export async function mountRom(FS, path, rom, onProgress = () => {}) {
  const blocks = [];
  const reader = (await rom.stream()).getReader();
  let bytes = 0;
  let filled = 0;
  let block;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length;) {
        if (!filled && value.length - offset === BLOCK_BYTES) {
          blocks.push(value.subarray(offset));
          bytes += BLOCK_BYTES;
          offset += BLOCK_BYTES;
        } else {
          block ??= new Uint8Array(BLOCK_BYTES);
          const n = Math.min(value.length - offset, BLOCK_BYTES - filled);
          block.set(value.subarray(offset, offset + n), filled);
          filled += n;
          bytes += n;
          offset += n;
          if (filled === BLOCK_BYTES) {
            blocks.push(block);
            block = undefined;
            filled = 0;
          }
        }
      }
      onProgress(bytes);
    }
    if (rom.size >= 0 && bytes !== rom.size) {
      throw new Error(`${rom.name} is truncated (${bytes} of ${rom.size} bytes)`);
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  if (filled) blocks.push(block.subarray(0, filled));

  const node = FS.create(path, 0o444);
  node.usedBytes = bytes;
  const readOnly = () => { throw new FS.ErrnoError(63); }; // EPERM
  node.stream_ops = {
    ...node.stream_ops,
    read(_stream, target, offset, length, position) {
      const count = Math.max(0, Math.min(length, bytes - position));
      let copied = 0;
      while (copied < count) {
        const index = Math.floor(position / BLOCK_BYTES);
        const start = position % BLOCK_BYTES;
        const n = Math.min(count - copied, blocks[index].length - start);
        target.set(blocks[index].subarray(start, start + n), offset + copied);
        copied += n;
        position += n;
      }
      return count;
    },
    write: readOnly,
    allocate: readOnly,
    mmap() { throw new FS.ErrnoError(43); }, // ENODEV: this file supports reads only.
    msync: readOnly,
  };
  node.node_ops = { ...node.node_ops, setattr: readOnly };
  return bytes;
}
