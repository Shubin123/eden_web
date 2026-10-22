// SPDX-License-Identifier: GPL-3.0-or-later
// Persists user-supplied Switch keys and firmware in IndexedDB and mounts them into the
// Emscripten filesystem at the locations Eden expects.

import { isArchive, openArchive } from './archive.js';

export const EDEN_DATA_ROOT = '/home/web_user/.local/share/eden';

const KEYS_PREFIX = 'keys/';
const FIRMWARE_PREFIX = 'nand/system/Contents/registered/';
const META_FIRMWARE = 'meta/firmware';

const DB_NAME = 'eden-system-files';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function allEntries() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys()),
    requestResult(store.getAll()),
  ]);
  db.close();
  return keys.map((key, i) => [key, values[i]]);
}

async function deletePrefix(prefix) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const range = IDBKeyRange.bound(prefix, prefix + '￿');
  store.delete(range);
  await done(tx);
  db.close();
}

async function putAll(records) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const [key, value] of records) {
    store.put(value, key);
  }
  await done(tx);
  db.close();
}

// Minimal ZIP reader: walks the central directory and returns lazily-sliced entries. Firmware
// dumps are usually stored uncompressed, so those entries are plain Blob slices of the source.
// ZIP64 is supported since XCI dumps commonly exceed 4 GiB.
export async function readZipEntries(file) {
  const tailSize = Math.min(file.size, 0x10000 + 22);
  const tailStart = file.size - tailSize;
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`${file.name} is not a ZIP archive`);
  }
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const eocd64Offset = Number(tail.getBigUint64(eocd - 12, true));
    const eocd64 = new DataView(await file.slice(eocd64Offset, eocd64Offset + 56).arrayBuffer());
    if (eocd64.getUint32(0, true) !== 0x06064b50) {
      throw new Error(`${file.name} has a corrupt ZIP64 directory`);
    }
    count = Number(eocd64.getBigUint64(32, true));
    cdSize = Number(eocd64.getBigUint64(40, true));
    cdOffset = Number(eocd64.getBigUint64(48, true));
  }

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) {
      throw new Error(`${file.name} has a corrupt central directory`);
    }
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLength = cd.getUint16(p + 28, true);
    const extraLength = cd.getUint16(p + 30, true);
    const commentLength = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLength));

    // The ZIP64 extra field holds, in order, only the values whose header field is saturated.
    for (let x = p + 46 + nameLength; x + 4 <= p + 46 + nameLength + extraLength;) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        const next = () => { const v = Number(cd.getBigUint64(q, true)); q += 8; return v; };
        if (size === 0xffffffff) size = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localOffset === 0xffffffff) localOffset = next();
      }
      x += 4 + len;
    }

    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) {
      continue;
    }
    entries.push({ name, method, compressedSize, size, localOffset });
  }

  return entries.map(entry => {
    async function raw() {
      const header = new DataView(
        await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
      const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
      return file.slice(start, start + entry.compressedSize);
    }
    async function stream() {
      const data = await raw();
      if (entry.method === 0) {
        return data.stream();
      }
      if (entry.method === 8) {
        return data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      }
      throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}`);
    }
    return {
      name: entry.name,
      size: entry.size,
      // Other methods (Deflate64, LZMA, ...) are left to the libarchive decoder.
      supported: entry.method === 0 || entry.method === 8,
      stream,
      async blob() {
        return entry.method === 0 ? raw() : new Response(await stream()).blob();
      },
    };
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/// Packs [{ name, data: Uint8Array }] into an uncompressed ZIP archive.
export function writeZip(files, time = new Date()) {
  const encoder = new TextEncoder();
  const dosTime = (time.getHours() << 11) | (time.getMinutes() << 5) | (time.getSeconds() >> 1);
  const dosDate = ((time.getFullYear() - 1980) << 9) | ((time.getMonth() + 1) << 5) | time.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = encoder.encode(name);
    if (offset + data.length > 0xfffffff0) throw new Error('Archive would exceed 4 GB');
    const header = (size, signature) => {
      const view = new DataView(new ArrayBuffer(size));
      view.setUint32(0, signature, true);
      return view;
    };
    // Version 20, UTF-8 names, stored.
    const local = header(30, 0x04034b50);
    const fields = [[4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2],
      [14, crc32(data), 4], [18, data.length, 4], [22, data.length, 4], [26, nameBytes.length, 2]];
    for (const [at, value, width] of fields) {
      width === 2 ? local.setUint16(at, value, true) : local.setUint32(at, value, true);
    }
    const entry = header(46, 0x02014b50);
    entry.setUint16(4, 20, true);
    for (const [at, value, width] of fields) {
      width === 2 ? entry.setUint16(at + 2, value, true) : entry.setUint32(at + 2, value, true);
    }
    entry.setUint32(42, offset, true);
    parts.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function baseName(name) {
  return name.split('/').pop();
}

async function readArchiveEntries(file) {
  const { system } = await openArchive(file, { romExtensions: [], systemExtensions: ['.keys', '.nca'] });
  return system.map(e => ({ name: e.name, size: e.blob.size, blob: async () => e.blob }));
}

/// Imports keys/firmware from a ZIP or other archive, a loose .keys file, or a loose .nca file.
/// Returns a summary of what was stored.
export async function importSystemFile(file, onProgress = () => {}) {
  const lower = file.name.toLowerCase();
  let entries;
  if (lower.endsWith('.keys') || lower.endsWith('.nca')) {
    entries = [{ name: file.name, size: file.size, blob: async () => file }];
  } else if (lower.endsWith('.zip')) {
    try {
      entries = await readZipEntries(file);
      if (entries.some(e => !e.supported)) entries = await readArchiveEntries(file);
    } catch (err) {
      entries = await readArchiveEntries(file);
    }
  } else if (isArchive(lower)) {
    entries = await readArchiveEntries(file);
  } else {
    throw new Error(`${file.name}: expected an archive, .keys or .nca file`);
  }

  const keyEntries = entries.filter(e => e.name.toLowerCase().endsWith('.keys'));
  const ncaEntries = entries.filter(e => e.name.toLowerCase().endsWith('.nca'));
  if (keyEntries.length === 0 && ncaEntries.length === 0) {
    throw new Error(`${file.name} contains no .keys or .nca files`);
  }

  const records = [];
  for (const entry of keyEntries) {
    records.push([KEYS_PREFIX + baseName(entry.name), await entry.blob()]);
  }

  // A firmware archive replaces the installed firmware, mirroring Eden's desktop installer.
  const isFirmwareSet = ncaEntries.length > 1;
  let copied = 0;
  for (const entry of ncaEntries) {
    records.push([FIRMWARE_PREFIX + baseName(entry.name), await entry.blob()]);
    onProgress(++copied, ncaEntries.length);
  }
  if (isFirmwareSet) {
    await deletePrefix(FIRMWARE_PREFIX);
    records.push([META_FIRMWARE, { source: file.name, count: ncaEntries.length }]);
  }
  await putAll(records);

  return {
    keys: keyEntries.map(e => baseName(e.name)),
    firmwareCount: ncaEntries.length,
  };
}

export async function getSystemFileStatus() {
  const entries = await allEntries();
  const keys = new Set();
  let firmwareCount = 0;
  let firmwareBytes = 0;
  let firmwareSource = null;
  for (const [key, value] of entries) {
    if (key.startsWith(KEYS_PREFIX)) {
      keys.add(key.slice(KEYS_PREFIX.length));
    } else if (key.startsWith(FIRMWARE_PREFIX)) {
      firmwareCount++;
      firmwareBytes += value.size;
    } else if (key === META_FIRMWARE) {
      firmwareSource = value.source;
    }
  }
  return {
    prodKeys: keys.has('prod.keys'),
    titleKeys: keys.has('title.keys'),
    keys: [...keys],
    firmwareCount,
    firmwareBytes,
    firmwareSource,
  };
}

export async function clearSystemFiles() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
  db.close();
}

/// Writes every stored key and firmware file into the Emscripten FS. Must run before
/// eden_init so the key manager and system NAND see them.
export async function mountSystemFiles(FS, root = EDEN_DATA_ROOT) {
  let mounted = 0;
  for (const [key, value] of await allEntries()) {
    if (!(value instanceof Blob)) {
      continue;
    }
    const path = `${root}/${key}`;
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    FS.writeFile(path, new Uint8Array(await value.arrayBuffer()));
    mounted++;
  }
  return mounted;
}
