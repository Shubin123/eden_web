// SPDX-License-Identifier: GPL-3.0-or-later
// Uploads web/runtime (from `npm run sync`) to the `runtime` GitHub release, which the Pages
// workflow deploys. Pass --deploy to start that workflow afterwards.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_FILES, engineRevision, writeRuntimeManifest } from './runtime-manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, 'web/runtime');
const engine = path.resolve(root, '../eden_emscripten');
const tag = 'runtime';

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options })?.trim();

run(process.execPath, ['tests/web_artifact_smoke.cjs'], { stdio: 'inherit' });

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
    '--notes', 'Eden WebAssembly runtime deployed to GitHub Pages. Assets are replaced by `npm run publish-runtime`.']);
}
run('gh', ['release', 'upload', tag, '--clobber', ...[...RUNTIME_FILES, 'runtime.json'].map(file => path.join(runtime, file))], { stdio: 'inherit' });
console.log(`Published runtime ${manifest.engineRevision} to release '${tag}'.`);

if (process.argv.includes('--deploy')) {
  run('gh', ['workflow', 'run', 'pages.yml', '--ref', 'main'], { stdio: 'inherit' });
  console.log('Started the Pages deployment workflow.');
}
