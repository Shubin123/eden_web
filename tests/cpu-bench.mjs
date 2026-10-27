// SPDX-License-Identifier: GPL-3.0-or-later
// CPU cost of emulating a fixed stretch of a game, for comparing engine builds. Runs a game to a
// scene, lets the JIT settle, then measures N game frames: game fps, frame times, guest work, and
// the CPU time the page's process spent. CPU time per frame barely moves with other load on the
// machine, unlike fps, so it is the number to compare. Builds run interleaved (a, b, a, b, ...) so
// whatever load there is hits them alike.
//
//   EDEN_KEYS=prod.zip EDEN_FIRMWARE=fw.zip node tests/cpu-bench.mjs --runtime <dir> [--runtime <dir> ...]
//       [--scenario silksong-title|toad|silksong-new-game|nier] [--rounds 2] [--frames 600] [--settle 600]
//       [--rom <titleId>=<file>]
// A --runtime directory holds eden.js and eden.wasm (a build's bin/ works); each is copied into
// web/runtime for its run, and the original runtime is put back afterwards. The first is the
// reference. EDEN_LAB_PROFILE=<dir> keeps the browser profile between runs (imported keys and
// firmware, compiled code), which saves the import each run. ROMs are found as in tests/games.mjs.
// Each run is limited to MAX_TEST_S.

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { frameTimeStats } from '../web/results.js';
import { DEFAULT_GAME_DIRS, MAX_TEST_S, findRoms, launchLab, openGame, spread, thumbnail } from './lib/game-session.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  options: {
    runtime: { type: 'string', multiple: true },
    scenario: { type: 'string', default: 'silksong-title' },
    rounds: { type: 'string', default: '2' },
    frames: { type: 'string', default: '600' },
    settle: { type: 'string', default: '600' },
    'games-dir': { type: 'string', multiple: true },
    rom: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
});
const keys = process.env.EDEN_KEYS;
const firmware = process.env.EDEN_FIRMWARE;
if (!keys || !firmware || !args.runtime?.length) {
  console.error('Set EDEN_KEYS and EDEN_FIRMWARE and pass at least one --runtime <dir>.');
  process.exit(2);
}

// Each scenario boots a title and presses A on a schedule (game frames) until the scene is on screen;
// a press can also be [frame, button].
const SCENARIOS = {
  'silksong-title': { titleId: '010013C00E930000', presses: [], reachFrame: 2400, walk: null },
  'silksong-new-game': { titleId: '010013C00E930000', presses: Array.from({ length: 37 }, (_, i) => 2400 + 100 * i), walk: [1, 0] },
  toad: { titleId: '01009BF0072D4000', presses: Array.from({ length: 24 }, (_, i) => 300 + 60 * i), walk: [0.5, 0.5] },
  // NieR:Automata from a fresh profile into the opening flight; its dialogs default to No, so each
  // A follows a Left. Use --settle 1200 to measure the shoot-em-up over the sea.
  nier: {
    titleId: '0100B8E016F76000',
    presses: Array.from({ length: 35 }, (_, i) => [[300 + 100 * i, 'Left'], [330 + 100 * i, 'A']]).flat(),
    walk: null,
  },
};
const scenario = SCENARIOS[args.scenario];
if (!scenario) {
  console.error(`Unknown scenario ${args.scenario}; one of ${Object.keys(SCENARIOS).join(', ')}.`);
  process.exit(2);
}

const roms = await findRoms(args['games-dir'] ?? process.env.EDEN_GAMES_DIRS?.split(':').filter(Boolean) ?? DEFAULT_GAME_DIRS);
for (const pair of args.rom ?? []) {
  const at = pair.indexOf('=');
  roms.set(pair.slice(0, at).toUpperCase(), path.resolve(pair.slice(at + 1)));
}
const rom = roms.get(scenario.titleId);
if (!rom) {
  console.error(`No ROM for ${scenario.titleId} found.`);
  process.exit(2);
}

const out = path.resolve(args.out ?? path.join(root, 'artifacts', `cpu-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(out, { recursive: true });
const runtimeDir = path.join(root, 'web/runtime');
const FILES = ['eden.js', 'eden.wasm'];

/// CPU seconds the page's renderer process has used, summed over its threads.
function rendererCpu(lab) {
  const seconds = t => t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  const rows = execFileSync('ps', ['-Ao', 'pid,ppid,time,command'], { encoding: 'utf8' }).split('\n')
    .map(row => row.trim().split(/\s+/)).filter(f => Number(f[1]) === lab.browser.process().pid && f.slice(3).join(' ').includes('--type=renderer'));
  return Math.max(0, ...rows.map(f => seconds(f[2])));
}

async function measure(label) {
  const started = Date.now();
  const deadline = started + (MAX_TEST_S - 10) * 1000;
  const lab = await launchLab();
  const result = { label, ok: false };
  try {
    await lab.installSystemFiles(keys, firmware);
    const session = await openGame(lab, { rom, stallS: 90 });
    if (scenario.reachFrame) await session.waitFrame(scenario.reachFrame, deadline);
    const presses = scenario.presses.map(press => (Array.isArray(press) ? press : [press, 'A']));
    for (const [frame, button] of presses) {
      await session.waitFrame(frame, deadline);
      await session.press(button, 6);
    }
    // Two detailed captures in a row: a loading screen is never measured as the scene.
    let detailed = 0;
    for (let frame = (presses.at(-1)?.[0] ?? scenario.reachFrame) + 100; detailed < 2; frame += 100) {
      if (Date.now() > deadline) throw new Error('scene not reached in time');
      await session.waitFrame(frame, deadline);
      const shot = await session.capture();
      result.spread = spread(await thumbnail(session.page, shot.png));
      detailed = result.spread > 25 ? detailed + 1 : 0;
      if (!detailed && scenario.walk) await session.press('A', 6);
    }
    result.sceneAtS = (Date.now() - started) / 1000;
    const frames = Number(args.frames);
    await session.waitFrame((await session.frame()) + Number(args.settle), deadline);
    const drain = () => session.page.evaluate(() => window.__edenLab.drainEngine?.() ?? []);
    await drain();
    const f0 = await session.frame();
    const e0 = await session.execStats();
    const cpu0 = rendererCpu(lab);
    const t0 = Date.now();
    const walking = scenario.walk ? session.stick('left', ...scenario.walk, frames + 60) : Promise.resolve();
    await session.waitFrame(f0 + frames, deadline);
    const seconds = (Date.now() - t0) / 1000;
    const f1 = await session.frame();
    const e1 = await session.execStats();
    result.cpuS = rendererCpu(lab) - cpu0;
    await walking.catch(() => {});
    result.cpuMsPerFrame = 1000 * result.cpuS / (f1 - f0);
    result.fps = (f1 - f0) / seconds;
    const times = await drain();
    result.frameMs = frameTimeStats(times.filter((_, i) => i % 2));
    const delta = i => e1.cycles[i] - e0.cycles[i];
    result.core0Mcps = delta(0) / seconds / 1e6;
    result.core0PerBusyS = delta(0) / ((e1.busyMs[0] - e0.busyMs[0]) / 1000) / 1e6;
    result.ok = true;
  } catch (err) {
    result.error = err.message;
  } finally {
    await lab.close();
    result.wallS = (Date.now() - started) / 1000;
  }
  return result;
}

const originals = {};
const results = [];
try {
  for (let round = 1; round <= Number(args.rounds); ++round) {
    for (const [index, dir] of args.runtime.entries()) {
      for (const file of FILES) {
        const target = path.join(runtimeDir, file);
        originals[file] ??= path.join(out, `original-${file}`);
        if (round === 1 && index === 0) await copyFile(target, originals[file]);
        await copyFile(path.join(path.resolve(dir), file), target);
      }
      const label = `${path.basename(path.resolve(dir))}#${round}`;
      const result = await measure(label);
      results.push(result);
      const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
      console.log(result.error ? `${label}: ERROR ${result.error}`
        : `${label}: ${f(result.cpuMsPerFrame)} ms CPU/frame, ${f(result.fps)} fps, frame ms ${f(result.frameMs?.p50)}/${f(result.frameMs?.p95)}/${f(result.frameMs?.p99)}, ` +
          `core 0 ${f(result.core0PerBusyS, 0)} M guest cycles per busy s, scene at ${f(result.sceneAtS, 0)} s`);
    }
  }
} finally {
  for (const file of FILES) if (originals[file]) await copyFile(originals[file], path.join(runtimeDir, file)).catch(() => {});
  await writeFile(path.join(out, 'cpu-bench.json'), JSON.stringify({ scenario: args.scenario, results }, null, 2));
}

// Median CPU per frame of each build against the reference.
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const byBuild = new Map();
for (const r of results.filter(r => r.ok)) byBuild.set(r.label.replace(/#\d+$/, ''), [...(byBuild.get(r.label.replace(/#\d+$/, '')) ?? []), r.cpuMsPerFrame]);
const reference = [...byBuild.values()][0] && median([...byBuild.values()][0]);
console.log(`\n${args.scenario}, ${args.frames} frames per run, median CPU ms/frame:`);
for (const [build, values] of byBuild) console.log(`  ${build.padEnd(20)} ${median(values).toFixed(1)}${reference ? ` (${(median(values) / reference).toFixed(2)}x)` : ''}  runs ${values.map(v => v.toFixed(1)).join(' ')}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
