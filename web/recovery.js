// SPDX-License-Identifier: GPL-3.0-or-later
// Keeps in-game saves across crashes and reloads, and records crashes for later testing.
//
// Save points: the save folders in the engine's in-memory filesystem are copied to IndexedDB
// whenever they change and then stay unchanged for a poll interval, so a snapshot is never taken
// halfway through the game writing a save. Every boot restores the latest snapshot. Save points
// can be exported to and imported from ZIP archives.
//
// Save slots keep a copy of one game's save folder. Loading a slot puts it back into the save
// point, which the game reads at its next boot.

import { EDEN_DATA_ROOT, readZipEntries, writeZip } from './system-files.js';

// nand/system/save holds the user profile; user saves are filed under its id, so both are needed.
const SAVE_DIRS = ['nand/user/save', 'nand/system/save'];
const DB_NAME = 'eden-recovery';
const SAVES = 'saves';
const CRASHES = 'crashes';
const SLOTS = 'slots';
const META_KEY = '__meta';
export const SLOT_COUNT = 8;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES);
      if (!db.objectStoreNames.contains(CRASHES)) db.createObjectStore(CRASHES, { autoIncrement: true });
      if (!db.objectStoreNames.contains(SLOTS)) db.createObjectStore(SLOTS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  try {
    const tx = db.transaction(name, mode);
    const result = await fn(tx.objectStore(name));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } finally {
    db.close();
  }
}

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/// Lists the save files as [relative path, stat] pairs.
function listSaveFiles(FS) {
  const files = [];
  const walk = (dir, rel) => {
    let names;
    try {
      names = FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const path = `${dir}/${name}`;
      const stat = FS.stat(path);
      if (FS.isDir(stat.mode)) walk(path, `${rel}/${name}`);
      else files.push([`${rel}/${name}`, stat]);
    }
  };
  for (const dir of SAVE_DIRS) walk(`${EDEN_DATA_ROOT}/${dir}`, dir);
  return files;
}

function signature(files) {
  return files.map(([path, stat]) => `${path}:${stat.size}:${+stat.mtime}`).sort().join('|');
}

/// Writes the stored save point into the engine filesystem. Returns the number of files.
export async function restoreSaves(FS) {
  const entries = await withStore(SAVES, 'readonly', async store => {
    const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
    return keys.map((key, i) => [key, values[i]]);
  });
  let count = 0;
  for (const [path, data] of entries) {
    if (path === META_KEY) continue;
    const full = `${EDEN_DATA_ROOT}/${path}`;
    FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    FS.writeFile(full, new Uint8Array(await data.arrayBuffer()));
    count++;
  }
  return count;
}

async function storeSaves(FS, files) {
  const meta = { time: Date.now(), files: files.length, bytes: 0 };
  await withStore(SAVES, 'readwrite', store => {
    store.clear();
    for (const [path] of files) {
      const data = FS.readFile(`${EDEN_DATA_ROOT}/${path}`);
      meta.bytes += data.length;
      store.put(new Blob([data]), path);
    }
    store.put(meta, META_KEY);
  });
  return meta;
}

export async function savePointInfo() {
  return withStore(SAVES, 'readonly', store => requestResult(store.get(META_KEY)));
}

export async function clearSaves() {
  await withStore(SAVES, 'readwrite', store => store.clear());
}

async function storedSaves() {
  return withStore(SAVES, 'readonly', async store => {
    const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
    return keys.map((key, i) => [key, values[i]]).filter(([key]) => key !== META_KEY);
  });
}

/// Packs the stored save point into a ZIP laid out like Eden's data directory, so it can be
/// unpacked into a desktop Eden or yuzu user folder. Returns null when nothing is stored.
export async function exportSaves() {
  const entries = await storedSaves();
  if (!entries.length) return null;
  const files = await Promise.all(entries.map(async ([name, blob]) =>
    ({ name, data: new Uint8Array(await blob.arrayBuffer()) })));
  return writeZip(files);
}

const TITLE_ID = /^01[0-9a-f]{14}$/i;
const PROFILE_SAVE = /^nand\/user\/save\/0000000000000000\/([0-9a-f]{32})\//i;

/// Maps an archive entry to its stored save path. Entries under nand/user/save or
/// nand/system/save keep their layout; a bare title ID folder (as other emulators export it) goes
/// to `profile`'s save folder. Returns null for entries that are not save data.
export function savePathFor(name, profile) {
  const parts = name.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Error(`${name}: unsafe path`);
  const base = parts.at(-1) ?? '';
  if (parts[0] === '__MACOSX' || base === '.DS_Store' || base.startsWith('._')) return null;
  const lower = parts.map(part => part.toLowerCase());
  for (let i = 0; i + 3 < parts.length; i++) {
    if (lower[i] === 'nand' && (lower[i + 1] === 'user' || lower[i + 1] === 'system') && lower[i + 2] === 'save') {
      return [`nand/${lower[i + 1]}/save`, ...parts.slice(i + 3)].join('/');
    }
  }
  const title = parts.findIndex(part => TITLE_ID.test(part));
  if (title < 0 || title === parts.length - 1) return null;
  if (!profile) throw new Error('No user profile yet: boot any game once, then import again');
  return [`nand/user/save/0000000000000000/${profile}`, parts[title].toUpperCase(), ...parts.slice(title + 1)].join('/');
}

/// Merges the saves in a ZIP into the stored save point; they are written into the game on the
/// next boot. Returns { files, bytes, titles }.
export async function importSaves(file) {
  const existing = await storedSaves();
  const profile = existing.map(([key]) => PROFILE_SAVE.exec(key)?.[1]).find(Boolean);
  const imported = [];
  const titles = new Set();
  for (const entry of await readZipEntries(file)) {
    const path = savePathFor(entry.name, profile);
    if (!path) continue;
    if (!entry.supported) throw new Error(`${entry.name}: unsupported ZIP compression`);
    imported.push([path, await entry.blob()]);
    const title = path.split('/').find(part => TITLE_ID.test(part));
    if (title && path.startsWith('nand/user/')) titles.add(title.toUpperCase());
  }
  if (!imported.length) throw new Error(`${file.name} holds no save data`);
  const merged = new Map([...existing, ...imported]);
  const meta = { time: Date.now(), files: merged.size, bytes: 0 };
  for (const blob of merged.values()) meta.bytes += blob.size;
  await withStore(SAVES, 'readwrite', store => {
    for (const [path, blob] of imported) store.put(blob, path);
    store.put(meta, META_KEY);
  });
  return { files: imported.length, bytes: imported.reduce((sum, [, blob]) => sum + blob.size, 0), titles: [...titles], meta };
}

async function writeSavePoint(entries) {
  const meta = { time: Date.now(), files: entries.length, bytes: 0 };
  for (const [, blob] of entries) meta.bytes += blob.size;
  await withStore(SAVES, 'readwrite', store => {
    store.clear();
    for (const [path, blob] of entries) store.put(blob, path);
    store.put(meta, META_KEY);
  });
  return meta;
}

/// Whether `path` lies in the user save folder of `titleId`.
function inTitleSave(path, titleId) {
  const parts = path.split('/');
  return path.startsWith('nand/user/save/') && parts.length > 6 && parts[5].toUpperCase() === titleId;
}

/// Copies the saves of `titleId` into `slot`, from the running engine's filesystem when `FS` is
/// given, otherwise from the stored save point. Returns the slot record without its files.
export async function saveSlot(slot, titleId, name, FS) {
  titleId = titleId.toUpperCase();
  const source = FS
    ? listSaveFiles(FS).map(([path]) => [path, new Blob([FS.readFile(`${EDEN_DATA_ROOT}/${path}`)])])
    : await storedSaves();
  const files = source.filter(([path]) => inTitleSave(path, titleId));
  if (!files.length) throw new Error(`${name || titleId} has not written a save yet`);
  const record = { slot, titleId, name: name || titleId, time: Date.now(), bytes: 0, files };
  for (const [, blob] of files) record.bytes += blob.size;
  await withStore(SLOTS, 'readwrite', store => store.put(record, slot));
  return { ...record, files: files.length };
}

/// Lists the slots as an array of SLOT_COUNT records (null for empty slots), without their files.
export async function listSlots() {
  const records = await withStore(SLOTS, 'readonly', store => requestResult(store.getAll()));
  const slots = Array(SLOT_COUNT).fill(null);
  for (const record of records) {
    if (record.slot >= 1 && record.slot <= SLOT_COUNT) slots[record.slot - 1] = { ...record, files: record.files.length };
  }
  return slots;
}

/// Replaces the game's saves in the stored save point with `slot`. Returns the slot record and
/// the new save point metadata.
export async function loadSlot(slot) {
  const record = await withStore(SLOTS, 'readonly', store => requestResult(store.get(slot)));
  if (!record) throw new Error(`Slot ${slot} is empty`);
  const kept = (await storedSaves()).filter(([path]) => !inTitleSave(path, record.titleId));
  // A profile created after the slot was saved has a new id; file the slot under it.
  const profile = kept.map(([key]) => PROFILE_SAVE.exec(key)?.[1]).find(Boolean);
  const files = record.files.map(([path, blob]) =>
    [profile ? path.replace(PROFILE_SAVE, `nand/user/save/0000000000000000/${profile}/`) : path, blob]);
  const meta = await writeSavePoint([...kept, ...files]);
  return { record: { ...record, files: record.files.length }, meta };
}

export async function clearSlot(slot) {
  await withStore(SLOTS, 'readwrite', store => store.delete(slot));
}

/// Polls the save folders while `healthy()` holds and stores a save point once a change has
/// settled. Returns a function that stops watching.
export function watchSaves(getFS, healthy, onSaved, intervalMs = 10_000) {
  const initialFS = getFS();
  let stored = initialFS ? signature(listSaveFiles(initialFS)) : null;
  let pending = null;
  let busy = false;
  const timer = setInterval(async () => {
    const FS = getFS();
    if (busy || !FS || !healthy()) return;
    busy = true;
    try {
      const files = listSaveFiles(FS);
      const sig = signature(files);
      if (stored === null) {
        // The first poll after boot only records what was restored.
        stored = sig;
      } else if (sig !== stored && sig === pending) {
        onSaved(await storeSaves(FS, files));
        stored = sig;
      }
      pending = sig;
    } catch (err) {
      console.warn('Save point failed:', err);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function recordCrash(report) {
  await withStore(CRASHES, 'readwrite', store => store.add(report));
}

export async function listCrashes() {
  return withStore(CRASHES, 'readonly', store => requestResult(store.getAll()));
}

export async function clearCrashes() {
  await withStore(CRASHES, 'readwrite', store => store.clear());
}
