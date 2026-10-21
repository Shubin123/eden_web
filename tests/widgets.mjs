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
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
  headless: false, protocolTimeout: 360_000,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebAssemblyMemory64'],
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
  check('CPU widget reflects core', await page.$eval('#engine-cpu', e => e.textContent) === 'Wasm JIT');
  await page.waitForFunction(() => parseFloat(document.querySelector('#engine-heap').textContent) > 0);
  check('performance reads real heap', parseFloat(await page.$eval('#engine-heap', e => e.textContent)) > 0);
  check('controls idle until boot', await page.$eval('#btn-pause', e => e.disabled));

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

  await page.select('#screen-filter', 'pixelated');
  check('renderer scaling setting applies', await page.$eval('#screen-stage', e => e.classList.contains('is-pixelated')));
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
