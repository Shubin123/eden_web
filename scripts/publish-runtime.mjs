// SPDX-License-Identifier: GPL-3.0-or-later
// Uploads web/runtime (from `npm run sync`) to the `runtime` GitHub release, which the Pages
// workflow deploys. Pass --deploy to start that workflow afterwards. --variant <name> publishes
// web/runtime/<name> (from `npm run sync -- --variant <name>`) to the `runtime-<name>` release.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_FILES, engineRevision, writeRuntimeManifest } from './runtime-manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const variantAt = process.argv.indexOf('--variant');
const variant = variantAt >= 0 ? process.argv[variantAt + 1] : null;
const runtime = path.join(root, 'web/runtime', variant ?? '');
const engine = path.resolve(root, '../eden_emscripten');
const tag = variant ? `runtime-${variant}` : 'runtime';

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options })?.trim();

if (!variant) run(process.execPath, ['tests/web_artifact_smoke.cjs'], { stdio: 'inherit' });

// Only release builds of committed engine sources are published, so the deployed runtime always
// maps back to a revision anyone can check out.
const synced = JSON.parse(await readFile(path.join(runtime, 'runtime.json'), 'utf8').catch(() => '{}'));
if (synced.build !== 'release' && !process.argv.includes('--force')) {
  throw new Error(`web/runtime holds a ${synced.build ?? 'unknown'} build; sync a release build (tools/web/build.sh) or pass --force`);
}
if (engineRevision(engine).endsWith('-dirty') && !process.argv.includes('--force')) {
  throw new Error('eden_emscripten has uncommitted changes; commit them or pass --force');
}

const manifest = await writeRuntimeManifest(runtime, engine, { build: synced.build, publishedAt: new Date().toISOString() });

try {
  run('gh', ['release', 'view', tag], { stdio: 'ignore' });
} catch {
  run('gh', ['release', 'create', tag, '--prerelease', '--title', 'Web runtime',
    '--notes', `Eden WebAssembly runtime${variant ? ` (${variant} build)` : ''} deployed to GitHub Pages. Assets are replaced by \`npm run publish-runtime\`.`]);
}
run('gh', ['release', 'upload', tag, '--clobber', ...[...RUNTIME_FILES, 'runtime.json'].map(file => path.join(runtime, file))], { stdio: 'inherit' });
console.log(`Published runtime ${manifest.engineRevision} to release '${tag}'.`);

// Record what each release holds in a tracked file, so engine updates show up in this repo's history.
const lockPath = path.join(root, 'runtime.lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8').catch(() => '{}'));
lock[tag] = { engineRevision: manifest.engineRevision, files: manifest.files };
await writeFile(lockPath, JSON.stringify(Object.fromEntries(Object.entries(lock).sort()), null, 2) + '\n');

if (process.argv.includes('--deploy')) {
  run('gh', ['workflow', 'run', 'pages.yml', '--ref', 'main'], { stdio: 'inherit' });
  console.log('Started the Pages deployment workflow.');
}
