// SPDX-License-Identifier: GPL-3.0-or-later
// Writes web/runtime/runtime.json: the engine revision the runtime was built from and the
// checksum of every file, so the page and the Pages workflow can show and verify it.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_FILES = ['eden.js', 'eden.wasm', 'eden_archive.js', 'eden_archive.wasm'];

export function engineRevision(engineDir) {
  try {
    return execFileSync('git', ['-C', engineDir, 'describe', '--always', '--dirty'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/// Writes web/version.json, the single place the page reads its version from. The Pages workflow
/// writes the deployed one; `npm run sync` writes a local one marked `local`.
export async function writeVersion(webDir, fields) {
  const { version } = JSON.parse(await readFile(path.join(webDir, '../package.json'), 'utf8'));
  const info = { version, webRevision: engineRevision(path.join(webDir, '..')), ...fields };
  await writeFile(path.join(webDir, 'version.json'), JSON.stringify(info, null, 2) + '\n');
  return info;
}

export async function writeRuntimeManifest(runtimeDir, engineDir, fields = {}) {
  const manifest = { engineRevision: engineRevision(engineDir), ...fields, files: {} };
  for (const file of RUNTIME_FILES) {
    const data = await readFile(path.join(runtimeDir, file));
    manifest.files[file] = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }
  await writeFile(path.join(runtimeDir, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
