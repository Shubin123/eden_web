// SPDX-License-Identifier: GPL-3.0-or-later
// Webcam as the right Joy-Con's IR camera. Frames are scaled to the size the game asks for,
// reduced to brightness and written into the engine's staging buffer.

const FRAME_INTERVAL_MS = 1000 / 30;
const MAX_WIDTH = 320;

/// `getModule` returns the Emscripten module once a game is running, else null.
export function setupCamera(getModule, log) {
  const toggle = document.getElementById('btn-camera');
  const deviceSelect = document.getElementById('camera-device');
  const preview = document.getElementById('camera-preview');
  const status = document.getElementById('camera-status');
  const gameUse = document.getElementById('camera-game');

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let stream = null;
  let timer = null;

  stop();
  if (!navigator.mediaDevices?.getUserMedia) {
    toggle.disabled = true;
    status.textContent = window.isSecureContext
      ? 'This browser does not expose cameras to web pages.'
      : 'Cameras need HTTPS or localhost.';
  }

  async function listDevices() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    deviceSelect.replaceChildren(...devices.map((device, i) => {
      const option = new Option(device.label || `Camera ${i + 1}`, device.deviceId);
      option.selected = device.deviceId === current;
      return option;
    }));
    deviceSelect.disabled = devices.length < 2;
  }

  async function start(deviceId) {
    stop();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (err) {
      status.textContent = `Camera unavailable: ${err.message}`;
      log(`Camera unavailable: ${err.message}`, 'err');
      return;
    }
    preview.srcObject = stream;
    preview.hidden = false;
    toggle.textContent = '📷 Stop camera';
    status.textContent = `Using ${stream.getVideoTracks()[0].label || 'camera'}.`;
    stream.getVideoTracks()[0].addEventListener('ended', stop);
    timer = setInterval(sendFrame, FRAME_INTERVAL_MS);
    await listDevices();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    preview.srcObject = null;
    preview.hidden = true;
    toggle.textContent = '📷 Start camera';
    status.textContent = 'Camera off. Games that use the IR camera see a dark image.';
  }

  function sendFrame() {
    const module = getModule();
    const requested = typeof module?._eden_get_camera_width === 'function' ? module._eden_get_camera_width() : 0;
    gameUse.textContent = requested > 0 ? `In use (${requested}×${requested * 3 / 4})` : 'Not in use';
    gameUse.classList.toggle('highlight', requested > 0);
    if (!requested || preview.readyState < 2) return;

    // The IR camera is 4:3; crop the middle of the webcam image to match.
    const width = Math.min(requested, MAX_WIDTH);
    const height = width * 3 / 4;
    canvas.width = width;
    canvas.height = height;
    const sourceWidth = preview.videoWidth;
    const sourceHeight = preview.videoHeight;
    const cropWidth = Math.min(sourceWidth, sourceHeight * 4 / 3);
    const cropHeight = cropWidth * 3 / 4;
    context.drawImage(preview, (sourceWidth - cropWidth) / 2, (sourceHeight - cropHeight) / 2,
      cropWidth, cropHeight, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;

    const pixels = new Uint32Array(module.HEAPU8.buffer, Number(module._eden_camera_buffer()), width * height);
    for (let i = 0; i < pixels.length; i++) {
      const luma = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
      pixels[i] = 0xff000000 | (luma << 16) | (luma << 8) | luma;
    }
    module._eden_submit_camera(width, height);
  }

  toggle.addEventListener('click', () => (stream ? stop() : start(deviceSelect.value)));
  deviceSelect.addEventListener('change', () => start(deviceSelect.value));
  window.addEventListener('pagehide', stop);
}
