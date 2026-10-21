// SPDX-License-Identifier: GPL-3.0-or-later
// Cross-core regression matrix: runs tests/e2e.mjs for every core x game x scenario and writes one
// result set (matrix.json, the format of web/results.js) plus a text table.
//
//   EDEN_KEYS=prod.zip EDEN_FIRMWARE=firmware.zip EDEN_ROMS="a.nsp:b.nsp" node tests/matrix.mjs [options] [-- e2e options]
//   npm run test:matrix -- --mode bench --games a.nsp --games b.nsp --seconds 120 --headful
//
// --mode compat (default) runs jobs in parallel (--jobs, default min(4, CPUs / 4)), each with its
//   own Chrome profile, server port and artifacts directory. Good for "does it still work".
// --mode bench runs one job at a time, since parallel jobs distort each other's timing, and
//   repeats each scenario (--repeat, default 3: one cold start, then warm starts).
// --cores jit,interpreter picks cores (default: every core in web/cores.js marked available; a core
//   that is not available is reported unsupported, not failed).
// --games a.nsp (repeatable; or EDEN_ROMS separated by colons or newlines). Without games, or with
//   the core-ready scenario, only page load and core start-up are tested.
// --scenarios boot,crash-recovery,core-ready (default boot with games, core-ready without).
// --seconds, --warmup, --headful, --static, --url and anything after -- are passed to e2e.mjs.
// --out <dir> (default artifacts/matrix-<time>). Exit code: 0 all passed or unsupported, 1 otherwise.

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CPU_CORES } from '../web/cores.js';
import { makeResult, makeResultSet, validateResult } from '../web/results.js';
import { gameFromFile, groupResults, median, table } from './lib/lab.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args, positionals: passthrough } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: 'string', default: 'compat' },
    cores: { type: 'string' },
    games: { type: 'string', multiple: true },
    scenarios: { type: 'string' },
    jobs: { type: 'string' },
    repeat: { type: 'string' },
    seconds: { type: 'string', default: '90' },
    warmup: { type: 'string' },
    headful: { type: 'boolean', default: false },
    static: { type: 'boolean', default: false },
    url: { type: 'string' },
    out: { type: 'string' },
  },
});

if (!['compat', 'bench'].includes(args.mode)) throw new Error(`--mode is compat or bench, not ${args.mode}`);
const bench = args.mode === 'bench';
const split = list => list.flatMap(item => item.split(/[\n:]/)).map(item => item.trim()).filter(Boolean);
const games = split(args.games ?? (process.env.EDEN_ROMS ? [process.env.EDEN_ROMS] : []));
const systemFiles = Boolean(process.env.EDEN_KEYS && process.env.EDEN_FIRMWARE);
if (games.length && !systemFiles) throw new Error('games need EDEN_KEYS and EDEN_FIRMWARE');
const cores = args.cores ? args.cores.split(',').map(id => id.trim()) : CPU_CORES.filter(core => core.available).map(core => core.id);
const SCENARIOS = {
  boot: { game: true, args: [] },
  'crash-recovery': { game: true, args: ['--crash-at', '20'] },
  'core-ready': { game: false, args: [] },
};
const scenarios = args.scenarios ? args.scenarios.split(',').map(name => name.trim()) : [games.length ? 'boot' : 'core-ready'];
for (const name of scenarios) if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(', ')}`);
const jobsLimit = bench ? 1 : Math.max(1, Number(args.jobs) || Math.min(4, Math.floor(os.availableParallelism() / 4)) || 1);
const repeat = Math.max(1, Number(args.repeat) || (bench ? 3 : 1));
const startedAt = new Date();
const out = path.resolve(args.out ?? path.join(root, 'artifacts', `matrix-${startedAt.toISOString().replace(/[:.]/g, '-')}`));
const slug = text => text.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'game';

const jobs = [];
for (const scenario of scenarios) {
  for (const game of SCENARIOS[scenario].game ? games : [null]) {
    for (const core of cores) jobs.push({ scenario, game, core });
  }
}
if (!jobs.length) throw new Error('nothing to run: the scenarios need games (--games or EDEN_ROMS)');

console.log(`matrix ${args.mode}: ${jobs.length} jobs (${cores.join(', ')} x ${games.length || 'no'} games x ${scenarios.join(', ')}), ` +
  `${jobsLimit} at a time, ${repeat} run${repeat > 1 ? 's' : ''} each -> ${path.relative(process.cwd(), out)}`);

async function runJob(job) {
  const gameName = job.game ? path.basename(job.game) : null;
  job.dir = path.join(out, job.core, job.game ? slug(gameName) : 'no-game', job.scenario);
  await mkdir(job.dir, { recursive: true });
  const e2eArgs = [
    path.join(root, 'tests/e2e.mjs'), '--core', job.core, '--scenario', job.scenario, '--artifacts', job.dir,
    '--repeat', String(repeat), '--seconds', args.seconds,
    ...(args.warmup ? ['--warmup', args.warmup] : []),
    ...(args.headful ? ['--headful'] : []), ...(args.static ? ['--static'] : []), ...(args.url ? ['--url', args.url] : []),
    ...SCENARIOS[job.scenario].args, ...passthrough,
  ];
  const env = { ...process.env };
  if (job.game) env.EDEN_ROM = job.game;
  else delete env.EDEN_ROM;
  const started = Date.now();
  const log = createWriteStream(path.join(job.dir, 'e2e.log'));
  job.exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, e2eArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', code => resolve(code ?? 1));
  });
  log.end();
  job.durationS = Math.round((Date.now() - started) / 1000);

  job.results = [];
  for (const file of (await readdir(job.dir)).filter(name => name.endsWith('.result.json')).sort()) {
    const result = JSON.parse(await readFile(path.join(job.dir, file), 'utf8'));
    result.source = 'matrix';
    if (!validateResult(result).length) job.results.push(result);
  }
  if (!job.results.length) {
    // The harness itself failed (bad option, Chrome did not start): keep that visible as a failure.
    const lastLine = (await readFile(path.join(job.dir, 'e2e.log'), 'utf8').catch(() => '')).trim().split('\n').at(-1) ?? '';
    job.results.push(makeResult({
      source: 'matrix', game: job.game ? gameFromFile(job.game) : null, core: { id: job.core, emulator: 'Eden' },
      scenario: { name: job.scenario, seconds: Number(args.seconds), warm: false, settings: { core: job.core } },
      outcome: 'fail', failure: { category: 'environment', detail: `e2e exited ${job.exitCode} without a result: ${lastLine.slice(0, 200)}` },
      notes: 'harness error',
    }));
  }
  const outcomes = job.results.map(result => result.outcome === 'fail' ? `fail:${result.failure.category}` : result.outcome);
  console.log(`  [${job.core}] ${gameName ?? '(no game)'} ${job.scenario}: ${outcomes.join(', ')} in ${job.durationS} s`);
}

// A small pool: at most jobsLimit e2e runs (each its own Chrome) at once.
const queue = [...jobs];
await Promise.all(Array.from({ length: Math.min(jobsLimit, jobs.length) }, async () => {
  while (queue.length) await runJob(queue.shift());
}));

const results = jobs.flatMap(job => job.results);
const finishedAt = new Date();
const set = makeResultSet(results, {
  source: 'matrix', mode: args.mode, startedAt: startedAt.toISOString(), durationS: Math.round((finishedAt - startedAt) / 1000),
  cores, games: games.map(game => path.basename(game)), scenarios, jobs: jobsLimit, repeat, seconds: Number(args.seconds),
  host: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.availableParallelism(), node: process.version },
  runs: jobs.map(job => ({
    core: job.core, game: job.game ? path.basename(job.game) : null, scenario: job.scenario, exitCode: job.exitCode,
    durationS: job.durationS, dir: path.relative(out, job.dir), results: job.results.map(result => result.id),
  })),
});
const setPath = path.join(out, 'matrix.json');
await writeFile(setPath, JSON.stringify(set, null, 2));

const fixed = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '');
const rows = results.map(result => ({
  game: result.game?.name ?? '-',
  core: result.core?.id,
  scenario: result.scenario?.name,
  start: result.scenario?.warm ? `warm ${result.scenario.settings?.run ?? ''}`.trim() : 'cold',
  outcome: result.outcome === 'fail' ? `fail:${result.failure.category}` : result.outcome,
  'ready ms': result.metrics?.coreReadyMs ?? '',
  'frame s': result.metrics?.firstFrameS ?? '',
  'sust fps': fixed(result.metrics?.sustainedFps),
  'p50 ms': fixed(result.metrics?.frameTime?.p50),
  'p99 ms': fixed(result.metrics?.frameTime?.p99),
  stutters: result.metrics?.frameTime?.stutters ?? '',
  source: result.metrics?.frameTimeSource ?? '',
}));
console.log(`\n${table(rows, Object.keys(rows[0]))}`);

// One cell per game and scenario per core: pass, fail:<category>, flaky n/m or unsupported.
const groups = groupResults(results);
const pivot = new Map();
for (const runs of groups.values()) {
  const first = runs[0];
  const row = `${first.game?.name ?? '(no game)'} / ${first.scenario?.name}`;
  if (!pivot.has(row)) pivot.set(row, { run: row });
  const passed = runs.filter(r => r.outcome === 'pass').length;
  const ran = runs.filter(r => r.outcome === 'pass' || r.outcome === 'fail').length;
  const failed = runs.find(r => r.outcome === 'fail');
  const fps = median(runs.map(r => r.metrics?.sustainedFps));
  const cell = !ran ? first.outcome : passed === ran ? 'pass' : passed ? `flaky ${passed}/${ran}` : `fail:${failed.failure.category}`;
  const column = `${first.core?.id}${first.scenario?.warm ? ' warm' : ''}`;
  pivot.get(row)[column] = `${cell}${Number.isFinite(fps) && first.game ? ` ${fps.toFixed(0)}fps` : ''}`;
}
const pivotRows = [...pivot.values()];
const columns = ['run', ...new Set(pivotRows.flatMap(row => Object.keys(row).filter(key => key !== 'run')))];
console.log(`\n${table(pivotRows, columns)}`);

const failed = results.filter(result => result.outcome === 'fail').length;
const unsupported = results.filter(result => result.outcome === 'unsupported').length;
console.log(`\n${results.length} results: ${results.length - failed - unsupported} passed, ${failed} failed, ${unsupported} unsupported; ` +
  `${set.meta.durationS} s; ${path.relative(process.cwd(), setPath)}`);
process.exit(failed ? 1 : 0);
