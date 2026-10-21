// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeManifest, writeVersion } from './runtime-manifest.mjs';

const sourceArgument = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const source = path.resolve(sourceArgument || fileURLToPath(new URL('../../eden_emscripten/build-web/bin/', import.meta.url)));
const destination = fileURLToPath(new URL('../web/runtime/', import.meta.url));

await mkdir(destination, { recursive: true });

try {
  const files = await readdir(source);
  let count = 0;
  for (const file of files) {
    // Only the browser runtime and archive decoder; the headless runner and test binaries also live in bin/.
    if (/^eden(_archive)?\.(wasm|js|data)$/.test(file)) {
      await copyFile(path.join(source, file), path.join(destination, file));
      count++;
    }
  }
  // build-web-dev holds EDEN_DEV=1 builds (lighter link), which must never be published.
  const build = path.basename(path.dirname(source)) === 'build-web-dev' ? 'dev' : 'release';
  const manifest = await writeRuntimeManifest(destination, path.resolve(source, '../..'),
    { build, syncedAt: new Date().toISOString() });
  await writeVersion(path.join(destination, '..'),
    { engineRevision: manifest.engineRevision, build, local: true, deployedAt: null });
  console.log(`Synced ${count} runtime files from ${source} to ${destination} (${build} build, engine ${manifest.engineRevision})`);
} catch (err) {
  console.warn(`Note: Could not sync from ${source}: ${err.message}`);
}
