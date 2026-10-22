// SPDX-License-Identifier: GPL-3.0-or-later
// Agentic game test suite. A Claude agent watches the emulator screen and plays toward goals
// written in plain language ("get from the title screen into the first room"), through controller
// tools timed in game frames, and reports what looks broken (rendering glitches, hangs, crashes,
// input that does nothing). Its tool calls are recorded as a scripted scenario, so a run that
// reaches its goal can be replayed deterministically by tests/games.mjs (--emit-scenarios).
//
// --judge <games.json report> instead asks Claude whether each checkpoint capture of a scripted
// run matches the checkpoint's "expect" text, catching wrong screens that pixel baselines accept.
//
//   EDEN_KEYS=prod.zip EDEN_FIRMWARE=firmware.zip node tests/agent.mjs [options]
// --only <id> (repeatable) picks goal sets from tests/agent/*.json. --max-cost <usd> (default 3)
// stops a run once its estimated API spend passes the limit. --effort low|medium|high (default
// medium). --emit-scenarios writes reached goals to tests/games/agent-<id>.json. --suite-dir,
// --games-dir, --rom, --core, --headful, --out as in tests/games.mjs.
// Credentials: ANTHROPIC_API_KEY, or an `ant auth login` profile. Every run spends API credits.
//
// Goal set format: { id, titleId, save: "<zip in saves/>" | createsSave: "<zip to write>",
//   goals: [{ goal, maxSteps?, expect? }] }. Every set starts from a save, which the game must be seen
//   reading, except a set that creates one; that set exports the save once all its goals are reached.
// Exit code: 0 every goal reached and no issue reported, 1 otherwise, 2 setup failed.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { BUTTONS, DEFAULT_GAME_DIRS, DEFAULT_SUITE_DIR, STICKS, checkSaveRule, findRoms, launchLab, openGame, saveEntries } from './lib/game-session.mjs';
import { createProgress } from './lib/progress.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  options: {
    only: { type: 'string', multiple: true },
    judge: { type: 'string' },
    'max-cost': { type: 'string', default: '3' },
    effort: { type: 'string', default: 'medium' },
    'emit-scenarios': { type: 'boolean', default: false },
    'suite-dir': { type: 'string' },
    'games-dir': { type: 'string', multiple: true },
    rom: { type: 'string', multiple: true },
    core: { type: 'string' },
    headful: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const MODEL = 'claude-opus-5-5';
// USD per million tokens for MODEL: input, output, cache write (5 min), cache read.
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
const SCREEN_WIDTH = 640;
const suiteDir = path.resolve(args['suite-dir'] ?? process.env.EDEN_SUITE_DIR ?? DEFAULT_SUITE_DIR);
const gameDirs = args['games-dir'] ?? process.env.EDEN_GAMES_DIRS?.split(':').filter(Boolean) ?? DEFAULT_GAME_DIRS;
const out = path.resolve(args.out ?? path.join(root, 'artifacts', `agent-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const maxCost = Number(args['max-cost']) || 3;
const client = new Anthropic();

/// Running API spend for one run, from each response's usage.
function createMeter() {
  const meter = { usd: 0, requests: 0, input: 0, output: 0, cacheRead: 0 };
  meter.add = usage => {
    meter.requests++;
    meter.input += usage.input_tokens ?? 0;
    meter.output += usage.output_tokens ?? 0;
    meter.cacheRead += usage.cache_read_input_tokens ?? 0;
    meter.usd += ((usage.input_tokens ?? 0) * PRICE.input + (usage.output_tokens ?? 0) * PRICE.output +
      (usage.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (usage.cache_read_input_tokens ?? 0) * PRICE.cacheRead) / 1e6;
  };
  return meter;
}

/// One request with refusal fallback; returns the response or throws on a refusal of the whole chain.
async function ask(meter, request) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: args.effort, ...request.output_config },
    cache_control: { type: 'ephemeral' },
    ...request,
  });
  meter.add(response.usage);
  if (response.stop_reason === 'refusal') {
    throw new Error(`model declined (${response.stop_details?.category ?? 'no category'})`);
  }
  return response;
}

const image = png => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });

const strict = (name, description, properties, required) => ({
  name, description, strict: true,
  input_schema: { type: 'object', properties, required, additionalProperties: false },
});
const TOOLS = [
  strict('press', 'Press and hold one controller button for some game frames (the game runs at 30-60 frames a second), then release it. Returns the screen afterwards.', {
    button: { type: 'string', enum: Object.keys(BUTTONS) },
    frames: { type: 'integer', minimum: 1, maximum: 120 },
  }, ['button', 'frames']),
  strict('stick', 'Tilt an analog stick for some game frames, then centre it. x is -1 (left) to 1 (right), y is -1 (down) to 1 (up). Returns the screen afterwards.', {
    stick: { type: 'string', enum: Object.keys(STICKS) },
    x: { type: 'number', minimum: -1, maximum: 1 },
    y: { type: 'number', minimum: -1, maximum: 1 },
    frames: { type: 'integer', minimum: 1, maximum: 600 },
  }, ['stick', 'x', 'y', 'frames']),
  strict('wait', 'Let the game run without input for some game frames, for loading screens and cutscenes. Returns the screen afterwards.', {
    frames: { type: 'integer', minimum: 1, maximum: 1800 },
  }, ['frames']),
  strict('report_issue', 'Record something that looks like an emulator bug rather than normal game behaviour: corrupted or missing graphics, a frozen picture, input that has no effect, very low frame rate. Does not change the game.', {
    kind: { type: 'string', enum: ['graphics', 'hang', 'input', 'performance', 'other'] },
    description: { type: 'string' },
  }, ['kind', 'description']),
  strict('finish', 'End this goal: reached is true when the screen shows the goal achieved.', {
    reached: { type: 'boolean' },
    summary: { type: 'string' },
  }, ['reached', 'summary']),
];

const SYSTEM = `You are testing a Nintendo Switch emulator that runs in a web browser. You control player 1's controller and see the game screen after every action. Each user turn gives you one goal; work toward it with the press, stick and wait tools, one action per call, and look at each returned screen before choosing the next action. Durations are in game frames, so a slow emulator gets the same input as a fast one.

Use report_issue for anything that looks like an emulator fault rather than the game working as designed, such as garbled textures, black or missing geometry, a picture that does not change for a long time, or input with no effect. Do not report a game's normal loading screens or cutscenes. Call finish once the screen shows the goal reached, or when you are sure it cannot be reached, and say why.`;

/// Plays one goal set: boots the game, then runs each goal as an append-only conversation.
async function runGoalSet(lab, set, rom, runDir, progress) {
  const meter = createMeter();
  const result = { id: set.id, goals: [], issues: [], meter, steps: [] };
  const save = set.save ? path.join(suiteDir, 'saves', set.save) : null;
  if (save && !existsSync(save)) throw new Error(`missing save ${save}`);
  const totalSteps = set.goals.reduce((sum, g) => sum + (g.maxSteps ?? 30), 0);
  let stepsDone = 0;
  progress.start(set.id, totalSteps);
  const session = await openGame(lab, { rom, save, titleId: set.titleId, core: args.core });
  const expected = save ? await saveEntries(await readFile(save)) : null;
  try {
    let shot = 0;
    const screen = async () => {
      // The game stays paused while the model decides, so it acts on the screen it was shown.
      const { png, frame } = await session.capture({ keepPaused: true });
      await writeFile(path.join(runDir, `${String(++shot).padStart(3, '0')}-f${frame}.png`), png);
      return { small: await session.downscale(png, SCREEN_WIDTH), frame, png };
    };
    for (const goal of set.goals) {
      const record = { goal: goal.goal, reached: false, summary: '', steps: 0 };
      result.goals.push(record);
      const first = await screen();
      const messages = [{ role: 'user', content: [
        image(first.small),
        { type: 'text', text: `Goal: ${goal.goal}\nGame frame ${first.frame}, ${(await session.fps()).toFixed(1)} fps.` },
      ] }];
      const maxSteps = goal.maxSteps ?? 30;
      while (record.steps < maxSteps && !record.done) {
        if (meter.usd > maxCost) {
          record.summary = `stopped: API spend reached $${meter.usd.toFixed(2)} (limit $${maxCost})`;
          break;
        }
        const response = await ask(meter, { system: SYSTEM, tools: TOOLS, messages });
        messages.push({ role: 'assistant', content: response.content });
        const calls = response.content.filter(b => b.type === 'tool_use');
        if (!calls.length) {
          // No action: ask once more, keeping the history append-only.
          messages.push({ role: 'user', content: 'Choose the next action with one of the tools, or call finish.' });
          record.steps++;
          continue;
        }
        const results = [];
        for (const call of calls) {
          const input = call.input;
          const start = await session.frame();
          let content;
          try {
            if (call.name === 'press') {
              await session.press(input.button, input.frames);
              result.steps.push({ frame: start, press: input.button, frames: input.frames });
            } else if (call.name === 'stick') {
              await session.stick(input.stick, input.x, input.y, input.frames);
              result.steps.push({ frame: start, stick: input.stick, x: input.x, y: input.y, frames: input.frames });
            } else if (call.name === 'wait') {
              await session.waitFrame(start + input.frames);
            } else if (call.name === 'report_issue') {
              const at = await screen();
              result.issues.push({ ...input, frame: at.frame, goal: goal.goal, file: `${String(shot).padStart(3, '0')}-f${at.frame}.png` });
              progress.log(`  issue (${input.kind}) at frame ${at.frame}: ${input.description}`);
              content = 'Recorded.';
            } else if (call.name === 'finish') {
              record.reached = input.reached;
              record.summary = input.summary;
              record.done = true;
              const at = await session.frame();
              if (input.reached) result.steps.push({ frame: at, checkpoint: `goal-${result.goals.length}` });
              content = 'Goal closed.';
            }
            if (!content) {
              const after = await screen();
              content = [image(after.small), { type: 'text', text: `Game frame ${after.frame}, ${(await session.fps()).toFixed(1)} fps.` }];
            }
          } catch (err) {
            // A crash or hang is a finding, not a harness failure.
            result.issues.push({ kind: /hang/.test(err.message) ? 'hang' : 'crash', description: err.message, frame: await session.frame().catch(() => -1), goal: goal.goal });
            record.summary = err.message;
            record.done = true;
            content = `The emulator failed: ${err.message}`;
          }
          results.push({ type: 'tool_result', tool_use_id: call.id, content });
        }
        messages.push({ role: 'user', content: results });
        record.steps++;
        stepsDone++;
        progress.update(stepsDone, `${goal.goal.slice(0, 40)} $${meter.usd.toFixed(2)}`);
        if (result.issues.some(i => i.kind === 'crash' || i.kind === 'hang')) break;
      }
      delete record.done;
      if (expected && result.goals.length === 1) {
        // By the end of the first goal the game has loaded its save, or it never will.
        result.save = await session.saveCheck(expected);
        if (!result.save.ok) {
          result.issues.push({ kind: 'save', description: result.save.problem, frame: await session.frame(), goal: goal.goal });
          progress.log(`  save not used: ${result.save.problem}`);
        }
      }
      stepsDone = result.goals.reduce((sum, g, i) => sum + (i < result.goals.length - 1 ? set.goals[i].maxSteps ?? 30 : record.steps), 0);
      progress.log(`${record.reached ? 'REACHED' : 'MISSED '} ${set.id}: ${goal.goal} (${record.steps} steps) - ${record.summary}`);
      if (!record.reached) break;
    }
    if (typeof set.createsSave === 'string' && result.goals.length === set.goals.length && result.goals.every(g => g.reached)) {
      await mkdir(path.join(suiteDir, 'saves'), { recursive: true });
      await writeFile(path.join(suiteDir, 'saves', set.createsSave), await session.exportSaves());
      progress.log(`  wrote saves/${set.createsSave}`);
    }
  } finally {
    await writeFile(path.join(runDir, 'console.log'), session.log.join('\n')).catch(() => {});
    await session.close();
    progress.finish();
  }
  return result;
}

/// Asks Claude whether each scripted checkpoint capture shows what its scenario expects.
async function judge(reportFile) {
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  const scenarios = new Map();
  for (const name of (await readdir(path.join(root, 'tests/games'))).filter(n => n.endsWith('.json'))) {
    for (const s of [].concat(JSON.parse(await readFile(path.join(root, 'tests/games', name), 'utf8')))) scenarios.set(s.id, s);
  }
  const meter = createMeter();
  const verdicts = [];
  const schema = {
    type: 'object',
    properties: {
      matches: { type: 'boolean' },
      shows: { type: 'string' },
      emulator_faults: { type: 'array', items: { type: 'string' } },
    },
    required: ['matches', 'shows', 'emulator_faults'],
    additionalProperties: false,
  };
  for (const entry of report.summary) {
    const scenario = scenarios.get(entry.id);
    for (const run of entry.runs ?? []) {
      for (const checkpoint of run.checkpoints) {
        const expect = scenario?.steps.find(s => s.checkpoint === checkpoint.name)?.expect;
        if (!expect || meter.usd > maxCost) continue;
        const response = await ask(meter, {
          output_config: { format: { type: 'json_schema', schema } },
          messages: [{ role: 'user', content: [
            image(await readFile(checkpoint.file)),
            { type: 'text', text: `This is a capture from a Nintendo Switch emulator running ${entry.id}. Expected: ${expect}\nDoes the capture match the expectation? Describe what it shows, and list any signs of emulator faults (corrupt or missing graphics) separately from normal game content.` },
          ] }],
        });
        const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
        const verdict = { scenario: entry.id, checkpoint: checkpoint.name, expect, ...JSON.parse(text) };
        verdicts.push(verdict);
        console.log(`${verdict.matches && !verdict.emulator_faults.length ? 'PASS' : 'FAIL'} ${entry.id} ${checkpoint.name}: ${verdict.shows}`);
        for (const fault of verdict.emulator_faults) console.log(`  - fault: ${fault}`);
      }
    }
  }
  console.log(`Judged ${verdicts.length} checkpoints, ${meter.requests} requests, about $${meter.usd.toFixed(2)}.`);
  await writeFile(reportFile.replace(/\.json$/, '-judged.json'), JSON.stringify({ verdicts, cost: meter }, null, 2));
  return verdicts.every(v => v.matches && !v.emulator_faults.length) ? 0 : 1;
}

if (args.judge) process.exit(await judge(path.resolve(args.judge)));

const keys = process.env.EDEN_KEYS;
const firmware = process.env.EDEN_FIRMWARE;
if (!keys || !firmware) {
  console.error('Set EDEN_KEYS and EDEN_FIRMWARE.');
  process.exit(2);
}
const sets = [];
for (const name of (await readdir(path.join(root, 'tests/agent'))).filter(n => n.endsWith('.json')).sort()) {
  sets.push(...[].concat(JSON.parse(await readFile(path.join(root, 'tests/agent', name), 'utf8'))));
}
const selected = sets.filter(s => !args.only || args.only.includes(s.id));
for (const set of selected) checkSaveRule(set);
const roms = await findRoms(gameDirs);
for (const pair of args.rom ?? []) {
  const [id, file] = pair.split(/=(.*)/s);
  roms.set(id.toUpperCase(), path.resolve(file));
}
await mkdir(out, { recursive: true });
const progress = createProgress(Math.max(1, selected.filter(s => roms.has(s.titleId.toUpperCase()))
  .reduce((sum, s) => sum + s.goals.reduce((n, g) => n + (g.maxSteps ?? 30), 0), 0)), { unit: 'step' });
const lab = await launchLab({ headful: args.headful });
const results = [];
let exitCode = 0;
try {
  await lab.installSystemFiles(keys, firmware);
  for (const set of selected) {
    const rom = roms.get(set.titleId.toUpperCase());
    if (!rom) {
      progress.log(`SKIP ${set.id}: no ROM with [${set.titleId}]`);
      continue;
    }
    const runDir = path.join(out, set.id);
    await mkdir(runDir, { recursive: true });
    const result = await runGoalSet(lab, set, rom, runDir, progress);
    results.push(result);
    if (result.goals.some(g => !g.reached) || result.issues.length) exitCode = 1;
    if (args['emit-scenarios'] && result.goals.every(g => g.reached)) {
      const file = path.join(root, 'tests/games', `agent-${set.id}.json`);
      const steps = result.steps.map(s => (s.checkpoint ? { ...s, expect: set.goals[Number(s.checkpoint.split('-')[1]) - 1].expect ?? set.goals[Number(s.checkpoint.split('-')[1]) - 1].goal } : s));
      if (set.createsSave) steps.push({ frame: steps.at(-1)?.frame ?? 0, exportSave: set.createsSave });
      await writeFile(file, `${JSON.stringify([{ id: `agent-${set.id}`, titleId: set.titleId, ...(set.save ? { save: set.save } : { createsSave: true }), about: `Recorded by tests/agent.mjs from goal set ${set.id}.`, timeoutS: 1200, steps }], null, 2)}\n`);
      progress.log(`  wrote ${path.relative(root, file)} (${steps.length} steps)`);
    }
  }
} catch (err) {
  progress.log(`Setup failed: ${err.message}`);
  exitCode = 2;
} finally {
  progress.stop();
  await lab.close();
}
await writeFile(path.join(out, 'agent.json'), JSON.stringify(results.map(({ meter, ...r }) => ({ ...r, cost: { usd: meter.usd, requests: meter.requests, inputTokens: meter.input, outputTokens: meter.output, cacheReadTokens: meter.cacheRead } })), null, 2));
const spend = results.reduce((sum, r) => sum + r.meter.usd, 0);
console.log(`${results.length} goal sets, ${results.reduce((n, r) => n + r.issues.length, 0)} issues, about $${spend.toFixed(2)} API spend. Report: ${path.relative(process.cwd(), path.join(out, 'agent.json'))}`);
process.exit(exitCode);
