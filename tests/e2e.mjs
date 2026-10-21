// SPDX-License-Identifier: GPL-3.0-or-later
// Browser end-to-end and regression test. Loads the frontend in Chrome, waits for the WebAssembly
// core, and, when system files and a game are given, imports them through the UI and boots the
// game. Results are checked against tests/baseline.json and written to artifacts/.
//
//   node tests/e2e.mjs [--url https://shubin123.github.io/eden_web/] [--static] [--seconds 90]
// --static serves the local build without COOP/COEP headers, as GitHub Pages does.
// --chrome-log prints Chrome's log, including GPU process errors, to stderr.
// --core <id> runs on that CPU core (see web/cores.js) and checks the engine reports it.
// --crash-at <s> simulates a crash <s> seconds after the first frame and checks the game restarts.
//   EDEN_KEYS=prod.zip EDEN_FIRMWARE=firmware.zip EDEN_ROM=game.nsp node tests/e2e.mjs

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from '../scripts/server.mjs';
import { CPU_CORES } from '../web/cores.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    seconds: { type: 'string', default: process.env.E2E_SECONDS || '90' },
    headful: { type: 'boolean', default: false },
    static: { type: 'boolean', default: false },
    'chrome-log': { type: 'boolean', default: false },
    core: { type: 'string' },
    'crash-at': { type: 'string' },
  },
});

const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keys = process.env.EDEN_KEYS;
const firmware = process.env.EDEN_FIRMWARE;
const rom = process.env.EDEN_ROM;
const bootGame = Boolean(keys && firmware && rom);
const baseline = JSON.parse(await readFile(path.join(root, 'tests/baseline.json'), 'utf8'));

for (const file of [keys, firmware, rom].filter(Boolean)) {
  if (!existsSync(file)) throw new Error(`missing input file ${file}`);
}

let server = null;
let url = args.url;
if (!url) {
  server = createServer({ isolation: !args.static });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
}

const consoleLog = [];
const report = { url, startedAt: new Date().toISOString(), bootGame, checks: [], timeline: [], frames: [], errors: [] };
const failures = [];
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`);
  if (!ok) failures.push(name);
}

if (process.platform === 'linux' && !args.headful && bootGame) {
  console.warn('Note: headless Chrome on Linux cannot present WebGPU canvases on some GPUs (NVIDIA), ' +
    'so frames may never appear. Use --headful for regression runs on Linux.');
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'eden-e2e-'));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: !args.headful,
  userDataDir: profile,
  protocolTimeout: 600_000,
  // --chrome-log prints Chrome's own log (GPU process errors, device losses) to stderr.
  dumpio: args['chrome-log'],
  args: ['--enable-unsafe-webgpu', '--enable-features=WebAssemblyMemory64',
    ...(args['chrome-log'] ? ['--enable-logging=stderr', '--v=0'] : []),
    // Extra Chrome flags, e.g. to try GPU backends: E2E_CHROME_ARGS="--use-angle=vulkan".
    ...(process.env.E2E_CHROME_ARGS?.split(/\s+/).filter(Boolean) ?? [])],
});

const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, '-');

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  let criticalLogs = 0;
  // A page that cannot reserve emulated memory (the previous page has not released it yet) logs
  // errors and reloads itself; that recovery is expected, so its errors are counted separately.
  let reloadingForMemory = false;
  report.memoryReloads = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloadingForMemory = false; });
  page.on('pageerror', error => { if (!reloadingForMemory) report.errors.push(`pageerror: ${error.message}`); });
  page.on('console', message => {
    const text = message.text();
    consoleLog.push(text);
    if (text.includes('Failed to allocate fallback buffer') && !reloadingForMemory) {
      reloadingForMemory = true;
      report.memoryReloads++;
    }
    if (reloadingForMemory) return;
    if (/<Critical>|Aborted\(|RuntimeError/.test(text)) {
      criticalLogs++;
      if (report.errors.length < 50) report.errors.push(text.slice(0, 400));
    }
  });
  // Aborts come from the COI reload or cancelled probes, not from missing files.
  page.on('requestfailed', request => request.failure()?.errorText !== 'net::ERR_ABORTED' && report.errors.push(`requestfailed: ${request.method()} ${request.resourceType()} ${request.url()} ${request.failure()?.errorText}`));
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) report.errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });

  const loadStart = Date.now();
  const core = args.core && CPU_CORES.find(c => c.id === args.core);
  if (args.core && !core) throw new Error(`unknown core ${args.core}; one of ${CPU_CORES.map(c => c.id).join(', ')}`);
  const pageUrl = new URL(url);
  if (core) pageUrl.searchParams.set('core', core.id);
  report.core = core?.id ?? 'default';
  await page.goto(pageUrl.href, { waitUntil: 'load' });
  // On static hosts the COI service worker reloads the page once before isolation is active.
  let isolated = false;
  for (const end = Date.now() + 30_000; !isolated && Date.now() < end;) {
    await new Promise(resolve => setTimeout(resolve, 250));
    isolated = await page.evaluate(() => document.readyState === 'complete' && window.crossOriginIsolated).catch(() => false);
  }
  check('cross-origin isolated', isolated);
  check('WebGPU available', await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter())));

  const coreReady = await page.waitForFunction(() => {
    const text = document.getElementById('wasm-status-text').textContent;
    return /Ready|Failed|missing|Needs/.test(text) && text;
  }, { timeout: baseline.coreReadyMs * 4, polling: 250 }).then(handle => handle.jsonValue()).catch(() => 'timeout');
  report.coreReadyMs = Date.now() - loadStart;
  check('WASM core ready', coreReady === 'WASM Core Ready', coreReady);
  check('core ready time', report.coreReadyMs <= baseline.coreReadyMs, `${report.coreReadyMs} ms <= ${baseline.coreReadyMs} ms`);
  const version = await page.waitForFunction(() => {
    const text = document.getElementById('build-version').textContent;
    return text !== '--' && text;
  }, { timeout: 15_000 }).then(handle => handle.jsonValue()).catch(() => '');
  check('version shown', /engine \S+/.test(version), version);
  report.version = version;
  report.wasmSize = await page.$eval('#wasm-size', element => element.textContent);
  check('runtime wasm served', /MB/.test(report.wasmSize), report.wasmSize);

  if (bootGame && coreReady === 'WASM Core Ready') {
    for (const [inputId, file] of [['#keys-input', keys], ['#firmware-input', firmware]]) {
      await (await page.$(inputId)).uploadFile(file);
      const result = await page.waitForFunction(() => {
        const text = document.getElementById('sys-progress').textContent;
        return /^(Imported|Import failed)/.test(text) && text;
      }, { timeout: 300_000, polling: 500 }).then(handle => handle.jsonValue());
      check(`import ${path.basename(file)}`, result.startsWith('Imported'), result);
    }

    await (await page.$('#file-input')).uploadFile(rom);
    const bootStart = Date.now();
    const deadline = bootStart + Number(args.seconds) * 1000;
    let shot = 0;
    const shotStages = new Set();
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Crash recovery reloads the page; skip samples taken while it navigates.
      const sample = await page.evaluate(() => ({
        status: document.getElementById('wasm-status-text').textContent,
        state: document.getElementById('wasm-state').textContent,
        fps: parseFloat(document.getElementById('fps-counter').textContent) || 0,
        load: document.getElementById('rom-eta').hidden ? '' : document.getElementById('rom-eta').textContent,
        progress: document.getElementById('rom-progress').value,
      })).catch(() => null);
      if (!sample) continue;
      sample.t = Math.round((Date.now() - bootStart) / 1000);
      report.timeline.push(sample);
      console.log(`  t=${sample.t}s ${sample.state} ${sample.fps.toFixed(1)} fps | ${sample.load}`);
      for (const stage of ['Reading', 'Booting', 'Loaded']) {
        if (sample.load.startsWith(stage) && !shotStages.has(stage)) {
          shotStages.add(stage);
          await page.screenshot({ path: path.join(artifacts, `e2e-${stamp}-load-${stage.toLowerCase()}.png`) }).catch(() => {});
        }
      }
      if (sample.state === 'Failed') break;
      if (args['crash-at'] && !report.crashInjectedAt) {
        const firstDrawn = report.timeline.find(entry => entry.fps > 0);
        if (firstDrawn && sample.t >= firstDrawn.t + Number(args['crash-at'])) {
          // The crash handler reloads the page, which can cut this call short.
          await page.evaluate(() => window.edenDebug.crash('e2e simulated crash')).catch(() => {});
          report.crashInjectedAt = sample.t;
          console.log(`  simulated a crash at t=${sample.t}s`);
        }
      }
      if (sample.t >= 10 * (shot + 1)) {
        await page.screenshot({ path: path.join(artifacts, `e2e-${stamp}-${shot}.png`) }).catch(() => {});
        // A blank or single-colour canvas compresses to a few KB; a rendered game frame does not.
        const frame = await page.$('#canvas')
          .then(element => element.screenshot({ path: path.join(artifacts, `e2e-${stamp}-${shot}-canvas.png`) }))
          .catch(() => null);
        if (frame) report.frames.push({ t: sample.t, bytes: frame.length });
        shot++;
      }
    }

    if (core) {
      const reported = consoleLog.find(line => line.includes('CPU core: ') && line.includes('Frontend'));
      check('engine uses selected core', reported?.includes(`CPU core: ${core.name}`), reported?.replace(/.*CPU core: /, '').replace(/\x1b\[[0-9;]*m/g, '') ?? 'not logged');
    }
    if (args['crash-at']) {
      const after = report.timeline.filter(sample => report.crashInjectedAt && sample.t > report.crashInjectedAt);
      check('crash simulated', Boolean(report.crashInjectedAt), report.crashInjectedAt ? `t=${report.crashInjectedAt}s` : 'game never drew a frame');
      check('crash report stored', await page.$eval('#crash-count', el => Number(el.textContent) > 0));
      check('game restarted', consoleLog.some(line => line.includes('CPU core:')) &&
        (await page.$eval('#recovery-status', el => el.textContent)).startsWith('Restarted'),
        await page.$eval('#recovery-status', el => el.textContent));
      check('frames after restart', after.some(sample => sample.fps > 0), `${after.filter(sample => sample.fps > 0).length} samples with frames`);
      report.savePoint = await page.$eval('#save-point', el => el.textContent);
      console.log(`  memory reloads: ${report.memoryReloads}`);
      console.log(`  save point: ${report.savePoint}`);
    }
    const running = report.timeline.find(sample => sample.state === 'Running');
    const firstFrame = report.timeline.find(sample => sample.fps > 0);
    const peakFps = Math.max(0, ...report.timeline.map(sample => sample.fps));
    const last = report.timeline.at(-1);
    report.loadSummary = report.timeline.filter(sample => sample.state === 'Running' || sample.load.startsWith('Loaded')).map(sample => sample.load).find(Boolean);
    report.bootToRunningS = running?.t ?? null;
    report.firstFrameS = firstFrame?.t ?? null;
    report.peakFps = peakFps;
    const tail = report.timeline.slice(-Math.max(1, Math.floor(report.timeline.length / 3))).map(sample => sample.fps).sort((a, b) => a - b);
    report.sustainedFps = tail[Math.floor(tail.length / 2)];
    check('game reaches Running', Boolean(running), running ? `${running.t} s` : last?.state);
    check('first frame', firstFrame && firstFrame.t <= baseline.firstFrameS, firstFrame ? `${firstFrame.t} s <= ${baseline.firstFrameS} s` : 'no frames');
    check('peak game fps', peakFps >= baseline.minPeakFps, `${peakFps.toFixed(1)} >= ${baseline.minPeakFps}`);
    check('sustained game fps', report.sustainedFps >= baseline.minSustainedFps, `median of last third ${report.sustainedFps.toFixed(1)} >= ${baseline.minSustainedFps}`);
    check('still running at end', last?.state === 'Running', last?.state);
    const detailed = report.frames.filter(frame => frame.bytes >= baseline.minFramePngBytes);
    check('game frames visible', detailed.length > 0,
      `${detailed.length}/${report.frames.length} canvas captures >= ${baseline.minFramePngBytes} bytes, largest ${Math.max(0, ...report.frames.map(frame => frame.bytes))}`);
    check('no critical logs', criticalLogs === 0, `${criticalLogs}`);
  }

  check('no page errors', report.errors.filter(error => error.startsWith('pageerror')).length === 0);
  check('no failed requests', report.errors.filter(error => /^(requestfailed|HTTP)/.test(error)).length === 0);
  await page.screenshot({ path: path.join(artifacts, `e2e-${stamp}-final.png`) });
} catch (err) {
  // An exception mid-run must fail the run, not end it with only the checks made so far.
  check('run completed', false, err.message);
} finally {
  await browser.close();
  server?.close();
  await rm(profile, { recursive: true, force: true });
  report.failures = failures;
  const reportPath = path.join(artifacts, `e2e-${stamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(path.join(artifacts, `e2e-${stamp}-console.log`), consoleLog.join('\n') + '\n');
  console.log(`${failures.length ? 'FAILED' : 'PASSED'}: ${report.checks.length - failures.length}/${report.checks.length} checks, report ${path.relative(root, reportPath)}`);
}

process.exit(failures.length ? 1 : 0);
