// SPDX-License-Identifier: GPL-3.0-or-later
// Drives one game in Chrome for the scripted suite (tests/games.mjs) and the agentic suite
// (tests/agent.mjs): system file import, booting from a save, controller input timed in game
// frames, screen captures with the page's pause overlay hidden, and save export.

import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { createServer } from '../../scripts/server.mjs';
import { installSampler } from './sampler.mjs';

export const BUTTONS = {
  A: 0, B: 1, X: 2, Y: 3, LStick: 4, RStick: 5, L: 6, R: 7, ZL: 8, ZR: 9,
  Plus: 10, Minus: 11, Left: 12, Up: 13, Right: 14, Down: 15, Home: 18, Capture: 19,
};
export const STICKS = { left: 0, right: 1 };

/// The entries of a stored (uncompressed) ZIP, as written by web/system-files.js writeZip or most
/// tools with -0, plus deflated ones via zlib: [{ path, sha256 }].
export async function saveEntries(zipBuffer) {
  const { inflateRawSync } = await import('node:zlib');
  const view = new DataView(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength);
  let eocd = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('save is not a ZIP archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extra = view.getUint16(p + 30, true);
    const comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = zipBuffer.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zipBuffer.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    const path = name.replace(/\\/g, '/').replace(/^.*?(nand\/(user|system)\/save\/)/i, (_, prefix) => prefix.toLowerCase());
    entries.push({ path, sha256: createHash('sha256').update(data).digest('hex') });
  }
  return entries;
}

/// 64x36 grey thumbnail of a PNG, computed in the page (Node has no PNG decoder here).
export async function thumbnail(page, png) {
  return page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(64, 36);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, 64, 36);
    const { data } = context.getImageData(0, 0, 64, 36);
    const grey = [];
    for (let i = 0; i < data.length; i += 4) grey.push(Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]));
    return grey;
  }, png.toString('base64'));
}

export const difference = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
export const spread = grey => {
  const mean = grey.reduce((a, b) => a + b, 0) / grey.length;
  return Math.sqrt(grey.reduce((sum, v) => sum + (v - mean) ** 2, 0) / grey.length);
};
export const DEFAULT_GAME_DIRS = [
  path.join(os.homedir(), 'Documents/emulators/games/switch'), '/Volumes/EXTERNAL/switchGames',
];
export const DEFAULT_SUITE_DIR = path.join(os.homedir(), 'Documents/emulators/games/switch/eden-suite');

/// Maps title IDs to ROM files whose name holds [<title ID>], preferring NSP/XCI over archives.
export async function findRoms(dirs) {
  const roms = new Map();
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
      const id = entry.isFile() && /\.(nsp|xci|7z|zip)$/i.test(entry.name) && entry.name.match(/\[(0100[0-9A-F]{12})\]/i)?.[1];
      if (id && (!roms.has(id.toUpperCase()) || /\.(nsp|xci)$/i.test(entry.name))) roms.set(id.toUpperCase(), full);
    }
  };
  for (const dir of dirs) await walk(dir, 0);
  return roms;
}

const coreReady = page => page.waitForFunction(
  () => document.querySelector('#wasm-status-text').textContent === 'WASM Core Ready', { timeout: 120_000 });

/// Starts the local server and Chrome. One browser profile is shared by every game it opens.
export async function launchLab({ headful = false } = {}) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: !headful,
    protocolTimeout: 900_000,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebAssemblyMemory64'],
  });
  const port = server.address().port;
  return {
    browser,
    port,
    /// Imports keys and firmware once; the profile keeps them for every later game.
    async installSystemFiles(keys, firmware) {
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${port}/`);
        await coreReady(page);
        for (const [selector, file] of [['#keys-input', keys], ['#firmware-input', firmware]]) {
          await (await page.$(selector)).uploadFile(file);
          await page.waitForFunction(() => /^(Imported|Import failed)/.test(document.querySelector('#sys-progress').textContent), { timeout: 300_000 });
          const status = await page.$eval('#sys-progress', e => e.textContent);
          if (!status.startsWith('Imported')) throw new Error(`${path.basename(file)}: ${status}`);
        }
      } finally {
        await page.close();
      }
    },
    async close() {
      await browser.close().catch(() => {});
      server.close();
    },
  };
}

/// Checks a scenario's save rule: every scenario starts from a save file, except one that creates
/// the save other scenarios start from (createsSave plus an exportSave step).
export function checkSaveRule(scenario) {
  const exports = (scenario.steps ?? []).some(step => step.exportSave);
  if (scenario.save && scenario.createsSave) throw new Error(`${scenario.id}: use either save or createsSave`);
  if (!scenario.save && !scenario.createsSave) {
    throw new Error(`${scenario.id}: needs a "save" to start from (or "createsSave": true if it makes the save)`);
  }
  if (scenario.createsSave && !exports && !scenario.goals) throw new Error(`${scenario.id}: createsSave needs an exportSave step`);
}

/// Boots `rom` in a fresh page, from `save` (a ZIP of Eden save folders) or from no save at all.
/// With a save, the page records which save files the game opens, and saveCheck() reports whether
/// the imported files reached the engine unchanged and whether the game read them.
/// `onProgress(frame)` is called while waiting for frames.
export async function openGame(lab, { rom, save = null, titleId = null, core = null, stallS = 60, onProgress = () => {} }) {
  const page = await lab.browser.newPage();
  const log = [];
  page.on('console', m => log.push(m.text()));
  page.on('pageerror', e => log.push(`pageerror: ${e.message}`));
  page.on('dialog', d => d.accept());
  await page.setViewport({ width: 1400, height: 1000 });
  await page.evaluateOnNewDocument(installSampler);
  // Records the save files the game opens, on every load of the page (a slot load reloads it and
  // boots straight away). Game file access is proxied to this thread's Emscripten FS, so wrapping
  // FS.open as soon as the runtime exists sees every read.
  await page.evaluateOnNewDocument(() => {
    const timer = setInterval(() => {
      const FS = window.__edenLab?.module?.FS;
      if (!FS) return;
      clearInterval(timer);
      const opened = window.__edenLab.savesOpened = [];
      const open = FS.open;
      FS.open = function (path, flags, ...rest) {
        const name = typeof path === 'string' ? path : path?.path ?? '';
        if (name.includes('/nand/user/save/')) opened.push({ path: name, flags: String(flags) });
        return open.call(this, path, flags, ...rest);
      };
    }, 1);
  });
  await page.goto(`http://127.0.0.1:${lab.port}/${core ? `?core=${core}` : ''}`);
  await coreReady(page);
  if (!(await page.evaluate(() => typeof window.__edenLab.module?._eden_get_game_frames === 'function'))) {
    throw new Error('runtime has no eden_get_game_frames; rebuild the engine');
  }
  await page.evaluate(async () => (await import('./recovery.js')).clearSaves());
  if (save) {
    await (await page.$('#saves-import-input')).uploadFile(save);
    await page.waitForFunction(() => /^(Imported|Import failed)/.test(document.querySelector('#saves-status').textContent), { timeout: 30_000 });
    const status = await page.$eval('#saves-status', e => e.textContent);
    if (!status.startsWith('Imported')) throw new Error(status);
  }
  await (await page.$('#file-input')).uploadFile(rom);
  await page.waitForFunction(() => window.__edenLab.module._eden_get_state() === 2, { timeout: 600_000, polling: 250 });

  const absolute = () => page.evaluate(() => window.__edenLab.module?._eden_get_game_frames?.() ?? -1);
  let bootFrames = await absolute();
  const failed = () => page.evaluate(() => Boolean(window.__edenLab.crashed) || window.__edenLab.module?._eden_get_state?.() === 4);
  const frame = async () => (await absolute()) - bootFrames;

  const session = {
    page,
    log,
    frame,
    failed,
    /// Waits until game frame `target` (counted from boot). Throws on a crash, or on a hang: no new
    /// game frame for `stallS` seconds.
    async waitFrame(target, deadline = Infinity) {
      await session.resume();
      let last = await frame();
      let lastProgress = Date.now();
      for (;;) {
        const reached = await page.waitForFunction((t, base) => {
          const m = window.__edenLab.module;
          return window.__edenLab.crashed || m._eden_get_state() === 4 || m._eden_get_game_frames() - base >= t;
        }, { timeout: 2_000, polling: 5 }, target, bootFrames).then(() => true, err => {
          if (err.name !== 'TimeoutError') throw err;
          return false;
        });
        if (await failed()) throw new Error(`game crashed before frame ${target}`);
        const now = await frame();
        onProgress(now);
        if (reached) return now;
        if (now !== last) {
          last = now;
          lastProgress = Date.now();
        } else if (Date.now() - lastProgress > stallS * 1000) {
          throw new Error(`hang: no game frame for ${stallS} s waiting for frame ${target}`);
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for frame ${target}`);
      }
    },
    /// Holds `button` for `frames` game frames.
    async press(button, frames = 4) {
      const id = BUTTONS[button];
      if (id === undefined) throw new Error(`unknown button ${button}`);
      await session.resume();
      const start = await frame();
      await page.evaluate(b => window.__edenLab.module._eden_set_button(0, b, 1), id);
      try {
        await session.waitFrame(start + frames);
      } finally {
        await page.evaluate(b => window.__edenLab.module._eden_set_button(0, b, 0), id);
      }
    },
    /// Tilts a stick (x, y in -1..1, y up) for `frames` game frames.
    async stick(name, x, y, frames = 30) {
      const id = STICKS[name];
      if (id === undefined) throw new Error(`unknown stick ${name}`);
      await session.resume();
      const start = await frame();
      await page.evaluate((s, sx, sy) => window.__edenLab.module._eden_set_stick(0, s, sx, sy), id, x, y);
      try {
        await session.waitFrame(start + frames);
      } finally {
        await page.evaluate(s => window.__edenLab.module._eden_set_stick(0, s, 0, 0), id);
      }
    },
    /// Pauses the emulator and captures the screen (PNG). Resumes afterwards unless `keepPaused`;
    /// input and waits resume a paused game themselves. Returns { png, frame }.
    async capture({ keepPaused = false } = {}) {
      await page.evaluate(() => window.__edenLab.module._eden_pause());
      await page.waitForFunction(() => window.__edenLab.module._eden_get_state() === 3, { timeout: 30_000 });
      const at = await frame();
      const overlay = await page.addStyleTag({ content: '#pause-overlay { visibility: hidden !important; }' });
      try {
        await new Promise(r => setTimeout(r, 500));
        const clip = await page.$eval('#canvas', el => {
          const r = el.getBoundingClientRect();
          return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 };
        });
        const png = Buffer.from(await page.screenshot({ clip, encoding: 'base64' }), 'base64');
        return { png, frame: at };
      } finally {
        await overlay.evaluate(el => el.remove());
        if (!keepPaused) await session.resume();
      }
    },
    async resume() {
      if (await page.evaluate(() => window.__edenLab.module._eden_get_state()) !== 3) return;
      await page.evaluate(() => window.__edenLab.module._eden_resume());
      await page.waitForFunction(() => window.__edenLab.module._eden_get_state() === 2, { timeout: 30_000 });
    },
    /// A smaller PNG of `png` (for sending to a model), scaled in the page.
    async downscale(png, width = 640) {
      const base64 = await page.evaluate(async (data, w) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }));
        const h = Math.round(bitmap.height * w / bitmap.width);
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      }, png.toString('base64'), width);
      return Buffer.from(base64, 'base64');
    },
    /// For a game booted from a save: whether the save's files for `titleId` are in the engine
    /// filesystem as imported, and which of them the game opened so far.
    /// Returns { imported, present, matching, opened, ok, problem }.
    async saveCheck(zipEntries) {
      const id = titleId?.toUpperCase();
      const wanted = zipEntries.filter(e => e.path.startsWith('nand/user/save/') && (!id || e.path.toUpperCase().includes(`/${id}/`)));
      const state = await page.evaluate(async entries => {
        const { EDEN_DATA_ROOT } = await import('./system-files.js');
        const FS = window.__edenLab.module.FS;
        const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        const files = [];
        for (const { path, sha256 } of entries) {
          let current = null;
          try { current = await digest(FS.readFile(`${EDEN_DATA_ROOT}/${path}`)); } catch {}
          files.push({ path, present: current !== null, unchanged: current === sha256 });
        }
        const opened = [...new Set((window.__edenLab.savesOpened ?? []).map(o => o.path.replace(`${EDEN_DATA_ROOT}/`, '')))];
        return { files, opened };
      }, wanted.map(({ path, sha256 }) => ({ path, sha256 })));
      const present = state.files.filter(f => f.present).length;
      const opened = state.opened.filter(p => wanted.some(w => w.path.toUpperCase() === p.toUpperCase()));
      let problem = null;
      if (!wanted.length) problem = `the save has no files for ${id ?? 'this game'}`;
      else if (present < wanted.length) problem = `${wanted.length - present} of ${wanted.length} save files never reached the engine`;
      else if (!opened.length) problem = 'the game never opened its save files';
      return { imported: wanted.length, present, opened, ok: !problem, problem };
    },
    /// Saves the running game to save slot `slot` through the page's Saves widget, loads the slot
    /// (the page restarts the game from it), and checks the restarted game read the slot's files.
    /// Frames count from the restart afterwards. Returns { saved, check }.
    async slotRoundTrip(slot = 1) {
      await session.resume();
      await page.waitForFunction(() => !document.querySelector('#btn-save-state').disabled, { timeout: 60_000 });
      await page.select('#save-state-slot', String(slot));
      await page.click('#btn-save-state');
      await page.waitForFunction(n => new RegExp(`slot ${n}`).test(document.querySelector('#saves-status').textContent), { timeout: 30_000 }, slot);
      const status = await page.$eval('#saves-status', e => e.textContent);
      if (!status.startsWith('Saved')) throw new Error(`save to slot ${slot} failed: ${status}`);
      // The slot's files, as stored, are what the restarted game has to read.
      const slotFiles = await page.evaluate(async n => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('eden-recovery');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const record = await new Promise((resolve, reject) => {
          const request = db.transaction('slots').objectStore('slots').get(n);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        return Promise.all(record.files.map(async ([path, blob]) => ({ path, sha256: await digest(blob) })));
      }, slot);
      const reloaded = page.waitForNavigation({ timeout: 600_000 });
      await page.click('#btn-load-slot');
      await reloaded;
      await coreReady(page);
      await page.waitForFunction(() => window.__edenLab.module._eden_get_state() === 2, { timeout: 600_000, polling: 250 });
      bootFrames = await absolute();
      return { saved: slotFiles.length, slotFiles };
    },
    /// Cumulative guest cycles and host busy time per emulated core, from the engine's runtime
    /// stats (null on engines that do not report them).
    async execStats() {
      const stats = await page.evaluate(() => {
        try {
          return JSON.parse(window.__edenLab.module.ccall('eden_get_runtime_stats', 'string', [], []));
        } catch {
          return null;
        }
      });
      if (!stats?.guestCycles) return null;
      return { at: Date.now(), cycles: stats.guestCycles, busyMs: stats.guestBusyMs };
    },
    async fps() {
      return page.evaluate(() => window.__edenLab.module._eden_get_game_fps());
    },
    /// The engine's save folders as a ZIP, read straight from its filesystem (the stored save point
    /// lags behind by a poll interval).
    async exportSaves() {
      const base64 = await page.evaluate(async () => {
        const { EDEN_DATA_ROOT, writeZip } = await import('./system-files.js');
        const FS = window.__edenLab.module.FS;
        const files = [];
        const walk = (dir, rel) => {
          let names;
          try { names = FS.readdir(dir); } catch { return; }
          for (const name of names) {
            if (name === '.' || name === '..') continue;
            const full = `${dir}/${name}`;
            if (FS.isDir(FS.stat(full).mode)) walk(full, `${rel}/${name}`);
            else files.push({ name: `${rel}/${name}`, data: FS.readFile(full) });
          }
        };
        for (const dir of ['nand/user/save', 'nand/system/save']) walk(`${EDEN_DATA_ROOT}/${dir}`, dir);
        const bytes = new Uint8Array(await writeZip(files).arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      });
      return Buffer.from(base64, 'base64');
    },
    async close() {
      await page.close().catch(() => {});
    },
  };
  return session;
}
