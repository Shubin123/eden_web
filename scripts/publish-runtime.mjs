// SPDX-License-Identifier: GPL-3.0-or-later
// Uploads web/runtime (from `npm run sync`) to the `runtime` GitHub release, which the Pages
// workflow deploys. Pass --deploy to start that workflow afterwards.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, 'web/runtime');
const engine = path.resolve(root, '../eden_emscripten');
const tag = 'runtime';
const files = ['eden.js', 'eden.wasm'];

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options })?.trim();

run(process.execPath, ['tests/web_artifact_smoke.cjs'], { stdio: 'inherit' });

const manifest = {
  engineRevision: run('git', ['-C', engine, 'describe', '--always', '--dirty'], { stdio: ['ignore', 'pipe', 'ignore'] }) || 'unknown',
  publishedAt: new Date().toISOString(),
  files: {},
};
for (const file of files) {
  const data = await readFile(path.join(runtime, file));
  manifest.files[file] = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
await writeFile(path.join(runtime, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');

try {
  run('gh', ['release', 'view', tag], { stdio: 'ignore' });
} catch {
  run('gh', ['release', 'create', tag, '--prerelease', '--title', 'Web runtime',
    '--notes', 'Eden WebAssembly runtime deployed to GitHub Pages. Assets are replaced by `npm run publish-runtime`.']);
}
run('gh', ['release', 'upload', tag, '--clobber', ...[...files, 'runtime.json'].map(file => path.join(runtime, file))], { stdio: 'inherit' });
console.log(`Published runtime ${manifest.engineRevision} to release '${tag}'.`);

if (process.argv.includes('--deploy')) {
  run('gh', ['workflow', 'run', 'pages.yml', '--ref', 'main'], { stdio: 'inherit' });
  console.log('Started the Pages deployment workflow.');
}
