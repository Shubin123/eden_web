// SPDX-License-Identifier: GPL-3.0-or-later
// Compatibility widget: a local database of how each game ran on each core and runtime build.
//
// Every play session records an 'automated' result once the game has played for a while after
// its first frame, or earlier if it fails; the user can add their own rating. Results use the shared format
// in results.js, so files from tests/e2e.mjs and tests/matrix.mjs import directly and an export
// can be read by the test harness. Games are identified by title ID and version when the runtime
// or the file name gives them, else by file name and a hash of the size; paths and file contents are never stored.
//
// The functions above setupCompatibility() are pure and tested in tests/compat.mjs.

import { CONFIDENCE, compareResults, frameTimeStats, makeResult, validateResult } from './results.js';
import { CPU_CORES, findCore } from './cores.js';

const DB_NAME = 'eden-compat';
const DB_VERSION = 1;
const RESULTS = 'results';
const LAST_SESSION_KEY = 'eden-compat-last';

// A session is judged on this much play after its first frame, or as failed if no frame comes
// within the boot limit. Boot times vary too much (15-60 s) for one window from boot to fit all.
export const PLAY_MS = 45_000;
export const BOOT_LIMIT_MS = 180_000;
const CHECKPOINT_MS = 15_000;
const POLL_MS = 500;
// Frames stopping this long during the window counts as a hang.
const HANG_MS = 15_000;
// Below this the game is recorded as running too slowly to play.
export const MIN_PLAYABLE_FPS = 10;
const MAX_FRAME_SAMPLES = 20_000;

/// The user's own rating, mapped onto the result format. 'Ingame' counts as running below the
/// bar (like a performance failure), 'Boots' as stopping before gameplay.
export const USER_RATINGS = [
  { id: 'perfect', label: 'Perfect', help: 'plays like on the console', outcome: 'pass' },
  { id: 'playable', label: 'Playable', help: 'can be played through, minor issues', outcome: 'pass' },
  { id: 'ingame', label: 'Ingame', help: 'reaches gameplay with major issues', outcome: 'fail', category: 'performance' },
  { id: 'boots', label: 'Boots', help: 'starts but never reaches gameplay', outcome: 'fail', category: 'hang' },
  { id: 'nothing', label: 'Nothing', help: 'does not start', outcome: 'fail', category: 'boot' },
];

const CONFIDENCE_LABELS = { automated: 'automated', confirmed: 'confirmed', user: 'user report' };

const FAILURE_TEXT = {
  environment: 'browser unsupported',
  artifact: 'runtime files missing',
  init: 'runtime failed to start',
  'system-files': 'keys or firmware problem',
  boot: 'does not boot',
  crash: 'crashes',
  hang: 'hangs',
  'no-frames': 'no frames',
  performance: 'too slow',
};

// ── Game identity ────────────────────────────────────────────────────────────────────────────

export const baseName = name => String(name ?? '').split(/[\\/]/).pop();

/// 32-bit FNV-1a, as 8 hex digits.
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(text))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/// Title ID, version and name from the common dump naming "Name [0100...][v65536].nsp".
export function parseFileName(fileName) {
  const name = baseName(fileName);
  const titleId = name.match(/\[([0-9A-F]{16})\]/i)?.[1]?.toUpperCase() ?? null;
  const version = name.match(/\[v(\d+)\]/i)?.[1];
  const title = name.replace(/\.[^.]+$/, '').replace(/\s*[[(][^\])]*[\])]/g, '').trim();
  return { titleId, version: version == null ? null : Number(version), name: title || name };
}

/// The `game` field of a result, from what the runtime reports and the file name and size.
export function gameIdentity({ info = null, fileName = '', size = -1 } = {}) {
  const file = fileName ? { name: baseName(fileName), sizeHash: fnv1a(size) } : null;
  const fromName = fileName ? parseFileName(fileName) : {};
  const reported = /^[0-9A-F]{16}$/i.test(info?.titleId ?? '') ? info.titleId.toUpperCase() : null;
  const titleId = reported ?? fromName.titleId ?? null;
  const game = {
    titleId,
    name: info?.name || fromName.name || 'Unknown game',
    version: info?.version ?? (reported ? null : fromName.version) ?? null,
    displayVersion: info?.displayVersion ?? null,
  };
  if (file) game.file = file;
  return game;
}

/// Storage key for a game: title ID and version when known, else the file fingerprint, else name.
export function gameKey(game) {
  if (!game) return 'unknown';
  if (game.titleId) return `title:${game.titleId.toUpperCase()}:${game.version ?? 'any'}`;
  if (game.file?.sizeHash) return `file:${baseName(game.file.name).toLowerCase()}:${game.file.sizeHash}`;
  return `name:${baseName(game.name).toLowerCase()}`;
}

/// Whether two `game` fields name the same game, comparing the strongest identity both have.
export function sameGame(a, b) {
  if (!a || !b) return false;
  if (a.titleId && b.titleId) {
    return a.titleId.toUpperCase() === b.titleId.toUpperCase()
      && (a.version == null || b.version == null || a.version === b.version);
  }
  if (a.file?.sizeHash && b.file?.sizeHash) return gameKey({ file: a.file }) === gameKey({ file: b.file });
  const names = g => [g.name, g.file?.name].filter(Boolean).map(n => baseName(n).toLowerCase());
  return names(a).some(name => names(b).includes(name));
}

export function gameLabel(game) {
  if (!game) return 'Unknown game';
  const version = game.displayVersion ? ` v${game.displayVersion}` : '';
  return `${game.name}${version}`;
}

/// Groups results by game. The group's game is the most specific identity seen (a title ID beats
/// a file name), newest group first.
export function groupByGame(results) {
  const groups = [];
  for (const result of [...results].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    let group = groups.find(g => sameGame(g.game, result.game));
    if (!group) groups.push(group = { game: result.game, results: [] });
    group.results.push(result);
    if (!group.game?.titleId && result.game?.titleId) group.game = { ...result.game, file: group.game?.file ?? result.game.file };
  }
  for (const group of groups) group.key = gameKey(group.game);
  return groups;
}

// ── Result handling ──────────────────────────────────────────────────────────────────────────

/// Keeps only what the format allows to identify a game: base names, never paths.
export function sanitizeResult(result) {
  const copy = structuredClone(result);
  if (copy.game) {
    if (copy.game.name) copy.game.name = baseName(copy.game.name);
    if (copy.game.file?.name) copy.game.file.name = baseName(copy.game.file.name);
    delete copy.game.path;
  }
  return copy;
}

/// Accepts a result, an array of results, or a summary with a `results` array.
export function parseImport(json) {
  const list = Array.isArray(json) ? json
    : Array.isArray(json?.results) ? json.results
      : json && typeof json === 'object' && 'schema' in json ? [json] : null;
  if (!list) return { valid: [], invalid: 0, problems: ['no results found'] };
  const valid = [];
  const problems = [];
  for (const entry of list) {
    const found = validateResult(entry);
    if (found.length) problems.push(found[0]);
    else valid.push(sanitizeResult(entry));
  }
  return { valid, invalid: problems.length, problems };
}

export const runtimeOf = result => result.core?.runtimeVersion ?? 'unknown';
export const coreIdOf = result => result.core?.id ?? 'unknown';
export const coreName = id => findCore(id)?.name ?? id;
export const shortRuntime = version => (/^[0-9a-f]{11,}$/i.test(version) ? version.slice(0, 10) : version);

/// Runtime versions in the order they were first seen.
export function runtimeOrder(results) {
  const first = new Map();
  for (const r of results) {
    const v = runtimeOf(r);
    if (!first.has(v) || r.createdAt < first.get(v)) first.set(v, r.createdAt);
  }
  return [...first].sort((a, b) => a[1].localeCompare(b[1])).map(([v]) => v);
}

export function describeResult(result) {
  const parts = [result.outcome === 'pass' ? 'passes' : FAILURE_TEXT[result.failure?.category] ?? result.outcome];
  const rating = USER_RATINGS.find(r => r.id === result.metrics?.rating);
  if (rating) parts[0] = `rated ${rating.label}`;
  const stutters = result.metrics?.frameTime?.stutters;
  if (Number.isFinite(stutters)) parts.push(`${stutters} stutter${stutters === 1 ? '' : 's'}`);
  const fps = result.metrics?.sustainedFps;
  if (Number.isFinite(fps) && fps > 0) parts.push(`${Math.round(fps)} fps`);
  return parts.join(', ');
}

/// "automated, 3 runs; 1 user report": the kinds of evidence behind a claim, strongest first.
function evidence(results) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return CONFIDENCE.map(c => [c, results.filter(r => r.confidence === c).length]).filter(([, n]) => n)
    .map(([c, n]) => (c === 'user' ? plural(n, 'user report') : `${c}, ${plural(n, 'run')}`)).join('; ');
}

function confidenceSummary(results) {
  const counts = CONFIDENCE.map(c => [c, results.filter(r => r.confidence === c).length]).filter(([, n]) => n);
  return counts.map(([c, n]) => `${CONFIDENCE_LABELS[c]}${n > 1 ? ` ×${n}` : ''}`).join(', ');
}

/// Per core: the runs on the runtime that matters (the current one when the core has results
/// there, else its newest), the best of them, and how many passed. Ranked best first.
export function summarizeCores(results, { currentRuntime = null } = {}) {
  const order = runtimeOrder(results);
  const byCore = new Map();
  for (const r of results) {
    if (!byCore.has(coreIdOf(r))) byCore.set(coreIdOf(r), []);
    byCore.get(coreIdOf(r)).push(r);
  }
  const summaries = [...byCore].map(([coreId, runs]) => {
    const versions = new Set(runs.map(runtimeOf));
    const runtime = currentRuntime && versions.has(currentRuntime)
      ? currentRuntime
      : order.filter(v => versions.has(v)).at(-1);
    const onRuntime = runs.filter(r => runtimeOf(r) === runtime).sort(compareResults);
    return {
      coreId,
      name: coreName(coreId),
      runtime,
      current: !currentRuntime || runtime === currentRuntime,
      runs: onRuntime.length,
      passes: onRuntime.filter(r => r.outcome === 'pass').length,
      best: onRuntime[0],
      confidence: confidenceSummary(onRuntime),
      allRuns: runs,
    };
  });
  return summaries.sort((a, b) => compareResults(a.best, b.best) || Number(b.current) - Number(a.current) || b.runs - a.runs);
}

/// A core whose runs on the current runtime all fail, after it passed on an earlier one.
export function findRegressions(results, currentRuntime = null) {
  const order = runtimeOrder(results);
  const current = currentRuntime ?? order.at(-1);
  const currentIndex = order.indexOf(current);
  if (currentIndex < 0) return [];
  const regressions = [];
  for (const summary of summarizeCores(results, { currentRuntime: current })) {
    const now = summary.allRuns.filter(r => runtimeOf(r) === current).sort(compareResults);
    if (!now.length || now.some(r => r.outcome === 'pass')) continue;
    const earlier = summary.allRuns
      .filter(r => r.outcome === 'pass' && order.indexOf(runtimeOf(r)) < currentIndex)
      .sort((a, b) => order.indexOf(runtimeOf(b)) - order.indexOf(runtimeOf(a)));
    if (!earlier.length) continue;
    regressions.push({
      coreId: summary.coreId,
      name: summary.name,
      passedOn: runtimeOf(earlier[0]),
      failsOn: current,
      category: now[0].failure?.category ?? now[0].outcome,
    });
  }
  return regressions;
}

/// The core to use for a game and why, plus which runnable cores have no results yet. Untested
/// cores are listed apart, never ranked below tested ones.
export function recommend(results, { currentRuntime = null, cores = CPU_CORES.filter(c => c.available) } = {}) {
  const ranked = summarizeCores(results, { currentRuntime });
  const untested = cores.filter(core => !ranked.some(s => s.coreId === core.id));
  const best = ranked[0];
  const works = best && (best.best.outcome === 'pass' || best.best.failure?.category === 'performance');
  const line = s => `${s.name}: ${describeResult(s.best)}${s.current ? '' : ` (engine ${shortRuntime(s.runtime)})`}`;
  return {
    core: works ? best : null,
    ranked,
    untested,
    reason: ranked.map(line).join(' vs '),
    evidence: works ? evidence(best.allRuns.filter(r => runtimeOf(r) === best.runtime)) : '',
    regressions: findRegressions(results, currentRuntime),
  };
}

// ── Automatic recording ──────────────────────────────────────────────────────────────────────

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/// Median game fps over the last third of the samples taken since the first frame.
export function sustainedFps(samples, firstFrameAt) {
  const drawn = samples.filter(s => firstFrameAt != null && s.t >= firstFrameAt);
  return median(drawn.slice(-Math.max(1, Math.floor(drawn.length / 3))).map(s => s.fps));
}

/// Outcome of a session from what was observed. Times are in ms on one clock.
export function assessSession({ now, crash = null, failed = false, loadResult = null, everRunning = false,
  firstFrameAt = null, lastFrameAt = null, fps = 0 }) {
  const fail = (category, detail) => ({ outcome: 'fail', failure: { category, detail } });
  if (crash) return fail(/no frames for/.test(crash) ? 'hang' : 'crash', crash);
  if (failed) return fail('boot', `boot failed (load result ${loadResult})`);
  if (firstFrameAt == null) {
    return everRunning ? fail('no-frames', 'running but drew no frame') : fail('boot', 'still booting');
  }
  if (now - lastFrameAt > HANG_MS) return fail('hang', `no frames for ${Math.round((now - lastFrameAt) / 1000)} s`);
  if (fps < MIN_PLAYABLE_FPS) return fail('performance', `${fps.toFixed(1)} fps sustained`);
  return { outcome: 'pass', failure: null };
}

// Exports take pointers and sizes as BigInt (Memory64); wrapped exports also accept them.
function readEngineFrameTimes(module, max = 4096) {
  const read = module?._eden_get_frame_times;
  const malloc = module?._malloc;
  const free = module?._free;
  const heapBuffer = module?.HEAPF64?.buffer ?? module?.HEAPU8?.buffer;
  if (typeof read !== 'function' || typeof malloc !== 'function' || typeof free !== 'function' || !heapBuffer) return null;
  let ptr = 0;
  try {
    ptr = Number(malloc(BigInt(max * 8)));
    if (!ptr) return null;
    const count = Math.min(max, Number(read(BigInt(ptr), max)));
    if (!(count > 0)) return null;
    const buffer = module.HEAPF64?.buffer ?? module.HEAPU8.buffer;
    return Array.from(new Float64Array(buffer, ptr, count));
  } catch (err) {
    console.warn('eden_get_frame_times failed:', err);
    return null;
  } finally {
    if (ptr) try { free(BigInt(ptr)); } catch {}
  }
}

function readGameInfo(module) {
  if (typeof module?._eden_get_game_info !== 'function') return null;
  let text = null;
  try {
    text = module.ccall('eden_get_game_info', 'string', [], []);
  } catch {
    try {
      const ptr = Number(module._eden_get_game_info());
      if (ptr && module.UTF8ToString) text = module.UTF8ToString(ptr);
    } catch {}
  }
  try {
    const info = text ? JSON.parse(text) : null;
    return info && (info.titleId || info.name) ? info : null;
  } catch {
    return null;
  }
}

async function describeEnvironment() {
  let gpu = null;
  try {
    const info = (await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info;
    if (info) gpu = [info.vendor, info.architecture || info.device].filter(Boolean).join(' ') || null;
  } catch {}
  return {
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform,
    gpu,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    crossOriginIsolated: window.crossOriginIsolated,
    url: location.origin + location.pathname,
  };
}

// ── IndexedDB ────────────────────────────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      // Each version adds to the previous one, so any older database upgrades step by step.
      if (event.oldVersion < 1) {
        const store = db.createObjectStore(RESULTS, { keyPath: 'id' });
        store.createIndex('gameKey', 'gameKey');
        store.createIndex('createdAt', 'result.createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    const tx = db.transaction(RESULTS, mode);
    const value = fn(tx.objectStore(RESULTS));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return value instanceof IDBRequest ? value.result : value;
  } finally {
    db.close();
  }
}

// Records keep the result unchanged next to the fields they are looked up by.
const toRecord = result => ({
  id: result.id,
  gameKey: gameKey(result.game),
  coreId: coreIdOf(result),
  runtimeVersion: runtimeOf(result),
  result,
});

export const putResults = results => withStore('readwrite', store => results.forEach(r => store.put(toRecord(r))));
export const listResults = async () => (await withStore('readonly', store => store.getAll())).map(record => record.result);
export const clearResults = () => withStore('readwrite', store => store.clear());

// ── Widget ───────────────────────────────────────────────────────────────────────────────────

/// Wires the Compatibility widget and the recommendation hint in the Emulation widget. Returns
/// the hooks app.js calls at points in a game's life.
export function setupCompatibility({ log = () => {} } = {}) {
  const $ = id => document.getElementById(id);
  const gameSelect = $('compat-game');
  const status = $('compat-status');
  const hint = $('cpu-core-recommendation');
  const ratingSelect = $('compat-rating');
  const reportButton = $('btn-compat-report');
  const importInput = $('compat-import-input');

  let coreReadyMs = null;
  let session = null;
  let selectedKey = null;
  let groups = [];
  let runtimeInfo = null;
  const runtimeReady = fetch('version.json', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(info => { runtimeInfo = info; });
  const environment = describeEnvironment();

  const readLast = () => {
    try { return JSON.parse(localStorage.getItem(LAST_SESSION_KEY)); } catch { return null; }
  };
  const writeLast = value => {
    try { localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(value)); } catch {}
  };

  const coreField = core => ({
    id: core.id,
    emulator: core.emulator,
    runtimeVersion: runtimeInfo?.engineRevision ?? 'unknown',
    build: runtimeInfo ? { web: runtimeInfo.webRevision, build: runtimeInfo.build, version: runtimeInfo.version, local: runtimeInfo.local } : null,
  });

  // What a rating applies to: the game playing now, else the last one played in this browser.
  const reportTarget = () => (session ? { game: session.game, core: coreField(session.core) } : readLast());

  for (const rating of USER_RATINGS) {
    ratingSelect.append(new Option(`${rating.label}: ${rating.help}`, rating.id));
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function render() {
    const count = groups.reduce((sum, g) => sum + g.results.length, 0);
    $('compat-count').textContent = `${count} result${count === 1 ? '' : 's'}, ${groups.length} game${groups.length === 1 ? '' : 's'}`;
    $('btn-compat-export').disabled = count === 0;
    $('btn-compat-clear').disabled = count === 0;

    const current = session?.game ?? readLast()?.game;
    const currentGroup = current && groups.find(g => sameGame(g.game, current));
    if (!groups.some(g => g.key === selectedKey)) selectedKey = (currentGroup ?? groups[0])?.key ?? null;
    gameSelect.replaceChildren(...groups.map(g => new Option(`${gameLabel(g.game)} (${g.results.length})`, g.key)));
    gameSelect.disabled = groups.length === 0;
    if (selectedKey) gameSelect.value = selectedKey;

    const group = groups.find(g => g.key === selectedKey);
    const recommendation = $('compat-recommendation');
    const warnings = $('compat-regressions');
    const list = $('compat-results');
    const coverage = $('compat-coverage');
    if (!group) {
      recommendation.textContent = 'No results yet. Play a game to record one, or import results.';
      warnings.hidden = true;
      list.replaceChildren();
      coverage.textContent = '';
    } else {
      const rec = recommend(group.results, { currentRuntime: runtimeInfo?.engineRevision });
      recommendation.replaceChildren(
        ...(rec.core
          ? [el('strong', `Recommended: ${rec.core.name}`), ` (${rec.evidence}). `]
          : [el('strong', 'No core is known to work yet. ')]),
        rec.reason,
      );
      warnings.hidden = rec.regressions.length === 0;
      warnings.textContent = rec.regressions.map(r =>
        `⚠ Regression on ${r.name}: passed on engine ${shortRuntime(r.passedOn)}, ${FAILURE_TEXT[r.category] ?? r.category} on engine ${shortRuntime(r.failsOn)}.`).join(' ');

      const items = [];
      for (const summary of rec.ranked) {
        const versions = runtimeOrder(summary.allRuns).reverse();
        for (const version of versions) {
          const runs = summary.allRuns.filter(r => runtimeOf(r) === version).sort(compareResults);
          const passes = runs.filter(r => r.outcome === 'pass').length;
          const li = el('li');
          const isCurrent = version === runtimeInfo?.engineRevision;
          li.append(
            el('strong', summary.name),
            ` · engine ${shortRuntime(version)}${isCurrent ? ' (current)' : ''}: ${describeResult(runs[0])}; `
              + `${passes}/${runs.length} pass · ${confidenceSummary(runs)}`,
          );
          const note = runs.filter(r => r.confidence === 'user' && r.notes).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (note) li.append(el('div', `Your note: ${note.notes}`, 'mode-help'));
          items.push(li);
        }
      }
      list.replaceChildren(...items);
      coverage.textContent = rec.untested.length
        ? `${rec.untested.map(c => c.name).join(' and ')} untested for this game: no results yet, which says nothing about how well it runs.`
        : 'Every core that runs here has results for this game.';
      if (rec.core) {
        const untested = rec.untested.length ? ` · ${rec.untested.map(c => c.name).join(', ')} untested` : '';
        hint.textContent = `Recommended for ${gameLabel(group.game)}: ${rec.core.name} (${rec.evidence})${untested}`;
      } else {
        hint.textContent = `No core is known to work for ${gameLabel(group.game)} yet.`;
      }
    }
    hint.hidden = !group;

    const target = reportTarget();
    reportButton.disabled = !target;
    $('compat-report-target').textContent = target
      ? `Rate ${gameLabel(target.game)} on ${coreName(target.core.id)} (engine ${shortRuntime(target.core.runtimeVersion)}).`
      : 'Play a game, then rate how it ran here.';
  }

  async function refresh() {
    try {
      await runtimeReady;
      groups = groupByGame(await listResults());
    } catch (err) {
      status.textContent = `Compatibility database unavailable: ${err.message}`;
      groups = [];
    }
    render();
  }

  async function save(results, message) {
    try {
      await putResults(results);
      if (message) status.textContent = message;
    } catch (err) {
      status.textContent = `Could not store the result: ${err.message}`;
    }
    await refresh();
  }

  gameSelect.addEventListener('change', () => {
    selectedKey = gameSelect.value;
    render();
  });

  reportButton.addEventListener('click', async () => {
    const target = reportTarget();
    const rating = USER_RATINGS.find(r => r.id === ratingSelect.value);
    if (!target || !rating) return;
    const note = $('compat-note').value.trim();
    const result = makeResult({
      source: 'browser',
      confidence: 'user',
      game: target.game,
      core: target.core,
      environment: await environment,
      scenario: { name: 'user-report' },
      outcome: rating.outcome,
      failure: rating.category ? { category: rating.category, detail: `rated ${rating.label}` } : null,
      metrics: { rating: rating.id },
      notes: note,
    });
    $('compat-note').value = '';
    save([result], `Saved your report: ${gameLabel(target.game)} is ${rating.label} on ${coreName(target.core.id)}.`);
  });

  $('btn-compat-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const files = [...importInput.files];
    importInput.value = '';
    const valid = [];
    let invalid = 0;
    const problems = [];
    for (const file of files) {
      try {
        const parsed = parseImport(JSON.parse(await file.text()));
        valid.push(...parsed.valid);
        invalid += parsed.invalid;
        problems.push(...parsed.problems.map(p => `${file.name}: ${p}`));
      } catch (err) {
        invalid++;
        problems.push(`${file.name}: ${err.message}`);
      }
    }
    const skipped = invalid ? ` Skipped ${invalid} invalid (${problems[0]}${problems.length > 1 ? ', ...' : ''}).` : '';
    await save(valid, `Imported ${valid.length} result${valid.length === 1 ? '' : 's'}.${skipped}`);
  });

  $('btn-compat-export').addEventListener('click', async () => {
    const results = await listResults();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), results }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `eden-compatibility-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  $('btn-compat-clear').addEventListener('click', async () => {
    if (!confirm('Delete all compatibility results stored in this browser? This cannot be undone.')) return;
    await clearResults().catch(() => {});
    status.textContent = 'Cleared the compatibility results.';
    await refresh();
  });

  /// One play session: samples the runtime and records a result for it.
  class Session {
    constructor({ module, rom, core }) {
      this.module = module;
      this.core = core;
      this.fileName = rom.name;
      this.size = rom.size;
      this.game = gameIdentity({ fileName: rom.name, size: rom.size });
      this.id = makeResult().id;
      this.bootAt = performance.now();
      this.samples = [];
      this.frameTimes = [];
      this.everRunning = false;
      this.firstFrameAt = null;
      this.lastFrameAt = null;
      this.savedAt = 0;
      this.observing = true;
      this.crash = null;
      this.failed = false;
      this.timer = setInterval(() => this.poll(), POLL_MS);
      this.lastRaf = null;
      const tick = time => {
        if (!this.observing) return;
        if (document.hidden || this.firstFrameAt == null) this.lastRaf = null;
        else {
          if (this.lastRaf != null && this.frameTimes.length < MAX_FRAME_SAMPLES) this.frameTimes.push(time - this.lastRaf);
          this.lastRaf = time;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      this.onHide = () => {
        if (this.observing && this.firstFrameAt != null) this.record();
      };
      addEventListener('pagehide', this.onHide);
    }

    poll() {
      const now = performance.now();
      let state;
      let fps;
      try {
        state = this.module._eden_get_state();
        fps = Number(this.module._eden_get_game_fps());
      } catch {
        return;
      }
      if (!Number.isFinite(fps)) fps = 0;
      if (state === 2) this.everRunning = true;
      if (state === 2 && fps > 0) {
        this.firstFrameAt ??= now;
        this.lastFrameAt = now;
      }
      if (state >= 2 && !this.infoRead) {
        const info = readGameInfo(this.module);
        if (info) {
          this.infoRead = true;
          this.game = gameIdentity({ info, fileName: this.fileName, size: this.size });
          this.remember();
        }
      }
      this.samples.push({ t: now, fps });
      if (state === 4) {
        this.failed = true;
        this.loadResult = this.module._eden_get_load_result?.();
        this.finish();
      } else if (this.firstFrameAt != null ? now - this.firstFrameAt >= PLAY_MS : now - this.bootAt >= BOOT_LIMIT_MS) {
        this.finish();
      } else if (this.firstFrameAt != null && now - this.savedAt >= CHECKPOINT_MS) {
        this.record();
      }
    }

    remember() {
      writeLast({ game: this.game, core: coreField(this.core) });
      render();
    }

    async build() {
      const now = performance.now();
      const fps = sustainedFps(this.samples, this.firstFrameAt);
      // Don't call into a crashed runtime: a thread that died holding a lock would block this one.
      const engineTimes = this.crash ? null : readEngineFrameTimes(this.module);
      const rafStats = frameTimeStats(this.frameTimes);
      const kept = this.crash ? this.lastResult?.metrics : null;
      const assessment = assessSession({
        now, crash: this.crash, failed: this.failed, loadResult: this.loadResult, everRunning: this.everRunning,
        firstFrameAt: this.firstFrameAt, lastFrameAt: this.lastFrameAt, fps,
      });
      const drawn = this.samples.filter(s => this.firstFrameAt != null && s.t >= this.firstFrameAt);
      return makeResult({
        id: this.id,
        source: 'browser',
        confidence: 'automated',
        game: this.game,
        core: coreField(this.core),
        environment: await environment,
        scenario: { name: 'browser-session', seconds: Math.round((now - this.bootAt) / 1000), warm: false,
          settings: { playSeconds: PLAY_MS / 1000, bootLimitSeconds: BOOT_LIMIT_MS / 1000, minPlayableFps: MIN_PLAYABLE_FPS } },
        ...assessment,
        metrics: {
          coreReadyMs,
          timeToFirstFrameMs: this.firstFrameAt == null ? null : Math.round(this.firstFrameAt - this.bootAt),
          sustainedFps: Math.round(fps * 10) / 10,
          peakFps: Math.max(0, ...drawn.map(s => s.fps)),
          frameTime: kept?.frameTime ?? (engineTimes && frameTimeStats(engineTimes)) ?? rafStats,
          frameTimeSource: kept?.frameTimeSource ?? (engineTimes ? 'engine' : rafStats ? 'browser-raf' : null),
          browserFrameTime: rafStats,
          ...(this.crash ? { crashAfterS: Math.round((now - this.bootAt) / 1000) } : {}),
        },
      });
    }

    async record(message) {
      this.savedAt = performance.now();
      const result = await this.build();
      this.lastResult = result;
      await save([result], message);
      return result;
    }

    async finish() {
      if (!this.observing) return;
      this.observing = false;
      clearInterval(this.timer);
      removeEventListener('pagehide', this.onHide);
      const result = await this.record();
      const verdict = result.outcome === 'pass' ? 'passed' : `failed (${result.failure.category}: ${result.failure.detail})`;
      const text = `Recorded ${gameLabel(this.game)} on ${coreName(this.core.id)}: ${verdict}.`;
      status.textContent = text;
      log(`Compatibility: ${text}`, 'ui');
    }

    /// A crash during or after the window turns this session's result into a failure.
    async crashed(reason) {
      this.crash = reason;
      if (this.observing) return this.finish();
      await this.record(`Recorded a crash of ${gameLabel(this.game)} on ${coreName(this.core.id)}.`);
    }
  }

  refresh();

  return {
    coreReady() {
      coreReadyMs = Math.round(performance.now());
    },
    async startSession({ module, rom, core }) {
      await runtimeReady;
      session = new Session({ module, rom, core });
      session.remember();
    },
    crashed: reason => session?.crashed(reason).catch(err => console.warn('Could not record the crash:', err)),
    refresh,
  };
}
