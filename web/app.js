// SPDX-License-Identifier: GPL-3.0-or-later

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const canvas = document.getElementById('canvas');
const headerStatus = document.getElementById('header-status');
const backendStatus = document.getElementById('backend-status');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnPause = document.getElementById('btn-pause');
const btnReset = document.getElementById('btn-reset');

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

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    canvas.requestFullscreen?.() || document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

async function handleFile(file) {
  headerStatus.textContent = `Loading ${file.name}...`;
  backendStatus.textContent = `Status: Mounting ${file.name}`;
  console.log(`Selected game: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);

  dropZone.style.display = 'none';
  btnPause.disabled = false;
  btnReset.disabled = false;

  try {
    // Check if runtime wasm is available
    const checkRuntime = await fetch('runtime/eden.js', { method: 'HEAD' });
    if (checkRuntime.ok) {
      headerStatus.textContent = `Booting runtime for ${file.name}`;
      // In full implementation, load runtime and mount file into MEMFS / IDBFS
    } else {
      headerStatus.textContent = `Runtime not yet built (${file.name} ready)`;
      backendStatus.textContent = 'Status: Waiting for build in eden_emscripten';
      console.info('Build the WebAssembly artifacts in eden_emscripten and run "npm run sync" to install them.');
    }
  } catch (err) {
    headerStatus.textContent = 'Runtime standby';
    backendStatus.textContent = 'Status: Waiting for build';
  }
}
