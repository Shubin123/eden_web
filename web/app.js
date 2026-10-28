// SPDX-License-Identifier: GPL-3.0-or-later

import {
  importSystemFile,
  getSystemFileStatus,
  clearSystemFiles,
  mountSystemFiles,
  readZipEntries,
} from './system-files.js';
import { setupInput } from './input.js';
import { mountRom } from './rom-file.js';
import { mountBrowserRom } from './browser-rom.js';
import { setupAudio } from './audio.js';
import { setupCamera } from './camera.js';
import { createFrameWatchdog } from './frame-watchdog.js';
import { isArchive, openArchive, storedRomSlice } from './archive.js';
import { CPU_CORES, activeCore, coreBackend, coreEnvironment, findCore, runtimeBase, storeCore } from './cores.js';
import {
  restoreSaves,
  watchSaves,
  savePointInfo,
  clearSaves,
  exportSaves,
  importSaves,
  SLOT_COUNT,
  saveSlot,
  listSlots,
  loadSlot,
  clearSlot,
  recordCrash,
  listCrashes,
  clearCrashes,
} from './recovery.js';
import { setupCompatibility } from './compat.js';
import { setupDiagnostics } from './diagnostics.js';

// DOM Elements
const canvas = document.getElementById('canvas');
const dropZone = document.getElementById('drop-zone');
const browseBtn = document.getElementById('browse-btn');
const fileInput = document.getElementById('file-input');
const pauseOverlay = document.getElementById('pause-overlay');

const wasmBadge = document.getElementById('wasm-badge');
const wasmStatusText = document.getElementById('wasm-status-text');
const wasmState = document.getElementById('wasm-state');
const wasmSize = document.getElementById('wasm-size');
const coopStatus = document.getElementById('coop-status');

const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStep = document.getElementById('btn-step');
const btnReset = document.getElementById('btn-reset');
const btnFullscreen = document.getElementById('btn-fullscreen');
const screenStage = document.getElementById('screen-stage');
const switchDevice = document.getElementById('switch-device');
const romStatus = document.getElementById('rom-status');
const fileLabel = document.getElementById('file-label');
const fpsCaption = document.getElementById('fps');
const systemFps = document.getElementById('system-fps');
const emuSpeed = document.getElementById('emu-speed');
const logBox = document.getElementById('log');

const titleName = document.getElementById('title-name');
const titleSize = document.getElementById('title-size');
const fpsCounter = document.getElementById('fps-counter');
const frametimeCounter = document.getElementById('frametime-counter');

// State variables
let edenModule = null;
let isInitialized = false;
let isRomLoaded = false;
let isRunning = false;
let isPaused = false;
let animFrameId = null;
let currentRomName = '';
let currentRomData = null;
let gpuFailure = '';
let memoryUnavailable = false;
let loadingRom = false;
let crashed = false;
let browserRom = null;

// Log widget: engine output and frontend events, newest at the bottom.
const LOG_LIMIT = 500;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const recentLog = [];
function log(text, kind = '') {
  text = String(text).replace(ANSI_ESCAPE, '');
  // Frontend messages pass a kind; mirror them to the console, where engine output already goes.
  if (kind === 'ui' || kind === 'err') console.info('[UI]', text);
  recentLog.push(`${new Date().toISOString()} ${text}`);
  if (recentLog.length > 300) recentLog.shift();
  if (/WebGPU.*(?:failed|not available)|Failed to initialize GPU/i.test(text)) gpuFailure = text;
  // Right after a reload the browser may not have released the previous page's emulated memory
  // yet, so the runtime cannot reserve its own. Another reload succeeds once it has.
  if (/Failed to allocate fallback buffer/.test(text) && !memoryUnavailable) {
    memoryUnavailable = true;
    setTimeout(reloadForMemory, 0);
  }
  if (!kind && /<(Error|Critical)>/.test(text)) kind = 'err';
  else if (!kind && /<Warning>/.test(text)) kind = 'warn';
  const line = document.createElement('div');
  if (kind) line.className = `log-${kind}`;
  line.textContent = text;
  const atBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 4;
  logBox.append(line);
  while (logBox.childElementCount > LOG_LIMIT) logBox.firstElementChild.remove();
  if (atBottom) logBox.scrollTop = logBox.scrollHeight;
}

const diagnostics = setupDiagnostics({
  getModule: () => crashed ? null : edenModule,
  getLog: () => recentLog,
  getCore: () => runningCore,
  getGameFile: () => currentRomName,
  listCrashes,
  getSystemFileStatus,
});

// Load progress: mounting system files, copying the game into the engine filesystem (timed by
// live throughput), then booting (timed from previous boots on this browser, else a default).
const romProgress = document.getElementById('rom-progress');
const romEta = document.getElementById('rom-eta');
const LOAD_KEY = 'eden-load-history';
const loadHistory = { copyBytesPerSec: 300 * 1024 * 1024, bootSeconds: 15 };
try {
  Object.assign(loadHistory, JSON.parse(localStorage.getItem(LOAD_KEY) || '{}'));
} catch (_) {}
function saveLoadHistory() {
  try { localStorage.setItem(LOAD_KEY, JSON.stringify(loadHistory)); } catch (_) {}
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

const loader = {
  // Phase weights as a share of the whole bar; the estimates below decide how long each takes.
  start: 0,
  copyStart: 0,
  copyEnd: 0,
  bootStart: 0,
  total: 0,
  phase: 'idle',
  bytes: 0,
  bytesTotal: 0,
  timer: null,
  begin(bytesTotal) {
    this.start = performance.now();
    this.bytesTotal = bytesTotal;
    this.bytes = 0;
    this.phase = 'mount';
    romProgress.hidden = false;
    romEta.hidden = false;
    this.timer ??= setInterval(() => this.render(), 250);
    this.render();
  },
  elapsed() { return (performance.now() - this.start) / 1000; },
  copyEstimate() { return this.bytesTotal / loadHistory.copyBytesPerSec; },
  render() {
    if (this.phase === 'idle') return;
    const copyEst = this.copyEstimate();
    const bootEst = loadHistory.bootSeconds;
    const now = performance.now();
    let fraction = 0;
    let label = '';
    let remaining = 0;
    if (this.phase === 'mount') {
      label = 'Mounting keys & firmware';
      remaining = copyEst + bootEst + 2;
    } else if (this.phase === 'copy') {
      const sec = (now - this.copyStart) / 1000;
      const rate = this.bytes > 0 && sec > 0.5 ? this.bytes / sec : loadHistory.copyBytesPerSec;
      const copyRemaining = Math.max(0, this.bytesTotal - this.bytes) / rate;
      label = this.bytesTotal > 0
        ? `Reading game ${(this.bytes / 1048576).toFixed(0)} / ${(this.bytesTotal / 1048576).toFixed(0)} MB`
        : `Reading game ${(this.bytes / 1048576).toFixed(0)} MB`;
      remaining = copyRemaining + bootEst;
      fraction = this.bytesTotal > 0 ? this.bytes / this.bytesTotal * (copyEst / (copyEst + bootEst)) : 0;
    } else if (this.phase === 'boot') {
      const sec = (now - this.bootStart) / 1000;
      label = sec > bootEst ? 'Booting: taking longer than usual' : 'Booting game';
      remaining = Math.max(0, bootEst - sec);
      // The engine reports no boot progress, so ease toward 95% instead of stalling or overshooting.
      const bootFraction = Math.min(0.95, sec / bootEst * 0.95);
      fraction = copyEst / (copyEst + bootEst) + bootFraction * (bootEst / (copyEst + bootEst));
      if (sec > bootEst) fraction = Math.min(0.99, fraction);
    } else if (this.phase === 'done') {
      fraction = 1;
      label = `Loaded in ${formatDuration(this.doneAfter)}`;
    }
    romProgress.value = Math.round(fraction * 1000) / 10;
    romEta.textContent = this.phase === 'done'
      ? label
      : `${label} · ${Math.round(fraction * 100)}% · about ${formatDuration(remaining)} left · elapsed ${formatDuration(this.elapsed())}`;
  },
  setPhase(phase) {
    this.phase = phase;
    if (phase === 'copy') this.copyStart = performance.now();
    if (phase === 'boot') {
      this.bootStart = performance.now();
      const sec = (this.bootStart - this.copyStart) / 1000;
      if (this.bytesTotal > 0 && sec > 0.5) {
        loadHistory.copyBytesPerSec = this.bytesTotal / sec;
        saveLoadHistory();
      }
    }
    this.render();
  },
  finish() {
    if (this.phase !== 'boot') return;
    const bootSec = (performance.now() - this.bootStart) / 1000;
    loadHistory.bootSeconds = bootSec;
    saveLoadHistory();
    this.doneAfter = this.elapsed();
    this.phase = 'done';
    this.render();
    clearInterval(this.timer);
    this.timer = null;
    log(`Game loaded in ${formatDuration(this.doneAfter)} (boot ${formatDuration(bootSec)}).`, 'ui');
  },
  fail() {
    this.phase = 'idle';
    clearInterval(this.timer);
    this.timer = null;
    romProgress.hidden = true;
    romEta.hidden = true;
  },
};

function setRomStatus(text) {
  romStatus.textContent = text;
  log(text, 'ui');
}

document.getElementById('btn-log-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logBox.innerText);
  } catch (err) {
    log(`Copy failed: ${err.message}`, 'err');
  }
});
document.getElementById('btn-log-clear').addEventListener('click', () => logBox.replaceChildren());

const pollAudio = setupAudio(() => crashed ? null : edenModule, log);
setInterval(pollAudio, 500);

// Display settings, remembered per browser. The page works without storage.
const SETTINGS_KEY = 'eden-settings';
const settings = {
  filter: 'smooth', fit: 'contain', joycons: true, fullscreenJoycons: false, speedLimit: 100, lastCappedLimit: 100,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch (_) {}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

const screenFilter = document.getElementById('screen-filter');
const screenFit = document.getElementById('screen-fit');
const showJoycons = document.getElementById('show-joycons');
const fullscreenJoycons = document.getElementById('fullscreen-joycons');

function applySettings() {
  screenFilter.value = settings.filter;
  screenFit.value = settings.fit;
  showJoycons.checked = settings.joycons;
  fullscreenJoycons.checked = settings.fullscreenJoycons;
  screenStage.classList.toggle('is-pixelated', settings.filter === 'pixelated');
  screenStage.classList.toggle('is-stretched', settings.fit === 'fill');
  const fullscreen = screenStage.classList.contains('is-fullscreen');
  switchDevice.classList.toggle('no-joycons', fullscreen ? !settings.fullscreenJoycons : !settings.joycons);
}

for (const [input, key, read] of [
  [screenFilter, 'filter', el => el.value],
  [screenFit, 'fit', el => el.value],
  [showJoycons, 'joycons', el => el.checked],
  [fullscreenJoycons, 'fullscreenJoycons', el => el.checked],
]) {
  input.addEventListener('change', () => {
    settings[key] = read(input);
    saveSettings();
    applySettings();
  });
}
applySettings();

// Speed widget: capped at a percentage of the Switch's speed, or uncapped (0), which also lifts the
// game's own frame cap. The engine applies it at once, even mid-game.
const speedLimit = document.getElementById('speed-limit');
const speedMode = document.getElementById('speed-mode');
const speedFps = document.getElementById('speed-fps');
const speedPeak = document.getElementById('speed-peak');
const speedHelp = document.getElementById('speed-help');
const btnUncap = document.getElementById('btn-uncap');
let peakFps = 0;

function applySpeedLimit() {
  speedLimit.value = String(settings.speedLimit);
  const supported = typeof edenModule?._eden_set_speed_limit === 'function';
  if (edenModule && !supported) {
    speedLimit.disabled = btnUncap.disabled = true;
    speedHelp.textContent = 'This engine build has no speed limit control; games run at normal speed.';
  }
  if (supported && !crashed) edenModule._eden_set_speed_limit(settings.speedLimit);
  showSpeedLimit(supported && !crashed ? edenModule._eden_get_speed_limit() : settings.speedLimit);
}

function showSpeedLimit(limit) {
  speedMode.textContent = limit === 0 ? 'Uncapped' : `Capped at ${limit}%`;
  btnUncap.textContent = limit === 0 ? `⏸ Cap at ${settings.lastCappedLimit}%` : '⏩ Uncap';
}

function setSpeedLimit(limit) {
  settings.speedLimit = limit;
  if (limit > 0) settings.lastCappedLimit = limit;
  saveSettings();
  peakFps = 0;
  speedPeak.textContent = '--';
  applySpeedLimit();
  log(`Speed: ${speedMode.textContent}.`, 'ui');
}

speedLimit.addEventListener('change', () => setSpeedLimit(Number(speedLimit.value)));
btnUncap.addEventListener('click', () => setSpeedLimit(settings.speedLimit === 0 ? settings.lastCappedLimit : 0));
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyU' && !btnUncap.disabled) {
    e.preventDefault();
    btnUncap.click();
  }
});
applySpeedLimit();

// Renderer info: the WebGPU adapter the browser would hand the engine.
async function inspectGpu() {
  const gpuAdapter = document.getElementById('gpu-adapter');
  gpuAdapter.classList.remove('missing', 'highlight');
  try {
    if (!window.isSecureContext) throw new Error('open this page over HTTPS or localhost');
    if (!navigator.gpu) throw new Error('navigator.gpu is unavailable in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no high-performance GPU adapter was returned');
    const device = await adapter.requestDevice();
    device.destroy();
    const info = adapter.info || {};
    gpuAdapter.textContent = [info.vendor, info.architecture || info.device].filter(Boolean).join(' ') || 'Available';
    gpuAdapter.classList.add('highlight');
    return true;
  } catch (err) {
    gpuAdapter.textContent = `Unavailable (${err.message})`;
    gpuAdapter.classList.add('missing');
    const message = `WebGPU unavailable: ${err.message}. This engine has no WebGL fallback. Check browser GPU acceleration and GPU diagnostics.`;
    document.getElementById('renderer-help').textContent = message;
    log(message, 'err');
    return false;
  }
}

const canvasSize = document.getElementById('canvas-size');
new ResizeObserver(() => {
  const rect = canvas.getBoundingClientRect();
  canvasSize.textContent = `${canvas.width}×${canvas.height} (shown ${Math.round(rect.width)}×${Math.round(rect.height)})`;
}).observe(canvas);

document.getElementById('hw-threads').textContent = `${navigator.hardwareConcurrency || '?'} logical cores`;

// Check Cross-Origin Isolation
function checkIsolation() {
  if (window.crossOriginIsolated) {
    coopStatus.textContent = 'Active (COOP/COEP)';
    coopStatus.classList.add('highlight');
  } else {
    coopStatus.textContent = 'Inactive';
    coopStatus.classList.add('missing');
  }
}

// Fetch WASM size metadata
// version.json is written by the Pages workflow when deploying and by `npm run sync` locally.
async function showVersion() {
  const element = document.getElementById('build-version');
  const info = await fetch('version.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!info) {
    element.textContent = 'unknown';
    return;
  }
  const parts = [info.version, `web ${info.webRevision}`, `engine ${info.engineRevision}`];
  if (info.local) parts.push(info.build === 'dev' ? 'local dev build' : 'local');
  element.textContent = parts.join(' · ');
  element.title = info.deployedAt ? `Deployed ${info.deployedAt}` : 'Served locally';
  log(`Eden Web ${parts.join(' · ')}`, 'ui');
}

/// Loads the engine build of the selected core (its folder holds eden.js and eden.wasm).
function loadRuntimeScript() {
  if (typeof createEdenModule === 'function') return Promise.resolve();
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = `${runtimeBase(runningCore)}eden.js`;
    script.onload = script.onerror = () => resolve();
    document.body.append(script);
  });
}

async function inspectWasmBinary() {
  try {
    const res = await fetch(`${runtimeBase(runningCore)}eden.wasm`, { method: 'HEAD' });
    const len = res.ok ? res.headers.get('content-length') : null;
    wasmSize.textContent = len ? `${(parseInt(len, 10) / (1024 * 1024)).toFixed(1)} MB` : 'Unavailable';
  } catch (err) {
    console.warn('Could not query runtime/eden.wasm:', err);
    wasmSize.textContent = 'Unavailable';
  }
}

// Initialize Emscripten Eden Module. main() runs on a worker (PROXY_TO_PTHREAD); the exported
// functions only queue requests and read status, so calling them never blocks this thread.
let initPromise = null;
function initWasmCore() {
  initPromise ??= initWasmCoreOnce();
  return initPromise;
}

async function initWasmCoreOnce() {
  checkIsolation();
  await loadRuntimeScript();
  await inspectWasmBinary();

  if (typeof createEdenModule !== 'function') {
    wasmBadge.className = 'status-badge';
    wasmStatusText.textContent = 'Runtime missing';
    wasmState.textContent = `${runtimeBase(runningCore)}eden.js not found (run npm run sync)`;
    log(`${runtimeBase(runningCore)}eden.js not found (run npm run sync).`, 'err');
    diagnostics.fail('artifact', `${runtimeBase(runningCore)}eden.js not found`);
    initPromise = null;
    return;
  }
  if (!window.crossOriginIsolated) {
    wasmStatusText.textContent = 'Needs cross-origin isolation';
    wasmState.textContent = 'Reload once the service worker is active';
    log('Cross-origin isolation is not active yet; reload once the service worker is installed.', 'err');
    diagnostics.fail('environment', 'Cross-origin isolation is not active');
    initPromise = null;
    return;
  }

  const unsupported = diagnostics.blockingProblem();
  if (unsupported) {
    wasmBadge.className = 'status-badge';
    wasmStatusText.textContent = 'Browser not supported';
    wasmState.textContent = unsupported;
    log(unsupported, 'err');
    diagnostics.fail('environment', unsupported);
    return;
  }

  try {
    wasmStatusText.textContent = 'Instantiating WASM...';
    diagnostics.stage('init');
    edenModule = await createEdenModule({
      locateFile: (path) => runtimeBase(runningCore) + path,
      preRun: [coreEnvironment(runningCore)],
      print: (text) => { console.log('[Eden]', text); log(text); checkCrashOutput(text); },
      printErr: (text) => { console.error('[Eden]', text); log(text); checkCrashOutput(text); },
      onAbort: (what) => onCrash(`runtime aborted: ${what}`),
    });
    isInitialized = true;
    applySpeedLimit();
    showCoreInfo();
    pollAudio();
    statusTimer ??= setInterval(pollStatus, 500);
    compat.coreReady();
    wasmBadge.className = 'status-badge ready';
    wasmStatusText.textContent = 'WASM Core Ready';
    wasmState.textContent = 'Idle';
    log('Eden WebAssembly core ready.', 'ui');
    diagnostics.stage('ready');
  } catch (err) {
    console.error('Failed to initialize Eden WebAssembly module:', err);
    wasmBadge.className = 'status-badge';
    wasmStatusText.textContent = 'WASM Init Failed';
    wasmState.textContent = 'Error: ' + err.message;
    log(`WASM init failed: ${err.message}`, 'err');
    diagnostics.fail(null, err);
  }
}

function reloadForMemory() {
  let attempts = 0;
  try { attempts = Number(sessionStorage.getItem('eden-memory-reloads')) || 0; } catch {}
  if (attempts >= 5) {
    log('Could not reserve emulated memory after 5 reloads; close other tabs and reload.', 'err');
    memoryUnavailable = false;
    return false;
  }
  try {
    sessionStorage.setItem('eden-memory-reloads', String(attempts + 1));
    // Keep a pending crash restart for the next load.
    if (resume) sessionStorage.setItem(RESUME_KEY, JSON.stringify(resume));
  } catch {}
  // Give the browser time to release the old memory; it does so lazily.
  const delay = Math.min(2000 * (attempts + 1), 10_000);
  wasmStatusText.textContent = 'Waiting for memory, reloading...';
  log(`The previous page still holds emulated memory; reloading in ${delay / 1000} s to reserve it.`, 'ui');
  setTimeout(() => location.reload(), delay);
  return true;
}

const EmuState = ['Idle', 'Booting', 'Running', 'Paused', 'Failed', 'Stopped'];
let statusTimer = null;
let lastState = -1;

const coreReadErrors = new Set();
function readCoreJson(name) {
  if (crashed || typeof edenModule?.[`_${name}`] !== 'function') return null;
  try {
    return JSON.parse(edenModule.ccall(name, 'string', [], []));
  } catch (err) {
    if (!coreReadErrors.has(name)) log(`${name}: ${err.message}`, 'err');
    coreReadErrors.add(name);
    return null;
  }
}

function showCoreInfo() {
  const capabilities = readCoreJson('eden_get_capabilities');
  document.getElementById('engine-api').textContent = capabilities?.apiVersion ?? 'Legacy';
  const reported = capabilities?.cpuBackend;
  const core = !reported || reported === coreBackend(runningCore) ? runningCore : findCore(reported) ?? runningCore;
  document.getElementById('engine-cpu').textContent = core.name;
  document.getElementById('cpu-core-active').textContent = core.name;
  document.getElementById('renderer-backend').textContent = capabilities?.renderer ?? 'WebGPU';
  const build = readCoreJson('eden_get_build_info');
  if (capabilities) log(`Core API ${capabilities.apiVersion}: ${core.name}, ${capabilities.renderer}, audio ${capabilities.audio ?? 'unavailable'}.`, 'ui');
  if (build?.describe) log(`Engine build: ${build.describe}, ${build.buildType}${build.devBuild ? ' (development)' : ''}${build.dirty ? ', modified source' : ''}.`, 'ui');
  if (core.id !== runningCore.id) log(`Core mismatch: requested ${runningCore.name}, engine reports ${core.name}.`, 'err');
}

let titleInfoRead = false;
let runningGame = null;
function showRuntimeInfo(state) {
  if (state === 2 && !titleInfoRead) {
    const info = readCoreJson('eden_get_game_info');
    if (info?.name) {
      const titleId = /^[0-9A-F]{16}$/i.test(info.titleId ?? '') ? info.titleId
        : currentRomName.match(/\[([0-9A-F]{16})\]/i)?.[1];
      runningGame = titleId ? { titleId: titleId.toUpperCase(), name: info.name } : null;
      refreshSlots();
      titleName.textContent = info.name;
      titleName.title = [info.titleId, info.displayVersion].filter(Boolean).join(' · ');
      log(`Game: ${info.name}, title ${info.titleId}${info.displayVersion ? `, version ${info.displayVersion}` : ''}.`, 'ui');
      titleInfoRead = true;
    }
  }
  const stats = readCoreJson('eden_get_runtime_stats');
  if (!stats) return;
  document.getElementById('engine-frames').textContent = String(stats.frames);
  document.getElementById('engine-heap').textContent = `${(stats.heapBytes / 1048576).toFixed(0)} MB`;
  document.getElementById('engine-shaders').textContent = `${stats.shaderCompiles} (${stats.shaderCompileFailures} failed)`;
  return stats;
}

function pollStatus() {
  if (!edenModule || crashed || memoryUnavailable) return;
  const state = edenModule._eden_get_state();
  const runtimeStats = showRuntimeInfo(state);
  const name = EmuState[state] || `State ${state}`;
  wasmState.textContent = name;
  isRunning = state === 2;
  isPaused = state === 3;
  pauseOverlay.style.display = isPaused ? 'flex' : 'none';
  fullscreenPause.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  fullscreenPause.disabled = !(isRunning || isPaused);
  btnPlay.disabled = !isPaused;
  btnPause.disabled = !isRunning;
  btnReset.disabled = !(isRunning || isPaused);
  btnStep.disabled = true;
  if (isRunning) attachPipStream();
  if (state !== lastState) {
    lastState = state;
    if (state === 1) peakFps = 0;
    log(`Emulation state: ${name}`, state === 4 ? 'err' : 'ui');
    if ((state === 2 || state === 4) && edenModule._eden_is_switch2_title?.() === 1) {
      log('This is a Nintendo Switch 2 game. Switch 2 games are not supported yet, so it may not boot or run correctly.', 'err');
    }
  }
  if (state === 4) {
    loader.fail();
    wasmStatusText.textContent = edenModule._eden_is_switch2_title?.() === 1
      ? 'Boot failed: Nintendo Switch 2 games are not supported yet'
      : `Boot failed (load result ${edenModule._eden_get_load_result()})`;
    romStatus.textContent = gpuFailure ? `GPU initialization failed: ${gpuFailure}. This runtime has no WebGL fallback; see the engine log for adapter/device errors.` : wasmStatusText.textContent;
  } else if (state >= 1 && state <= 3) {
    wasmStatusText.textContent = `${name}: ${currentRomName}`;
  }
  const finite = (value) => (Number.isFinite(value) ? value : 0);
  const gameFps = finite(edenModule._eden_get_game_fps());
  // Running is reported as soon as the core starts; the game is loaded once it draws a frame.
  if (state === 2 && gameFps > 0) loader.finish();
  watchFrames(state, gameFps, runtimeStats?.frames);
  const speed = finite(edenModule._eden_get_emulation_speed()) * 100;
  fpsCounter.textContent = `${gameFps.toFixed(1)} FPS`;
  systemFps.textContent = `${finite(edenModule._eden_get_system_fps()).toFixed(1)} FPS`;
  frametimeCounter.textContent = `${finite(edenModule._eden_get_frametime()).toFixed(2)} ms`;
  const limit = edenModule._eden_get_speed_limit?.() ?? 100;
  const uncapped = limit === 0;
  if (edenModule._eden_get_speed_limit) showSpeedLimit(limit);
  emuSpeed.textContent = `${speed.toFixed(0)}%${uncapped ? ' · uncapped' : ''}`;
  fpsCaption.textContent = isRunning ? `${gameFps.toFixed(1)} FPS · ${uncapped ? 'uncapped' : `${speed.toFixed(0)}%`}` : '';
  if (isRunning) peakFps = Math.max(peakFps, gameFps);
  speedFps.textContent = isRunning ? `${gameFps.toFixed(1)} FPS` : '--';
  speedPeak.textContent = peakFps > 0 ? `${peakFps.toFixed(1)} FPS` : '--';
}

function startLoop() {
  log('Controls: resume requested.', 'ui');
  edenModule?._eden_resume();
}

function pauseLoop() {
  log('Controls: pause requested.', 'ui');
  edenModule?._eden_pause();
}

function resetEmulation() {
  // The core does not support rebooting in place; reload the page to start over.
  if (!crashed) edenModule?._eden_shutdown();
  location.reload();
}

const ROM_EXTENSIONS = ['.nsp', '.xci', '.nro', '.nca', '.nso'];
// .nca is left out: an archive of NCAs is a firmware dump.
const ARCHIVED_ROM_EXTENSIONS = ['.nsp', '.xci', '.nro', '.nso'];

const hasExtension = (name, extensions) => extensions.some(ext => name.toLowerCase().endsWith(ext));
const baseName = (name) => name.split('/').pop();

// Finds the first game in a ZIP, 7z, RAR or other archive, or returns null if there is none.
async function findRomInArchive(file) {
  if (file.name.toLowerCase().endsWith('.zip')) {
    try {
      const roms = (await readZipEntries(file)).filter(e => hasExtension(e.name, ARCHIVED_ROM_EXTENSIONS));
      if (roms.length === 0) return null;
      if (roms[0].supported) {
        if (roms.length > 1) log(`${file.name} holds ${roms.length} ROMs; loading ${roms[0].name}.`, 'ui');
        return { ...roms[0], name: baseName(roms[0].name) };
      }
    } catch (err) {
      log(`${file.name}: ${err.message}; retrying with the archive decoder.`, 'ui');
    }
  }
  const { rom } = await openArchive(file, { romExtensions: ARCHIVED_ROM_EXTENSIONS, systemExtensions: [] });
  if (!rom) return null;
  const stored = await storedRomSlice(file, rom).catch(() => null);
  if (stored) {
    log(`${file.name}: ${baseName(rom.name)} is stored uncompressed; reading it in place.`, 'ui');
    return { name: baseName(rom.name), size: rom.size, file: stored, stream: async () => stored.stream() };
  }
  // The check may have read from the decoder, so start it again.
  rom.cancel?.();
  const { rom: decoded } = await openArchive(file, { romExtensions: ARCHIVED_ROM_EXTENSIONS, systemExtensions: [] });
  return decoded ? { ...decoded, name: baseName(decoded.name) } : null;
}

// Handle dropped or selected ROM file, or an archive holding one
async function handleFile(file) {
  if (!file) return;
  if (loadingRom || isRomLoaded) {
    log('ROM selection ignored: a game is already loading or loaded.', 'ui');
    return;
  }
  loadingRom = true;
  fileInput.disabled = true;
  browseBtn.disabled = true;
  try {
    await loadFile(file);
  } finally {
    loadingRom = false;
    fileInput.disabled = isRomLoaded;
    browseBtn.disabled = isRomLoaded;
  }
}

async function loadFile(file) {
  let rom = { name: file.name, size: file.size, file, stream: async () => file.stream() };
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.keys')) {
    await importSystemFiles([file]);
    return;
  }
  if (isArchive(lowerName)) {
    if (isRomLoaded) {
      alert('A game is already running. Reload the page to start another one.');
      return;
    }
    setRomStatus(`Opening ${file.name}...`);
    let found;
    const openedAt = performance.now();
    log(`Opening archive ${file.name} (${file.size} bytes).`, 'ui');
    try {
      found = await findRomInArchive(file);
    } catch (err) {
      setRomStatus(`Cannot open ${file.name}: ${err.message}`);
      diagnostics.fail(null, err);
      alert(`Cannot open ${file.name}: ${err.message}`);
      return;
    }
    if (!found) {
      setRomStatus(`${file.name} holds no game; importing it as keys or firmware.`);
      await importSystemFiles([file]);
      return;
    }
    rom = found;
    log(`Archive selected ${rom.name} (${rom.size} bytes) in ${((performance.now() - openedAt) / 1000).toFixed(1)} s.`, 'ui');
  } else if (!hasExtension(lowerName, ROM_EXTENSIONS)) {
    setRomStatus(`Unsupported ROM format "${file.name}".`);
    alert(`Unsupported ROM format "${file.name}".`);
    return;
  }
  if (isRomLoaded) {
    alert('A game is already running. Reload the page to start another one.');
    return;
  }

  try {
    if (!await inspectGpu()) {
      setRomStatus('Cannot boot: WebGPU is unavailable. See the Renderer card for details. This runtime has no WebGL fallback.');
      diagnostics.fail('environment', 'WebGPU is unavailable');
      return;
    }

    await initWasmCore();
    if (!isInitialized) {
      alert('The Eden WebAssembly core is not ready.');
      return;
    }

    currentRomName = rom.name;
    titleName.textContent = rom.name;
    fileLabel.textContent = rom.name;
    titleSize.textContent = rom.size >= 0 ? `${(rom.size / (1024 * 1024)).toFixed(2)} MB` : 'Unknown';

    // Raw compressed streams (game.nsp.xz) do not record the size, so progress shows bytes only.
    loader.begin(Math.max(rom.size, 0));
    try {
      wasmStatusText.textContent = 'Mounting keys & firmware...';
      setRomStatus('Mounting keys & firmware...');
      diagnostics.stage('system-files');
      const mounted = await mountSystemFiles(edenModule.FS);
      log(`Mounted ${mounted} system files into the Eden data directory.`, 'ui');
      const restored = await restoreSaves(edenModule.FS).catch(err => {
        log(`Could not restore in-game saves: ${err.message}`, 'err');
        return 0;
      });
      if (restored) log(`Restored ${restored} in-game save files from the last save point.`, 'ui');

      wasmStatusText.textContent = `Reading ${rom.name}...`;
      setRomStatus(`Reading ${rom.name}...`);
      const path = '/roms/' + rom.name;
      edenModule.FS.mkdirTree('/roms');
      loader.setPhase('copy');
      diagnostics.stage('copy');
      let copied;
      if (edenModule._eden_register_browser_rom && (rom.file || navigator.storage?.getDirectory)) {
        browserRom = await mountBrowserRom(edenModule, path, rom, bytes => { loader.bytes = bytes; });
        copied = browserRom.bytes;
      } else {
        copied = await mountRom(edenModule.FS, path, rom, bytes => { loader.bytes = bytes; });
      }
      log(`Mounted ${rom.name}: ${copied} bytes in ${((performance.now() - loader.copyStart) / 1000).toFixed(1)} s.`, 'ui');
      loader.setPhase('boot');
      diagnostics.stage('boot');

      if (edenModule.ccall('eden_boot', 'number', ['string'], [path]) !== 0) {
        throw new Error('eden_boot rejected the request');
      }
      isRomLoaded = true;
      lastGameFile = file;
      bootedAt = performance.now();
      stopSaveWatch?.();
      stopSaveWatch = watchSaves(() => edenModule?.FS, () => isRunning && !crashed, showSavePoint);
      compat.startSession({ module: edenModule, rom, core: runningCore });
      dropZone.style.display = 'none';
      fileInput.disabled = true;
      setRomStatus(`Booting ${rom.name}. Reload the page to load a different game.`);
      statusTimer ??= setInterval(pollStatus, 500);
    } catch (err) {
      browserRom?.close();
      browserRom = null;
      console.error('Failed to load ROM:', err.stack || err.message);
      alert(`Failed to load ROM: ${err.message}`);
      loader.fail();
      wasmStatusText.textContent = 'ROM Load Failed';
      setRomStatus(`ROM load failed: ${err.message}`);
      diagnostics.fail(null, err);
    }
  } finally {
    await rom.cancel?.().catch(() => {});
  }
}

// UI Event Listeners
browseBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleFile(fileInput.files[0]);
  }
});

btnPlay.addEventListener('click', startLoop);
btnPause.addEventListener('click', pauseLoop);
btnReset.addEventListener('click', resetEmulation);

// Fullscreen: the stage (Joy-Con frame + screen) fills the display.
const fullscreenPause = document.getElementById('btn-fullscreen-pause');
const fullscreenHelp = document.getElementById('fullscreen-help');
const canFullscreen = !!(screenStage.requestFullscreen || screenStage.webkitRequestFullscreen);
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

function toggleFullscreen() {
  if (fullscreenElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else if (canFullscreen) {
    (screenStage.requestFullscreen || screenStage.webkitRequestFullscreen).call(screenStage)?.catch?.(err => {
      log(`Fullscreen failed: ${err.message}`, 'err');
    });
  }
}

function onFullscreenChange() {
  const active = fullscreenElement() === screenStage;
  screenStage.classList.toggle('is-fullscreen', active);
  btnFullscreen.textContent = active ? '✕ Exit fullscreen' : '⛶ Fullscreen';
  applySettings();
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

if (!canFullscreen) {
  btnFullscreen.disabled = true;
  fullscreenHelp.textContent = 'This browser does not allow fullscreen for page content.';
}
btnFullscreen.addEventListener('click', toggleFullscreen);
document.getElementById('btn-fullscreen-stage').addEventListener('click', toggleFullscreen);
document.getElementById('btn-fullscreen-exit').addEventListener('click', toggleFullscreen);
fullscreenPause.disabled = true;
fullscreenPause.addEventListener('click', () => (isPaused ? startLoop() : pauseLoop()));
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'Enter') {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key === 'Escape' && fullscreenElement() === screenStage) {
    toggleFullscreen();
  }
});

// Picture-in-picture: a video fed by the canvas stream floats above other windows.
// Keyboard and gamepad input still reach this tab, which keeps rendering while hidden.
const pipVideo = document.getElementById('pip-video');
const btnPip = document.getElementById('btn-pip');
const btnPipStage = document.getElementById('btn-pip-stage');
const pipOverlay = document.getElementById('pip-overlay');
const pipHelp = document.getElementById('pip-help');
const canPip = !!(document.pictureInPictureEnabled && canvas.captureStream && pipVideo.requestPictureInPicture);

// The canvas stream only has frames once a game draws, so it is attached at boot
// and PiP stays unavailable until the video has its first frame.
function attachPipStream() {
  if (!canPip || pipVideo.srcObject) return;
  pipVideo.srcObject = canvas.captureStream(60);
  pipVideo.play().catch(() => {});
}
pipVideo.addEventListener('loadedmetadata', () => {
  btnPip.disabled = false;
  btnPipStage.disabled = false;
});

async function togglePictureInPicture() {
  if (!canPip) return;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }
    if (pipVideo.readyState < 1) return;
    if (fullscreenElement()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    await pipVideo.requestPictureInPicture();
  } catch (err) {
    log(`Picture-in-picture failed: ${err.message}`, 'err');
  }
}

function onPipChange(active) {
  pipOverlay.hidden = !active;
  btnPip.textContent = active ? '✕ Exit picture-in-picture' : '⧉ Picture-in-picture';
  if (!active) pipVideo.play().catch(() => {});
}
pipVideo.addEventListener('enterpictureinpicture', () => onPipChange(true));
pipVideo.addEventListener('leavepictureinpicture', () => onPipChange(false));
// The PiP window's play/pause buttons drive the emulator rather than the stream.
pipVideo.addEventListener('pause', () => {
  if (document.pictureInPictureElement === pipVideo && isRunning) pauseLoop();
});
pipVideo.addEventListener('play', () => {
  if (document.pictureInPictureElement === pipVideo && isPaused) startLoop();
});

if (canPip) {
  btnPip.disabled = true;
  btnPipStage.disabled = true;
  btnPip.addEventListener('click', togglePictureInPicture);
  btnPipStage.addEventListener('click', togglePictureInPicture);
  document.getElementById('btn-pip-return').addEventListener('click', togglePictureInPicture);
} else {
  btnPip.disabled = true;
  btnPipStage.hidden = true;
  pipHelp.textContent = 'This browser does not support picture-in-picture for the game screen.';
}
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyP') {
    e.preventDefault();
    togglePictureInPicture();
  }
});

// Controller input goes to the engine once a game is running.
const gamepads = setupInput(() => (isRomLoaded && !crashed ? edenModule : null));
{
  const list = document.getElementById('gamepad-list');
  const layout = document.getElementById('gamepad-layout');
  const multiplayer = document.getElementById('gamepad-multiplayer');
  const rumble = document.getElementById('gamepad-rumble');
  const testRumble = document.getElementById('btn-test-rumble');
  layout.value = gamepads.prefs.layout;
  multiplayer.checked = gamepads.prefs.multiplayer;
  rumble.checked = gamepads.prefs.rumble;
  layout.addEventListener('change', () => gamepads.setLayout(layout.value));
  multiplayer.addEventListener('change', () => gamepads.setMultiplayer(multiplayer.checked));
  rumble.addEventListener('change', () => gamepads.setRumble(rumble.checked));
  testRumble.addEventListener('click', () => gamepads.testRumble());
  gamepads.onChange(pads => {
    list.replaceChildren(...(pads.length ? pads.map(pad => {
      const item = document.createElement('li');
      const notes = [pad.standard ? '' : 'non-standard mapping, buttons may be mixed up', pad.rumble ? '' : 'no rumble']
        .filter(Boolean).join('; ');
      item.textContent = `Player ${pad.player}: ${pad.id}${notes ? ` (${notes})` : ''}`;
      return item;
    }) : [Object.assign(document.createElement('li'), {
      className: 'mode-help',
      textContent: 'No gamepad yet. Connect one and press a button so the browser shows it.',
    })]));
    testRumble.disabled = !pads.some(pad => pad.rumble);
  });
}
setupCamera(() => (isRomLoaded && !crashed ? edenModule : null), log);

// Keys & firmware widget
const systemCard = document.getElementById('system-files-card');
const systemTag = document.getElementById('system-files-tag');
const sysProdKeys = document.getElementById('sys-prod-keys');
const sysTitleKeys = document.getElementById('sys-title-keys');
const sysFirmware = document.getElementById('sys-firmware');
const sysProgress = document.getElementById('sys-progress');
const keysInput = document.getElementById('keys-input');
const firmwareInput = document.getElementById('firmware-input');
const systemButtons = ['btn-add-keys', 'btn-add-firmware', 'btn-clear-system']
  .map(id => document.getElementById(id));

function setPresence(elem, present, text) {
  elem.textContent = text;
  elem.classList.toggle('highlight', present);
  elem.classList.toggle('missing', !present);
}

async function refreshSystemStatus() {
  try {
    const status = await getSystemFileStatus();
    systemTag.classList.toggle('highlight', status.prodKeys);
    systemTag.classList.toggle('missing', !status.prodKeys);
    setPresence(sysProdKeys, status.prodKeys, status.prodKeys ? 'Installed' : 'Missing');
    setPresence(sysTitleKeys, status.titleKeys, status.titleKeys ? 'Installed' : 'Optional');
    sysTitleKeys.classList.remove('missing');
    const mb = (status.firmwareBytes / (1024 * 1024)).toFixed(0);
    setPresence(sysFirmware, status.firmwareCount > 0,
      status.firmwareCount > 0 ? `${status.firmwareCount} NCAs, ${mb} MB` : 'Missing');
    systemTag.textContent = status.prodKeys ? 'Ready' : 'Keys required';
    if (status.firmwareSource) {
      sysFirmware.title = status.firmwareSource;
    }
  } catch (err) {
    systemTag.textContent = 'Unavailable';
    sysProgress.textContent = `IndexedDB unavailable: ${err.message}`;
  }
}

async function importSystemFiles(files) {
  systemButtons.forEach(btn => { btn.disabled = true; });
  try {
    for (const file of files) {
      sysProgress.textContent = `Importing ${file.name}...`;
      const result = await importSystemFile(file, (copied, total) => {
        sysProgress.textContent = `Importing ${file.name}: ${copied}/${total} NCAs`;
      });
      const parts = [];
      if (result.keys.length) parts.push(result.keys.join(', '));
      if (result.firmwareCount) parts.push(`${result.firmwareCount} firmware NCAs`);
      sysProgress.textContent = `Imported ${parts.join(' and ')} from ${file.name}.`;
    }
    if (isRomLoaded) {
      sysProgress.textContent += ' Reload the page to apply.';
    }
  } catch (err) {
    console.error('System file import failed:', err);
    sysProgress.textContent = `Import failed: ${err.message}`;
  } finally {
    systemButtons.forEach(btn => { btn.disabled = false; });
    await refreshSystemStatus();
  }
}

document.getElementById('btn-add-keys').addEventListener('click', () => keysInput.click());
document.getElementById('btn-add-firmware').addEventListener('click', () => firmwareInput.click());
document.getElementById('btn-clear-system').addEventListener('click', async () => {
  if (!confirm('Remove stored keys and firmware from this browser?')) return;
  await clearSystemFiles();
  sysProgress.textContent = 'Cleared stored keys and firmware.';
  await refreshSystemStatus();
});

for (const input of [keysInput, firmwareInput]) {
  input.addEventListener('change', () => {
    importSystemFiles([...input.files]);
    input.value = '';
  });
}

// Only file drags count here; dragging a widget over this card moves it.
const isFileDrag = (e) => [...e.dataTransfer.types].includes('Files');
systemCard.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  systemCard.classList.add('dragover');
});
systemCard.addEventListener('dragleave', () => systemCard.classList.remove('dragover'));
systemCard.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  systemCard.classList.remove('dragover');
  importSystemFiles([...e.dataTransfer.files]);
});

// Crash recovery. When the running game breaks (the runtime aborts, a thread throws, guest code
// faults, or frames stop), the crash is recorded for later testing and the page reloads and boots
// the same game again from the last save point. The runtime cannot be restarted in place (a new
// instance cannot get memory while the crashed one still holds it), so the game file is copied to
// the origin-private file system first and the reloaded page boots from that copy. Repeated
// crashes stop the restarts so a broken game cannot loop forever.
const MAX_RESTARTS = 2;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const FREEZE_MS = 45_000;
const RESUME_KEY = 'eden-resume';
const RESTARTS_KEY = 'eden-restarts';
const RESUME_DIR = 'crash-resume';
let lastGameFile = null;
let bootedAt = 0;
let stopSaveWatch = null;
const autoRestart = document.getElementById('auto-restart');
const recoveryStatus = document.getElementById('recovery-status');

function readSession(key, fallback) {
  try {
    return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
// The resume marker is used once; restart times survive reloads so the limit holds across them.
const resume = readSession(RESUME_KEY, null);
try { sessionStorage.removeItem(RESUME_KEY); } catch {}
const restarts = readSession(RESTARTS_KEY, []).filter(time => Date.now() - time < RESTART_WINDOW_MS);

const CRASH_OUTPUT = [
  /Eden native termination:/,
  /worker sent an error!/,
  /Aborted\(/,
  /RuntimeError/,
  /Core\.ARM <Critical>/,
  /WebGPU device lost/,
];

function checkCrashOutput(text) {
  if (!isRomLoaded || crashed) return;
  const clean = String(text).replace(ANSI_ESCAPE, '');
  if (CRASH_OUTPUT.some(pattern => pattern.test(clean))) onCrash(clean.slice(0, 300));
}

// Frame counters keep the watchdog effective when a dead worker leaves a stale FPS value.
const observeFrames = createFrameWatchdog({
  timeoutMs: FREEZE_MS,
  onFirstFrame: () => {
    try { sessionStorage.removeItem('eden-memory-reloads'); } catch {}
  },
  onFreeze: onCrash,
});
function watchFrames(state, gameFps, frames) {
  if (crashed || !isRomLoaded) return;
  observeFrames(state, gameFps, frames);
}

async function onCrash(reason) {
  // A reload for memory is already on its way; the errors that follow are not a game crash.
  if (crashed || !lastGameFile || memoryUnavailable) return;
  crashed = true;
  isRunning = false;
  isPaused = false;
  clearInterval(statusTimer);
  statusTimer = null;
  wasmState.textContent = 'Crashed';
  wasmStatusText.textContent = `Crashed: ${currentRomName}`;
  fpsCaption.textContent = '';
  fpsCounter.textContent = '--';
  speedFps.textContent = '--';
  systemFps.textContent = '--';
  frametimeCounter.textContent = '-- ms';
  emuSpeed.textContent = '--';
  pauseOverlay.style.display = 'none';
  fullscreenPause.disabled = true;
  try { edenModule?._eden_set_audio_volume?.(0, 1); } catch {}
  btnPlay.disabled = true;
  btnPause.disabled = true;
  btnReset.disabled = false;
  stopSaveWatch?.();
  diagnostics.fail(/^no frames/.test(reason) ? 'hang' : 'crash', reason);
  // The engine logs a backtrace right after a guest fault; include it in the report.
  await new Promise(resolve => setTimeout(resolve, 500));
  const version = await fetch('version.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const report = {
    time: new Date().toISOString(),
    reason,
    game: currentRomName,
    file: lastGameFile.name,
    core: runningCore.id,
    version,
    uptimeSeconds: Math.round((performance.now() - bootedAt) / 1000),
    restartsBefore: restarts.length,
    userAgent: navigator.userAgent,
    log: recentLog.slice(-200),
  };
  log(`Game crashed on ${runningCore.name}: ${reason}`, 'err');
  await recordCrash(report).catch(err => console.warn('Could not store crash report:', err));
  await compat.crashed(reason);
  refreshCrashReports();

  const hint = runningCore.id === 'jit' ? ' If it keeps happening, try the IR interpreter core.' : '';
  if (!autoRestart.checked || restarts.length >= MAX_RESTARTS) {
    setRomStatus(`${currentRomName} stopped working (${reason}). The crash was logged.${hint} Reload the page to start again.`);
    recoveryStatus.textContent = restarts.length >= MAX_RESTARTS
      ? `Stopped restarting after ${MAX_RESTARTS} crashes in 10 minutes.${hint}`
      : 'Crashed; automatic restart is off.';
    return;
  }
  recoveryStatus.textContent = `Crashed (${reason}); restarting from the last save point...`;
  setRomStatus(`${currentRomName} stopped working. Restarting from your last save point...`);
  try {
    await stashGameFile(lastGameFile);
  } catch (err) {
    setRomStatus(`${currentRomName} stopped working and could not be restarted automatically (${err.message}). Reload the page and pick the game again.`);
    return;
  }
  try {
    sessionStorage.setItem(RESTARTS_KEY, JSON.stringify([...restarts, Date.now()]));
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ name: lastGameFile.name, reason }));
  } catch {}
  // Don't call into the crashed runtime here: a thread that died holding a lock would block this
  // thread. The reload discards the instance.
  setTimeout(() => location.reload(), 1000);
}

async function resumeDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RESUME_DIR, { create: true });
}

async function stashGameFile(file) {
  const dir = await resumeDir();
  // A file already stashed by an earlier restart is the same game; keep it.
  const existing = await dir.getFileHandle(file.name).then(handle => handle.getFile()).catch(() => null);
  if (existing?.size === file.size) return;
  const writable = await (await dir.getFileHandle(file.name, { create: true })).createWritable();
  await file.stream().pipeTo(writable);
}

async function resumeAfterCrash() {
  if (!resume) {
    // A normal page load: drop any game copy left from an earlier crash.
    navigator.storage?.getDirectory?.().then(root => root.removeEntry(RESUME_DIR, { recursive: true })).catch(() => {});
    return;
  }
  try {
    const file = await (await (await resumeDir()).getFileHandle(resume.name)).getFile();
    if (resume.slot) {
      savesStatus.textContent = `Restarted from slot ${resume.slot}.`;
      log(`Restarting ${resume.name} from save slot ${resume.slot}.`, 'ui');
    } else {
      recoveryStatus.textContent = `Restarted after a crash (${resume.reason}).`;
      log(`Restarting ${resume.name} after a crash (${resume.reason}).`, 'ui');
    }
    await handleFile(file);
  } catch (err) {
    setRomStatus(`Could not restart ${resume.slot ? 'from the slot' : 'after the crash'} (${err.message}). Pick the game again.`);
  }
}

function showSavePoint(meta) {
  document.getElementById('btn-saves-export').disabled = !meta?.files;
  if (!meta) return;
  const kb = (meta.bytes / 1024).toFixed(0);
  document.getElementById('save-point').textContent =
    `${meta.files} files, ${kb} KB, ${new Date(meta.time).toLocaleTimeString()}`;
}

async function refreshCrashReports() {
  const reports = await listCrashes().catch(() => []);
  document.getElementById('crash-count').textContent = String(reports.length);
  document.getElementById('btn-crash-download').disabled = reports.length === 0;
  document.getElementById('btn-crash-clear').disabled = reports.length === 0;
}

document.getElementById('btn-crash-download').addEventListener('click', async () => {
  const reports = await listCrashes();
  const blob = new Blob([JSON.stringify(reports, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `eden-crash-reports-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
document.getElementById('btn-crash-clear').addEventListener('click', async () => {
  await clearCrashes();
  refreshCrashReports();
});
document.getElementById('btn-saves-clear').addEventListener('click', async () => {
  if (!confirm('Delete the in-game saves stored in this browser? This cannot be undone.')) return;
  await clearSaves();
  document.getElementById('save-point').textContent = 'None yet';
  showSavePoint(null);
});
const savesStatus = document.getElementById('saves-status');
const savesImportInput = document.getElementById('saves-import-input');
document.getElementById('btn-saves-export').addEventListener('click', async () => {
  try {
    const zip = await exportSaves();
    if (!zip) {
      savesStatus.textContent = 'There are no stored saves to export yet.';
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(zip);
    link.download = `eden-saves-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    savesStatus.textContent = `Exported ${(zip.size / 1024).toFixed(0)} KB of saves.`;
  } catch (err) {
    savesStatus.textContent = `Export failed: ${err.message}`;
  }
});
document.getElementById('btn-saves-import').addEventListener('click', () => savesImportInput.click());

const slotSelect = document.getElementById('save-state-slot');
const slotInfo = document.getElementById('save-slot-info');
const btnSaveSlot = document.getElementById('btn-save-state');
const btnLoadSlot = document.getElementById('btn-load-slot');
const btnClearSlot = document.getElementById('btn-clear-slot');
let slots = [];
for (let n = 1; n <= SLOT_COUNT; n++) slotSelect.add(new Option(`Slot ${n}`, String(n)));

function showSlot() {
  const record = slots[Number(slotSelect.value) - 1];
  slotInfo.textContent = record
    ? `${record.name}, ${record.files} files, ${(record.bytes / 1024).toFixed(0)} KB, saved ${new Date(record.time).toLocaleString()}`
    : 'Empty slot.';
  btnSaveSlot.disabled = !(isRomLoaded && runningGame);
  btnSaveSlot.title = btnSaveSlot.disabled ? 'Start a game to save its saves to a slot' : '';
  btnLoadSlot.disabled = !record;
  btnClearSlot.disabled = !record;
}

async function refreshSlots() {
  slots = await listSlots().catch(() => []);
  slots.forEach((record, i) => { slotSelect.options[i].text = `Slot ${i + 1}${record ? ' ●' : ''}`; });
  showSlot();
}

slotSelect.addEventListener('change', showSlot);
btnSaveSlot.addEventListener('click', async () => {
  const slot = Number(slotSelect.value);
  const record = slots[slot - 1];
  if (record && !confirm(`Replace slot ${slot} (${record.name})?`)) return;
  try {
    const saved = await saveSlot(slot, runningGame.titleId, runningGame.name, edenModule.FS);
    savesStatus.textContent = `Saved ${saved.name} to slot ${slot}.`;
  } catch (err) {
    savesStatus.textContent = `Could not save to slot ${slot}: ${err.message}`;
  }
  refreshSlots();
});
btnLoadSlot.addEventListener('click', async () => {
  const slot = Number(slotSelect.value);
  const record = slots[slot - 1];
  if (!record) return;
  const restart = isRomLoaded && lastGameFile;
  if (isRomLoaded && !confirm(`Restart the game from slot ${slot} (${record.name})? Progress since it was saved is lost.`)) return;
  // A running game would overwrite the loaded slot with its own saves at the next save point.
  stopSaveWatch?.();
  stopSaveWatch = null;
  try {
    const { meta } = await loadSlot(slot);
    showSavePoint(meta);
  } catch (err) {
    savesStatus.textContent = `Could not load slot ${slot}: ${err.message}`;
    if (isRomLoaded) stopSaveWatch = watchSaves(() => edenModule?.FS, () => isRunning && !crashed, showSavePoint);
    return;
  }
  if (!restart) {
    savesStatus.textContent = `Loaded slot ${slot} (${record.name}). It is used the next time the game boots.`;
    return;
  }
  savesStatus.textContent = `Loaded slot ${slot}; restarting ${record.name}...`;
  try {
    await stashGameFile(lastGameFile);
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ name: lastGameFile.name, slot }));
    location.reload();
  } catch (err) {
    savesStatus.textContent = `Loaded slot ${slot}. Reload the page and start the game to use it (${err.message}).`;
  }
});
btnClearSlot.addEventListener('click', async () => {
  const slot = Number(slotSelect.value);
  if (!confirm(`Delete slot ${slot}? This cannot be undone.`)) return;
  await clearSlot(slot).catch(() => {});
  refreshSlots();
});
refreshSlots();
savesImportInput.addEventListener('change', async () => {
  const files = [...savesImportInput.files];
  savesImportInput.value = '';
  if (!files.length) return;
  // A running game would overwrite the import with its own saves at the next save point.
  if (isRomLoaded) {
    if (!confirm('Imported saves load when a game boots. Stop the running game and reload the page now? Progress since the last save point is lost.')) return;
    stopSaveWatch?.();
    stopSaveWatch = null;
  }
  const done = [];
  try {
    for (const file of files) {
      const result = await importSaves(file);
      done.push(result);
      showSavePoint(result.meta);
    }
    const count = done.reduce((sum, r) => sum + r.files, 0);
    const titles = [...new Set(done.flatMap(r => r.titles))];
    savesStatus.textContent = `Imported ${count} save files${titles.length ? ` for ${titles.join(', ')}` : ''}. They load the next time a game boots.`;
    log(savesStatus.textContent, 'ui');
    if (isRomLoaded) location.reload();
  } catch (err) {
    savesStatus.textContent = `Import failed: ${err.message}`;
    if (isRomLoaded && !stopSaveWatch) {
      stopSaveWatch = watchSaves(() => edenModule?.FS, () => isRunning && !crashed, showSavePoint);
    }
  }
});
try {
  autoRestart.checked = localStorage.getItem('eden-auto-restart') !== 'off';
} catch {}
autoRestart.addEventListener('change', () => {
  try { localStorage.setItem('eden-auto-restart', autoRestart.checked ? 'on' : 'off'); } catch {}
});
savePointInfo().then(showSavePoint).catch(() => {});
refreshCrashReports();
// For tests: simulate a crash of the running game.
window.edenDebug = { crash: (reason = 'simulated crash') => onCrash(reason) };

// Emulation core widget: the CPU core is chosen before the runtime starts, so a change reloads the page.
const runningCore = activeCore();
const coreSelect = document.getElementById('cpu-core');
const coreApply = document.getElementById('cpu-core-apply');

function fillList(id, items, render = item => [document.createTextNode(item)]) {
  const list = document.getElementById(id);
  list.replaceChildren(...items.map(item => {
    const li = document.createElement('li');
    li.append(...render(item));
    return li;
  }));
}

function showCore(core) {
  document.getElementById('cpu-core-summary').textContent = core.summary;
  fillList('cpu-core-pros', core.pros);
  fillList('cpu-core-cons', core.cons);
  fillList('cpu-core-tested', core.tested ?? [], ({ game, result }) => {
    const name = document.createElement('strong');
    name.textContent = game;
    return [name, document.createTextNode(`: ${result}`)];
  });
  document.getElementById('cpu-core-tested-section').hidden = !core.available;
  document.getElementById('cpu-core-port-section').hidden = core.available;
  document.getElementById('cpu-core-port').textContent = core.browser ?? '';
  document.getElementById('cpu-core-credits').textContent = core.credits;
  document.getElementById('cpu-core-links').replaceChildren(...core.links.map(href => {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = new URL(href).host + new URL(href).pathname.replace(/\/$/, '');
    return link;
  }));
  coreApply.hidden = core.id === runningCore.id;
  coreApply.disabled = !core.available;
  coreApply.textContent = core.available ? `Reload to switch to ${core.name}` : 'Not available in the browser';
}

// Runnable cores first; the other emulators are listed for comparison and credit.
for (const [label, available] of [['Eden: runs in this browser', true], ['Other Switch emulators: not available here', false]]) {
  const group = document.createElement('optgroup');
  group.label = label;
  for (const core of CPU_CORES.filter(c => c.available === available)) {
    group.append(new Option(core.name, core.id));
  }
  coreSelect.append(group);
}
coreSelect.value = runningCore.id;
document.getElementById('cpu-core-active').textContent = runningCore.name;
showCore(runningCore);
coreSelect.addEventListener('change', () => showCore(findCore(coreSelect.value)));
coreApply.addEventListener('click', () => {
  if (!findCore(coreSelect.value)?.available) return;
  if (isRomLoaded && !confirm('Switching the CPU core reloads the page and stops the running game. Continue?')) return;
  storeCore(coreSelect.value);
  const url = new URL(location.href);
  url.searchParams.delete('core');
  location.replace(url);
});
log(`CPU core: ${runningCore.name}`, 'ui');

// Compatibility widget: records each play session and recommends a core per game.
const compat = setupCompatibility({ log });

refreshSystemStatus();
inspectGpu();
showVersion();

// Initial boot (module scripts are deferred, so the DOM is already parsed)
initWasmCore().then(resumeAfterCrash);
