// SPDX-License-Identifier: GPL-3.0-or-later
// Compares two sets of test results, e.g. a baseline build against a candidate, and exits nonzero
// on regressions. Each side is any mix of result files, result sets (matrix or --repeat output) and
// directories of them. Runs are matched by game, core, scenario and cold/warm start.
//
//   node scripts/compare-results.mjs <baseline> <candidate> [--threshold 0.1] [--strict] [--json out.json]
//   npm run compare -- artifacts/matrix-old artifacts/matrix-new
//
// Outcomes: pass -> fail is a regression; a failure moving to an earlier stage (performance ->
// crash) is too. pass -> flaky (some repeats failed) is a warning, a regression with --strict.
// Metrics (boot times, fps, frame-time p50/p95/p99 and stutter rate) regress when the median moves
// the wrong way by more than max(threshold, spread of either side's repeats) and by more than the
// metric's noise floor. Exit code: 0 no regressions, 1 regressions, 2 bad input.

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FAILURE_CATEGORIES } from '../web/results.js';
import { METRICS, groupResults, loadResults, metricValue, summarize, table } from '../tests/lib/lab.mjs';

/// pass, fail, flaky (mixed), unsupported or skipped, for the repeats of one run.
function groupOutcome(results) {
  const ran = results.filter(result => result.outcome === 'pass' || result.outcome === 'fail');
  if (!ran.length) return results[0]?.outcome ?? 'missing';
  const passed = ran.filter(result => result.outcome === 'pass').length;
  return passed === ran.length ? 'pass' : passed === 0 ? 'fail' : 'flaky';
}

/// The earliest failure stage among the runs, by FAILURE_CATEGORIES order.
function worstCategory(results) {
  const indices = results.map(result => FAILURE_CATEGORIES.indexOf(result.failure?.category)).filter(index => index >= 0);
  return indices.length ? FAILURE_CATEGORIES[Math.min(...indices)] : null;
}

export function compareSets(baseline, candidate, { threshold = 0.1, strict = false } = {}) {
  const base = groupResults(baseline);
  const cand = groupResults(candidate);
  const findings = [];
  // Keys use title IDs; the table shows the game's name.
  const label = key => {
    const game = (cand.get(key) ?? base.get(key))[0].game;
    return game?.name ? key.replace(/^[^|]+\|/, `${game.name} |`) : key;
  };
  const add = (key, kind, what, detail) => findings.push({ key, run: label(key), kind, what, detail });

  for (const key of [...new Set([...base.keys(), ...cand.keys()])].sort()) {
    const before = base.get(key) ?? [];
    const after = cand.get(key) ?? [];
    if (!after.length) {
      add(key, 'warning', 'missing', 'not run in candidate');
      continue;
    }
    if (!before.length) {
      add(key, 'info', 'new', `candidate ${groupOutcome(after)}`);
      continue;
    }
    const was = groupOutcome(before);
    const now = groupOutcome(after);
    const wasCategory = worstCategory(before);
    const nowCategory = worstCategory(after);
    const runs = (outcome, results) => `${outcome}${results.length > 1 ? ` (${results.filter(r => r.outcome === 'pass').length}/${results.length} passed)` : ''}`;
    if (was === 'pass' && now === 'fail') {
      add(key, 'regression', 'outcome', `pass -> fail (${nowCategory}: ${after.find(r => r.failure)?.failure.detail ?? ''})`);
    } else if (was === 'pass' && now === 'flaky') {
      add(key, strict ? 'regression' : 'warning', 'outcome', `pass -> ${runs(now, after)}, ${nowCategory}`);
    } else if ((was === 'fail' || was === 'flaky') && now === 'pass') {
      add(key, 'improvement', 'outcome', `${runs(was, before)} -> pass`);
    } else if (was === 'pass' && (now === 'unsupported' || now === 'skipped')) {
      add(key, 'warning', 'outcome', `pass -> ${now}`);
    } else if (wasCategory && nowCategory && wasCategory !== nowCategory) {
      // Both failed; failing at an earlier stage (e.g. performance -> crash) is worse.
      const worse = FAILURE_CATEGORIES.indexOf(nowCategory) < FAILURE_CATEGORIES.indexOf(wasCategory);
      add(key, worse ? 'regression' : 'improvement', 'failure', `${wasCategory} -> ${nowCategory}`);
    }

    // Metrics only mean something for runs that got as far in both builds.
    const comparable = results => results.filter(result => result.outcome === 'pass' || result.failure?.category === 'performance');
    for (const metric of METRICS) {
      const b = summarize(comparable(before).map(result => metricValue(result, metric.key)));
      const a = summarize(comparable(after).map(result => metricValue(result, metric.key)));
      if (!a || !b) continue;
      const delta = a.median - b.median;
      const relative = b.median ? delta / Math.abs(b.median) : delta ? Infinity : 0;
      const tolerance = Math.max(threshold, b.n > 1 ? b.spread : 0, a.n > 1 ? a.spread : 0);
      if (Math.abs(delta) <= metric.floor || Math.abs(relative) <= tolerance) continue;
      const worse = metric.better === 'lower' ? delta > 0 : delta < 0;
      const format = value => `${+value.toFixed(metric.key.endsWith('Rate') ? 3 : 1)}${metric.unit}`;
      add(key, worse ? 'regression' : 'improvement', metric.key,
        `${format(b.median)} -> ${format(a.median)} (${relative > 0 ? '+' : ''}${(relative * 100).toFixed(0)}%, tolerance ${(tolerance * 100).toFixed(0)}%, n=${b.n}/${a.n})`);
    }
  }
  return {
    findings,
    regressions: findings.filter(finding => finding.kind === 'regression'),
    compared: [...base.keys()].filter(key => cand.has(key)).length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      threshold: { type: 'string', default: '0.1' },
      strict: { type: 'boolean', default: false },
      json: { type: 'string' },
    },
  });
  if (positionals.length !== 2) {
    console.error('usage: compare-results.mjs <baseline> <candidate> [--threshold 0.1] [--strict] [--json out.json]');
    process.exit(2);
  }
  const sides = [];
  for (const input of positionals) {
    const { results, problems } = await loadResults(input).catch(err => ({ results: [], problems: [err.message] }));
    for (const problem of problems) console.warn(`warning: ${problem}`);
    if (!results.length) {
      console.error(`no results in ${input}`);
      process.exit(2);
    }
    sides.push(results);
  }
  const report = compareSets(sides[0], sides[1], { threshold: Number(values.threshold), strict: values.strict });
  const order = ['regression', 'warning', 'improvement', 'info'];
  const rows = [...report.findings].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  console.log(`baseline ${sides[0].length} results, candidate ${sides[1].length}; ${report.compared} runs compared`);
  if (rows.length) console.log(table(rows, ['kind', 'run', 'what', 'detail']));
  else console.log('no differences beyond noise');
  if (values.json) await writeFile(values.json, JSON.stringify(report, null, 2));
  console.log(report.regressions.length ? `REGRESSIONS: ${report.regressions.length}` : 'no regressions');
  process.exit(report.regressions.length ? 1 : 0);
}
