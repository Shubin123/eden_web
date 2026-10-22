// SPDX-License-Identifier: GPL-3.0-or-later
// One status line for a benchmark or test run: overall progress, the current run's progress, its
// live frame rate (or other detail) and an ETA. On a terminal it redraws in place; in a log file
// or CI it prints a line every 10% instead.
//
//   ██████████░░░░░░░░░░░░░░░░░░░░  34%  4m12s elapsed, ETA 8m05s  silksong-new-game #2/3 intro-cutscene 6210/10000 frames 41.2 fps

const time = s => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
  : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);

const bar = (fraction, width) => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};

/// `total` is the work of the whole run in `unit`s (game frames for the scripted suite, agent
/// steps for the agentic one).
export function createProgress(total, { unit = 'frame', stream = process.stdout } = {}) {
  const tty = Boolean(stream.isTTY);
  const started = Date.now();
  let done = 0;
  let current = null;
  let lastDecile = -1;
  let timer = null;

  const fraction = () => Math.min(1, (done + (current ? Math.min(current.value, current.total) : 0)) / Math.max(1, total));
  const line = () => {
    const overall = fraction();
    const elapsed = (Date.now() - started) / 1000;
    const eta = overall > 0.01 ? time(elapsed / overall - elapsed) : '--';
    let label = '';
    if (current) {
      label = `${current.label} ${current.phase} ${Math.min(current.value, current.total)}/${current.total} ${unit}s`;
      if (unit === 'frame' && current.fps) label += ` ${current.fps.toFixed(1)} fps`;
    }
    return `${bar(overall, 30)} ${(overall * 100).toFixed(0).padStart(3)}%  ${time(elapsed)} elapsed, ETA ${eta}  ${label}`;
  };
  const draw = () => {
    if (tty) {
      stream.write(`\r\x1b[2K${line().slice(0, (stream.columns || 120) - 1)}`);
      return;
    }
    const decile = Math.floor(fraction() * 10);
    if (decile > lastDecile) {
      lastDecile = decile;
      stream.write(`${line()}\n`);
    }
  };
  const clear = () => tty && stream.write('\r\x1b[2K');

  return {
    start(label, runTotal) {
      current = { label, total: runTotal, value: 0, phase: 'booting', fps: 0, at: Date.now(), atValue: 0 };
      timer ??= setInterval(draw, 500);
      draw();
    },
    update(value, phase) {
      if (!current) return;
      const now = Date.now();
      if (now - current.at >= 2000) {
        current.fps = (value - current.atValue) / ((now - current.at) / 1000);
        current.at = now;
        current.atValue = value;
      }
      current.value = Math.max(0, value);
      if (phase) current.phase = phase;
    },
    finish() {
      if (current) done += current.total;
      current = null;
      draw();
    },
    /// Prints a line above the bar without tearing it.
    log(text) {
      clear();
      stream.write(`${text}\n`);
      if (current || done) draw();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      clear();
    },
  };
}
