// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the regression lab helpers and scripts/compare-results.mjs against the synthetic result
// sets in tests/fixtures/. Needs no browser or games.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeResult, validateResult } from '../web/results.js';
import { compareSets } from '../scripts/compare-results.mjs';
import { classify, findHang, gameFromFile, groupKey, loadResults, mergeGameInfo, summarizeRuns } from './lib/lab.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = path.join(root, 'tests/fixtures');
const baselineFile = path.join(fixtures, 'results-baseline.json');
const candidateFile = path.join(fixtures, 'results-candidate.json');

// Game identity from a file name keeps only the base name.
const game = gameFromFile('/media/games/Captain Toad Treasure Tracker [01009BF0072D4000][v0].nsp');
assert.deepEqual(game, { titleId: '01009BF0072D4000', name: 'Captain Toad Treasure Tracker', version: 0, displayVersion: null, file: 'Captain Toad Treasure Tracker [01009BF0072D4000][v0].nsp' });
assert.equal(gameFromFile('homebrew.nro').titleId, null);
assert.equal(mergeGameInfo(game, { title_id: '0x01009bf0072d4000', name: 'Captain Toad', display_version: '1.3.0' }).displayVersion, '1.3.0');
assert.equal(mergeGameInfo(game, { titleId: 'garbage' }).titleId, '01009BF0072D4000');
assert.equal(mergeGameInfo(game, null), game);

// The earliest failing stage picks the category.
assert.deepEqual(classify([{ name: 'a', ok: true, category: 'init' }]), { outcome: 'pass', failure: null });
const crashed = classify([
  { name: 'sustained game fps', ok: false, category: 'performance' },
  { name: 'no crashes', ok: false, detail: 'runtime aborted', category: 'crash' },
  { name: 'game frames visible', ok: false, category: 'no-frames' },
]);
assert.equal(crashed.failure.category, 'crash');
assert.equal(crashed.failure.detail, 'no crashes: runtime aborted');
assert.deepEqual(validateResult(makeResult({ outcome: crashed.outcome, failure: crashed.failure })), []);

// A hang needs frames first, then enough frameless samples in a row.
const timeline = fps => fps.map((value, i) => ({ t: i * 2, fps: value }));
assert.equal(findHang(timeline([0, 0, 0, 0, 0, 0]), 3), null, 'never drew: no-frames, not a hang');
assert.equal(findHang(timeline([30, 0, 0, 30, 0, 0]), 3), null, 'recovered in time');
assert.deepEqual(findHang(timeline([30, 30, 0, 0, 0]), 3), { fromS: 4, samples: 3 });

// Repeats summarize to median and spread; cold and warm starts are kept apart.
const runs = [20, 22, 24].map(fps => makeResult({ outcome: 'pass', metrics: { sustainedFps: fps } }));
assert.deepEqual(summarizeRuns(runs).sustainedFps, { n: 3, median: 22, min: 20, max: 24, spread: 4 / 22 });
assert.notEqual(groupKey(makeResult({ scenario: { name: 's', warm: false } })), groupKey(makeResult({ scenario: { name: 's', warm: true } })));

// Synthetic baseline vs candidate: three regressions (an outcome, a failure stage, a frame-time
// p99 beyond the repeats' spread), one improvement; noise within tolerance or floors is ignored.
const baseline = (await loadResults(baselineFile)).results;
const candidate = (await loadResults(candidateFile)).results;
assert.equal(baseline.length, 7);
assert.equal(candidate.length, 8);
const report = compareSets(baseline, candidate);
const summary = report.findings.map(f => `${f.kind} ${f.run} ${f.what}`).sort();
assert.deepEqual(summary, [
  'improvement Pikmin 1 | jit | boot 60s | cold outcome',
  'info Captain Toad Treasure Tracker | jit | crash-recovery 60s | cold new',
  'regression Blaster Master Zero 3 | interpreter | boot 60s | cold outcome',
  'regression Captain Toad Treasure Tracker | interpreter | boot 60s | cold failure',
  'regression Captain Toad Treasure Tracker | jit | boot 60s | warm frameTime.p99',
]);
// A looser threshold hides the p99 change; the outcome regressions stay.
assert.equal(compareSets(baseline, candidate, { threshold: 1 }).regressions.length, 2);
// Identical sets compare clean.
assert.equal(compareSets(baseline, baseline).findings.length, 0);

// One failed repeat out of three is flaky: a warning, or a regression with --strict.
const pass = makeResult({ outcome: 'pass', scenario: { name: 'x' } });
const fail = makeResult({ outcome: 'fail', failure: { category: 'hang' }, scenario: { name: 'x' } });
assert.equal(compareSets([pass, pass, pass], [pass, pass, fail]).findings[0].kind, 'warning');
assert.equal(compareSets([pass, pass, pass], [pass, pass, fail], { strict: true }).regressions.length, 1);

// Directories are read recursively; a result also embedded in a set counts once; bad files are reported.
const dir = await mkdtemp(path.join(os.tmpdir(), 'eden-compare-'));
try {
  await writeFile(path.join(dir, 'set.json'), JSON.stringify({ schema: 'eden-web/result-set@1', results: [pass] }));
  await writeFile(path.join(dir, 'single.result.json'), JSON.stringify(pass));
  await writeFile(path.join(dir, 'broken.json'), '{');
  await writeFile(path.join(dir, 'invalid.json'), JSON.stringify({ ...fail, failure: null }));
  const loaded = await loadResults(dir);
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.problems.length, 2);
} finally {
  await rm(dir, { recursive: true, force: true });
}

// The command line exits 1 on regressions and 0 without.
const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/compare-results.mjs'), ...args], { encoding: 'utf8' });
const regressed = cli(baselineFile, candidateFile);
assert.equal(regressed.status, 1, regressed.stderr);
assert.match(regressed.stdout, /REGRESSIONS: 3/);
assert.equal(cli(baselineFile, baselineFile).status, 0);
assert.equal(cli(baselineFile).status, 2);

console.log('compare results OK');
