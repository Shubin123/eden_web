// SPDX-License-Identifier: GPL-3.0-or-later
// Scripted game regression suite. Each scenario in tests/games/*.json boots a game in Chrome from a
// save file, drives the controller on a timeline counted in game frames (not wall-clock time, so a
// slower or faster build presses the same buttons at the same point of the game), pauses at
// checkpoints to capture the screen, and compares captures, frame rates and frame times with a
// recorded baseline. Every scenario must start from a save and the game must be seen reading it;
// the one exception is a scenario that creates the save (see tests/lib/game-session.mjs).
//
//   EDEN_KEYS=prod.zip EDEN_FIRMWARE=firmware.zip node tests/games.mjs [options]
// --record writes baselines (and the saves that createsSave scenarios export) instead of comparing.
// --only <id> (repeatable) runs only those scenarios; a scenario's save is made first when the
//   scenario that creates it is selected too. --repeat <n> runs each scenario n times and checks the
//   runs agree, which measures how deterministic the scenario is.
// --suite-dir <dir> holds saves/ and baselines/ (default $EDEN_SUITE_DIR or
//   ~/Documents/emulators/games/switch/eden-suite). Saves are user data and never go in the repo.
// --games-dir <dir> (repeatable; or EDEN_GAMES_DIRS separated by colons) is searched for ROMs whose
//   file name holds the scenario's [title ID]; --rom <titleId>=<file> (repeatable) names one
//   directly. --core <id>, --headful, --out <dir>.
//
// Steps, in order; `frame` counts game frames from boot, from the last matched anchor, or from the
// restart after a slotRoundTrip:
//   { frame, press|hold: "A", frames? }            hold a button (default 4 frames)
//   { frame, stick: "left", x, y, frames }          tilt a stick
//   { frame, checkpoint: "<name>", expect?, minSpread? }  capture and compare the screen (a capture
//                                                   flatter than minSpread, default 4, is blank)
//   { frame, anchor: "<name>", timeoutS?, minSpread? }  wait until the screen matches the recorded
//                                                   capture (loading takes a varying number of frames);
//                                                   recording takes the first still screen at least
//                                                   minSpread detailed
//   { frame, slotRoundTrip: <slot> }                save to that save slot, load it, check the
//                                                   restarted game reads the slot's files
//   { frame, exportSave: "<zip>" }                  write the save (createsSave scenarios)
// Exit code: 0 all passed, 1 a scenario failed or regressed, 2 setup failed.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { frameTimeStats } from '../web/results.js';
import { DEFAULT_GAME_DIRS, DEFAULT_SUITE_DIR, checkSaveRule, findRoms, launchLab, openGame, saveEntries } from './lib/game-session.mjs';
import { createProgress } from './lib/progress.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  options: {
    record: { type: 'boolean', default: false },
    only: { type: 'string', multiple: true },
    repeat: { type: 'string', default: '1' },
    'suite-dir': { type: 'string' },
    'games-dir': { type: 'string', multiple: true },
    rom: { type: 'string', multiple: true },
    core: { type: 'string' },
    headful: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

// Mean absolute difference (0-255) of 64x36 grey thumbnails allowed between a capture and its baseline.
const DEFAULT_TOLERANCE = 28;
// A segment may run this much slower than its baseline before it counts as a regression.
const FPS_REGRESSION = 0.8;
// Anchors are polled this many game frames apart.
const ANCHOR_POLL_FRAMES = 20;

const suiteDir = path.resolve(args['suite-dir'] ?? process.env.EDEN_SUITE_DIR ?? DEFAULT_SUITE_DIR);
const gameDirs = args['games-dir'] ?? process.env.EDEN_GAMES_DIRS?.split(':').filter(Boolean) ?? DEFAULT_GAME_DIRS;
const out = path.resolve(args.out ?? path.join(root, 'artifacts', `games-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const repeat = Math.max(1, Number(args.repeat) || 1);
const keys = process.env.EDEN_KEYS;
const firmware = process.env.EDEN_FIRMWARE;
if (!keys || !firmware) {
  console.error('Set EDEN_KEYS and EDEN_FIRMWARE.');
  process.exit(2);
}

async function loadScenarios() {
  const dir = path.join(root, 'tests/games');
  const scenarios = [];
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.json')).sort()) {
    for (const scenario of [].concat(JSON.parse(await readFile(path.join(dir, name), 'utf8')))) {
      if (!scenario.id || !/^[0-9A-F]{16}$/i.test(scenario.titleId ?? '')) throw new Error(`${name}: scenario needs id and titleId`);
      checkSaveRule(scenario);
      let last = -1;
      for (const step of scenario.steps) {
        if (!Number.isInteger(step.frame) || step.frame < last) throw new Error(`${scenario.id}: steps must be in frame order`);
        // Frames restart from 0 when a slot round trip reboots the game.
        last = step.slotRoundTrip ? 0 : step.frame;
      }
      scenarios.push(scenario);
    }
  }
  const selected = scenarios.filter(s => !args.only || args.only.includes(s.id));
  // Scenarios that create saves run before the ones that start from them.
  return selected.sort((a, b) => Number(Boolean(b.createsSave)) - Number(Boolean(a.createsSave)));
}

/// 64x36 grey thumbnail of a PNG, computed in the page (Node has no PNG decoder here).
async function thumbnail(page, png) {
  return page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(64, 36);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, 64, 36);
    const { data } = context.getImageData(0, 0, 64, 36);
    const grey = [];
    for (let i = 0; i < data.length; i += 4) grey.push(Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]));
    return grey;
  }, png.toString('base64'));
}

const difference = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
const spread = grey => {
  const mean = grey.reduce((a, b) => a + b, 0) / grey.length;
  return Math.sqrt(grey.reduce((sum, v) => sum + (v - mean) ** 2, 0) / grey.length);
};
const round = v => Math.round(v * 10) / 10;

async function runScenario(lab, scenario, rom, runDir, baseline, progress) {
  const result = { id: scenario.id, ok: false, checkpoints: [], segments: [], exports: [], save: null, slots: [] };
  const savePath = scenario.save ? path.join(suiteDir, 'saves', scenario.save) : null;
  if (savePath && !existsSync(savePath)) {
    result.error = `missing save ${savePath}; record the scenario that creates it first`;
    return result;
  }
  const timeoutAt = Date.now() + (scenario.timeoutS ?? 900) * 1000;
  const lastFrame = scenario.steps.at(-1).frame;
  let session;
  // Save files the game has to read: the scenario's save, then a slot's files after a round trip.
  let expected = savePath ? await saveEntries(await readFile(savePath)) : null;
  try {
    session = await openGame(lab, {
      rom, save: savePath, titleId: scenario.titleId, core: args.core, stallS: scenario.stallS ?? 60,
      onProgress: frame => progress.update(frame + origin),
    });
    progress.update(0, 'running');
    // Step frames are relative to `origin`, which anchors and slot restarts move.
    let origin = 0;
    const engineTimes = () => session.page.evaluate(() => window.__edenLab.drainEngine?.() ?? []);
    await engineTimes();
    let segmentStart = { frame: 0, time: Date.now(), exec: await session.execStats() };
    // Guest CPU work per segment: millions of guest cycles per real second (all cores and core 0),
    // and per second the cores spent executing, which keeps measuring emulation speed when a
    // game sits at its frame cap.
    const guestRates = (from, to) => {
      if (!from || !to) return null;
      const seconds = Math.max(0.001, (to.at - from.at) / 1000);
      const delta = to.cycles.map((c, i) => c - from.cycles[i]);
      const busy = to.busyMs.reduce((s, ms, i) => s + ms - from.busyMs[i], 0) / 1000;
      const cycles = delta.reduce((a, b) => a + b, 0);
      return {
        mcps: round(cycles / seconds / 1e6),
        core0Mcps: round(delta[0] / seconds / 1e6),
        busyMcps: busy > 0 ? round(cycles / busy / 1e6) : null,
      };
    };
    const endSegment = async name => {
      const now = { frame: await session.frame(), time: Date.now(), exec: await session.execStats() };
      const fps = (now.frame - segmentStart.frame) / Math.max(0.001, (now.time - segmentStart.time) / 1000);
      const times = await engineTimes();
      const ms = [];
      for (let i = 1; i < times.length; i += 2) ms.push(times[i]);
      const stats = ms.length ? frameTimeStats(ms) : null;
      result.segments.push({
        until: name, fps: round(fps),
        frameMs: stats ? { p50: round(stats.p50), p95: round(stats.p95), p99: round(stats.p99) } : null,
        stutters: stats?.stutters ?? null,
        guest: guestRates(segmentStart.exec, now.exec),
      });
    };
    const shoot = async name => {
      const { png, frame } = await session.capture({ keepPaused: true });
      const file = path.join(runDir, `${scenario.id}-${name}.png`);
      await writeFile(file, png);
      return { png, frame, file, grey: await thumbnail(session.page, png) };
    };

    for (const step of scenario.steps) {
      await session.waitFrame(origin + step.frame, timeoutAt);
      const phase = step.checkpoint ?? step.anchor ?? (step.slotRoundTrip ? `slot ${step.slotRoundTrip}` : null);
      if (phase) progress.update(origin + step.frame, phase);
      if (step.press || step.hold) {
        await session.press(step.press ?? step.hold, step.frames ?? 4);
      } else if (step.stick) {
        await session.stick(step.stick, step.x ?? 0, step.y ?? 0, step.frames ?? 30);
      } else if (step.checkpoint) {
        await endSegment(step.checkpoint);
        const shot = await shoot(step.checkpoint);
        result.checkpoints.push({ name: step.checkpoint, frame: shot.frame, file: shot.file, grey: shot.grey, spread: round(spread(shot.grey)), minSpread: step.minSpread });
        await session.resume();
        segmentStart = { frame: await session.frame(), time: Date.now(), exec: await session.execStats() };
      } else if (step.anchor) {
        await endSegment(step.anchor);
        const reference = baseline?.checkpoints.find(c => c.name === step.anchor && c.anchor);
        const tolerance = scenario.tolerance ?? DEFAULT_TOLERANCE;
        const anchorDeadline = Date.now() + (step.timeoutS ?? 120) * 1000;
        // With a recorded capture, wait for the screen to match it. Without one (recording), wait for
        // a drawn screen that holds still across two polls, so a loading screen is never recorded.
        const settled = (shot, previous) => (reference
          ? difference(shot.grey, reference.grey) <= tolerance
          : spread(shot.grey) >= (step.minSpread ?? scenario.minSpread ?? 4) && previous && difference(shot.grey, previous.grey) <= tolerance / 2);
        let previous = null;
        let shot = await shoot(step.anchor);
        while (!settled(shot, previous)) {
          if (Date.now() > anchorDeadline) {
            throw new Error(`anchor ${step.anchor} never appeared${reference ? ` (diff ${difference(shot.grey, reference.grey).toFixed(1)} > ${tolerance})` : ''}`);
          }
          previous = shot;
          await session.waitFrame(shot.frame + ANCHOR_POLL_FRAMES, timeoutAt);
          shot = await shoot(step.anchor);
        }
        origin = shot.frame - step.frame;
        result.checkpoints.push({ name: step.anchor, anchor: true, frame: shot.frame, file: shot.file, grey: shot.grey, spread: round(spread(shot.grey)) });
        await session.resume();
        segmentStart = { frame: await session.frame(), time: Date.now(), exec: await session.execStats() };
      } else if (step.slotRoundTrip) {
        await endSegment(`slot-${step.slotRoundTrip}`);
        // A game must have used its save before it is replaced by the slot.
        if (expected) result.save = await session.saveCheck(expected);
        if (result.save && !result.save.ok) throw new Error(`save not used before the slot round trip: ${result.save.problem}`);
        const trip = await session.slotRoundTrip(step.slotRoundTrip);
        result.slots.push({ slot: step.slotRoundTrip, files: trip.saved });
        expected = trip.slotFiles;
        origin = 0;
        segmentStart = { frame: 0, time: Date.now(), exec: await session.execStats() };
      } else if (step.exportSave) {
        const file = path.join(runDir, step.exportSave);
        await writeFile(file, await session.exportSaves());
        result.exports.push({ name: step.exportSave, file });
      }
    }
    await endSegment('end');
    if (expected) {
      const check = await session.saveCheck(expected);
      if (result.slots.length) result.slotCheck = check;
      else result.save = check;
      if (!check.ok) throw new Error(`save not used: ${check.problem}`);
    }
    result.ok = true;
  } catch (err) {
    result.error = err.message;
    await session?.page.screenshot({ path: path.join(runDir, `${scenario.id}-failure.png`) }).catch(() => {});
  } finally {
    if (session) {
      await writeFile(path.join(runDir, `${scenario.id}-console.log`), session.log.join('\n')).catch(() => {});
      await session.close();
    }
  }
  result.lastFrame = lastFrame;
  return result;
}

/// Problems with `run` relative to `reference` (a baseline or another run of the same scenario).
function compare(scenario, run, reference, label) {
  const problems = [];
  const tolerance = scenario.tolerance ?? DEFAULT_TOLERANCE;
  for (const checkpoint of run.checkpoints) {
    const expected = reference.checkpoints.find(c => c.name === checkpoint.name);
    if (!expected) continue;
    const diff = difference(checkpoint.grey, expected.grey);
    checkpoint[`diff_${label === 'baseline' ? 'baseline' : 'run1'}`] = round(diff);
    if (diff > tolerance) problems.push(`${checkpoint.name} differs from ${label} (${diff.toFixed(1)} > ${tolerance})`);
  }
  for (const segment of run.segments) {
    const expected = reference.segments.find(s => s.until === segment.until);
    if (expected && segment.until !== 'end' && segment.fps < expected.fps * FPS_REGRESSION) {
      problems.push(`${segment.until}: ${segment.fps} fps vs ${expected.fps} in ${label}`);
    }
  }
  return problems;
}

const scenarios = await loadScenarios();
if (!scenarios.length) {
  console.error('No scenarios selected.');
  process.exit(2);
}
const roms = await findRoms(gameDirs);
for (const pair of args.rom ?? []) {
  const [id, file] = pair.split(/=(.*)/s);
  roms.set(id.toUpperCase(), path.resolve(file));
}
await mkdir(out, { recursive: true });
await mkdir(path.join(suiteDir, 'baselines'), { recursive: true });
await mkdir(path.join(suiteDir, 'saves'), { recursive: true });

const planned = scenarios.filter(s => roms.has(s.titleId.toUpperCase()));
const progress = createProgress(Math.max(1, planned.reduce((sum, s) => sum + s.steps.at(-1).frame, 0) * repeat));
const lab = await launchLab({ headful: args.headful });
const summary = [];
let exitCode = 0;
try {
  await lab.installSystemFiles(keys, firmware);
  for (const scenario of scenarios) {
    const rom = roms.get(scenario.titleId.toUpperCase());
    if (!rom) {
      progress.log(`SKIP ${scenario.id}: no ROM with [${scenario.titleId}] in ${gameDirs.join(', ')}`);
      summary.push({ id: scenario.id, status: 'skipped' });
      continue;
    }
    const baselineFile = path.join(suiteDir, 'baselines', `${scenario.id}.json`);
    const baseline = existsSync(baselineFile) ? JSON.parse(await readFile(baselineFile, 'utf8')) : null;
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      const runDir = path.join(out, repeat > 1 ? `${scenario.id}-${i + 1}` : scenario.id);
      await mkdir(runDir, { recursive: true });
      const started = Date.now();
      progress.start(`${scenario.id}${repeat > 1 ? ` #${i + 1}/${repeat}` : ''}`, scenario.steps.at(-1).frame);
      const run = await runScenario(lab, scenario, rom, runDir, baseline, progress);
      progress.finish();
      run.seconds = Math.round((Date.now() - started) / 1000);
      run.problems = run.ok ? [] : [run.error];
      if (run.ok) {
        for (const checkpoint of run.checkpoints) {
          // A uniform screen (black, white, one colour) means nothing was drawn.
          if (!checkpoint.anchor && checkpoint.spread < (checkpoint.minSpread ?? scenario.minSpread ?? 4)) run.problems.push(`${checkpoint.name} is a blank screen`);
        }
        for (const segment of run.segments) {
          if (scenario.minFps && segment.until !== 'end' && segment.fps < scenario.minFps) run.problems.push(`${segment.until}: ${segment.fps} fps < ${scenario.minFps}`);
        }
        if (baseline && !args.record) run.problems.push(...compare(scenario, run, baseline, 'baseline'));
        if (i > 0 && runs[0].ok) run.problems.push(...compare(scenario, run, runs[0], 'run 1'));
      }
      runs.push(run);
      const saveNote = run.save ? (run.save.ok ? `save read (${run.save.opened.length}/${run.save.imported} files opened)` : `save NOT used`) : 'creates save';
      const detail = [
        saveNote,
        ...run.slots.map(s => `slot ${s.slot} round trip (${s.files} files)${run.slotCheck?.ok ? ' read back' : ''}`),
        ...run.checkpoints.map(c => `${c.name}@${c.frame}${c.diff_baseline !== undefined ? ` diff ${c.diff_baseline}` : ''}`),
        ...run.segments.map(s => `${s.until} ${s.fps} fps${s.frameMs ? ` p95 ${s.frameMs.p95} ms` : ''}${s.guest ? ` ${s.guest.mcps} Mcyc/s` : ''}`),
      ].join(', ');
      progress.log(`${run.problems.length ? 'FAIL' : 'PASS'} ${scenario.id}${repeat > 1 ? ` #${i + 1}` : ''} (${run.seconds} s): ${detail}`);
      for (const problem of run.problems) progress.log(`  - ${problem}`);
    }
    const failed = runs.some(r => r.problems.length);
    if (failed) exitCode = 1;
    if (args.record && !failed) {
      const run = runs[0];
      await writeFile(baselineFile, JSON.stringify({
        id: scenario.id, recordedAt: new Date().toISOString(),
        checkpoints: run.checkpoints.map(({ name, anchor, frame, grey }) => ({ name, anchor, frame, grey })),
        segments: run.segments,
      }));
      for (const saved of run.exports) await writeFile(path.join(suiteDir, 'saves', saved.name), await readFile(saved.file));
      progress.log(`  recorded ${path.relative(suiteDir, baselineFile)}${run.exports.length ? ` and ${run.exports.map(e => `saves/${e.name}`).join(', ')}` : ''}`);
    }
    summary.push({ id: scenario.id, status: failed ? 'failed' : 'passed', runs: runs.map(r => ({
      ...r, checkpoints: r.checkpoints.map(({ grey, ...c }) => c),
    })) });
  }
} catch (err) {
  progress.log(`Setup failed: ${err.message}`);
  exitCode = 2;
} finally {
  progress.stop();
  await lab.close();
}
await writeFile(path.join(out, 'games.json'), JSON.stringify({ record: args.record, suiteDir, summary }, null, 2));
const counts = ['passed', 'failed', 'skipped'].map(s => `${summary.filter(r => r.status === s).length} ${s}`).join(', ');
console.log(`${counts}. Report: ${path.relative(process.cwd(), path.join(out, 'games.json'))}`);
process.exit(exitCode);
