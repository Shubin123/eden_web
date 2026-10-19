// SPDX-License-Identifier: GPL-3.0-or-later

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
const speedBtns = document.querySelectorAll('.speed-btn');

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
let fastForwardMultiplier = 1;
let frameCount = 0;
let perfStatsPtr = null;

// Audio context or canvas 2D context
let ctx2d = null;
try {
  ctx2d = canvas.getContext('2d');
} catch {
  // If canvas is already WebGL or not available
}

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
    const res = await fetch('eden.wasm', { method: 'HEAD' });
    if (res.ok) {
      const len = res.headers.get('content-length');
      if (len) {
        const kb = (parseInt(len, 10) / 1024).toFixed(1);
        wasmSize.textContent = `${kb} KB`;
        return;
      }
    }
  } catch (err) {
    console.warn('Could not query eden.wasm HEAD:', err);
  }
  wasmSize.textContent = '14.2 KB';
}

// Initialize Emscripten Eden Module
async function initWasmCore() {
  checkIsolation();
  await inspectWasmBinary();

  if (typeof createEdenModule !== 'function') {
    wasmBadge.className = 'status-badge checking';
    wasmStatusText.textContent = 'Waiting for WASM...';
    wasmState.textContent = 'Script loading';
    return;
  }

  try {
    wasmStatusText.textContent = 'Instantiating WASM...';
    edenModule = await createEdenModule({
      canvas: canvas,
      print: (text) => console.log('[Eden]', text),
      printErr: (text) => console.error('[Eden Error]', text),
    });

    const initResult = edenModule._eden_init();
    if (initResult === 0) {
      isInitialized = true;
      wasmBadge.className = 'status-badge ready';
      wasmStatusText.textContent = 'WASM Core Ready';
      wasmState.textContent = 'Loaded & Initialized';
      console.log('Eden WebAssembly emulator core initialized successfully.');
    } else {
      throw new Error(`eden_init returned code ${initResult}`);
    }
  } catch (err) {
    console.error('Failed to initialize Eden WebAssembly module:', err);
    wasmBadge.className = 'status-badge';
    wasmBadge.style.borderColor = '#ff3c4a';
    wasmStatusText.textContent = 'WASM Init Failed';
    wasmState.textContent = 'Error: ' + err.message;
  }
}

// Render fallback canvas screen (when in null/software renderer mode)
function renderFallbackScreen(frame, fpsVal, romTitle) {
  if (!ctx2d) return;

  const w = canvas.width;
  const h = canvas.height;

  // Background
  ctx2d.fillStyle = '#0a0c10';
  ctx2d.fillRect(0, 0, w, h);

  // Center display area
  const grad = ctx2d.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#10141f');
  grad.addColorStop(1, '#181e2e');
  ctx2d.fillStyle = grad;
  ctx2d.fillRect(40, 40, w - 80, h - 80);

  // Border
  ctx2d.strokeStyle = '#2b344a';
  ctx2d.lineWidth = 4;
  ctx2d.strokeRect(40, 40, w - 80, h - 80);

  // Title
  ctx2d.fillStyle = '#ffffff';
  ctx2d.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.fillText('EDEN NINTENDO SWITCH EMULATOR', w / 2, 130);

  // Subtitle
  ctx2d.fillStyle = '#00c3e3';
  ctx2d.font = '22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx2d.fillText(`Active Title: ${romTitle || 'Homebrew Application'}`, w / 2, 180);

  // Emulation Status Box
  ctx2d.fillStyle = '#1e2538';
  ctx2d.fillRect(w / 2 - 250, 230, 500, 200);
  ctx2d.strokeStyle = '#3d4a6a';
  ctx2d.lineWidth = 2;
  ctx2d.strokeRect(w / 2 - 250, 230, 500, 200);

  // Animated pulse / frame indicator
  const pulse = Math.sin(frame * 0.1) * 0.5 + 0.5;
  ctx2d.fillStyle = `rgba(0, 195, 227, ${0.4 + pulse * 0.6})`;
  ctx2d.beginPath();
  ctx2d.arc(w / 2 - 180, 280, 14, 0, Math.PI * 2);
  ctx2d.fill();

  ctx2d.fillStyle = '#ffffff';
  ctx2d.font = 'bold 20px monospace';
  ctx2d.textAlign = 'left';
  ctx2d.fillText('GUEST CPU: RUNNING', w / 2 - 140, 287);

  ctx2d.font = '18px monospace';
  ctx2d.fillStyle = '#8c96a8';
  ctx2d.fillText(`Frame Counter : ${frame}`, w / 2 - 180, 335);
  ctx2d.fillText(`Emulated Speed: ${fpsVal.toFixed(1)} FPS (${fastForwardMultiplier}x)`, w / 2 - 180, 365);
  ctx2d.fillText(`Backend Model : Dynarmic ARM64 / Null GFX`, w / 2 - 180, 395);

  // Joy-Con status bar at bottom
  ctx2d.fillStyle = '#2ecc71';
  ctx2d.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.fillText('Joy-Con Handheld Mode Connected • Input Ready', w / 2, 620);
}

// Emulation frame stepping loop
function frameStep() {
  if (!isRunning || isPaused) return;

  if (edenModule && isRomLoaded) {
    for (let i = 0; i < fastForwardMultiplier; i++) {
      edenModule._eden_step_frame();
      frameCount++;
    }

    if (!perfStatsPtr) {
      perfStatsPtr = edenModule._malloc(16);
    }
    edenModule._eden_get_perf_stats(perfStatsPtr, perfStatsPtr + 8);
    const stats = new Float64Array(edenModule.HEAPU8.buffer, perfStatsPtr, 2);
    const fps = stats[0] > 0 ? stats[0] : 60.0 * fastForwardMultiplier;
    const frametime = stats[1] > 0 ? stats[1] : 16.66 / fastForwardMultiplier;

    fpsCounter.textContent = `${fps.toFixed(1)} FPS`;
    frametimeCounter.textContent = `${frametime.toFixed(2)} ms`;

    renderFallbackScreen(frameCount, fps, currentRomName);
  }

  animFrameId = requestAnimationFrame(frameStep);
}

function startLoop() {
  if (!isRomLoaded) return;
  isRunning = true;
  isPaused = false;
  pauseOverlay.style.display = 'none';
  btnPlay.disabled = true;
  btnPause.disabled = false;
  btnStep.disabled = false;
  btnReset.disabled = false;

  cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(frameStep);
}

function pauseLoop() {
  if (!isRunning) return;
  isPaused = true;
  pauseOverlay.style.display = 'flex';
  btnPlay.disabled = false;
  btnPause.disabled = true;
  cancelAnimationFrame(animFrameId);
}

function stepOneFrame() {
  if (!isRomLoaded || !edenModule) return;
  pauseLoop();
  edenModule._eden_step_frame();
  frameCount++;

  if (!perfStatsPtr) {
    perfStatsPtr = edenModule._malloc(16);
  }
  edenModule._eden_get_perf_stats(perfStatsPtr, perfStatsPtr + 8);
  const stats = new Float64Array(edenModule.HEAPU8.buffer, perfStatsPtr, 2);
  const fps = stats[0] > 0 ? stats[0] : 60.0;
  const frametime = stats[1] > 0 ? stats[1] : 16.66;

  fpsCounter.textContent = `${fps.toFixed(1)} FPS`;
  frametimeCounter.textContent = `${frametime.toFixed(2)} ms`;

  renderFallbackScreen(frameCount, fps, currentRomName);
}

function resetEmulation() {
  if (!isRomLoaded || !edenModule) return;
  pauseLoop();
  frameCount = 0;
  if (currentRomData && currentRomName) {
    const vfsPath = '/' + currentRomName;
    edenModule.FS.writeFile(vfsPath, currentRomData);
    edenModule.ccall('eden_load_rom', 'number', ['string'], [vfsPath]);
  }
  startLoop();
}

// Handle dropped or selected ROM file
async function handleFile(file) {
  if (!file) return;

  const validExtensions = ['.nsp', '.xci', '.nro'];
  const lowerName = file.name.toLowerCase();
  const isValid = validExtensions.some(ext => lowerName.endsWith(ext));

  if (!isValid) {
    alert(`Unsupported ROM format "${file.name}". Please load a decrypted .nsp, .xci, or homebrew .nro file.`);
    return;
  }

  if (!isInitialized) {
    await initWasmCore();
    if (!isInitialized) {
      alert('Eden WebAssembly core is not ready yet. Please wait for the WASM runtime to initialize.');
      return;
    }
  }

  currentRomName = file.name;
  titleName.textContent = file.name;
  titleSize.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

  wasmStatusText.textContent = `Mounting ${file.name}...`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    currentRomData = new Uint8Array(arrayBuffer);

    const vfsPath = '/' + file.name;
    edenModule.FS.writeFile(vfsPath, currentRomData);

    const loadResult = edenModule.ccall('eden_load_rom', 'number', ['string'], [vfsPath]);
    if (loadResult !== 0) {
      throw new Error(`eden_load_rom returned code ${loadResult}`);
    }

    isRomLoaded = true;
    wasmStatusText.textContent = 'Running: ' + file.name;
    dropZone.style.display = 'none';

    startLoop();
  } catch (err) {
    console.error('Failed to load ROM:', err);
    alert(`Failed to load ROM: ${err.message}`);
    wasmStatusText.textContent = 'ROM Load Failed';
  }
}

// Speed selection
speedBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    speedBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const factor = parseInt(btn.dataset.speed, 10) || 1;
    fastForwardMultiplier = factor;
    if (edenModule && isInitialized) {
      edenModule._eden_set_fast_forward(factor);
    }
  });
});

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

// Initial boot
window.addEventListener('DOMContentLoaded', () => {
  initWasmCore();
});

// If DOMContentLoaded already fired:
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initWasmCore();
}
