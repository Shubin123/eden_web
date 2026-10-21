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
// --repeat <n> runs the scenario n times in one browser profile: the first run starts cold, the
//   others warm (HTTP cache, compiled WebAssembly and installed system files kept).
// --warmup <s> leaves the first <s> seconds after the first frame out of frame-time statistics.
// --hang-samples <n> counts n frameless 2 s samples after the game has drawn as a hang (default 5).
// --no-present skips the canvas capture sampler (it copies every frame, which costs a little).
// --scenario <name> names the scenario in results; --artifacts <dir> writes there instead.
//   EDEN_KEYS=prod.zip EDEN_FIRMWARE=firmware.zip EDEN_ROM=game.nsp node tests/e2e.mjs
//
// Each run writes, next to its report and screenshots, a result in the shared format of
// web/results.js (e2e-<time>.result.json) with the failure classified, the environment, the game
// (title ID from the engine or the file name, never a path) and frame-time statistics. Exit code:
// 0 all runs passed, 1 a run failed, 2 the core or runtime is not available (unsupported).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from '../scripts/server.mjs';
import { CPU_CORES, DEFAULT_CORE, findCore } from '../web/cores.js';
import { frameTimeStats, makeResult, makeResultSet, validateResult } from '../web/results.js';
import { classify, findHang, gameFromFile, mergeGameInfo, summarizeRuns, table } from './lib/lab.mjs';
import { installSampler } from './lib/sampler.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  allowNegative: true,
  options: {
    url: { type: 'string' },
    seconds: { type: 'string', default: process.env.E2E_SECONDS || '90' },
    headful: { type: 'boolean', default: false },
    static: { type: 'boolean', default: false },
    'chrome-log': { type: 'boolean', default: false },
    core: { type: 'string' },
    'crash-at': { type: 'string' },
    repeat: { type: 'string', default: '1' },
    warmup: { type: 'string', default: '10' },
    'hang-samples': { type: 'string', default: '5' },
    present: { type: 'boolean', default: true },
    scenario: { type: 'string' },
    artifacts: { type: 'string' },
  },
});

const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keys = process.env.EDEN_KEYS;
const firmware = process.env.EDEN_FIRMWARE;
const rom = process.env.EDEN_ROM;
const bootGame = Boolean(keys && firmware && rom);
const baseline = JSON.parse(await readFile(path.join(root, 'tests/baseline.json'), 'utf8'));
const repeat = Math.max(1, Number(args.repeat) || 1);
const warmupS = Number(args.warmup) || 0;
const hangSamples = Math.max(1, Number(args['hang-samples']) || 5);
const artifacts = path.resolve(args.artifacts ?? path.join(root, 'artifacts'));
const scenarioName = args.scenario ?? (args['crash-at'] ? 'crash-recovery' : bootGame ? `boot-${args.seconds}s` : 'core-ready');
const fileGame = rom ? gameFromFile(rom) : null;

for (const file of [keys, firmware, rom].filter(Boolean)) {
  if (!existsSync(file)) throw new Error(`missing input file ${path.basename(file)}`);
}
await mkdir(artifacts, { recursive: true });

const runnable = CPU_CORES.filter(c => c.available);
const core = args.core ? findCore(args.core) : null;
const scenario = (index = 0) => ({
  name: scenarioName,
  seconds: bootGame ? Number(args.seconds) : 0,
  warm: index > 0,
  settings: {
    core: args.core ?? DEFAULT_CORE.id, run: index + 1, of: repeat, warmupS, hangSamples, static: args.static,
    headless: !args.headful, remote: Boolean(args.url), presentSampler: args.present,
    ...(args['crash-at'] ? { crashAt: Number(args['crash-at']) } : {}),
  },
});

async function writeResult(result, stamp) {
  const problems = validateResult(result);
  if (problems.length) throw new Error(`invalid result: ${problems.join('; ')}`);
  const file = path.join(artifacts, `e2e-${stamp}.result.json`);
  await writeFile(file, JSON.stringify(result, null, 2));
  console.log(`result ${path.relative(process.cwd(), file)}`);
  return file;
}

// A core that is not built for this runtime, or no runtime at all, is unsupported, not failed.
const unsupported = args.core && !core?.available ? `core ${args.core} does not run here; one of ${runnable.map(c => c.id).join(', ')}`
  : !args.url && !existsSync(path.join(root, 'web/runtime/eden.js')) ? 'runtime not built (run npm run sync)' : null;
if (unsupported) {
  console.log(`UNSUPPORTED: ${unsupported}`);
  await writeResult(makeResult({
    source: 'e2e', game: fileGame, core: { id: args.core ?? DEFAULT_CORE.id, emulator: core?.emulator ?? 'Eden' },
    scenario: scenario(), outcome: 'unsupported', notes: unsupported,
  }), new Date().toISOString().replace(/[:.]/g, '-'));
  process.exit(2);
}

let server = null;
let url = args.url;
if (!url) {
  server = createServer({ isolation: !args.static });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
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
const browserVersion = await browser.version();

/// Frame times in the steady-state window, from the best source that produced any.
function frameTimes(streams, windowStart) {
  const sources = {};
  for (const [name, pairs] of Object.entries(streams)) {
    const times = [];
    for (let i = 0; i < pairs.length; i += 2) if (windowStart !== null && pairs[i] >= windowStart) times.push(pairs[i + 1]);
    const stats = frameTimeStats(times);
    if (stats) sources[name] = stats;
  }
  const primary = ['engine', 'present', 'raf'].find(name => sources[name]);
  return { frameTime: primary ? sources[primary] : null, frameTimeSource: primary ?? null, frameTimeSources: sources };
}

async function runOnce(index) {
  const consoleLog = [];
  const report = { url, startedAt: new Date().toISOString(), run: index + 1, of: repeat, warm: index > 0, bootGame, checks: [], timeline: [], frames: [], errors: [] };
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const failures = [];
  // Every check names the failure category it stands for (see FAILURE_CATEGORIES).
  function check(name, ok, detail, category) {
    report.checks.push({ name, ok: Boolean(ok), detail, category });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`);
    if (!ok) failures.push(name);
  }
  const streams = { raf: [], present: [], engine: [] };
  const environment = { browser: browserVersion, os: `${os.type()} ${os.release()} ${os.arch()}`, headless: !args.headful, url: args.url ?? 'local' };
  let game = fileGame;
  let runtime = null;
  let stage = 'environment';
  let bootStart = null;
  let firstFrameAt = null;

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1400, height: 1000 });
    await page.evaluateOnNewDocument(installSampler);
    let criticalLogs = 0;
    // A page that cannot reserve emulated memory (the previous page has not released it yet) logs
    // errors and reloads itself; that recovery is expected, so its errors are counted separately.
    let reloadingForMemory = false;
    report.memoryReloads = 0;
    report.crashes = [];
    const pageErrors = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloadingForMemory = false; });
    page.on('pageerror', error => {
      if (reloadingForMemory) return;
      report.errors.push(`pageerror: ${error.message}`);
      pageErrors.push({ booted: bootStart !== null, message: error.message });
    });
    page.on('console', message => {
      const text = message.text();
      consoleLog.push(text);
      if (text.includes('Failed to allocate fallback buffer') && !reloadingForMemory) {
        reloadingForMemory = true;
        report.memoryReloads++;
      }
      if (reloadingForMemory) return;
      const crash = text.match(/Game crashed on [^:]+: (.*)/);
      if (crash && crash[1] !== 'e2e simulated crash') report.crashes.push({ t: bootStart ? Math.round((Date.now() - bootStart) / 1000) : 0, reason: crash[1].slice(0, 300) });
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
    check('cross-origin isolated', isolated, undefined, 'environment');
    Object.assign(environment, await page.evaluate(async () => {
      let gpu = null;
      try {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        const info = adapter?.info ?? {};
        gpu = adapter ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'available' : null;
      } catch {}
      return {
        userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform ?? navigator.platform, gpu,
        hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory ?? null,
        crossOriginIsolated: window.crossOriginIsolated,
      };
    }).catch(() => ({})));
    check('WebGPU available', Boolean(environment.gpu), environment.gpu ?? 'no adapter', 'environment');
    runtime = await page.evaluate(async () => {
      const get = file => fetch(file, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
      return { version: await get('version.json'), runtime: await get('runtime/runtime.json') };
    }).catch(() => null);

    stage = 'init';
    const coreReady = await page.waitForFunction(() => {
      const text = document.getElementById('wasm-status-text').textContent;
      return /Ready|Failed|missing|Needs/.test(text) && text;
    }, { timeout: baseline.coreReadyMs * 4, polling: 250 }).then(handle => handle.jsonValue()).catch(() => 'timeout');
    report.coreReadyMs = Date.now() - loadStart;
    check('WASM core ready', coreReady === 'WASM Core Ready', coreReady,
      /missing/.test(coreReady) ? 'artifact' : /Needs/.test(coreReady) ? 'environment' : 'init');
    check('core ready time', report.coreReadyMs <= baseline.coreReadyMs, `${report.coreReadyMs} ms <= ${baseline.coreReadyMs} ms`, 'performance');
    const version = await page.waitForFunction(() => {
      const text = document.getElementById('build-version').textContent;
      return text !== '--' && text;
    }, { timeout: 15_000 }).then(handle => handle.jsonValue()).catch(() => '');
    check('version shown', /engine \S+/.test(version), version, 'artifact');
    report.version = version;
    report.wasmSize = await page.$eval('#wasm-size', element => element.textContent);
    check('runtime wasm served', /MB/.test(report.wasmSize), report.wasmSize, 'artifact');
    report.engineExports = await page.evaluate(() => Object.keys(window.__edenLab?.module ?? {}).filter(key => /^_eden_/.test(key)).sort()).catch(() => []);

    if (bootGame && coreReady === 'WASM Core Ready') {
      stage = 'system-files';
      // Warm runs keep the keys and firmware installed by the first run.
      const installed = index > 0 && await page.evaluate(() => document.getElementById('sys-prod-keys').textContent === 'Installed' &&
        !/Missing/.test(document.getElementById('sys-firmware').textContent)).catch(() => false);
      if (!installed) {
        const importStart = Date.now();
        for (const [inputId, file] of [['#keys-input', keys], ['#firmware-input', firmware]]) {
          await (await page.$(inputId)).uploadFile(file);
          const result = await page.waitForFunction(() => {
            const text = document.getElementById('sys-progress').textContent;
            return /^(Imported|Import failed)/.test(text) && text;
          }, { timeout: 300_000, polling: 500 }).then(handle => handle.jsonValue());
          check(`import ${path.basename(file)}`, result.startsWith('Imported'), result, 'system-files');
        }
        report.systemFilesMs = Date.now() - importStart;
      }

      stage = 'boot';
      await (await page.$('#file-input')).uploadFile(rom);
      bootStart = Date.now();
      const deadline = bootStart + Number(args.seconds) * 1000;
      let shot = 0;
      const shotStages = new Set();
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Crash recovery reloads the page; skip samples taken while it navigates.
        const sample = await page.evaluate(wantPresent => {
          const lab = window.__edenLab;
          const fps = parseFloat(document.getElementById('fps-counter').textContent) || 0;
          if (wantPresent && fps > 0) lab?.startPresent();
          return {
            status: document.getElementById('wasm-status-text').textContent,
            state: document.getElementById('wasm-state').textContent,
            fps,
            load: document.getElementById('rom-eta').hidden ? '' : document.getElementById('rom-eta').textContent,
            progress: document.getElementById('rom-progress').value,
            drained: lab?.drain() ?? null,
          };
        }, args.present).catch(() => null);
        if (!sample) continue;
        const { drained } = sample;
        delete sample.drained;
        if (drained) {
          streams.raf.push(...drained.raf);
          streams.present.push(...drained.present);
          if (drained.engine) streams.engine.push(...drained.engine);
          if (drained.engineError && !report.engineError) report.engineError = drained.engineError;
        }
        sample.t = Math.round((Date.now() - bootStart) / 1000);
        report.timeline.push(sample);
        if (sample.fps > 0 && firstFrameAt === null) {
          firstFrameAt = drained?.now ?? Date.now();
          stage = 'running';
        }
        console.log(`  t=${sample.t}s ${sample.state} ${sample.fps.toFixed(1)} fps | ${sample.load}`);
        for (const loadStage of ['Reading', 'Booting', 'Loaded']) {
          if (sample.load.startsWith(loadStage) && !shotStages.has(loadStage)) {
            shotStages.add(loadStage);
            await page.screenshot({ path: path.join(artifacts, `e2e-${stamp}-load-${loadStage.toLowerCase()}.png`) }).catch(() => {});
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
      game = mergeGameInfo(fileGame, await page.evaluate(() => window.__edenLab?.gameInfo()).catch(() => null));

      const failedState = report.timeline.find(sample => sample.state === 'Failed');
      if (core) {
        const reported = consoleLog.find(line => line.includes('CPU core: ') && line.includes('Frontend'));
        check('engine uses selected core', reported?.includes(`CPU core: ${core.name}`), reported?.replace(/.*CPU core: /, '').replace(/\x1b\[[0-9;]*m/g, '') ?? 'not logged', 'init');
      }
      if (args['crash-at']) {
        const after = report.timeline.filter(sample => report.crashInjectedAt && sample.t > report.crashInjectedAt);
        check('crash simulated', Boolean(report.crashInjectedAt), report.crashInjectedAt ? `t=${report.crashInjectedAt}s` : 'game never drew a frame', 'no-frames');
        check('crash report stored', await page.$eval('#crash-count', el => Number(el.textContent) > 0), undefined, 'crash');
        check('game restarted', consoleLog.some(line => line.includes('CPU core:')) &&
          (await page.$eval('#recovery-status', el => el.textContent)).startsWith('Restarted'),
          await page.$eval('#recovery-status', el => el.textContent), 'crash');
        check('frames after restart', after.some(sample => sample.fps > 0), `${after.filter(sample => sample.fps > 0).length} samples with frames`, 'crash');
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
      report.sustainedFps = tail[Math.floor(tail.length / 2)] ?? 0;
      check('game boots', !failedState, failedState ? failedState.status : undefined, 'boot');
      check('game reaches Running', Boolean(running), running ? `${running.t} s` : last?.state, 'boot');
      // The page's own watchdog reports frames stopping as a crash "no frames for N s".
      const crashes = report.crashes.filter(crash => !/^no frames/.test(crash.reason));
      check('no crashes', crashes.length === 0, crashes.map(crash => `t=${crash.t}s ${crash.reason}`).join('; ') || undefined, 'crash');
      // A simulated crash restarts the game; the restart is checked above, not counted as a hang.
      const segments = report.crashInjectedAt
        ? [report.timeline.filter(s => s.t <= report.crashInjectedAt), report.timeline.filter(s => s.t > report.crashInjectedAt)]
        : [report.timeline];
      const hang = segments.map(segment => findHang(segment, hangSamples)).find(Boolean) ?? null;
      const frozen = report.crashes.find(crash => /^no frames/.test(crash.reason));
      report.hang = hang ?? (frozen ? { fromS: frozen.t, reason: frozen.reason } : null);
      check('no hang', !report.hang, hang ? `no frames from t=${hang.fromS}s for ${hang.samples * 2} s` : frozen?.reason, 'hang');
      check('first frame', firstFrame && firstFrame.t <= baseline.firstFrameS, firstFrame ? `${firstFrame.t} s <= ${baseline.firstFrameS} s` : 'no frames',
        firstFrame ? 'performance' : 'no-frames');
      check('peak game fps', peakFps >= baseline.minPeakFps, `${peakFps.toFixed(1)} >= ${baseline.minPeakFps}`, 'performance');
      check('sustained game fps', report.sustainedFps >= baseline.minSustainedFps, `median of last third ${report.sustainedFps.toFixed(1)} >= ${baseline.minSustainedFps}`, 'performance');
      check('still running at end', last?.state === 'Running', last?.state, firstFrame ? 'crash' : 'boot');
      const detailed = report.frames.filter(frame => frame.bytes >= baseline.minFramePngBytes);
      check('game frames visible', detailed.length > 0,
        `${detailed.length}/${report.frames.length} canvas captures >= ${baseline.minFramePngBytes} bytes, largest ${Math.max(0, ...report.frames.map(frame => frame.bytes))}`, 'no-frames');
      check('no critical logs', criticalLogs === 0, `${criticalLogs}`, 'crash');
    }

    check('no page errors', pageErrors.length === 0, pageErrors[0]?.message, pageErrors[0]?.booted ? 'crash' : 'init');
    check('no failed requests', report.errors.filter(error => /^(requestfailed|HTTP)/.test(error)).length === 0, undefined, 'artifact');
    await page.screenshot({ path: path.join(artifacts, `e2e-${stamp}-final.png`) });
  } catch (err) {
    // An exception mid-run must fail the run, not end it with only the checks made so far.
    const category = { environment: 'environment', init: 'init', 'system-files': 'system-files', boot: 'boot', running: 'crash' }[stage];
    check('run completed', false, err.message, category);
  } finally {
    await page.close().catch(() => {});
  }

  report.failures = failures;
  const reportPath = path.join(artifacts, `e2e-${stamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(path.join(artifacts, `e2e-${stamp}-console.log`), consoleLog.join('\n') + '\n');
  console.log(`${failures.length ? 'FAILED' : 'PASSED'}: ${report.checks.length - failures.length}/${report.checks.length} checks, report ${path.relative(process.cwd(), reportPath)}`);

  const { outcome, failure } = classify(report.checks);
  const windowStart = firstFrameAt === null ? null : firstFrameAt + warmupS * 1000;
  const runtimeVersion = runtime?.version
    ? [runtime.version.version, `web ${runtime.version.webRevision}`, `engine ${runtime.version.engineRevision}`].join(' · ') : report.version || null;
  const result = makeResult({
    source: 'e2e',
    createdAt: report.startedAt,
    game,
    core: {
      // A fresh profile runs the default core unless one is asked for.
      id: (core ?? DEFAULT_CORE).id, name: (core ?? DEFAULT_CORE).name, emulator: (core ?? DEFAULT_CORE).emulator, runtimeVersion,
      build: {
        webRevision: runtime?.version?.webRevision ?? null, engineRevision: runtime?.runtime?.engineRevision ?? runtime?.version?.engineRevision ?? null,
        build: runtime?.runtime?.build ?? runtime?.version?.build ?? null, local: runtime?.version?.local ?? null,
        engineExports: report.engineExports ?? [],
      },
    },
    environment,
    scenario: scenario(index),
    outcome,
    failure,
    metrics: {
      coreReadyMs: report.coreReadyMs ?? null,
      systemFilesMs: report.systemFilesMs ?? null,
      bootToRunningS: report.bootToRunningS ?? null,
      firstFrameS: report.firstFrameS ?? null,
      peakFps: bootGame ? report.peakFps ?? null : null,
      sustainedFps: bootGame ? report.sustainedFps ?? null : null,
      ...frameTimes(streams, windowStart),
      memoryReloads: report.memoryReloads ?? 0,
      crashes: report.crashes?.length ?? 0,
      hangAtS: report.hang?.fromS ?? null,
      largestFramePngBytes: report.frames.length ? Math.max(...report.frames.map(frame => frame.bytes)) : null,
    },
    notes: `report ${path.basename(reportPath)}`,
  });
  await writeResult(result, stamp);
  const ft = result.metrics.frameTime;
  if (ft) {
    console.log(`  frame time (${result.metrics.frameTimeSource}, ${ft.count} frames after ${warmupS} s warm-up): ` +
      `p50 ${ft.p50.toFixed(1)} p95 ${ft.p95.toFixed(1)} p99 ${ft.p99.toFixed(1)} max ${ft.max.toFixed(1)} ms, ${ft.stutters} stutters`);
  }
  console.log(`  outcome: ${outcome}${failure ? ` (${failure.category}: ${failure.detail})` : ''}`);
  return result;
}

const results = [];
try {
  for (let index = 0; index < repeat; index++) {
    if (repeat > 1) console.log(`--- run ${index + 1}/${repeat} (${index ? 'warm' : 'cold'})`);
    results.push(await runOnce(index));
    // Let the browser release the previous page's emulated memory before the next one reserves it.
    if (index + 1 < repeat) await new Promise(resolve => setTimeout(resolve, 3000));
  }
} finally {
  await browser.close();
  server?.close();
  await rm(profile, { recursive: true, force: true });
}

if (repeat > 1) {
  const stamp = results[0].createdAt.replace(/[:.]/g, '-');
  const summary = {};
  for (const [label, runs] of [['cold', results.slice(0, 1)], ['warm', results.slice(1)], ['all', results]]) summary[label] = summarizeRuns(runs);
  const set = makeResultSet(results, { source: 'e2e', scenario: scenarioName, core: (core ?? DEFAULT_CORE).id, repeat, summary });
  const setPath = path.join(artifacts, `e2e-${stamp}.set.json`);
  await writeFile(setPath, JSON.stringify(set, null, 2));
  const rows = Object.entries(summary.all).map(([metric]) => {
    const cell = stats => (stats ? `${+stats.median.toFixed(2)}` : '');
    const spread = stats => (stats && stats.n > 1 ? `${+stats.min.toFixed(2)}..${+stats.max.toFixed(2)} (${(stats.spread * 100).toFixed(0)}%)` : '');
    return { metric, cold: cell(summary.cold[metric]), 'warm median': cell(summary.warm[metric]), 'warm range': spread(summary.warm[metric]) };
  });
  console.log(`\n${table(rows, ['metric', 'cold', 'warm median', 'warm range'])}`);
  console.log(`outcomes: ${results.map(r => r.outcome).join(', ')}; set ${path.relative(process.cwd(), setPath)}`);
}

process.exit(results.every(result => result.outcome === 'pass') ? 0 : 1);
