// SPDX-License-Identifier: GPL-3.0-or-later
// Smoke test validating Eden WebAssembly web artifacts (eden.js, eden.wasm)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'web');
const artifactName = 'eden';
const pageName = 'index.html';

const expectedExports = [
    'eden_init',
    'eden_load_rom',
    'eden_step_frame',
    'eden_run_loop',
    'eden_shutdown',
    'eden_get_perf_stats',
    'eden_set_fast_forward',
    'eden_get_fast_forward',
    'eden_is_rom_loaded',
];

function read(file) {
    return fs.readFileSync(file);
}

function requireFile(dir, name) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), `missing ${path.relative(root, file)}`);
    assert.ok(fs.statSync(file).size > 0, `empty ${path.relative(root, file)}`);
    return file;
}

requireFile(webDir, `${artifactName}.js`);
requireFile(webDir, `${artifactName}.wasm`);

const html = read(path.join(webDir, pageName)).toString('utf8');
const glue = read(path.join(webDir, `${artifactName}.js`)).toString('utf8');

assert.match(html, /<canvas\s+id=["']canvas["']/i, 'index.html must contain <canvas id="canvas">');

for (const name of expectedExports) {
    assert.match(glue, new RegExp(`_${name}\\b`), `missing ${name} in generated JS`);
}

const wasmBytes = read(path.join(webDir, `${artifactName}.wasm`));
const wasmModule = new WebAssembly.Module(wasmBytes);
const moduleExports = WebAssembly.Module.exports(wasmModule);

assert.ok(
    moduleExports.some(({name, kind}) => name === 'memory' && kind === 'memory'),
    'WASM binary has no memory export'
);

for (const name of expectedExports) {
    assert.ok(
        moduleExports.some(e => e.name === name || e.name === `_${name}`),
        `WASM binary missing export ${name}`
    );
}

console.log(`Eden web artifact smoke test passed (${moduleExports.length} WASM exports inspected, ${wasmBytes.length} bytes).`);
