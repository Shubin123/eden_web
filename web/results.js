// SPDX-License-Identifier: GPL-3.0-or-later
// Test result format shared by the browser widgets and the Node test harness. A result says what
// was run (game, core, runtime build, environment, scenario), whether it worked, why not, and what
// was measured. It names no frontend code, so other tools can read results without this project.
// Paths and file contents never go in a result: games are identified by title ID and version.

export const RESULT_SCHEMA = 'eden-web/result@1';

/// Ordered from "the environment could not run anything" to "it ran, but too slowly", so the
/// first failing stage of a launch picks the category.
export const FAILURE_CATEGORIES = [
  'environment', // browser lacks a requirement (cross-origin isolation, WebGPU, Memory64, ...)
  'artifact', // runtime files missing, mismatched or failed to download
  'init', // runtime failed to start
  'system-files', // keys or firmware missing or invalid
  'boot', // the game failed to load
  'crash', // the runtime aborted or threw after boot
  'hang', // the game stopped making progress
  'no-frames', // the game ran but never presented a frame
  'performance', // the game ran below the scenario's thresholds
];

export const OUTCOMES = ['pass', 'fail', 'unsupported', 'skipped'];

/// How much a compatibility claim can be trusted, strongest first.
export const CONFIDENCE = ['automated', 'confirmed', 'user'];

export function makeResult(fields = {}) {
  return {
    schema: RESULT_SCHEMA,
    id: fields.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: fields.createdAt ?? new Date().toISOString(),
    source: fields.source ?? 'browser', // browser | e2e | matrix | import
    confidence: fields.confidence ?? 'automated',
    // { titleId, name, version, displayVersion }; titleId is 16 hex digits when known.
    game: fields.game ?? null,
    // { id, emulator, runtimeVersion, build: { commit, emscripten, flags, ... } }
    core: fields.core ?? null,
    // { userAgent, platform, gpu, hardwareConcurrency, deviceMemoryGB, crossOriginIsolated, url }
    environment: fields.environment ?? null,
    // { name, seconds, warm, settings }
    scenario: fields.scenario ?? null,
    outcome: fields.outcome ?? 'skipped',
    failure: fields.failure ?? null, // { category, detail }
    metrics: fields.metrics ?? {},
    notes: fields.notes ?? '',
  };
}

/// Returns a list of problems; empty when the result is well formed.
export function validateResult(result) {
  const problems = [];
  if (!result || typeof result !== 'object') return ['not an object'];
  if (result.schema !== RESULT_SCHEMA) problems.push(`schema is ${result.schema}, expected ${RESULT_SCHEMA}`);
  if (typeof result.id !== 'string' || !result.id) problems.push('missing id');
  if (Number.isNaN(Date.parse(result.createdAt))) problems.push('createdAt is not a date');
  if (!OUTCOMES.includes(result.outcome)) problems.push(`unknown outcome ${result.outcome}`);
  if (!CONFIDENCE.includes(result.confidence)) problems.push(`unknown confidence ${result.confidence}`);
  if (result.outcome === 'fail' && !FAILURE_CATEGORIES.includes(result.failure?.category)) {
    problems.push(`failed result needs a failure category, got ${result.failure?.category}`);
  }
  if (result.game?.titleId && !/^[0-9A-F]{16}$/i.test(result.game.titleId)) problems.push(`bad titleId ${result.game.titleId}`);
  if (result.metrics && typeof result.metrics !== 'object') problems.push('metrics is not an object');
  return problems;
}

/// Frame-time statistics from a list of frame times in milliseconds. A stutter is a frame that
/// took more than twice the median and at least 25 ms, so a steady 30 fps game is not counted.
export function frameTimeStats(frameTimesMs) {
  const times = frameTimesMs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!times.length) return null;
  const at = q => times[Math.min(times.length - 1, Math.floor(q * times.length))];
  const median = at(0.5);
  const stutterMs = Math.max(25, median * 2);
  const stutters = frameTimesMs.filter(ms => ms > stutterMs);
  return {
    count: times.length,
    p50: median,
    p95: at(0.95),
    p99: at(0.99),
    max: times.at(-1),
    stutters: stutters.length,
    stutterMs,
    stutterTotalMs: stutters.reduce((sum, ms) => sum + ms, 0),
  };
}

/// Ranks results for one game: working beats broken, then automated evidence beats user reports,
/// then fewer stutters and higher sustained fps. Performance never outranks correctness.
export function compareResults(a, b) {
  const rank = r => (r.outcome === 'pass' ? 0 : r.failure?.category === 'performance' ? 1 : 2);
  return rank(a) - rank(b)
    || CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence)
    || (a.metrics?.frameTime?.stutters ?? Infinity) - (b.metrics?.frameTime?.stutters ?? Infinity)
    || (b.metrics?.sustainedFps ?? 0) - (a.metrics?.sustainedFps ?? 0);
}
