// SPDX-License-Identifier: GPL-3.0-or-later
// Persists user-supplied Switch keys and firmware in IndexedDB and mounts them into the
// Emscripten filesystem at the locations Eden expects.

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
async function readZipEntries(file) {
  const tailSize = Math.min(file.size, 0x10000 + 22);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
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
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error(`${file.name} uses ZIP64, which is not supported`);
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
    const compressedSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nameLength = cd.getUint16(p + 28, true);
    const extraLength = cd.getUint16(p + 30, true);
    const commentLength = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) {
      continue;
    }
    entries.push({ name, method, compressedSize, size, localOffset });
  }

  return entries.map(entry => ({
    name: entry.name,
    size: entry.size,
    async blob() {
      const header = new DataView(
        await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
      const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
      const raw = file.slice(start, start + entry.compressedSize);
      if (entry.method === 0) {
        return raw;
      }
      if (entry.method === 8) {
        const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).blob();
      }
      throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}`);
    },
  }));
}

function baseName(name) {
  return name.split('/').pop();
}

/// Imports a keys/firmware ZIP, a loose .keys file, or a loose .nca file.
/// Returns a summary of what was stored.
export async function importSystemFile(file, onProgress = () => {}) {
  const lower = file.name.toLowerCase();
  let entries;
  if (lower.endsWith('.zip')) {
    entries = await readZipEntries(file);
  } else if (lower.endsWith('.keys') || lower.endsWith('.nca')) {
    entries = [{ name: file.name, size: file.size, blob: async () => file }];
  } else {
    throw new Error(`${file.name}: expected a .zip, .keys or .nca file`);
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
