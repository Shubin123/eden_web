// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceArgument = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const source = path.resolve(sourceArgument || fileURLToPath(new URL('../../eden_emscripten/build-web/bin/', import.meta.url)));
const destination = fileURLToPath(new URL('../web/runtime/', import.meta.url));

await mkdir(destination, { recursive: true });

try {
  const files = await readdir(source);
  let count = 0;
  for (const file of files) {
    if (file.endsWith('.wasm') || file.endsWith('.js') || file.endsWith('.data')) {
      await copyFile(path.join(source, file), path.join(destination, file));
      count++;
    }
  }
  console.log(`Synced ${count} runtime files from ${source} to ${destination}`);
} catch (err) {
  console.warn(`Note: Could not sync from ${source}: ${err.message}`);
}
