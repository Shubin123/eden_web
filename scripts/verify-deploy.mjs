// SPDX-License-Identifier: GPL-3.0-or-later
// Checks a deployed site against this checkout: every widget in web/index.html is on the live
// page, every frontend module and runtime file is served, and version.json names the expected
// commit. Retries while the CDN still serves the previous deployment.
//
//   node scripts/verify-deploy.mjs <site url> [expected web revision]

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [siteArg, expectedRevision] = process.argv.slice(2);
if (!siteArg) {
  console.error('usage: node scripts/verify-deploy.mjs <site url> [expected web revision]');
  process.exit(2);
}
const site = siteArg.endsWith('/') ? siteArg : `${siteArg}/`;
const web = fileURLToPath(new URL('../web/', import.meta.url));
const RUNTIME = ['runtime/eden.js', 'runtime/eden.wasm', 'runtime/eden_archive.js', 'runtime/eden_archive.wasm'];

const widgets = html => [...html.matchAll(/data-widget="([^"]+)"/g)].map(m => m[1]);
const expectedWidgets = widgets(await readFile(path.join(web, 'index.html'), 'utf8'));
const modules = (await readdir(web)).filter(name => name.endsWith('.js'));

async function check() {
  const problems = [];
  const bust = `?verify=${Date.now()}`;
  const get = url => fetch(url + bust, { cache: 'no-store' });

  const page = await get(site);
  if (!page.ok) return [`index.html: HTTP ${page.status}`];
  const live = new Set(widgets(await page.text()));
  for (const id of expectedWidgets) {
    if (!live.has(id)) problems.push(`widget "${id}" is missing from the deployed page`);
  }

  for (const file of [...modules, ...RUNTIME]) {
    const res = await fetch(site + file, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) problems.push(`${file}: HTTP ${res.status}`);
  }

  const version = await get(`${site}version.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!version) {
    problems.push('version.json is missing');
  } else if (expectedRevision && !String(version.webRevision).startsWith(expectedRevision.slice(0, 7))) {
    problems.push(`version.json names web ${version.webRevision}, expected ${expectedRevision.slice(0, 7)}`);
  }
  return { problems, version, widgets: live.size };
}

const deadline = Date.now() + 6 * 60 * 1000;
for (let attempt = 1; ; attempt++) {
  const result = await check();
  const problems = Array.isArray(result) ? result : result.problems;
  if (problems.length === 0) {
    console.log(`Deployment verified: ${expectedWidgets.length} widgets, ${modules.length} modules, ` +
      `${RUNTIME.length} runtime files, web ${result.version.webRevision} engine ${result.version.engineRevision}.`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(`Deployment check failed after ${attempt} attempts:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Attempt ${attempt}: ${problems.length} problem(s), first: ${problems[0]}; retrying in 30 s`);
  await new Promise(resolve => setTimeout(resolve, 30_000));
}
