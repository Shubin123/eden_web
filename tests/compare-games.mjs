// SPDX-License-Identifier: GPL-3.0-or-later
// Turns game suite reports (tests/games.mjs games.json) from several builds into one comparison:
// a table per scenario with game fps and frame times per segment, how far each checkpoint capture
// moved from the reference build, and a verdict line. Printed as Markdown and written next to the
// first report as compare.md.
//
//   node tests/compare-games.mjs main=artifacts/games-a/games.json upstream-sync=artifacts/games-b/games.json
// The first report is the reference. A segment counts as a regression when its median game fps
// drops more than --fps-tolerance percent (default 10), its p95 frame time rises more than that, or
// its guest cycles per busy second drop more than that. Guest CPU work (million guest cycles per real second, and per second the cores spent executing)
// is tabled too, so a build that emulates faster shows up even when the game is frame-capped.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'fps-tolerance': { type: 'string', default: '10' }, out: { type: 'string' } },
});
if (positionals.length < 1) {
  console.error('usage: node tests/compare-games.mjs <label>=<games.json> [<label>=<games.json> ...]');
  process.exit(2);
}
const tolerance = Number(args['fps-tolerance']) / 100;

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fmt = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '–');
const delta = (value, reference) => {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference === 0) return '';
  const pct = (value / reference - 1) * 100;
  return ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`;
};

const builds = [];
for (const arg of positionals) {
  const [label, file] = arg.includes('=') ? arg.split(/=(.*)/s) : [path.basename(path.dirname(arg)), arg];
  builds.push({ label, file, report: JSON.parse(await readFile(file, 'utf8')) });
}

/// Per scenario: status, runs, and per segment the medians across runs.
function summarize(report) {
  const scenarios = new Map();
  for (const entry of report.summary) {
    const runs = entry.runs ?? [];
    const segments = new Map();
    for (const run of runs) {
      for (const s of run.segments ?? []) {
        if (!segments.has(s.until)) segments.set(s.until, []);
        segments.get(s.until).push(s);
      }
    }
    const checkpoints = new Map();
    for (const run of runs) {
      for (const c of run.checkpoints ?? []) {
        if (!checkpoints.has(c.name)) checkpoints.set(c.name, []);
        checkpoints.get(c.name).push(c);
      }
    }
    scenarios.set(entry.id, {
      status: entry.status,
      runs: runs.length,
      problems: runs.flatMap(r => r.problems ?? []),
      seconds: median(runs.map(r => r.seconds)),
      segments: new Map([...segments].map(([name, list]) => [name, {
        fps: median(list.map(s => s.fps)),
        fpsMin: Math.min(...list.map(s => s.fps)),
        fpsMax: Math.max(...list.map(s => s.fps)),
        p50: median(list.map(s => s.frameMs?.p50)),
        p95: median(list.map(s => s.frameMs?.p95)),
        p99: median(list.map(s => s.frameMs?.p99)),
        mcps: median(list.map(s => s.guest?.mcps)),
        core0: median(list.map(s => s.guest?.core0Mcps)),
        busy: median(list.map(s => s.guest?.busyMcps)),
      }])),
      checkpoints: new Map([...checkpoints].map(([name, list]) => [name, {
        frame: median(list.map(c => c.frame)),
        diff: median(list.map(c => c.diff_baseline)),
      }])),
    });
  }
  return scenarios;
}

const summaries = builds.map(b => ({ ...b, scenarios: summarize(b.report) }));
const reference = summaries[0];
const ids = [...new Set(summaries.flatMap(s => [...s.scenarios.keys()]))];
const lines = [`# Game suite comparison`, '', `Reference build: **${reference.label}**. Builds: ${summaries.map(s => `${s.label} (${path.relative(process.cwd(), s.file)})`).join(', ')}.`, ''];
const verdicts = [];

for (const id of ids) {
  lines.push(`## ${id}`, '');
  lines.push(`| Build | Status | Runs | Wall time |`, `|---|---|---|---|`);
  for (const s of summaries) {
    const sc = s.scenarios.get(id);
    lines.push(`| ${s.label} | ${sc ? (sc.status === 'passed' ? 'pass' : sc.status) : 'not run'} | ${sc?.runs ?? 0} | ${sc ? `${fmt(sc.seconds, 0)} s` : '–'} |`);
  }
  lines.push('');
  const segmentNames = [...new Set(summaries.flatMap(s => [...(s.scenarios.get(id)?.segments.keys() ?? [])]))];
  lines.push(`| Segment | ${summaries.map(s => `${s.label} fps (min–max)`).join(' | ')} | ${summaries.map(s => `${s.label} frame ms p50 / p95 / p99`).join(' | ')} |`);
  lines.push(`|---|${summaries.map(() => '---:').join('|')}|${summaries.map(() => '---:').join('|')}|`);
  const guestRows = [];
  const regressions = new Map(summaries.slice(1).map(s => [s.label, []]));
  const improvements = new Map(summaries.slice(1).map(s => [s.label, []]));
  for (const name of segmentNames) {
    const ref = reference.scenarios.get(id)?.segments.get(name);
    const fpsCells = summaries.map(s => {
      const seg = s.scenarios.get(id)?.segments.get(name);
      if (!seg) return '–';
      const spread = seg.fpsMin !== seg.fpsMax ? ` (${fmt(seg.fpsMin)}–${fmt(seg.fpsMax)})` : '';
      return `${fmt(seg.fps)}${s === reference ? '' : delta(seg.fps, ref?.fps)}${spread}`;
    });
    const timeCells = summaries.map(s => {
      const seg = s.scenarios.get(id)?.segments.get(name);
      return seg ? `${fmt(seg.p50)} / ${fmt(seg.p95)} / ${fmt(seg.p99)}` : '–';
    });
    lines.push(`| ${name} | ${fpsCells.join(' | ')} | ${timeCells.join(' | ')} |`);
    guestRows.push(`| ${name} | ${summaries.map(s => {
      const seg = s.scenarios.get(id)?.segments.get(name);
      if (!seg || !Number.isFinite(seg.mcps)) return '–';
      return `${fmt(seg.mcps)}${s === reference ? '' : delta(seg.mcps, ref?.mcps)} / ${fmt(seg.core0)} / ${fmt(seg.busy)}${s === reference ? '' : delta(seg.busy, ref?.busy)}`;
    }).join(' | ')} |`);
    if (!ref || name === 'end') continue;
    for (const s of summaries.slice(1)) {
      const seg = s.scenarios.get(id)?.segments.get(name);
      if (!seg) continue;
      const slowerCpu = Number.isFinite(seg.busy) && Number.isFinite(ref.busy) && seg.busy < ref.busy * (1 - tolerance);
      const fasterCpu = Number.isFinite(seg.busy) && Number.isFinite(ref.busy) && seg.busy > ref.busy * (1 + tolerance);
      if (seg.fps < ref.fps * (1 - tolerance) || seg.p95 > ref.p95 * (1 + tolerance) || slowerCpu) regressions.get(s.label).push(name);
      else if (seg.fps > ref.fps * (1 + tolerance) || fasterCpu) improvements.get(s.label).push(name);
    }
  }
  lines.push('');
  if (guestRows.some(row => !/^\| [^|]+ \|( – \|)+$/.test(row))) {
    lines.push(`Guest CPU work, million guest cycles per real second (all cores / core 0) and per second of execution:`, '');
    lines.push(`| Segment | ${summaries.map(s => `${s.label} Mcyc/s / core 0 / per busy s`).join(' | ')} |`, `|---|${summaries.map(() => '---:').join('|')}|`);
    lines.push(...guestRows, '');
  }
  const checkpointNames = [...new Set(summaries.flatMap(s => [...(s.scenarios.get(id)?.checkpoints.keys() ?? [])]))];
  if (checkpointNames.length) {
    lines.push(`| Checkpoint | ${summaries.map(s => `${s.label} diff from baseline`).join(' | ')} |`, `|---|${summaries.map(() => '---:').join('|')}|`);
    for (const name of checkpointNames) {
      lines.push(`| ${name} | ${summaries.map(s => fmt(s.scenarios.get(id)?.checkpoints.get(name)?.diff)).join(' | ')} |`);
    }
    lines.push('');
  }
  for (const s of summaries) {
    const problems = s.scenarios.get(id)?.problems ?? [];
    if (problems.length) lines.push(`- **${s.label}** problems: ${[...new Set(problems)].join('; ')}`);
  }
  for (const s of summaries.slice(1)) {
    const sc = s.scenarios.get(id);
    const failed = sc && sc.status !== 'passed';
    const worse = regressions.get(s.label);
    const better = improvements.get(s.label);
    const verdict = failed ? 'FAILS' : worse.length ? `REGRESSION in ${worse.join(', ')}` : better.length ? `faster in ${better.join(', ')}` : 'no regression';
    verdicts.push({ id, build: s.label, verdict, bad: failed || worse.length > 0 });
    lines.push(`- **Verdict ${s.label} vs ${reference.label}:** ${verdict}`);
  }
  lines.push('');
}

lines.push('## Summary', '', `| Scenario | ${summaries.slice(1).map(s => s.label).join(' | ')} |`, `|---|${summaries.slice(1).map(() => '---').join('|')}|`);
for (const id of ids) {
  lines.push(`| ${id} | ${summaries.slice(1).map(s => verdicts.find(v => v.id === id && v.build === s.label)?.verdict ?? '–').join(' | ')} |`);
}
const text = `${lines.join('\n')}\n`;
const outFile = args.out ?? path.join(path.dirname(builds[0].file), 'compare.md');
await writeFile(outFile, text);
console.log(text);
console.log(`Written to ${path.relative(process.cwd(), outFile)}`);
process.exit(verdicts.some(v => v.bad) ? 1 : 0);
