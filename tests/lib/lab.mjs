// SPDX-License-Identifier: GPL-3.0-or-later
// Helpers shared by the regression lab (tests/e2e.mjs, tests/matrix.mjs and
// scripts/compare-results.mjs): failure classification, game identity, repeat summaries and
// reading result sets. Nothing here needs a browser, so tests/compare_results.mjs covers it.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { FAILURE_CATEGORIES, resultsFrom, validateResult } from '../../web/results.js';

/// Identifies a game from its file name alone. Dump names usually carry the title ID and version,
/// e.g. "Game [01009BF0072D4000][v0].nsp". Only the base name is kept, never the directory.
export function gameFromFile(file) {
  const base = path.basename(file);
  const titleId = base.match(/\[([0-9A-Fa-f]{16})\]/)?.[1]?.toUpperCase() ?? null;
  const version = base.match(/\[v(\d+)\]/)?.[1];
  const name = base.replace(/\.[^.]+$/, '').replace(/\s*[[(].*$/, '').trim() || base;
  return { titleId, name, version: version === undefined ? null : Number(version), displayVersion: null, file: base };
}

/// Merges what the engine reports about the running game (any of a few field spellings) into the
/// identity taken from the file name.
export function mergeGameInfo(fromFile, info) {
  if (!info || typeof info !== 'object') return fromFile;
  const pick = (...keys) => keys.map(key => info[key]).find(value => value !== undefined && value !== null && value !== '');
  let titleId = pick('titleId', 'title_id', 'programId', 'program_id');
  if (typeof titleId === 'number' || typeof titleId === 'bigint') titleId = titleId.toString(16).padStart(16, '0');
  if (typeof titleId === 'string') titleId = titleId.replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(titleId ?? '')) titleId = null;
  return {
    ...fromFile,
    titleId: titleId ?? fromFile.titleId,
    name: pick('name', 'title') ?? fromFile.name,
    version: pick('version') ?? fromFile.version,
    displayVersion: pick('displayVersion', 'display_version') ?? fromFile.displayVersion,
  };
}

/// The failure of a run from its checks: each failed check names a category, and the earliest
/// stage (FAILURE_CATEGORIES order) wins, so a crash that also stopped frames is a crash.
export function classify(checks) {
  const failed = checks.filter(entry => !entry.ok);
  if (!failed.length) return { outcome: 'pass', failure: null };
  const rank = entry => {
    const index = FAILURE_CATEGORIES.indexOf(entry.category);
    return index < 0 ? FAILURE_CATEGORIES.length : index;
  };
  const first = [...failed].sort((a, b) => rank(a) - rank(b))[0];
  const category = FAILURE_CATEGORIES.includes(first.category) ? first.category : 'crash';
  const detail = `${first.name}${first.detail === undefined ? '' : `: ${first.detail}`}`;
  return { outcome: 'fail', failure: { category, detail, checks: failed.map(entry => entry.name) } };
}

/// The first stretch of `samples` consecutive frameless samples after the game has drawn, or null.
export function findHang(timeline, samples) {
  let drawn = false;
  let start = null;
  let count = 0;
  for (const sample of timeline) {
    if (sample.fps > 0) {
      drawn = true;
      start = null;
      count = 0;
    } else if (drawn) {
      start ??= sample.t;
      if (++count >= samples) return { fromS: start, samples: count };
    }
  }
  return null;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/// Metrics compared between runs, with which direction is better and the smallest change that
/// counts (FPS is sampled every 2 s and first frame is known to the sample, so tiny deltas are noise).
export const METRICS = [
  { key: 'coreReadyMs', better: 'lower', floor: 250, unit: 'ms' },
  { key: 'bootToRunningS', better: 'lower', floor: 2, unit: 's' },
  { key: 'firstFrameS', better: 'lower', floor: 2, unit: 's' },
  { key: 'peakFps', better: 'higher', floor: 1, unit: 'fps' },
  { key: 'sustainedFps', better: 'higher', floor: 1, unit: 'fps' },
  { key: 'frameTime.p50', better: 'lower', floor: 1, unit: 'ms' },
  { key: 'frameTime.p95', better: 'lower', floor: 2, unit: 'ms' },
  { key: 'frameTime.p99', better: 'lower', floor: 3, unit: 'ms' },
  { key: 'frameTime.stutterRate', better: 'lower', floor: 0.005, unit: '' },
];

export function metricValue(result, key) {
  const metrics = result.metrics ?? {};
  if (key === 'frameTime.stutterRate') {
    const ft = metrics.frameTime;
    return ft?.count ? ft.stutters / ft.count : null;
  }
  const value = key.split('.').reduce((object, part) => object?.[part], metrics);
  return Number.isFinite(value) ? value : null;
}

/// Median, range and relative spread ((max - min) / |median|) of a metric over repeated runs.
export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const mid = median(finite);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return { n: finite.length, median: mid, min, max, spread: mid ? (max - min) / Math.abs(mid) : 0 };
}

export function summarizeRuns(results) {
  const summary = {};
  for (const { key } of METRICS) {
    const stats = summarize(results.map(result => metricValue(result, key)));
    if (stats) summary[key] = stats;
  }
  return summary;
}

/// Which runs are repeats of each other: same game, core, scenario and cold/warm start.
export function groupKey(result) {
  const game = result.game?.titleId ?? result.game?.name ?? result.game?.file ?? 'no-game';
  const core = result.core?.id ?? 'default';
  const scenario = result.scenario?.name ?? 'default';
  const start = result.scenario?.warm ? 'warm' : 'cold';
  return `${game} | ${core} | ${scenario} | ${start}`;
}

export function groupResults(results) {
  const groups = new Map();
  for (const result of results) {
    const key = groupKey(result);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return groups;
}

/// Reads results from files and directories (searched recursively): single results, arrays and
/// result sets all count. Malformed results are reported, not silently dropped.
export async function loadResults(inputs) {
  const results = [];
  const problems = [];
  const visit = async file => {
    if ((await stat(file)).isDirectory()) {
      for (const entry of (await readdir(file)).sort()) {
        if (entry.endsWith('.json') || (await stat(path.join(file, entry))).isDirectory()) await visit(path.join(file, entry));
      }
      return;
    }
    let json;
    try {
      json = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      problems.push(`${file}: ${err.message}`);
      return;
    }
    for (const result of resultsFrom(json)) {
      const issues = validateResult(result);
      if (issues.length) problems.push(`${file}: ${issues.join('; ')}`);
      else results.push(result);
    }
  };
  for (const input of [inputs].flat()) await visit(input);
  // Sets embed the results also written as single files; count each run once.
  const seen = new Set();
  return { results: results.filter(result => !seen.has(result.id) && seen.add(result.id)), problems };
}

/// A fixed-width text table.
export function table(rows, columns) {
  const cells = rows.map(row => columns.map(column => String(row[column] ?? '')));
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map(row => row[i].length)));
  const line = values => values.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns), line(widths.map(width => '-'.repeat(width))), ...cells.map(line)].join('\n');
}
