// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createFrameWatchdog } from '../web/frame-watchdog.js';

let time = 0;
const freezes = [];
let first = 0;
const watch = createFrameWatchdog({ timeoutMs: 45_000, now: () => time,
  onFirstFrame: () => first++, onFreeze: text => freezes.push(text) });
watch(2, 0, 0);
time = 60_000;
watch(2, 0, 0);
assert.equal(freezes.length, 0, 'booting without a first frame does not count as a freeze');
watch(2, 60, 1);
assert.equal(first, 1);
time += 46_000;
watch(2, 60, 1);
assert.equal(freezes.length, 1, 'stale positive FPS cannot hide a stopped frame counter');
watch(2, 60, 1);
assert.equal(freezes.length, 1, 'a freeze is reported once');
watch(2, 60, 2);
time += 1000;
watch(3, 60, 2);
time += 120_000;
watch(3, 60, 2);
watch(2, 0, 2);
assert.equal(freezes.length, 1, 'a long pause does not cause a freeze on resume');
time += 1000;
watch(2, 0, 3);
assert.equal(freezes.length, 1, 'new frame counters indicate progress even if averaged FPS is zero');
assert.equal(first, 1);
const legacy = createFrameWatchdog({ timeoutMs: 10, now: () => time, onFreeze: text => freezes.push(text) });
legacy(2, 1);
time += 11;
legacy(2, 0);
assert.equal(freezes.length, 2, 'legacy runtimes fall back to FPS');
console.log('Frame watchdog: stale FPS, long pause, first frame and legacy runtime OK');
