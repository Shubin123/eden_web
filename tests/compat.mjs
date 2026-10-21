// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the pure logic of the Compatibility widget in web/compat.js.

import assert from 'node:assert/strict';
import { makeResult } from '../web/results.js';
import {
  assessSession, findRegressions, gameIdentity, gameKey, groupByGame, parseImport, recommend, sameGame,
  sustainedFps,
} from '../web/compat.js';

// Game identity: title ID and version when known, else base name and a hash of the size.
const byFile = gameIdentity({ fileName: '/home/me/games/Captain Toad.nsp', size: 1234 });
assert.equal(byFile.file.name, 'Captain Toad.nsp', 'paths are reduced to the base name');
assert.ok(!JSON.stringify(byFile).includes('/home'), 'no path stored');
assert.match(gameKey(byFile), /^file:captain toad\.nsp:[0-9a-f]{8}$/);
assert.notEqual(gameKey(byFile), gameKey(gameIdentity({ fileName: 'Captain Toad.nsp', size: 1235 })));
assert.equal(gameKey(byFile), gameKey(gameIdentity({ fileName: 'C:\\roms\\Captain Toad.nsp', size: 1234 })));
const info = { titleId: '01009bf0072d4000', name: 'Captain Toad', version: 65536, displayVersion: '1.1.0' };
const byTitle = gameIdentity({ info, fileName: 'Captain Toad.nsp', size: 1234 });
assert.equal(byTitle.titleId, '01009BF0072D4000');
assert.equal(gameKey(byTitle), 'title:01009BF0072D4000:65536');
assert.equal(gameIdentity({ info: { titleId: 'bad', name: 'X' } }).titleId, null);
assert.ok(sameGame(byFile, byTitle), 'the same file before and after the runtime reports its title');
assert.ok(!sameGame(byTitle, { ...byTitle, version: 0 }), 'different game versions');
assert.ok(sameGame({ name: 'Captain Toad.nsp' }, byFile), 'harness results named by file match');

const run = (core, runtime, fields = {}, createdAt = '2026-10-20T00:00:00Z') => makeResult({
  game: byFile, core: { id: core, runtimeVersion: runtime }, createdAt, ...fields,
});
const pass = (fps, stutters) => ({ outcome: 'pass', metrics: { sustainedFps: fps, frameTime: { stutters } } });
const fail = category => ({ outcome: 'fail', failure: { category } });

assert.equal(groupByGame([run('jit', 'a'), run('jit', 'a', { game: byTitle }), run('jit', 'a', { game: { name: 'Other' } })]).length, 2);

// Recommendation: correctness first, then stutters and fps; untested cores are listed apart.
const results = [
  run('jit', 'b', pass(58, 0)),
  run('jit', 'b', pass(55, 2)),
  run('jit', 'b', pass(50, 1)),
  run('interpreter', 'b', fail('no-frames')),
];
let rec = recommend(results, { currentRuntime: 'b' });
assert.equal(rec.core.coreId, 'jit');
assert.equal(rec.core.runs, 3);
assert.match(rec.reason, /^Wasm JIT: passes, 0 stutters, 58 fps vs IR interpreter: no frames$/);
assert.equal(rec.evidence, 'automated, 3 runs');
assert.deepEqual(rec.untested, []);

rec = recommend([run('jit', 'b', pass(20, 4))], { currentRuntime: 'b' });
assert.equal(rec.core.coreId, 'jit');
assert.equal(rec.evidence, 'automated, 1 run');
assert.deepEqual(rec.untested.map(c => c.id), ['interpreter'], 'an untested core is not ranked as failing');
assert.equal(rec.ranked.length, 1);

rec = recommend([run('jit', 'b', fail('crash'))], { currentRuntime: 'b' });
assert.equal(rec.core, null, 'nothing is recommended when every tested core fails');

// A user report never outranks automated evidence of the same outcome.
rec = recommend([run('jit', 'b', pass(30, 0)), run('interpreter', 'b', { ...pass(60, 0), confidence: 'user' })], { currentRuntime: 'b' });
assert.equal(rec.core.coreId, 'jit');
rec = recommend([run('jit', 'b', pass(30, 0)), run('jit', 'b', { outcome: 'pass', confidence: 'user' })], { currentRuntime: 'b' });
assert.equal(rec.evidence, 'automated, 1 run; 1 user report');

// Results on an older runtime still count when the current one has none, but are marked.
rec = recommend([run('jit', 'a', pass(60, 0))], { currentRuntime: 'b' });
assert.equal(rec.core.current, false);
assert.match(rec.reason, /engine a/);

// Regressions: passed on an older runtime, only failures on the current one.
const history = [
  run('jit', 'old', pass(60, 0), '2026-10-01T00:00:00Z'),
  run('jit', 'new', fail('hang'), '2026-10-10T00:00:00Z'),
  run('interpreter', 'old', fail('no-frames'), '2026-10-01T00:00:00Z'),
  run('interpreter', 'new', fail('no-frames'), '2026-10-10T00:00:00Z'),
];
assert.deepEqual(findRegressions(history, 'new').map(r => [r.coreId, r.passedOn, r.failsOn, r.category]), [['jit', 'old', 'new', 'hang']]);
assert.deepEqual(findRegressions(history), findRegressions(history, 'new'), 'defaults to the newest runtime');
assert.deepEqual(findRegressions([...history, run('jit', 'new', pass(40, 0), '2026-10-11T00:00:00Z')], 'new'), []);
assert.deepEqual(findRegressions(history, 'old'), []);
assert.deepEqual(findRegressions(history, 'unseen'), []);

// Import: arrays, { results } summaries and single results; invalid entries are counted.
const good = run('jit', 'b', pass(60, 0));
const withPath = { ...run('jit', 'b'), game: { name: '/home/me/roms/Game.nsp', path: '/home/me/roms/Game.nsp' } };
let parsed = parseImport({ results: [good, { schema: 'nope' }, run('jit', 'b', { outcome: 'fail' }), withPath] });
assert.equal(parsed.valid.length, 2);
assert.equal(parsed.invalid, 2);
assert.match(parsed.problems[0], /schema/);
assert.equal(parsed.valid[1].game.name, 'Game.nsp');
assert.equal(parsed.valid[1].game.path, undefined);
assert.equal(withPath.game.path, '/home/me/roms/Game.nsp', 'the input is not modified');
assert.equal(parseImport([good]).valid.length, 1);
assert.equal(parseImport(good).valid.length, 1);
parsed = parseImport({ checks: [] });
assert.equal(parsed.valid.length, 0);
assert.match(parsed.problems[0], /no results/);

// Session assessment.
const base = { now: 60_000, everRunning: true, firstFrameAt: 10_000, lastFrameAt: 59_500, fps: 30 };
assert.equal(assessSession(base).outcome, 'pass');
assert.equal(assessSession({ ...base, fps: 4 }).failure.category, 'performance');
assert.equal(assessSession({ ...base, lastFrameAt: 30_000 }).failure.category, 'hang');
assert.equal(assessSession({ ...base, firstFrameAt: null }).failure.category, 'no-frames');
assert.equal(assessSession({ ...base, firstFrameAt: null, everRunning: false }).failure.category, 'boot');
assert.equal(assessSession({ ...base, failed: true, loadResult: 2 }).failure.category, 'boot');
assert.equal(assessSession({ ...base, crash: 'runtime aborted: x' }).failure.category, 'crash');
assert.equal(assessSession({ ...base, crash: 'no frames for 46 s' }).failure.category, 'hang');

const samples = [0, 10, 20, 30, 40, 50].map((fps, i) => ({ t: i * 1000, fps }));
assert.equal(sustainedFps(samples, 3000), 50);
assert.equal(sustainedFps(samples, null), 0);

console.log('compatibility logic OK');
