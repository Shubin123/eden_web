// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the pure parts of the Diagnostics widget: feature probes, failure classification and
// bundle redaction.

import assert from 'node:assert/strict';
import { FAILURE_CATEGORIES } from '../web/results.js';
import {
  WASM_PROBES, blockingProblem, buildBundle, classifyFailure, describeLoadResult, errorOrigin,
  featureChecks, readEngineInfo, redactText, runPreflight, summaryText, wasmFeatures,
} from '../web/diagnostics.js';

// Every probe is a valid module in this Node, and a corrupted one is rejected, so the probes test
// the feature and not their own encoding.
const features = wasmFeatures();
for (const [name, supported] of Object.entries(features)) assert.equal(supported, true, `${name} probe`);
for (const [name, bytes] of Object.entries(WASM_PROBES)) {
  const broken = bytes.slice();
  broken[broken.length - 1] = 0xff;
  assert.equal(WebAssembly.validate(broken), false, `corrupted ${name} probe`);
}
const none = wasmFeatures(() => false);
assert.ok(Object.values(none).every(v => v === false));
assert.match(blockingProblem({ checks: featureChecks(none, true) }), /Memory64|threads/);
assert.equal(blockingProblem({ checks: featureChecks(features, true) }), null);
assert.equal(featureChecks(features, false).find(c => c.id === 'threads').status, 'warn');

// Preflight in a browser without isolation, WebGPU or storage.
const bare = await runPreflight({
  WebAssembly, isSecureContext: true, crossOriginIsolated: false,
  navigator: { hardwareConcurrency: 2, serviceWorker: { controller: null } },
});
const byId = Object.fromEntries(bare.checks.map(c => [c.id, c]));
assert.equal(byId.isolation.status, 'fail');
assert.match(byId.isolation.help, /coi-serviceworker/);
assert.equal(byId.webgpu.status, 'fail');
assert.match(byId.webgpu.help, /WebGL/);
assert.equal(byId.cpu.status, 'warn');
assert.equal(byId.memory64.status, 'pass');
const insecure = await runPreflight({ WebAssembly, isSecureContext: false, navigator: {} });
assert.match(insecure.checks.find(c => c.id === 'isolation').help, /HTTPS/);

// Load results map onto the shared failure categories.
assert.equal(describeLoadResult(3).category, 'system-files');
assert.equal(describeLoadResult(7 + 13).category, 'system-files'); // missing prod.keys
assert.equal(describeLoadResult(7 + 33).category, 'boot'); // no RomFS
assert.equal(describeLoadResult(5).category, 'environment');

const firmware = classifyFailure({ stage: 'boot', detail: 'Boot failed', loadResult: 4,
  systemFiles: { prodKeys: true, titleKeys: true, firmwareCount: 0 } });
assert.equal(firmware.category, 'system-files');
assert.match(firmware.fix, /Firmware missing: import firmware in the System Files widget/);
assert.equal(firmware.widget, 'system-files');
const keys = classifyFailure({ stage: 'boot', detail: 'Boot failed', loadResult: 2,
  systemFiles: { prodKeys: false, firmwareCount: 100 } });
assert.equal(keys.category, 'system-files');
assert.match(keys.fix, /prod\.keys missing/);

const abort = classifyFailure({ stage: 'running', category: 'crash', detail: 'runtime aborted: Aborted(RuntimeError: unreachable)' });
assert.equal(abort.origin, 'engine');
assert.equal(classifyFailure({ stage: 'running', detail: 'no frames for 46 s' }).category, 'hang');
assert.equal(classifyFailure({ stage: 'init', detail: new TypeError('x is not a function') }).category, 'init');
assert.equal(classifyFailure({ stage: 'init', detail: new TypeError('x is not a function') }).origin, 'frontend');
assert.equal(classifyFailure({ stage: 'init', detail: 'failed to load runtime/eden.wasm: 404' }).category, 'artifact');
const gpu = classifyFailure({ stage: 'boot', detail: 'WebGPU is unavailable' });
assert.equal(gpu.category, 'environment');
assert.equal(gpu.origin, 'environment');
for (const stage of ['preflight', 'init', 'copy', 'boot', 'running']) {
  assert.ok(FAILURE_CATEGORIES.includes(classifyFailure({ stage, detail: 'something' }).category));
}

const trap = new WebAssembly.RuntimeError('memory access out of bounds');
assert.equal(errorOrigin(trap), 'engine');
const uiError = new Error('Cannot read properties of null');
uiError.stack = 'Error: Cannot read properties of null\n    at handleFile (http://127.0.0.1:8080/app.js:540:12)';
assert.equal(errorOrigin(uiError), 'frontend');
const engineStack = new Error('oops');
engineStack.stack = 'Error: oops\n    at http://127.0.0.1:8080/runtime/eden.js:1:2';
assert.equal(errorOrigin(engineStack), 'engine');

// Redaction: paths lose their directories, keys and long hex strings disappear, URLs stay.
const KEY = '0123456789abcdef0123456789ABCDEF';
const leaky = [
  'Loading /home/x/game.nsp now',
  `header_key = ${KEY}${KEY}`,
  `title key ${KEY}`,
  'C:\\Users\\me\\Games\\zelda.xci failed',
  'assert in /home/x/eden_emscripten/src/video_core/format_lookup_table.cpp:42',
  'see http://127.0.0.1:8080/runtime/eden.js:1:2',
  'title 0100000000010000 v65536',
].join('\n');
const clean = redactText(leaky);
for (const secret of ['/home/x', 'Users\\me', KEY, KEY.toLowerCase(), 'eden_emscripten/src']) {
  assert.ok(!clean.includes(secret), `redacted ${secret}: ${clean}`);
}
assert.match(clean, /…\/game\.nsp/);
assert.match(clean, /…\/zelda\.xci/);
assert.match(clean, /header_key = <redacted>/);
assert.match(clean, /http:\/\/127\.0\.0\.1:8080\/runtime\/eden\.js/);
assert.match(clean, /0100000000010000/, 'title IDs are kept');

const sha = 'a'.repeat(64);
const bundle = buildBundle({
  environment: { userAgent: 'Test', hardwareConcurrency: 8, crossOriginIsolated: true },
  runtime: { files: { 'eden.wasm': { size: 10, sha256: sha } } },
  engine: { apiVersion: 1n, buildInfo: { path: '/home/x/eden', flags: '-sMEMORY64=1' } },
  core: { id: 'jit', name: 'Wasm JIT' },
  gameFile: '/home/x/Switch Games/game.nsp',
  launch: { stage: 'failed', failure: firmware },
  systemFiles: { prodKeys: true, titleKeys: false, firmwareCount: 0, firmwareSource: '/home/x/fw.zip' },
  errors: [{ message: 'failed at /home/x/web/app.js', origin: 'frontend' }],
  log: ['Booting /roms/game.nsp', `prod key ${KEY}`],
  keys: 'header_key = 00',
  romData: new Uint8Array([1, 2, 3]),
});
const text = JSON.stringify(bundle);
for (const secret of ['/home/x', KEY, 'fw.zip', 'romData', 'header_key = 00', 'Switch Games']) {
  assert.ok(!text.includes(secret), `bundle leaks ${secret}`);
}
assert.deepEqual(bundle.game, { file: 'game.nsp' });
assert.equal(bundle.runtime.files['eden.wasm'].sha256, sha, 'artifact checksums are kept');
assert.equal(bundle.engine.apiVersion, 1);
assert.deepEqual(bundle.systemFiles, { prodKeys: true, titleKeys: false, firmwareCount: 0 });
const titled = buildBundle({ engine: { gameInfo: { titleId: '0100000000010000', version: 65536, name: 'Game' } }, gameFile: 'x.nsp' });
assert.equal(titled.game.titleId, '0100000000010000');
assert.equal(titled.game.file, undefined);

const summary = summaryText(bundle);
assert.match(summary, /Scenario:/);
assert.match(summary, /Expected:/);
assert.match(summary, /Actual:/);
assert.match(summary, /system-files/);
assert.ok(!summary.includes('/home/x'));

// Engine introspection: optional exports, BigInt pointers from the Memory64 module.
assert.equal(readEngineInfo(null), null);
const strings = { 16: '{"commit":"abc","emscripten":"4.0"}' };
const engine = readEngineInfo({
  _eden_get_api_version: () => 2,
  _eden_get_build_info: () => 16n,
  _eden_get_state: () => 2,
  UTF8ToString: ptr => strings[ptr],
});
assert.equal(engine.apiVersion, 2);
assert.deepEqual(engine.buildInfo, { commit: 'abc', emscripten: '4.0' });
assert.equal(engine.capabilities, undefined);
assert.equal(engine.status.state, 2);
assert.equal(readEngineInfo({ _eden_get_state: () => 0 }).buildInfo, undefined);

console.log('diagnostics OK');
