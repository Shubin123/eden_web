// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the libarchive decoder (runtime/eden_archive.js) off the main thread. The archive is read
// on demand with FileReaderSync and the chosen entry is handed out in chunks as the page pulls
// them, so neither the archive nor the game has to fit in memory.

import createEdenArchive from './runtime/eden_archive.js';

const CHUNK_SIZE = 4 * 1024 * 1024;

let file = null;
const fileReader = new FileReaderSync();
const mod = await createEdenArchive({
  readAt(offset, ptr, length) {
    try {
      const data = fileReader.readAsArrayBuffer(file.slice(offset, offset + length));
      mod.HEAPU8.set(new Uint8Array(data), ptr);
      return data.byteLength;
    } catch (err) {
      console.error('Archive read failed:', err);
      return -1;
    }
  },
});

let reader = 0;
let buffer = 0;

function close() {
  if (reader) mod._ea_close(reader);
  if (buffer) mod._free(buffer);
  reader = 0;
  buffer = 0;
}

function error() {
  return mod.UTF8ToString(mod._ea_error(reader));
}

// Copies up to `limit` bytes of the current entry; a shorter result means the entry ended.
function readChunk(limit) {
  const out = new Uint8Array(limit);
  let filled = 0;
  while (filled < limit) {
    const n = mod._ea_read(reader, buffer, Math.min(CHUNK_SIZE, limit - filled));
    if (n < 0) throw new Error(error());
    if (n === 0) break;
    out.set(mod.HEAPU8.subarray(buffer, buffer + n), filled);
    filled += n;
  }
  return filled === limit ? out : out.slice(0, filled);
}

function matches(name, extensions) {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext));
}

// A raw compressed stream such as game.nsp.xz has a single entry called "data".
function entryName(name) {
  if (name !== 'data' || !mod.UTF8ToString(mod._ea_format(reader)).startsWith('raw')) {
    return name;
  }
  return file.name.replace(/\.[^.]+$/, '');
}

function scan({ romExtensions, systemExtensions }) {
  reader = mod._ea_open(file.size);
  buffer = mod._malloc(CHUNK_SIZE);
  const system = [];
  for (;;) {
    const status = mod._ea_next(reader);
    if (status < 0) throw new Error(error());
    if (status === 0) break;
    if (!mod._ea_entry_is_file(reader)) continue;
    const name = entryName(mod.UTF8ToString(mod._ea_entry_name(reader)));
    if (matches(name, romExtensions)) {
      // Leave the reader on this entry; the page pulls its data next.
      postMessage({ type: 'rom', name, size: mod._ea_entry_size(reader) });
      return;
    }
    if (matches(name, systemExtensions)) {
      const parts = [];
      for (let part; (part = readChunk(CHUNK_SIZE)).length > 0;) parts.push(part);
      system.push({ name, blob: new Blob(parts) });
    }
  }
  close();
  postMessage({ type: 'system', entries: system });
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'open') {
      file = data.file;
      scan(data);
    } else if (data.type === 'pull') {
      const chunk = readChunk(CHUNK_SIZE);
      if (chunk.length === 0) close();
      postMessage({ type: 'chunk', data: chunk }, [chunk.buffer]);
    } else if (data.type === 'close') {
      close();
    }
  } catch (err) {
    close();
    postMessage({ type: 'error', message: err.message });
  }
};

postMessage({ type: 'ready' });
