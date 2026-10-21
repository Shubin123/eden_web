// SPDX-License-Identifier: GPL-3.0-or-later

export function setupAudio(getModule, log) {
  const button = document.getElementById('btn-sound');
  const volume = document.getElementById('audio-volume');
  const value = document.getElementById('audio-volume-value');
  const status = document.getElementById('audio-status');
  const prefs = { volume: 80, muted: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('eden-audio') || '{}')); } catch {}
  prefs.volume = Math.max(0, Math.min(100, Number(prefs.volume) || 0));
  const save = () => {
    try { localStorage.setItem('eden-audio', JSON.stringify(prefs)); } catch {}
  };
  function poll() {
    const module = getModule();
    const supported = typeof module?._eden_get_audio_state === 'function' &&
      typeof module?._eden_set_audio_volume === 'function' && typeof module?._eden_resume_audio === 'function';
    const state = supported ? module._eden_get_audio_state() : -1;
    volume.disabled = !supported;
    button.disabled = state <= 0;
    volume.value = prefs.volume;
    value.textContent = supported ? `${prefs.volume}%` : '--';
    button.textContent = state <= 0 ? '🔇 Sound: waiting' : state === 1 ? '🔊 Enable sound'
      : prefs.muted ? '🔇 Sound: muted' : '🔊 Sound: on';
    status.textContent = !module ? 'Waiting for the core.' : !supported
      ? 'This runtime has no browser audio controls. Sync a runtime with Web Audio support.'
      : state === 0 ? 'Waiting for the game to open its audio stream.'
      : state < 0 ? 'The audio device is unavailable.'
      : state === 1 ? 'Click Enable sound to allow playback in this browser.'
      : prefs.muted ? 'Game audio is muted.' : `Game audio is playing at ${prefs.volume}% volume.`;
    if (supported) module._eden_set_audio_volume(prefs.volume, prefs.muted ? 1 : 0);
  }
  button.addEventListener('click', () => {
    const module = getModule();
    if (!module?._eden_get_audio_state) return;
    if (module._eden_get_audio_state() === 1 || prefs.muted) {
      prefs.muted = false;
      module._eden_resume_audio();
      log('Audio: playback enabled.', 'ui');
    } else {
      prefs.muted = true;
      log('Audio: muted.', 'ui');
    }
    save();
    poll();
  });
  volume.addEventListener('input', () => {
    prefs.volume = Number(volume.value);
    save();
    poll();
  });
  volume.addEventListener('change', () => log(`Audio: volume ${prefs.volume}%.`, 'ui'));
  poll();
  return poll;
}
