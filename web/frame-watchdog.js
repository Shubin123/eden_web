// SPDX-License-Identifier: GPL-3.0-or-later

export function createFrameWatchdog({ timeoutMs, now = () => performance.now(), onFirstFrame = () => {}, onFreeze }) {
  let previousFrames = null;
  let lastFrameAt = null;
  let reported = false;
  return (state, fps, frames) => {
    if (state !== 2) {
      if (state === 3 && lastFrameAt !== null) lastFrameAt = now();
      return;
    }
    const time = now();
    const hasCounter = Number.isFinite(frames) && frames >= 0;
    const advanced = hasCounter ? frames > (previousFrames ?? 0) : fps > 0;
    if (hasCounter) previousFrames = frames;
    if (advanced) {
      if (lastFrameAt === null) onFirstFrame();
      lastFrameAt = time;
      reported = false;
    } else if (lastFrameAt !== null && time - lastFrameAt > timeoutMs && !reported) {
      reported = true;
      onFreeze(`no frames for ${Math.round((time - lastFrameAt) / 1000)} s`);
    }
  };
}
