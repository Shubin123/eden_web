// SPDX-License-Identifier: GPL-3.0-or-later
// Sequential widget checks against the real browser core. All storage uses a fresh profile.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from '../scripts/server.mjs';
import { installSampler } from './lib/sampler.mjs';

const artifacts = path.resolve('artifacts/widget-core/widgets');
await mkdir(artifacts, { recursive: true });
const report = { checks: [], log: [] };
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome-stable'),
  headless: process.env.WIDGET_HEADFUL !== '1', protocolTimeout: 360_000,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebAssemblyMemory64',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`);
  assert.ok(ok, name);
};
page.on('console', m => report.log.push(m.text()));
page.on('pageerror', error => {
  report.errors ??= [];
  if (report.errors.length < 5) { report.errors.push(error.stack); console.error(error.stack); }
});
page.on('dialog', d => d.dismiss());
try {
  await page.evaluateOnNewDocument(installSampler);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('#wasm-status-text').textContent === 'WASM Core Ready', { timeout: 60_000 });
  const caps = await page.evaluate(() => JSON.parse(window.__edenLab.module.ccall('eden_get_capabilities', 'string', [], [])));
  check('core advertises browser audio', caps.audio === 'webaudio' && caps.apiVersion >= 3);
  check('core advertises camera', caps.operations.includes('camera'));
  await page.click('#btn-camera');
  await page.waitForFunction(() => document.querySelector('#camera-preview').videoWidth > 0);
  check('camera preview starts', await page.$eval('#camera-preview', preview => !preview.hidden && preview.srcObject.active));
  await page.click('#btn-camera');
  check('camera preview stops', await page.$eval('#camera-preview', preview => preview.hidden && !preview.srcObject));
  check('CPU widget reflects core', await page.$eval('#engine-cpu', e => e.textContent) === 'Wasm JIT');
  await page.waitForFunction(() => parseFloat(document.querySelector('#engine-heap').textContent) > 0);
  check('performance reads real heap', parseFloat(await page.$eval('#engine-heap', e => e.textContent)) > 0);
  check('controls idle until boot', await page.$eval('#btn-pause', e => e.disabled));

  const viewport = page.viewport();
  await page.setViewport({ width: 1600, height: 900 });
  const placement = beside => page.evaluate(b => {
    const toggle = document.getElementById('layout-beside-screen');
    toggle.checked = b;
    toggle.dispatchEvent(new Event('change'));
    const screen = document.querySelector('.canvas-panel').getBoundingClientRect();
    const cards = [...document.querySelectorAll('#widget-grid > .card:not([hidden])')]
      .map(card => card.getBoundingClientRect());
    return {
      beside: cards.filter(r => r.left >= screen.right && r.top < screen.bottom).length,
      under: cards.filter(r => r.top >= screen.bottom && r.left < screen.right).length,
      allUnder: cards.every(r => r.top >= screen.bottom),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  }, beside);
  const wide = await placement(true);
  check('widgets fill beside and underneath the screen', wide.beside > 0 && wide.under > 0 && !wide.overflow,
    JSON.stringify(wide));
  const below = await placement(false);
  check('widgets can all sit underneath the screen', below.allUnder && !below.overflow);
  await placement(true);
  await page.setViewport(viewport);

  const fileCheck = await page.evaluate(async () => {
    const { mountRom } = await import('./rom-file.js');
    const FS = window.__edenLab.module.FS;
    const block = 4 * 1024 * 1024;
    const bytes = Uint8Array.from({ length: block + 17 }, (_, i) => i % 251);
    FS.mkdirTree('/roms');
    await mountRom(FS, '/roms/fixture.nsp', {
      name: 'fixture.nsp', size: bytes.length, stream: async () => new Blob([bytes]).stream(),
    });
    const stream = FS.open('/roms/fixture.nsp', 'r');
    const actual = new Uint8Array(39);
    const count = FS.read(stream, actual, 0, actual.length, block - 22);
    const size = FS.stat('/roms/fixture.nsp').size;
    FS.close(stream);
    FS.unlink('/roms/fixture.nsp');
    return size === bytes.length && count === 39 && actual.every((v, i) => v === bytes[block - 22 + i]);
  });
  check('ROM block file works through real engine FS', fileCheck);

  if (caps.operations.includes('browserRom')) {
    const rejects = await page.evaluate(async () => {
      const { mountBrowserRom } = await import('./browser-rom.js');
      const module = window.__edenLab.module;
      const errors = [];
      for (const stream of [
        async () => { throw new Error('fixture decoder failed'); },
        async () => new Blob([new Uint8Array([1, 2])]).stream(),
      ]) {
        try {
          await mountBrowserRom(module, '/roms/broken.nsp', { name: 'broken.nsp', size: 3, stream }, () => {});
          return false;
        } catch (error) { errors.push(error.message); }
      }
      return errors[0] === 'fixture decoder failed' && errors[1].includes('truncated');
    });
    check('archive cache rejects decoder errors and truncated ROMs', rejects);
    const reads = await page.evaluate(async () => {
      const { mountBrowserRom } = await import('./browser-rom.js');
      const m = window.__edenLab.module;
      const bytes = Uint8Array.from({ length: 4 * 1024 * 1024 + 17 }, (_, i) => i % 251);
      const file = new File([bytes], 'fixture.nsp');
      const results = [];
      for (const archived of [false, true]) {
        const rom = { name: file.name, size: file.size, stream: async () => file.stream(),
          ...(archived ? {} : { file }) };
        const mounted = await mountBrowserRom(m, '/roms/fixture.nsp', rom, () => {});
        try {
          const control = new Int32Array(m.HEAPF64.buffer, Number(m._eden_get_rom_io_control()), 6);
          const position = new BigUint64Array(m.HEAPF64.buffer, Number(m._eden_get_rom_io_control()) + 16, 1);
          const output = new Uint8Array(m.HEAPF64.buffer, Number(m._eden_get_rom_io_buffer()), m._eden_get_rom_io_buffer_size());
          for (const [offset, length] of [[0, 27], [4 * 1024 * 1024 - 5, 22], [file.size, 16]]) {
            position[0] = BigInt(offset);
            control[1] = length;
            Atomics.store(control, 0, 1);
            Atomics.notify(control, 0);
            const deadline = performance.now() + 5000;
            while (Atomics.load(control, 0) === 1 && performance.now() < deadline) await new Promise(r => setTimeout(r, 1));
            const count = control[2];
            if (Atomics.load(control, 0) !== 2 || count !== Math.min(length, file.size - offset)) return false;
            if (!output.subarray(0, count).every((v, i) => v === bytes[offset + i])) return false;
            Atomics.store(control, 0, 0);
          }
          results.push(mounted.bytes === file.size);
        } finally { mounted.close(); }
      }
      return results.every(Boolean);
    });
    check('raw and archived ROM mailbox reads, boundaries and EOF', reads);
    const largeOffset = await page.evaluate(async () => {
      const { mountBrowserRom } = await import('./browser-rom.js');
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('rom-cache', { create: true });
      const handle = await directory.getFileHandle('offset-fixture', { create: true });
      const writer = await handle.createWritable();
      const offset = 2 ** 32 + 7;
      await writer.seek(offset);
      await writer.write(new Uint8Array([8, 9, 2]));
      await writer.close();
      const file = await handle.getFile();
      const m = window.__edenLab.module;
      const mounted = await mountBrowserRom(m, '/roms/large-fixture.nsp', { file }, () => {});
      try {
        const control = new Int32Array(m.HEAPF64.buffer, Number(m._eden_get_rom_io_control()), 6);
        new BigUint64Array(m.HEAPF64.buffer, Number(m._eden_get_rom_io_control()) + 16, 1)[0] = BigInt(offset);
        control[1] = 3;
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        const deadline = performance.now() + 5000;
        while (Atomics.load(control, 0) === 1 && performance.now() < deadline) await new Promise(r => setTimeout(r, 1));
        const bytes = new Uint8Array(m.HEAPF64.buffer, Number(m._eden_get_rom_io_buffer()), 3);
        return Atomics.load(control, 0) === 2 && control[2] === 3 && bytes.join(',') === '8,9,2';
      } finally {
        mounted.close();
        await directory.removeEntry('offset-fixture');
      }
    });
    check('ROM mailbox preserves offsets above 4 GB', largeOffset);
  }

  const saves = await page.evaluate(async () => {
    const { watchSaves, restoreSaves, clearSaves, savePointInfo } = await import('./recovery.js');
    const { EDEN_DATA_ROOT } = await import('./system-files.js');
    const FS = window.__edenLab.module.FS;
    const file = `${EDEN_DATA_ROOT}/nand/user/save/browser-fixture/test.bin`;
    FS.mkdirTree(file.slice(0, file.lastIndexOf('/')));
    let saved = false;
    const stop = watchSaves(() => FS, () => true, () => { saved = true; }, 30);
    try {
      FS.writeFile(file, new Uint8Array([9, 2, 7]));
      const deadline = performance.now() + 5000;
      while (!saved && performance.now() < deadline) await new Promise(r => setTimeout(r, 30));
      if (!saved) throw new Error('first save was never persisted');
      const meta = await savePointInfo();
      FS.unlink(file);
      await restoreSaves(FS);
      const bytes = Array.from(FS.readFile(file));
      FS.unlink(file);
      await clearSaves();
      return { bytes, files: meta.files };
    } finally { stop(); }
  });
  check('first in-game save persists and restores', saves.bytes.join(',') === '9,2,7' && saves.files > 0);

  const roundTrip = await page.evaluate(async () => {
    const { importSaves, exportSaves, restoreSaves, clearSaves } = await import('./recovery.js');
    const { EDEN_DATA_ROOT, readZipEntries, writeZip } = await import('./system-files.js');
    const FS = window.__edenLab.module.FS;
    const name = 'nand/user/save/0000000000000000/0123456789ABCDEF0123456789ABCDEF/0100000000010000/slot.sav';
    try {
      const imported = await importSaves(new File([writeZip([{ name: `eden/${name}`, data: new Uint8Array([4, 5, 6]) }])], 'in.zip'));
      const exported = await readZipEntries(new File([await exportSaves()], 'out.zip'));
      await restoreSaves(FS);
      const bytes = Array.from(FS.readFile(`${EDEN_DATA_ROOT}/${name}`));
      FS.unlink(`${EDEN_DATA_ROOT}/${name}`);
      return { files: imported.files, titles: imported.titles, exported: exported.map(e => e.name), bytes };
    } finally { await clearSaves(); }
  });
  const slotTrip = await page.evaluate(async () => {
    const { saveSlot, loadSlot, listSlots, clearSlot, restoreSaves, clearSaves, importSaves } = await import('./recovery.js');
    const { EDEN_DATA_ROOT, writeZip } = await import('./system-files.js');
    const FS = window.__edenLab.module.FS;
    const dir = 'nand/user/save/0000000000000000/0123456789ABCDEF0123456789ABCDEF';
    const own = `${dir}/0100000000020000/progress.sav`;
    const other = `${dir}/0100000000030000/other.sav`;
    const write = (path, bytes) => {
      FS.mkdirTree(`${EDEN_DATA_ROOT}/${path}`.slice(0, `${EDEN_DATA_ROOT}/${path}`.lastIndexOf('/')));
      FS.writeFile(`${EDEN_DATA_ROOT}/${path}`, new Uint8Array(bytes));
    };
    try {
      write(own, [1]);
      write(other, [7]);
      const saved = await saveSlot(3, '0100000000020000', 'Fixture', FS);
      write(own, [2]);
      // The stored save point holds newer progress for this game and another game's save.
      await importSaves(new File([writeZip([{ name: own, data: new Uint8Array([2]) }, { name: other, data: new Uint8Array([8]) }])], 'x.zip'));
      await loadSlot(3);
      FS.unlink(`${EDEN_DATA_ROOT}/${own}`);
      FS.unlink(`${EDEN_DATA_ROOT}/${other}`);
      await restoreSaves(FS);
      const result = {
        files: saved.files,
        listed: (await listSlots())[2]?.name,
        own: Array.from(FS.readFile(`${EDEN_DATA_ROOT}/${own}`)),
        other: Array.from(FS.readFile(`${EDEN_DATA_ROOT}/${other}`)),
      };
      await clearSlot(3);
      result.cleared = (await listSlots())[2] === null;
      FS.unlink(`${EDEN_DATA_ROOT}/${own}`);
      FS.unlink(`${EDEN_DATA_ROOT}/${other}`);
      return result;
    } finally { await clearSaves(); }
  });
  check('save slot restores one game and keeps the others', slotTrip.files === 1 && slotTrip.listed === 'Fixture' &&
    slotTrip.own.join() === '1' && slotTrip.other.join() === '8' && slotTrip.cleared);
  check('slot controls show the slots', await page.$$eval('#save-state-slot option', o => o.length) === 8 &&
    await page.$eval('#btn-save-state', b => b.disabled));
  check('saves import from and export to ZIP', roundTrip.files === 1 && roundTrip.titles[0] === '0100000000010000' &&
    roundTrip.exported.includes('nand/user/save/0000000000000000/0123456789ABCDEF0123456789ABCDEF/0100000000010000/slot.sav') &&
    roundTrip.bytes.join(',') === '4,5,6');

  await page.select('#screen-filter', 'pixelated');
  check('renderer scaling setting applies', await page.$eval('#screen-stage', e => e.classList.contains('is-pixelated')));
  await page.click('#btn-fullscreen-stage');
  await page.waitForFunction(() => document.fullscreenElement?.id === 'screen-stage');
  check('fullscreen button enters native fullscreen', true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.fullscreenElement);
  check('Escape leaves fullscreen', true);
  await page.keyboard.down('Alt');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Alt');
  await page.waitForFunction(() => document.fullscreenElement?.id === 'screen-stage');
  check('Alt+Enter enters fullscreen', true);
  await page.click('#btn-fullscreen-exit');
  await page.waitForFunction(() => !document.fullscreenElement);
  check('exit button leaves fullscreen', true);
  const game = process.env.EDEN_ROM;
  if (game) {
    for (const [selector, file] of [['#keys-input', process.env.EDEN_KEYS], ['#firmware-input', process.env.EDEN_FIRMWARE]]) {
      assert.ok(file, `${selector}: missing input`);
      await (await page.$(selector)).uploadFile(file);
      await page.waitForFunction(() => /^(Imported|Import failed)/.test(document.querySelector('#sys-progress').textContent), { timeout: 300_000 });
      check(`${selector} import`, (await page.$eval('#sys-progress', e => e.textContent)).startsWith('Imported'));
    }
    await (await page.$('#file-input')).uploadFile(game);
    await page.waitForFunction(() => window.__edenLab.module._eden_get_state() === 2 &&
      window.__edenLab.module._eden_get_game_fps() >= 10, { timeout: 300_000, polling: 1000 });
    check('game running from supplied file', true, path.basename(game));
    await page.$eval('#btn-pause', e => e.click());
    await page.waitForFunction(() => window.__edenLab.module._eden_get_state() === 3, { timeout: 15_000 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#pause-overlay')).display !== 'none');
    check('pause reaches core', await page.$eval('#pause-overlay', e => getComputedStyle(e).display) !== 'none');
    await page.$eval('#btn-play', e => e.click());
    await page.waitForFunction(() => window.__edenLab.module._eden_get_state() === 2, { timeout: 15_000 });
    check('resume reaches core', true);
    await page.waitForFunction(() => window.__edenLab.module._eden_get_audio_state() > 0, { timeout: 30_000 });
    await page.click('#btn-sound');
    await page.waitForFunction(() => window.__edenLab.module._eden_get_audio_state() === 2, { timeout: 10_000 });
    await page.$eval('#audio-volume', e => { e.value = '37'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    if ((await page.$eval('#btn-sound', e => e.textContent)).includes('muted')) await page.click('#btn-sound');
    await page.waitForFunction(() => Math.abs(window.__edenLab.module.edenAudioGain.gain.value - 0.37) < 0.01);
    check('volume changes real output gain', true);
    await page.click('#btn-sound');
    await page.waitForFunction(() => window.__edenLab.module.edenAudioGain.gain.value < 0.001);
    check('mute silences real output gain', true);
    await page.click('#btn-sound');
    await page.evaluate(() => {
      const m = window.__edenLab.module;
      window.inputCalls = [];
      const original = m._eden_set_button;
      m._eden_set_button = (...args) => { window.inputCalls.push(args); return original(...args); };
    });
    await page.click('#canvas');
    await page.keyboard.press('Enter');
    check('keyboard sends press and release to core', await page.evaluate(() =>
      inputCalls.some(c => c[1] === 10 && c[2] === 1) && inputCalls.some(c => c[1] === 10 && c[2] === 0)));
    await page.screenshot({ path: path.join(artifacts, 'game.png') });
    await page.$eval('#auto-restart', e => { e.checked = false; });
    await page.evaluate(() => window.edenDebug.crash('widget crash-state check'));
    await page.waitForFunction(() => document.querySelector('#recovery-status').textContent.startsWith('Crashed;'));
    check('crash clears live performance state', await page.$eval('#wasm-state', e => e.textContent) === 'Crashed' &&
      await page.$eval('#fps-counter', e => e.textContent) === '--');
    check('crash disables emulation controls', await page.$eval('#btn-play', e => e.disabled) &&
      await page.$eval('#btn-pause', e => e.disabled) && await page.$eval('#btn-fullscreen-pause', e => e.disabled));
    check('crash report persisted', Number(await page.$eval('#crash-count', e => e.textContent)) === 1);
  }
  check('no browser errors', !report.errors?.length, report.errors?.[0]);
} catch (error) {
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
