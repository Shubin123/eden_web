// SPDX-License-Identifier: GPL-3.0-or-later

import {
  importSystemFile,
  getSystemFileStatus,
  clearSystemFiles,
  mountSystemFiles,
  readZipEntries,
} from './system-files.js';
import { setupInput } from './input.js';
import { isArchive, openArchive } from './archive.js';

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

// Log widget: engine output and frontend events, newest at the bottom.
const LOG_LIMIT = 500;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
function log(text, kind = '') {
  text = String(text).replace(ANSI_ESCAPE, '');
  if (/WebGPU.*(?:failed|not available)|Failed to initialize GPU/i.test(text)) gpuFailure = text;
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

// Display settings, remembered per browser. The page works without storage.
const SETTINGS_KEY = 'eden-settings';
const settings = { filter: 'smooth', fit: 'contain', joycons: true, fullscreenJoycons: false };
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

async function inspectWasmBinary() {
  try {
    const res = await fetch('runtime/eden.wasm', { method: 'HEAD' });
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
  await inspectWasmBinary();

  if (typeof createEdenModule !== 'function') {
    wasmBadge.className = 'status-badge';
    wasmStatusText.textContent = 'Runtime missing';
    wasmState.textContent = 'runtime/eden.js not found (run npm run sync)';
    log('runtime/eden.js not found (run npm run sync).', 'err');
    initPromise = null;
    return;
  }
  if (!window.crossOriginIsolated) {
    wasmStatusText.textContent = 'Needs cross-origin isolation';
    wasmState.textContent = 'Reload once the service worker is active';
    log('Cross-origin isolation is not active yet; reload once the service worker is installed.', 'err');
    initPromise = null;
    return;
  }

  try {
    wasmStatusText.textContent = 'Instantiating WASM...';
    edenModule = await createEdenModule({
      locateFile: (path) => 'runtime/' + path,
      print: (text) => { console.log('[Eden]', text); log(text); },
      printErr: (text) => { console.error('[Eden]', text); log(text); },
    });
    isInitialized = true;
    wasmBadge.className = 'status-badge ready';
    wasmStatusText.textContent = 'WASM Core Ready';
    wasmState.textContent = 'Idle';
    log('Eden WebAssembly core ready.', 'ui');
  } catch (err) {
    console.error('Failed to initialize Eden WebAssembly module:', err);
    wasmBadge.className = 'status-badge';
    wasmStatusText.textContent = 'WASM Init Failed';
    wasmState.textContent = 'Error: ' + err.message;
    log(`WASM init failed: ${err.message}`, 'err');
  }
}

const EmuState = ['Idle', 'Booting', 'Running', 'Paused', 'Failed', 'Stopped'];
let statusTimer = null;
let lastState = -1;

function pollStatus() {
  if (!edenModule) return;
  const state = edenModule._eden_get_state();
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
  if (state !== lastState) {
    lastState = state;
    log(`Emulation state: ${name}`, state === 4 ? 'err' : 'ui');
  }
  if (state === 4) {
    loader.fail();
    wasmStatusText.textContent = `Boot failed (load result ${edenModule._eden_get_load_result()})`;
    romStatus.textContent = gpuFailure ? `GPU initialization failed: ${gpuFailure}. This runtime has no WebGL fallback; see the engine log for adapter/device errors.` : wasmStatusText.textContent;
  } else if (state >= 1 && state <= 3) {
    wasmStatusText.textContent = `${name}: ${currentRomName}`;
  }
  const finite = (value) => (Number.isFinite(value) ? value : 0);
  const gameFps = finite(edenModule._eden_get_game_fps());
  // Running is reported as soon as the core starts; the game is loaded once it draws a frame.
  if (state === 2 && gameFps > 0) loader.finish();
  const speed = finite(edenModule._eden_get_emulation_speed()) * 100;
  fpsCounter.textContent = `${gameFps.toFixed(1)} FPS`;
  systemFps.textContent = `${finite(edenModule._eden_get_system_fps()).toFixed(1)} FPS`;
  frametimeCounter.textContent = `${finite(edenModule._eden_get_frametime()).toFixed(2)} ms`;
  emuSpeed.textContent = `${speed.toFixed(0)}%`;
  fpsCaption.textContent = isRunning ? `${gameFps.toFixed(1)} FPS · ${speed.toFixed(0)}%` : '';
}

function startLoop() {
  edenModule?._eden_resume();
}

function pauseLoop() {
  edenModule?._eden_pause();
}

function stepOneFrame() {}

function resetEmulation() {
  // The core does not support rebooting in place; reload the page to start over.
  edenModule?._eden_shutdown();
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
  return rom ? { ...rom, name: baseName(rom.name) } : null;
}

// Handle dropped or selected ROM file, or an archive holding one
async function handleFile(file) {
  if (!file) return;

  let rom = { name: file.name, size: file.size, stream: async () => file.stream() };
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
    try {
      found = await findRomInArchive(file);
    } catch (err) {
      setRomStatus(`Cannot open ${file.name}: ${err.message}`);
      alert(`Cannot open ${file.name}: ${err.message}`);
      return;
    }
    if (!found) {
      setRomStatus(`${file.name} holds no game; importing it as keys or firmware.`);
      await importSystemFiles([file]);
      return;
    }
    rom = found;
  } else if (!hasExtension(lowerName, ROM_EXTENSIONS)) {
    setRomStatus(`Unsupported ROM format "${file.name}".`);
    alert(`Unsupported ROM format "${file.name}".`);
    return;
  }
  if (isRomLoaded) {
    alert('A game is already running. Reload the page to start another one.');
    return;
  }

  if (!await inspectGpu()) {
    setRomStatus('Cannot boot: WebGPU is unavailable. See the Renderer card for details. This runtime has no WebGL fallback.');
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
    const mounted = await mountSystemFiles(edenModule.FS);
    log(`Mounted ${mounted} system files into the Eden data directory.`, 'ui');

    wasmStatusText.textContent = `Reading ${rom.name}...`;
    setRomStatus(`Reading ${rom.name}...`);
    const path = '/roms/' + rom.name;
    edenModule.FS.mkdirTree('/roms');
    loader.setPhase('copy');
    const stream = edenModule.FS.open(path, 'w');
    const reader = (await rom.stream()).getReader();
    try {
      let pos = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        edenModule.FS.write(stream, value, 0, value.length, pos);
        pos += value.length;
        loader.bytes = pos;
      }
      if (rom.size >= 0 && pos !== rom.size) {
        throw new Error(`${rom.name} is truncated (${pos} of ${rom.size} bytes)`);
      }
    } finally {
      reader.releaseLock();
      edenModule.FS.close(stream);
    }
    loader.setPhase('boot');

    if (edenModule.ccall('eden_boot', 'number', ['string'], [path]) !== 0) {
      throw new Error('eden_boot rejected the request');
    }
    isRomLoaded = true;
    dropZone.style.display = 'none';
    fileInput.disabled = true;
    setRomStatus(`Booting ${rom.name}. Reload the page to load a different game.`);
    statusTimer ??= setInterval(pollStatus, 500);
  } catch (err) {
    console.error('Failed to load ROM:', err);
    alert(`Failed to load ROM: ${err.message}`);
    loader.fail();
    wasmStatusText.textContent = 'ROM Load Failed';
    setRomStatus(`ROM load failed: ${err.message}`);
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
btnStep.addEventListener('click', stepOneFrame);
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
  }
});

// Controller input goes to the engine once a game is running.
setupInput(() => (isRomLoaded ? edenModule : null));

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
    if (isInitialized) {
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

refreshSystemStatus();
inspectGpu();
showVersion();

// Initial boot (module scripts are deferred, so the DOM is already parsed)
initWasmCore();
