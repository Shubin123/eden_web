// SPDX-License-Identifier: GPL-3.0-or-later

import {
  importSystemFile,
  getSystemFileStatus,
  clearSystemFiles,
  mountSystemFiles,
} from './system-files.js';

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

// Check Cross-Origin Isolation
function checkIsolation() {
  if (window.crossOriginIsolated) {
    coopStatus.textContent = 'Active (SharedArrayBuffer enabled)';
    coopStatus.classList.add('highlight');
  } else {
    coopStatus.textContent = 'Inactive (Single-threaded fallback)';
  }
}

// Fetch WASM size metadata
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
    initPromise = null;
    return;
  }
  if (!window.crossOriginIsolated) {
    wasmStatusText.textContent = 'Needs cross-origin isolation';
    wasmState.textContent = 'Reload once the service worker is active';
    initPromise = null;
    return;
  }

  try {
    wasmStatusText.textContent = 'Instantiating WASM...';
    edenModule = await createEdenModule({
      locateFile: (path) => 'runtime/' + path,
      print: (text) => console.log('[Eden]', text),
      printErr: (text) => console.error('[Eden]', text),
    });
    isInitialized = true;
    wasmBadge.className = 'status-badge ready';
    wasmStatusText.textContent = 'WASM Core Ready';
    wasmState.textContent = 'Loaded';
  } catch (err) {
    console.error('Failed to initialize Eden WebAssembly module:', err);
    wasmBadge.className = 'status-badge';
    wasmStatusText.textContent = 'WASM Init Failed';
    wasmState.textContent = 'Error: ' + err.message;
  }
}

const EmuState = ['Idle', 'Booting', 'Running', 'Paused', 'Failed', 'Stopped'];
let statusTimer = null;

function pollStatus() {
  if (!edenModule) return;
  const state = edenModule._eden_get_state();
  const name = EmuState[state] || `State ${state}`;
  wasmState.textContent = name;
  isRunning = state === 2;
  isPaused = state === 3;
  pauseOverlay.style.display = isPaused ? 'flex' : 'none';
  btnPlay.disabled = !isPaused;
  btnPause.disabled = !isRunning;
  btnReset.disabled = !(isRunning || isPaused);
  btnStep.disabled = true;
  if (state === 4) {
    wasmStatusText.textContent = `Boot failed (load result ${edenModule._eden_get_load_result()})`;
  } else if (state >= 1 && state <= 3) {
    wasmStatusText.textContent = `${name}: ${currentRomName}`;
  }
  const finite = (value) => (Number.isFinite(value) ? value : 0);
  fpsCounter.textContent = `${finite(edenModule._eden_get_game_fps()).toFixed(1)} FPS`;
  frametimeCounter.textContent = `${finite(edenModule._eden_get_frametime()).toFixed(2)} ms (${(finite(edenModule._eden_get_emulation_speed()) * 100).toFixed(0)}%)`;
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

// Handle dropped or selected ROM file
async function handleFile(file) {
  if (!file) return;

  const lowerName = file.name.toLowerCase();
  if (['.zip', '.keys'].some(ext => lowerName.endsWith(ext))) {
    await importSystemFiles([file]);
    return;
  }

  const validExtensions = ['.nsp', '.xci', '.nro', '.nca', '.nso'];
  if (!validExtensions.some(ext => lowerName.endsWith(ext))) {
    alert(`Unsupported ROM format "${file.name}".`);
    return;
  }
  if (isRomLoaded) {
    alert('A game is already running. Reload the page to start another one.');
    return;
  }

  await initWasmCore();
  if (!isInitialized) {
    alert('The Eden WebAssembly core is not ready.');
    return;
  }

  currentRomName = file.name;
  titleName.textContent = file.name;
  titleSize.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

  try {
    wasmStatusText.textContent = 'Mounting keys & firmware...';
    const mounted = await mountSystemFiles(edenModule.FS);
    console.log(`Mounted ${mounted} system files into the Eden data directory.`);

    wasmStatusText.textContent = `Reading ${file.name}...`;
    const path = '/roms/' + file.name;
    edenModule.FS.mkdirTree('/roms');
    edenModule.FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));

    if (edenModule.ccall('eden_boot', 'number', ['string'], [path]) !== 0) {
      throw new Error('eden_boot rejected the request');
    }
    isRomLoaded = true;
    dropZone.style.display = 'none';
    statusTimer ??= setInterval(pollStatus, 500);
  } catch (err) {
    console.error('Failed to load ROM:', err);
    alert(`Failed to load ROM: ${err.message}`);
    wasmStatusText.textContent = 'ROM Load Failed';
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

btnFullscreen.addEventListener('click', () => {
  const container = document.querySelector('.switch-device') || canvas;
  if (!document.fullscreenElement) {
    container.requestFullscreen?.() || document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

// Keyboard mapping to Joy-Con controls
const keyElementMap = {
  KeyA: document.querySelector('.abxy-btn.btn-a'),
  KeyS: document.querySelector('.abxy-btn.btn-b'),
  KeyX: document.querySelector('.abxy-btn.btn-x'),
  KeyZ: document.querySelector('.abxy-btn.btn-y'),
  ArrowUp: document.querySelector('.dpad-btn.up'),
  ArrowDown: document.querySelector('.dpad-btn.down'),
  ArrowLeft: document.querySelector('.dpad-btn.left'),
  ArrowRight: document.querySelector('.dpad-btn.right'),
  Enter: document.querySelector('.btn-plus'),
  Backspace: document.querySelector('.btn-minus'),
  KeyQ: document.querySelector('.stick-left'),
  KeyE: document.querySelector('.stick-right'),
};

window.addEventListener('keydown', (e) => {
  const elem = keyElementMap[e.code];
  if (elem) {
    elem.classList.add('pressed');
  }
});

window.addEventListener('keyup', (e) => {
  const elem = keyElementMap[e.code];
  if (elem) {
    elem.classList.remove('pressed');
  }
});

// Interactive on-screen Joy-Con button press feedback
document.querySelectorAll('.abxy-btn, .dpad-btn, .jc-button, .jc-stick').forEach(btn => {
  btn.addEventListener('mousedown', () => btn.classList.add('pressed'));
  btn.addEventListener('mouseup', () => btn.classList.remove('pressed'));
  btn.addEventListener('mouseleave', () => btn.classList.remove('pressed'));
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    btn.classList.add('pressed');
  });
  btn.addEventListener('touchend', () => btn.classList.remove('pressed'));
});

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

systemCard.addEventListener('dragover', (e) => {
  e.preventDefault();
  systemCard.classList.add('dragover');
});
systemCard.addEventListener('dragleave', () => systemCard.classList.remove('dragover'));
systemCard.addEventListener('drop', (e) => {
  e.preventDefault();
  systemCard.classList.remove('dragover');
  importSystemFiles([...e.dataTransfer.files]);
});

refreshSystemStatus();

// Initial boot (module scripts are deferred, so the DOM is already parsed)
initWasmCore();
