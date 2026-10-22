// SPDX-License-Identifier: GPL-3.0-or-later
// Agentic game test suite. A model watches the emulator screen and plays toward goals written in
// plain language ("get from the title screen into the first room"), one controller action per turn
// timed in game frames, and reports what looks broken (rendering glitches, hangs, crashes, input
// that does nothing). Its inputs are recorded as a scripted scenario, so a run that reaches its
// goal can be replayed deterministically by tests/games.mjs (--emit-scenarios).
//
// --judge <games.json report> instead asks the model whether each checkpoint capture of a scripted
// run matches the checkpoint's "expect" text, catching wrong screens that pixel baselines accept.
//
//   EDEN_KEYS=prod.zip EDEN_FIRMWARE=firmware.zip node tests/agent.mjs [options]
// Any model works: an OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio, OpenRouter,
// OpenAI) or the Anthropic Messages API, configured with EDEN_AGENT_* (see tests/lib/llm.mjs). The
// default is a local Ollama qwen2.5vl:3b. Each turn offers a numbered list of actions, which even
// small models answer reliably; "done" and fault reports are confirmed by a second yes/no look at
// the screen, by EDEN_AGENT_CHECK_MODEL when set (a vision model to pair with a text-only player).
// A goal that no vision model confirmed counts as not reached.
// --check-model sends one request and exits. --provider, --model, --base-url, --no-vision override
// the environment. --only <id> (repeatable) picks goal sets from tests/agent/*.json. --max-cost
// <usd> (default 3) stops a run once its estimated spend passes the limit; prices come from
// EDEN_AGENT_PRICE="<input>,<output>" in USD per million tokens (default 0, a local model).
// --emit-scenarios writes reached goals to tests/games/agent-<id>.json. --suite-dir, --games-dir,
// --rom, --core, --headful, --out as in tests/games.mjs.
//
// Goal set format: { id, titleId, save: "<zip in saves/>" | createsSave: "<zip to write>", startFrame?,
//   goals: [{ goal, maxSteps?, expect?, check? }] }. The model first looks at game frame startFrame. `check` is the yes/no question that confirms the
//   goal (default: whether the screen shows `expect` or the goal). Every set starts from a save,
//   which the game must be seen reading, except a set that creates one; that set exports the save
//   once all its goals are reached.
// Exit code: 0 every goal reached and no issue reported, 1 otherwise, 2 setup failed.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GAME_DIRS, DEFAULT_SUITE_DIR, checkSaveRule, difference, findRoms, launchLab, openGame, saveEntries, spread, thumbnail } from './lib/game-session.mjs';
import { actionKey, choiceMenu, createModel, parseChoice, parseObject } from './lib/llm.mjs';
import { createProgress } from './lib/progress.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: args } = parseArgs({
  options: {
    only: { type: 'string', multiple: true },
    judge: { type: 'string' },
    'max-cost': { type: 'string', default: '3' },
    'check-model': { type: 'boolean', default: false },
    provider: { type: 'string' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    'no-vision': { type: 'boolean', default: false },
    'emit-scenarios': { type: 'boolean', default: false },
    'suite-dir': { type: 'string' },
    'games-dir': { type: 'string', multiple: true },
    rom: { type: 'string', multiple: true },
    core: { type: 'string' },
    headful: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const SCREEN_WIDTH = 640;
// Turns of earlier actions repeated to the model; small models lose track with long histories.
const HISTORY = 8;
// Looks in a row at a uniform screen, after the game has drawn something, that count as an issue.
const BLANK_LOOKS = 4;
const suiteDir = path.resolve(args['suite-dir'] ?? process.env.EDEN_SUITE_DIR ?? DEFAULT_SUITE_DIR);
const gameDirs = args['games-dir'] ?? process.env.EDEN_GAMES_DIRS?.split(':').filter(Boolean) ?? DEFAULT_GAME_DIRS;
const out = path.resolve(args.out ?? path.join(root, 'artifacts', `agent-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const maxCost = Number(args['max-cost']) || 3;
const [priceIn, priceOut] = (process.env.EDEN_AGENT_PRICE ?? '0,0').split(',').map(v => Number(v) || 0);

const model = createModel({
  provider: args.provider, model: args.model, baseUrl: args['base-url'],
  vision: args['no-vision'] ? false : undefined,
});
// "done" and issues are confirmed by a second look, optionally by a different (vision) model.
const checker = process.env.EDEN_AGENT_CHECK_MODEL
  ? createModel({ provider: args.provider, baseUrl: args['base-url'], model: process.env.EDEN_AGENT_CHECK_MODEL, vision: true })
  : model;
console.log(`Model: ${model.config.model} via ${model.config.provider} at ${model.config.baseUrl}${model.config.vision ? '' : ' (text only)'}` +
  `${checker === model ? '' : `, checked by ${checker.config.model}`}`);

/// Running spend and token use for one run.
function createMeter() {
  const meter = { usd: 0, requests: 0, input: 0, output: 0, ms: [] };
  meter.add = reply => {
    meter.requests++;
    meter.input += reply.inputTokens ?? 0;
    meter.output += reply.outputTokens ?? 0;
    meter.ms.push(reply.ms);
    meter.usd += ((reply.inputTokens ?? 0) * priceIn + (reply.outputTokens ?? 0) * priceOut) / 1e6;
  };
  return meter;
}

async function ask(meter, client, system, messages) {
  const reply = await client.chat(system, messages);
  meter.add(reply);
  return reply;
}

/// Asks `client` a yes/no question about a screen.
async function confirm(meter, png, grey, question) {
  const reply = await ask(meter, checker, 'You check screenshots of a game. Answer only yes or no.', [{
    role: 'user', image: png,
    text: `${question}${checker.config.vision ? '' : `\nBrightness map of the screen:\n${asciiScreen(grey)}`}\nAnswer yes or no.`,
  }]);
  return { yes: /^\W*yes\b/i.test(reply.text.replace(/<think>[\s\S]*?<\/think>/gi, '')), text: reply.text.trim().slice(0, 200) };
}

// Ten grey levels, dark to light, for the text picture given to models without vision.
const SHADES = ' .:-=+*#%@';
function asciiScreen(grey) {
  const rows = [];
  for (let y = 0; y < 36; y += 3) {
    let row = '';
    for (let x = 0; x < 64; x += 2) {
      let sum = 0;
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 2; dx++) sum += grey[(y + dy) * 64 + x + dx];
      row += SHADES[Math.min(9, Math.floor(sum / 6 / 25.6))];
    }
    rows.push(row);
  }
  return rows.join('\n');
}

const percentile = (values, p) => (values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))] : null);

const SYSTEM = `You are testing a Nintendo Switch emulator that runs in a web browser. You control player 1's controller toward a goal, one action per turn.
Each turn you get the goal, the game screen and a numbered list of actions. Reply with ONE JSON object and nothing else:
{"screen":"<what you see on this screen>","choice":<number>,"reason":"<why>"}
You may add "frames":<number> to set how long a press, stick or wait lasts (60 frames is one second), and "kind" to a fault: graphics, hang, input, performance or other.
Choose done only when the goal is visibly reached on this screen, and give up only when you are sure it cannot be reached. Choose fault for anything that looks like an emulator fault rather than the game working as designed: garbled textures, black or missing geometry, a picture that does not change for a long time, input with no effect. Wait only on loading screens and cutscenes. In menus A confirms and B goes back.`;

if (args['check-model']) {
  try {
    const menu = choiceMenu();
    const reply = await model.chat(SYSTEM, [{ role: 'user', text: ['Goal: press the A button.', 'Actions:', ...menu.map(e => `${e.number}. ${e.label}`)].join('\n') }]);
    const action = parseChoice(reply.text, menu);
    console.log(`Reply in ${reply.ms} ms: ${reply.text.trim().slice(0, 200)}`);
    console.log(`Parsed: ${JSON.stringify(action)}`);
    process.exit(action ? 0 : 1);
  } catch (err) {
    console.error(`Model unreachable: ${err.message}`);
    process.exit(2);
  }
}

/// Plays one goal set: boots the game, then runs each goal as an append-only conversation.
async function runGoalSet(lab, set, rom, runDir, progress) {
  const meter = createMeter();
  const result = { id: set.id, model: model.config.model, provider: model.config.provider, vision: model.config.vision, goals: [], issues: [], suspected: [], turns: [], meter, steps: [] };
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
      const file = `${String(++shot).padStart(3, '0')}-f${frame}.png`;
      await writeFile(path.join(runDir, file), png);
      return { small: await session.downscale(png, SCREEN_WIDTH), frame, file, grey: await thumbnail(session.page, png) };
    };
    let drawn = false;
    let blank = 0;
    // Boot logos need no decisions.
    if (set.startFrame) await session.waitFrame(set.startFrame);
    for (const goal of set.goals) {
      const record = { goal: goal.goal, reached: false, summary: '', steps: 0 };
      result.goals.push(record);
      const history = [];
      let previous = null;
      let repeats = 0;
      let lastKey = '';
      const maxSteps = goal.maxSteps ?? 30;
      while (record.steps < maxSteps && !record.done) {
        if (meter.usd > maxCost) {
          record.summary = `stopped: model spend reached $${meter.usd.toFixed(2)} (limit $${maxCost})`;
          break;
        }
        record.steps++;
        stepsDone++;
        try {
          const at = await screen();
          const screenSpread = spread(at.grey);
          const change = previous ? difference(at.grey, previous) : null;
          previous = at.grey;
          if (screenSpread >= 4) {
            drawn = true;
            blank = 0;
          } else if (drawn && ++blank >= BLANK_LOOKS) {
            result.issues.push({ kind: 'graphics', description: `blank screen for ${BLANK_LOOKS} looks`, frame: at.frame, goal: goal.goal, file: at.file, source: 'harness' });
            blank = 0;
          }
          // Small models settle into repeating one action that does nothing; after three in a row
          // it is left out of the list.
          const menu = choiceMenu(repeats >= 3 ? lastKey : undefined);
          const text = [
            `Goal: ${goal.goal}`,
            `Turn ${record.steps} of ${maxSteps}. Game frame ${at.frame}, ${(await session.fps()).toFixed(1)} fps.`,
            `Screen: ${screenSpread < 4 ? 'almost uniform (blank or fading)' : 'has content'}` +
              (change === null ? '.' : `, ${change < 2 ? 'unchanged' : change < 12 ? 'slightly changed' : 'clearly changed'} since your last action.`),
            ...(model.config.vision ? [] : ['Brightness map of the screen (dark " " to light "@"):', asciiScreen(at.grey)]),
            ...(history.length ? ['Your recent actions:', ...history.slice(-HISTORY)] : []),
            'Actions:', ...menu.map(e => `${e.number}. ${e.label}`),
          ].join('\n');
          const message = { role: 'user', text, image: at.small };
          let reply = await ask(meter, model, SYSTEM, [message]);
          let action = parseChoice(reply.text, menu);
          if (!action) {
            // One correction round; a small model often fixes its format when shown the problem.
            reply = await ask(meter, model, SYSTEM, [message, { role: 'assistant', text: reply.text.slice(0, 500) },
              { role: 'user', text: 'That was not a valid reply. Reply with exactly one JSON object such as {"screen":"title menu","choice":1}.' }]);
            action = parseChoice(reply.text, menu);
          }
          const seen = String(reply.text.match(/"screen"\s*:\s*"([^"]{0,80})/)?.[1] ?? '');
          const turn = { goal: result.goals.length, frame: at.frame, file: at.file, screen: seen, action, reply: reply.text.slice(0, 500) };
          result.turns.push(turn);
          if (!action) {
            history.push(`- (${seen}) gave no valid choice`);
            continue;
          }
          const key = actionKey(action);
          repeats = key === lastKey ? repeats + 1 : 1;
          lastKey = key;
          const label = action.action === 'press' ? `pressed ${action.button} for ${action.frames} frames`
            : action.action === 'stick' ? `stick x ${action.x} y ${action.y} for ${action.frames} frames`
              : action.action === 'wait' ? `waited ${action.frames} frames` : action.action;
          if (action.action === 'press') {
            result.steps.push({ frame: at.frame, press: action.button, frames: action.frames });
            await session.press(action.button, action.frames);
          } else if (action.action === 'stick') {
            result.steps.push({ frame: at.frame, stick: action.stick, x: action.x, y: action.y, frames: action.frames });
            await session.stick(action.stick, action.x, action.y, action.frames);
          } else if (action.action === 'wait') {
            await session.waitFrame(at.frame + action.frames);
          } else if (action.action === 'fault') {
            // Small models see faults everywhere; without a confirming look it stays a suspicion.
            const check = checker.config.vision ? await confirm(meter, at.small, at.grey, 'Does this game screen look broken: garbled or missing graphics, wrong colours or a corrupted picture?') : { yes: false, text: 'no vision model' };
            turn.check = check.text;
            const issue = { kind: action.kind ?? 'other', description: action.reason || 'reported by the model', frame: at.frame, goal: goal.goal, file: at.file };
            (check.yes ? result.issues : result.suspected).push(issue);
            progress.log(`  ${check.yes ? 'issue' : 'unconfirmed issue'} (${issue.kind}) at frame ${at.frame}: ${issue.description}`);
          } else if (action.action === 'giveup') {
            record.summary = `gave up: ${action.reason}`;
            record.done = true;
          } else if (action.action === 'done') {
            const check = await confirm(meter, at.small, at.grey, goal.check ?? `Does this screen show this: "${goal.expect ?? goal.goal}"?`);
            turn.check = check.text;
            if (check.yes && checker.config.vision) {
              record.reached = true;
              record.summary = action.reason || seen;
              record.done = true;
              result.steps.push({ frame: at.frame, checkpoint: `goal-${result.goals.length}` });
            } else {
              history.push(`- (${seen}) said done, but the goal is NOT reached yet; keep playing`);
              progress.log(`  done not confirmed: ${check.yes ? 'no vision model looked at the screen' : check.text}`);
              if (check.yes) {
                record.summary = 'reached by the model\'s account, but no vision model confirmed it';
                record.done = true;
              }
              continue;
            }
          }
          history.push(`- (${seen}) ${label}`);
        } catch (err) {
          // A crash or hang is a finding, not a harness failure.
          result.issues.push({ kind: /hang/.test(err.message) ? 'hang' : 'crash', description: err.message, frame: await session.frame().catch(() => -1), goal: goal.goal, source: 'harness' });
          record.summary = err.message;
          record.done = true;
        }
        progress.update(stepsDone, `${goal.goal.slice(0, 40)}${meter.usd ? ` $${meter.usd.toFixed(2)}` : ''}`);
        if (result.issues.some(i => i.kind === 'crash' || i.kind === 'hang')) break;
      }
      if (!drawn && record.steps >= BLANK_LOOKS && !result.issues.some(i => i.source === 'harness' && /never showed/.test(i.description))) {
        result.issues.push({ kind: 'graphics', description: `the screen never showed anything in ${record.steps} looks`, frame: await session.frame().catch(() => -1), goal: goal.goal, source: 'harness' });
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

/// Asks the model whether each scripted checkpoint capture shows what its scenario expects.
async function judge(reportFile) {
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  const scenarios = new Map();
  for (const name of (await readdir(path.join(root, 'tests/games'))).filter(n => n.endsWith('.json'))) {
    for (const s of [].concat(JSON.parse(await readFile(path.join(root, 'tests/games', name), 'utf8')))) scenarios.set(s.id, s);
  }
  if (!checker.config.vision) {
    console.error('Judging needs a vision model: unset EDEN_AGENT_VISION=0 or set EDEN_AGENT_CHECK_MODEL.');
    return 2;
  }
  const meter = createMeter();
  const verdicts = [];
  for (const entry of report.summary) {
    const scenario = scenarios.get(entry.id);
    for (const run of entry.runs ?? []) {
      for (const checkpoint of run.checkpoints) {
        const expect = scenario?.steps.find(s => s.checkpoint === checkpoint.name)?.expect;
        if (!expect || meter.usd > maxCost) continue;
        const reply = await ask(meter, checker, 'You check screenshots of a game. Reply with one JSON object and nothing else.', [{
          role: 'user', image: await readFile(checkpoint.file),
          text: `This is a capture from a Nintendo Switch emulator running ${entry.id}. Expected: ${expect}\nDoes the capture match the expectation? Describe what it shows, and list any signs of emulator faults (corrupt or missing graphics) separately from normal game content.\nReply as {"matches": true or false, "shows": "<what the capture shows>", "emulator_faults": ["<fault>", ...]}`,
        }]);
        const parsed = parseObject(reply.text) ?? {};
        // A reply without the object is read as a plain yes or no.
        const matches = typeof parsed.matches === 'boolean' ? parsed.matches : /^\W*(yes|true)\b/i.test(reply.text);
        const faults = Array.isArray(parsed.emulator_faults) ? parsed.emulator_faults.map(String).filter(f => f && !/^(none|no)$/i.test(f)) : [];
        const verdict = { scenario: entry.id, checkpoint: checkpoint.name, expect, matches, shows: String(parsed.shows ?? reply.text.slice(0, 200)), emulator_faults: faults };
        verdicts.push(verdict);
        console.log(`${verdict.matches && !faults.length ? 'PASS' : 'FAIL'} ${entry.id} ${checkpoint.name}: ${verdict.shows}`);
        for (const fault of faults) console.log(`  - fault: ${fault}`);
      }
    }
  }
  console.log(`Judged ${verdicts.length} checkpoints with ${checker.config.model}, ${meter.requests} requests${meter.usd ? `, about $${meter.usd.toFixed(2)}` : ''}.`);
  await writeFile(reportFile.replace(/\.json$/, '-judged.json'), JSON.stringify({ model: checker.config.model, verdicts, cost: { usd: meter.usd, requests: meter.requests, inputTokens: meter.input, outputTokens: meter.output } }, null, 2));
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
await writeFile(path.join(out, 'agent.json'), JSON.stringify(results.map(({ meter, ...r }) => ({
  ...r,
  cost: { usd: meter.usd, requests: meter.requests, inputTokens: meter.input, outputTokens: meter.output },
  modelMs: { p50: percentile(meter.ms, 0.5), p95: percentile(meter.ms, 0.95) },
})), null, 2));
for (const r of results) {
  console.log(`${r.id}: ${r.goals.filter(g => g.reached).length}/${r.goals.length} goals, ${r.issues.length} issues (${r.suspected.length} unconfirmed), ` +
    `${r.meter.requests} requests, model p50 ${percentile(r.meter.ms, 0.5)} ms p95 ${percentile(r.meter.ms, 0.95)} ms`);
}
const spend = results.reduce((sum, r) => sum + r.meter.usd, 0);
console.log(`${results.length} goal sets, ${results.reduce((n, r) => n + r.issues.length, 0)} issues${spend ? `, about $${spend.toFixed(2)} model spend` : ''}. Report: ${path.relative(process.cwd(), path.join(out, 'agent.json'))}`);
process.exit(exitCode);
