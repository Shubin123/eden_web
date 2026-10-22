// SPDX-License-Identifier: GPL-3.0-or-later
// Smoke test validating the Eden WebAssembly runtime in web/runtime (eden.js, eden.wasm)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'web');
const runtimeDir = path.join(webDir, 'runtime');

// C API used by web/app.js.
const expectedExports = [
    'eden_boot',
    'eden_pause',
    'eden_resume',
    'eden_shutdown',
    'eden_set_button',
    'eden_set_stick',
    'eden_camera_buffer',
    'eden_submit_camera',
    'eden_get_camera_width',
    'eden_get_state',
    'eden_get_load_result',
    'eden_get_game_fps',
    'eden_get_system_fps',
    'eden_get_emulation_speed',
    'eden_get_frametime',
];

function requireFile(dir, name) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), `missing ${path.relative(root, file)} (run npm run sync)`);
    assert.ok(fs.statSync(file).size > 0, `empty ${path.relative(root, file)}`);
    return file;
}

function readLeb(bytes, offset) {
    let value = 0n;
    let shift = 0n;
    for (;;) {
        const byte = bytes[offset++];
        value |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
        if ((byte & 0x80) === 0) return [value, offset];
    }
}

function readName(bytes, offset) {
    const [length, start] = readLeb(bytes, offset);
    const end = start + Number(length);
    return [bytes.subarray(start, end).toString('utf8'), end];
}

// Returns the limits flags of the imported memory (bit 1 = shared, bit 2 = memory64).
function importedMemoryFlags(bytes) {
    let offset = 8;
    while (offset < bytes.length) {
        const id = bytes[offset];
        const [size, body] = readLeb(bytes, offset + 1);
        offset = body + Number(size);
        if (id !== 2) continue;
        let [count, cursor] = readLeb(bytes, body);
        for (; count > 0n; --count) {
            [, cursor] = readName(bytes, cursor);
            [, cursor] = readName(bytes, cursor);
            const kind = bytes[cursor++];
            if (kind === 2) return bytes[cursor];
            if (kind === 0) [, cursor] = readLeb(bytes, cursor);
            else if (kind === 1) { cursor++; const flags = bytes[cursor++]; [, cursor] = readLeb(bytes, cursor); if (flags & 1) [, cursor] = readLeb(bytes, cursor); }
            else if (kind === 3) cursor += 2;
            else if (kind === 4) [, cursor] = readLeb(bytes, cursor + 1);
            else throw new Error(`unknown import kind ${kind}`);
        }
    }
    return null;
}

const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
const glue = fs.readFileSync(requireFile(runtimeDir, 'eden.js'), 'utf8');
const wasmBytes = fs.readFileSync(requireFile(runtimeDir, 'eden.wasm'));

assert.match(html, /<canvas\s+id=["']canvas["']/i, 'index.html must contain <canvas id="canvas">');
assert.match(html, /<script src="runtime\/eden\.js">/, 'index.html must load runtime/eden.js');
assert.match(glue, /createEdenModule/, 'eden.js must define createEdenModule');

const memoryFlags = importedMemoryFlags(wasmBytes);
assert.notEqual(memoryFlags, null, 'eden.wasm must import its memory (pthread build)');
assert.ok(memoryFlags & 0x2, 'eden.wasm memory must be shared (pthreads)');
assert.ok(memoryFlags & 0x4, 'eden.wasm memory must be 64-bit (MEMORY64)');

const wasmModule = new WebAssembly.Module(wasmBytes);
const moduleExports = new Set(WebAssembly.Module.exports(wasmModule).map(({name}) => name));

for (const name of expectedExports) {
    // Release links minify export names; the glue maps each C symbol to its export.
    const match = glue.match(new RegExp(`_${name}\\s*=\\s*Module\\["_${name}"\\]\\s*=\\s*wasmExports\\["([^"]+)"\\]`));
    assert.ok(match, `missing ${name} in generated JS`);
    assert.ok(moduleExports.has(match[1]), `eden.wasm missing export ${match[1]} for ${name}`);
}

console.log(`Eden web artifact smoke test passed (${expectedExports.length} C exports checked, ${(wasmBytes.length / 1048576).toFixed(1)} MB wasm).`);
