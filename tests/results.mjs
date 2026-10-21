// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the shared test result format in web/results.js.

import assert from 'node:assert/strict';
import { compareResults, frameTimeStats, makeResult, validateResult } from '../web/results.js';

assert.deepEqual(validateResult(makeResult({ outcome: 'pass' })), []);
assert.match(validateResult(makeResult({ outcome: 'fail' }))[0], /failure category/);
assert.deepEqual(validateResult(makeResult({ outcome: 'fail', failure: { category: 'boot', detail: 'load result 2' } })), []);
assert.match(validateResult(makeResult({ game: { titleId: 'nope' } }))[0], /titleId/);
assert.match(validateResult({ schema: 'other' })[0], /schema/);

const steady = Array(100).fill(16.7);
assert.equal(frameTimeStats(steady).stutters, 0);
const spiky = [...steady.slice(0, 98), 120, 250];
const stats = frameTimeStats(spiky);
assert.equal(stats.stutters, 2);
assert.equal(stats.max, 250);
assert.equal(stats.p50, 16.7);
assert.equal(frameTimeStats(Array(60).fill(33.3)).stutters, 0, 'steady 30 fps is not stutter');
assert.equal(frameTimeStats([]), null);

const fast = makeResult({ outcome: 'fail', failure: { category: 'no-frames' }, metrics: { sustainedFps: 60 } });
const slow = makeResult({ outcome: 'pass', metrics: { sustainedFps: 20 } });
const slower = makeResult({ outcome: 'pass', metrics: { sustainedFps: 15 } });
const reported = makeResult({ outcome: 'pass', confidence: 'user', metrics: { sustainedFps: 60 } });
assert.deepEqual([fast, reported, slower, slow].sort(compareResults), [slow, slower, reported, fast]);

console.log('results format OK');
