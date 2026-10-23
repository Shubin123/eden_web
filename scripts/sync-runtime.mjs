// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeManifest, writeVersion } from './runtime-manifest.mjs';

// --variant <name> syncs a second engine build into web/runtime/<name>/, for a core that runs on it
// (see `runtime` in web/cores.js); without it the default runtime is synced.
const argv = process.argv.slice(2);
const variantAt = argv.indexOf('--variant');
const variant = variantAt >= 0 ? argv.splice(variantAt, 2)[1] : null;
const sourceArgument = argv.find(arg => !arg.startsWith('--'));
const source = path.resolve(sourceArgument || fileURLToPath(new URL('../../eden_emscripten/build-web/bin/', import.meta.url)));
const destination = fileURLToPath(new URL(`../web/runtime/${variant ? `${variant}/` : ''}`, import.meta.url));

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
  if (!variant) {
    await writeVersion(path.join(destination, '..'),
      { engineRevision: manifest.engineRevision, build, local: true, deployedAt: null });
  }
  console.log(`Synced ${count} runtime files from ${source} to ${destination} (${build} build, engine ${manifest.engineRevision})`);
} catch (err) {
  console.warn(`Note: Could not sync from ${source}: ${err.message}`);
}
