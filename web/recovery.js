// SPDX-License-Identifier: GPL-3.0-or-later
// Keeps in-game saves across crashes and reloads, and records crashes for later testing.
//
// Save points: the save folders in the engine's in-memory filesystem are copied to IndexedDB
// whenever they change and then stay unchanged for a poll interval, so a snapshot is never taken
// halfway through the game writing a save. Every boot restores the latest snapshot.

import { EDEN_DATA_ROOT } from './system-files.js';

// nand/system/save holds the user profile; user saves are filed under its id, so both are needed.
const SAVE_DIRS = ['nand/user/save', 'nand/system/save'];
const DB_NAME = 'eden-recovery';
const SAVES = 'saves';
const CRASHES = 'crashes';
const META_KEY = '__meta';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SAVES);
      request.result.createObjectStore(CRASHES, { autoIncrement: true });
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
