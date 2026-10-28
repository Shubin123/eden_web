// SPDX-License-Identifier: GPL-3.0-or-later
// Diagnostics widget: checks the browser before the runtime starts, shows which build is running,
// follows a launch through its stages and explains a failure, and packs everything a bug report
// needs into a bundle. The bundle never holds keys, firmware, game data, saves or file paths.

import { activeCore, runtimeBase } from './cores.js';
import { FAILURE_CATEGORIES } from './results.js';

export const BUNDLE_SCHEMA = 'eden-web/diagnostics@1';

// ── WebAssembly feature probes ─────────────────────────────────────────
// Tiny modules that only validate when the browser supports the feature the engine is built with
// (-sMEMORY64=1 -pthread -msimd128 -fwasm-exceptions, which emits the legacy try/catch encoding).

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const section = (id, ...body) => [id, body.length, ...body];
const wasmModule = (...sections) => new Uint8Array([...HEADER, ...sections.flat()]);
// One function of type [] -> [] with the given body.
const voidFunction = code => [
  section(0x01, 1, 0x60, 0, 0),
  section(0x03, 1, 0),
  section(0x0a, 1, code.length + 1, 0, ...code),
];

export const WASM_PROBES = {
  // memory i64 min 1
  memory64: wasmModule(section(0x05, 1, 0x04, 1)),
  // memory shared min 1 max 1
  threads: wasmModule(section(0x05, 1, 0x03, 1, 1)),
  // memory i64 shared min 1 max 1, which is what the engine actually declares
  memory64Shared: wasmModule(section(0x05, 1, 0x07, 1, 1)),
  // func [] -> [v128]: i32.const 0; i8x16.splat
  simd: wasmModule(section(0x01, 1, 0x60, 0, 1, 0x7b), section(0x03, 1, 0),
    section(0x0a, 1, 6, 0, 0x41, 0, 0xfd, 0x0f, 0x0b)),
  // try; catch_all; end
  exceptions: wasmModule(...voidFunction([0x06, 0x40, 0x19, 0x0b, 0x0b])),
  // try_table with no catches; end
  exnref: wasmModule(...voidFunction([0x1f, 0x40, 0x00, 0x0b, 0x0b])),
};

export function wasmFeatures(validate = bytes => WebAssembly.validate(bytes)) {
  const features = {};
  for (const [name, bytes] of Object.entries(WASM_PROBES)) {
    try {
      features[name] = validate(bytes) === true;
    } catch {
      features[name] = false;
    }
  }
  return features;
}

// ── Preflight ──────────────────────────────────────────────────────────

const REQUIRED = new Set(['isolation', 'threads', 'memory64', 'simd', 'exceptions', 'webgpu']);
// Missing before the runtime starts means it cannot start at all.
const BLOCKING = new Set(['wasm', 'threads', 'memory64', 'simd', 'exceptions']);

const GPU_LIMITS = ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize',
  'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupStorageSize', 'maxBindGroups'];

const UPDATE_BROWSER = 'Use a current Chrome or Edge (133 or newer) or Firefox (134 or newer).';

function isolationHelp(env) {
  const nav = env.navigator ?? {};
  if (!env.isSecureContext) {
    return 'Open the page over HTTPS or from http://localhost. Cross-origin isolation, service workers and WebGPU only work in a secure context.';
  }
  if (!nav.serviceWorker) {
    return 'The server does not send the Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp headers, and this browser cannot run the coi-serviceworker fallback that adds them (service workers are off, as in some private windows). Use a normal window, `npm start` locally, or a host that sends the headers.';
  }
  if (nav.serviceWorker.controller) {
    return 'The coi-serviceworker fallback is installed but the page is still not isolated. Reload once; if that does not help, do a hard reload (Ctrl+Shift+R) and check that no extension blocks service workers.';
  }
  return 'The server does not send the COOP/COEP headers that enable SharedArrayBuffer, so the coi-serviceworker fallback is installing and reloads the page once. If the page does not reload by itself, reload it.';
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms))]);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function gpuCheck(env) {
  const nav = env.navigator ?? {};
  if (!env.isSecureContext) {
    return { status: 'fail', value: 'Needs a secure context', help: 'WebGPU only works over HTTPS or on localhost.' };
  }
  if (!nav.gpu) {
    return {
      status: 'fail', value: 'navigator.gpu missing',
      help: 'This browser has no WebGPU, and the engine has no WebGL fallback. Use Chrome or Edge 113 or newer; on Linux enable chrome://flags/#enable-unsafe-webgpu and Vulkan if WebGPU is still off.',
    };
  }
  let adapter;
  try {
    adapter = await withTimeout(nav.gpu.requestAdapter({ powerPreference: 'high-performance' }), 8000, 'The GPU');
  } catch (err) {
    return { status: 'fail', value: 'Adapter request failed', help: `${err.message}. Check chrome://gpu and that graphics acceleration is on.` };
  }
  if (!adapter) {
    return {
      status: 'fail', value: 'No adapter',
      help: 'The browser offers WebGPU but returned no GPU adapter: hardware acceleration is off or the GPU/driver is blocklisted. Turn on "Use graphics acceleration when available" and check chrome://gpu.',
    };
  }
  const info = adapter.info ?? {};
  const gpu = {
    vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '',
    description: info.description || '', fallback: Boolean(adapter.isFallbackAdapter ?? info.isFallbackAdapter),
    limits: {}, features: [...(adapter.features ?? [])].sort(),
  };
  for (const name of GPU_LIMITS) gpu.limits[name] = adapter.limits?.[name];
  const name = [gpu.vendor, gpu.architecture || gpu.device].filter(Boolean).join(' ') || gpu.description || 'Available';
  const limits = `textures up to ${gpu.limits.maxTextureDimension2D}px, buffers up to ${formatBytes(gpu.limits.maxBufferSize)}, storage bindings up to ${formatBytes(gpu.limits.maxStorageBufferBindingSize)}`;
  if (gpu.fallback) {
    return { status: 'warn', value: `${name} (software)`, help: `This is a software adapter, so games will be very slow. Enable hardware acceleration. ${limits}.`, gpu };
  }
  return { status: 'pass', value: name, help: `${limits}; ${gpu.features.length} optional features.`, gpu };
}

/// Checks for the WebAssembly features the engine is built with.
export function featureChecks(features, sharedArrayBuffer) {
  const checks = [];
  const add = (id, label, status, value, help = '') => checks.push({ id, label, status, required: true, value, help });
  if (!features.threads) {
    add('threads', 'WebAssembly threads', 'fail', 'Unsupported', `Shared WebAssembly memory is unavailable. ${UPDATE_BROWSER}`);
  } else if (!sharedArrayBuffer) {
    add('threads', 'WebAssembly threads', 'warn', 'Blocked', 'Supported, but blocked until cross-origin isolation is active (see above).');
  } else {
    add('threads', 'WebAssembly threads', 'pass', 'Supported');
  }
  if (!features.memory64) {
    add('memory64', 'Memory64', 'fail', 'Unsupported', `The engine uses 64-bit WebAssembly memory, which this browser cannot run. ${UPDATE_BROWSER}`);
  } else if (!features.memory64Shared) {
    add('memory64', 'Memory64', 'fail', 'Not shared', `This browser has 64-bit memory but cannot share it between threads. ${UPDATE_BROWSER}`);
  } else {
    add('memory64', 'Memory64', 'pass', 'Supported (shared)');
  }
  add('simd', 'WebAssembly SIMD', features.simd ? 'pass' : 'fail', features.simd ? 'Supported' : 'Unsupported',
    features.simd ? '' : `128-bit SIMD is missing. ${UPDATE_BROWSER} Some hardened browser modes turn it off.`);
  add('exceptions', 'Exception handling', features.exceptions ? 'pass' : 'fail',
    features.exceptions ? `Supported${features.exnref ? ' (also exnref)' : ''}` : 'Unsupported',
    features.exceptions ? '' : `The engine is built with WebAssembly exception handling (try/catch). ${UPDATE_BROWSER}`);
  return checks;
}

/// Checks everything the runtime needs from the browser. `env` is the global object; tests pass a
/// stand-in. Each check is { id, label, status: pass | warn | fail | info, required, value, help }.
export async function runPreflight(env = globalThis) {
  const checks = [];
  const add = (id, label, status, value, help = '', extra = {}) =>
    checks.push({ id, label, status, required: REQUIRED.has(id), value, help, ...extra });
  const nav = env.navigator ?? {};

  if (typeof env.WebAssembly?.validate !== 'function') {
    add('wasm', 'WebAssembly', 'fail', 'Unavailable',
      'WebAssembly is disabled or missing. Turn off settings that disable JavaScript optimizations for this site (such as Edge\'s enhanced security or Lockdown Mode).');
  }
  const features = env.WebAssembly ? wasmFeatures(bytes => env.WebAssembly.validate(bytes)) : {};

  const isolated = env.crossOriginIsolated === true;
  const sab = typeof env.SharedArrayBuffer === 'function';
  if (isolated && sab) add('isolation', 'Cross-origin isolation', 'pass', 'Active, SharedArrayBuffer available');
  else add('isolation', 'Cross-origin isolation', 'fail', isolated ? 'SharedArrayBuffer missing' : 'Not active', isolationHelp(env));
  checks.push(...featureChecks(features, sab));

  const gpu = await gpuCheck(env);
  add('webgpu', 'WebGPU', gpu.status, gpu.value, gpu.help, gpu.gpu ? { gpu: gpu.gpu } : {});

  const threads = nav.hardwareConcurrency;
  if (!threads) add('cpu', 'CPU threads', 'info', 'Not reported');
  else add('cpu', 'CPU threads', threads >= 4 ? 'pass' : 'warn', `${threads}`,
    threads >= 4 ? '' : 'The engine runs the guest CPU, GPU and services on separate threads; fewer than 4 makes games slow.');

  const memory = nav.deviceMemory;
  if (!memory) add('memory', 'Device memory', 'info', 'Not reported', 'Only Chromium browsers report this.');
  else add('memory', 'Device memory', memory >= 8 ? 'pass' : 'warn', `${memory} GB${memory >= 8 ? ' or more' : ''}`,
    memory >= 8 ? '' : 'Games need several GB of memory; close other tabs and apps if loading fails.');

  try {
    const { quota, usage } = await nav.storage.estimate();
    const free = quota - usage;
    add('storage', 'Storage', free >= 2 * 1024 ** 3 ? 'pass' : 'warn', `${formatBytes(usage)} used of ${formatBytes(quota)}`,
      free >= 2 * 1024 ** 3 ? '' : 'Under 2 GB left for this site; firmware and crash-restart copies of games may not fit. Free disk space or leave private browsing.',
      { quota, usage });
  } catch {
    add('storage', 'Storage', 'warn', 'Unavailable', 'Storage is blocked, so keys, firmware and saves cannot be kept. Allow site data for this page.');
  }
  try {
    const persisted = await nav.storage.persisted();
    add('persisted', 'Persistent storage', persisted ? 'pass' : 'info', persisted ? 'Granted' : 'Not granted',
      persisted ? '' : 'The browser may clear stored keys, firmware and saves when disk space runs low. Press "Keep storage" to ask it not to.',
      { persisted });
  } catch {
    add('persisted', 'Persistent storage', 'info', 'Unknown');
  }

  if (typeof nav.getGamepads === 'function') {
    let connected = 0;
    try {
      connected = [...nav.getGamepads()].filter(Boolean).length;
    } catch {}
    add('gamepad', 'Gamepad API', 'pass', `${connected} connected`, connected ? '' : 'Press a button on a controller for the browser to show it.');
  } else {
    add('gamepad', 'Gamepad API', 'info', 'Unavailable', 'Keyboard and touch controls still work.');
  }

  return { ranAt: new Date().toISOString(), features, checks };
}

/// The first check that keeps the runtime from starting at all, as a message, or null.
export function blockingProblem(preflight) {
  const failed = preflight?.checks.find(c => BLOCKING.has(c.id) && c.status === 'fail');
  return failed ? `This browser cannot run the engine: ${failed.label} ${failed.value.toLowerCase()}. ${failed.help}` : null;
}

// ── Launch failures ────────────────────────────────────────────────────

export const LAUNCH_STAGES = {
  preflight: 'Checking browser',
  init: 'Starting runtime',
  ready: 'Ready, load a game',
  'system-files': 'Mounting keys & firmware',
  copy: 'Reading game',
  boot: 'Booting game',
  running: 'Running',
  failed: 'Failed',
};

// Core::SystemResultStatus, with loader errors as 7 + Loader::ResultStatus.
const LOAD_RESULTS = ['Success', 'core not initialized', 'no loader for this file', 'system files missing',
  'shared font missing', 'video core failed', 'unknown error'];
// Loader::ResultStatus values that mean keys or firmware are missing or wrong.
const LOADER_ERRORS = {
  13: 'prod.keys missing', 14: 'header key missing', 15: 'header key incorrect', 18: 'title key missing',
  21: 'key area key missing', 22: 'key area key incorrect', 23: 'title key or KEK incorrect', 29: 'empty file',
  33: 'no RomFS', 52: 'no program NCA in the NSP',
};
const KEY_LOADER_ERRORS = new Set([13, 14, 15, 18, 19, 21, 22, 23, 46, 47, 48, 49, 50, 51]);

export function describeLoadResult(code) {
  if (!Number.isInteger(code) || code < 0) return { category: 'boot', text: `load result ${code}` };
  if (code < LOAD_RESULTS.length) {
    const category = code === 1 ? 'init' : code === 3 || code === 4 ? 'system-files' : code === 5 ? 'environment' : 'boot';
    return { category, text: `${LOAD_RESULTS[code]} (load result ${code})` };
  }
  const loader = code - 7;
  return {
    category: KEY_LOADER_ERRORS.has(loader) ? 'system-files' : 'boot',
    text: `${LOADER_ERRORS[loader] ?? `loader error ${loader}`} (load result ${code})`,
  };
}

const ENGINE_ERROR = /Aborted\(|RuntimeError|unreachable|memory access out of bounds|wasm-function|worker sent an error|Core\.ARM <Critical>|WebGPU device lost|eden_boot/;

/// Where an error came from: the engine (wasm abort, trap, engine log), the frontend (an exception
/// in web/*.js) or the environment (what the browser lacks).
export function errorOrigin(error, category) {
  if (category === 'environment') return 'environment';
  const name = error?.name ?? '';
  const text = `${name} ${error?.message ?? error ?? ''} ${error?.stack ?? ''}`;
  if (/^(RuntimeError|CompileError|LinkError)$/.test(name) || ENGINE_ERROR.test(text) || /\/runtime\/eden/.test(text)) {
    return 'engine';
  }
  return 'frontend';
}

const FIXES = {
  environment: 'This browser or device is missing something the engine needs; see the browser check above.',
  artifact: 'The runtime files are missing or did not download completely. Locally, build the engine and run `npm run sync`; online, do a hard reload (Ctrl+Shift+R).',
  init: 'The runtime failed to start. Close other heavy tabs and reload; if it keeps failing, download the diagnostic bundle and report it.',
  'system-files': 'Keys or firmware are missing or do not match the game: add prod.keys (and title.keys) and firmware in the System Files widget, then reload.',
  boot: 'The game failed to load. Check that the dump is complete and is an .nsp, .xci or .nro the keys can decrypt.',
  crash: 'The game crashed inside the engine. Try the IR interpreter core in the Emulation widget; Crash recovery restarts from the last save point.',
  hang: 'The game stopped drawing frames. Try the IR interpreter core in the Emulation widget and report the bundle.',
  'no-frames': 'The game runs but has not drawn a frame, which usually means a renderer problem. Check the log for WebGPU errors.',
  performance: 'The game runs below full speed. Close other tabs and check the Performance widget.',
};

const SWITCH2_FIX = 'This is a Nintendo Switch 2 game. Eden Web runs Nintendo Switch games; Switch 2 games are not supported yet.';

/// Picks the failure category, origin and fix for a launch failure.
/// event: { stage, category?, detail (string or Error), loadResult?, systemFiles?, preflight?, switch2? }
export function classifyFailure(event) {
  const detail = event.detail instanceof Error ? event.detail.message : String(event.detail ?? '');
  let category = event.category ?? null;
  let text = detail;
  let widget = null;
  let fix = null;

  if (!category && Number.isInteger(event.loadResult) && event.loadResult !== 0) {
    const load = describeLoadResult(event.loadResult);
    category = load.category;
    text = detail ? `${detail}: ${load.text}` : load.text;
  }
  if (!category) {
    if (/WebGPU|GPU adapter|no WebGL|requestAdapter/i.test(detail)) category = 'environment';
    else if (/\b404\b|not found|Failed to fetch|magic word|expected magic|NetworkError|npm run sync/i.test(detail)) category = 'artifact';
    else if (/prod\.keys|title\.keys|missing.*keys?|keys? .*missing|firmware/i.test(detail)) category = 'system-files';
    else if (/no frames for/.test(detail)) category = 'hang';
    else if (event.stage === 'init' || event.stage === 'preflight') category = 'init';
    else if (event.stage === 'running') category = 'crash';
    else category = 'boot';
  }
  if (!FAILURE_CATEGORIES.includes(category)) category = 'boot';

  const files = event.systemFiles;
  if (category === 'system-files' || (category === 'boot' && files && !files.prodKeys)) {
    category = 'system-files';
    widget = 'system-files';
    if (files && !files.prodKeys) fix = 'prod.keys missing: add your keys in the System Files widget, then reload.';
    else if (files && !files.firmwareCount) fix = 'Firmware missing: import firmware in the System Files widget, then reload.';
  }
  if (category === 'environment') {
    const failed = event.preflight?.checks.filter(c => c.required && c.status === 'fail') ?? [];
    if (failed.length) fix = failed.map(c => `${c.label}: ${c.help}`).join(' ');
    else if (/GPU/i.test(detail)) fix = 'WebGPU failed to start. Turn on graphics acceleration in the browser settings and check chrome://gpu; this engine has no WebGL fallback.';
  }
  if (category === 'crash' || category === 'hang') widget = 'emulation';
  // The engine read the game's control data and found a Switch 2 title: that, not the dump or
  // the setup, is why it fails.
  if (event.switch2 && category !== 'environment' && category !== 'artifact') {
    text = text ? `Nintendo Switch 2 game: ${text}` : 'Nintendo Switch 2 game';
    fix = SWITCH2_FIX;
    widget = null;
  }
  let origin = errorOrigin(event.detail, category);
  if (category === 'system-files') origin = 'setup';
  else if (['crash', 'hang', 'no-frames'].includes(category) || Number.isInteger(event.loadResult)) origin = 'engine';
  return {
    category,
    origin,
    stage: event.stage ?? null,
    detail: text,
    fix: fix ?? FIXES[category],
    widget,
  };
}

// ── Redaction ──────────────────────────────────────────────────────────

const KEY_LINE = /\b([A-Za-z0-9_]*key[A-Za-z0-9_]*)\s*[=:]\s*[0-9A-Fa-f]{16,}/gi;
const LONG_HEX = /\b[0-9A-Fa-f]{32,}\b/g;
// An absolute path with at least one directory; URLs are left alone, since `//host/` follows a colon.
const PATH = /(^|[\s"'`(=,;[<{])((?:~|[A-Za-z]:)?[\\/](?:[^\s"'`()\\/<>|,;]+[\\/])+)([^\s"'`()\\/<>|,;]*)/g;

/// Strips anything secret or identifying from free text: key values, long hex strings, and the
/// directories of absolute paths (the file name stays).
export function redactText(text) {
  return String(text)
    .replace(KEY_LINE, '$1 = <redacted>')
    .replace(LONG_HEX, '<redacted hex>')
    .replace(PATH, (_, before, _dir, base) => `${before}…/${base}`);
}

// Values under these keys never go in a bundle.
const DROPPED_KEYS = new Set(['path', 'fullPath', 'filePath', 'firmwareSource', 'romData', 'data', 'keys',
  'prodKeysText', 'titleKeysText', 'saves', 'saveData']);
// Values under these keys are checksums of public build artifacts, which look like keys but are not.
const HEX_KEYS = new Set(['sha256']);

export function redactValue(value, key = '') {
  if (DROPPED_KEYS.has(key)) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return HEX_KEYS.has(key) ? value : redactText(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof Blob === 'function' && value instanceof Blob)) {
    return undefined;
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item)).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const redacted = redactValue(v, k);
      if (redacted !== undefined) out[k] = redacted;
    }
    return out;
  }
  return undefined;
}

export const baseName = name => String(name ?? '').split(/[\\/]/).pop();

/// The game as a bundle may name it: title ID and version from the engine, else the file name only.
export function gameIdentity(engineGame, fileName) {
  if (engineGame && typeof engineGame === 'object' && engineGame.titleId) {
    const { titleId, version, displayVersion, name } = engineGame;
    return { titleId, version, displayVersion, name };
  }
  return fileName ? { file: baseName(fileName) } : null;
}

/// Assembles and redacts a diagnostic bundle from what the page knows.
export function buildBundle(parts) {
  return redactValue({
    schema: BUNDLE_SCHEMA,
    createdAt: parts.createdAt ?? new Date().toISOString(),
    environment: parts.environment ?? null,
    preflight: parts.preflight ?? null,
    version: parts.version ?? null,
    runtime: parts.runtime ?? null,
    engine: parts.engine ?? null,
    core: parts.core ?? null,
    game: gameIdentity(parts.engine?.gameInfo, parts.gameFile),
    launch: parts.launch ?? null,
    errors: parts.errors ?? [],
    systemFiles: parts.systemFiles ? {
      prodKeys: Boolean(parts.systemFiles.prodKeys),
      titleKeys: Boolean(parts.systemFiles.titleKeys),
      firmwareCount: parts.systemFiles.firmwareCount ?? 0,
    } : null,
    crashReports: parts.crashReports ?? 0,
    layout: parts.layout ?? null,
    settings: parts.settings ?? null,
    log: (parts.log ?? []).slice(-200),
  });
}

/// A short plain-text issue report from a bundle, with blanks for the user to fill in.
export function summaryText(bundle) {
  const env = bundle.environment ?? {};
  const failed = (bundle.preflight?.checks ?? []).filter(c => c.required && c.status === 'fail').map(c => c.label);
  const gpu = bundle.preflight?.checks.find(c => c.id === 'webgpu')?.value ?? 'unknown';
  const game = bundle.game?.titleId
    ? `${bundle.game.name ?? ''} ${bundle.game.titleId} v${bundle.game.displayVersion ?? bundle.game.version ?? '?'}`.trim()
    : bundle.game?.file ?? 'none';
  const launch = bundle.launch ?? {};
  const failure = launch.failure
    ? `${launch.failure.category} (${launch.failure.origin}): ${launch.failure.detail}`
    : 'none';
  const v = bundle.version ?? {};
  return [
    'Eden Web issue report',
    `Environment: ${env.userAgent ?? 'unknown browser'}`,
    `Hardware: ${env.hardwareConcurrency ?? '?'} threads, ${env.deviceMemoryGB ? `${env.deviceMemoryGB} GB` : '? GB'}, GPU ${gpu}, isolated: ${env.crossOriginIsolated ? 'yes' : 'no'}`,
    `Browser check: ${failed.length ? `missing ${failed.join(', ')}` : 'all requirements met'}`,
    `Build: web ${v.version ?? '?'} (${v.webRevision ?? '?'}), engine ${v.engineRevision ?? bundle.runtime?.engineRevision ?? '?'} (${v.build ?? bundle.runtime?.build ?? '?'}), core ${bundle.core?.name ?? '?'}`,
    `Game: ${game}`,
    `Launch stage: ${LAUNCH_STAGES[launch.stage] ?? launch.stage ?? 'unknown'}; failure: ${failure}`,
    `Crash reports stored: ${bundle.crashReports ?? 0}`,
    '',
    'Scenario: <what you did, e.g. loaded the game and pressed A at the title screen>',
    'Expected: <what should have happened>',
    'Actual: <what happened instead>',
  ].join('\n');
}

// ── Engine introspection ───────────────────────────────────────────────

// Calls an optional engine export that returns a C string. The module uses Memory64, so the
// pointer may arrive as a BigInt.
function engineString(Module, name) {
  const fn = Module?.[`_${name}`];
  if (typeof fn !== 'function') return undefined;
  try {
    let text;
    if (typeof Module.UTF8ToString === 'function') {
      const ptr = Number(fn());
      if (!ptr) return null;
      text = Module.UTF8ToString(ptr);
    } else {
      text = Module.ccall(name, 'string', [], []);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    return { error: err.message };
  }
}

/// What the engine says about itself; every export is optional.
export function readEngineInfo(Module) {
  if (!Module) return null;
  const info = {};
  if (typeof Module._eden_get_api_version === 'function') {
    try {
      info.apiVersion = Number(Module._eden_get_api_version());
    } catch {}
  }
  for (const [key, name] of [['buildInfo', 'eden_get_build_info'], ['capabilities', 'eden_get_capabilities'],
    ['runtimeStats', 'eden_get_runtime_stats'], ['gameInfo', 'eden_get_game_info']]) {
    const value = engineString(Module, name);
    if (value !== undefined) info[key] = value;
  }
  const number = name => {
    try {
      return typeof Module[name] === 'function' ? Number(Module[name]()) : undefined;
    } catch {
      return undefined;
    }
  };
  info.status = {
    state: number('_eden_get_state'),
    loadResult: number('_eden_get_load_result'),
    switch2: number('_eden_is_switch2_title'),
    gameFps: number('_eden_get_game_fps'),
    systemFps: number('_eden_get_system_fps'),
    frametimeMs: number('_eden_get_frametime'),
    speed: number('_eden_get_emulation_speed'),
  };
  return info;
}

// ── Widget ─────────────────────────────────────────────────────────────

const MARKS = { pass: '✓', fail: '✗', warn: '!', info: '•' };
const ORIGINS = { engine: 'engine error', frontend: 'frontend error', environment: 'environment', setup: 'setup' };
const NO_FRAMES_MS = 90_000;

const fetchJson = url => fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function layoutSummary() {
  const state = globalThis.EdenLayout?.getState?.() ?? readStorage('eden-layout');
  if (!state?.widgets) return null;
  const ids = Object.keys(state.widgets);
  return {
    widgetWidth: state.widgetWidth,
    gap: state.gap,
    beside: state.beside,
    hidden: ids.filter(id => state.widgets[id].hidden),
    collapsed: ids.filter(id => state.widgets[id].collapsed),
  };
}

function settingsSummary() {
  let autoRestart = null;
  let core = null;
  try {
    autoRestart = localStorage.getItem('eden-auto-restart') !== 'off';
    core = localStorage.getItem('eden-cpu-core');
  } catch {}
  return { display: readStorage('eden-settings'), storedCore: core, autoRestart };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statRow(label, value, className = '') {
  const row = el('div', 'stat-row');
  row.append(el('span', 'label', label), el('span', `value ${className}`.trim(), value));
  return row;
}

/// Sets up the Diagnostics widget and starts the browser check.
/// options: { getModule, getLog, getCore, getGameFile, listCrashes, getSystemFileStatus }
export function setupDiagnostics(options) {
  const $ = id => document.getElementById(id);
  const stageEl = $('diag-stage');
  const failureEl = $('diag-failure');
  const checksEl = $('diag-checks');
  const buildEl = $('diag-build');
  const errorsEl = $('diag-errors');
  const persistBtn = $('btn-diag-persist');

  const launch = { stage: 'preflight', detail: '', failure: null, history: [] };
  const errors = [];
  let version = null;
  let runtime = null;
  let preflight = null;

  // The WebAssembly features are known right away, so a missing one can stop the runtime from
  // starting before the slower checks (GPU, storage) finish.
  const quick = { checks: featureChecks(wasmFeatures(), typeof SharedArrayBuffer === 'function') };

  function renderStage() {
    stageEl.textContent = LAUNCH_STAGES[launch.stage] ?? launch.stage;
    stageEl.classList.toggle('missing', launch.stage === 'failed');
    stageEl.classList.toggle('highlight', launch.stage === 'running' || launch.stage === 'ready');
    stageEl.title = launch.detail;
    const f = launch.failure;
    failureEl.hidden = !f;
    if (!f) return;
    const title = el('strong', '', `${f.category}: ${f.detail}`);
    const fix = el('p', 'mode-help', f.fix);
    failureEl.replaceChildren(title);
    if (f.origin !== f.category) failureEl.append(' ', el('span', 'diag-origin', `(${ORIGINS[f.origin] ?? f.origin})`));
    failureEl.append(fix);
    if (f.widget && globalThis.EdenLayout?.reveal) {
      const open = el('button', 'btn btn-secondary diag-open', `Open ${f.widget === 'system-files' ? 'System Files' : 'Emulation core'} →`);
      open.type = 'button';
      open.addEventListener('click', () => globalThis.EdenLayout.reveal(f.widget));
      failureEl.append(open);
    }
  }

  function renderChecks() {
    if (!preflight) return;
    checksEl.replaceChildren(...preflight.checks.map(check => {
      const li = el('li', `diag-check is-${check.status}`);
      li.append(el('span', 'diag-mark', MARKS[check.status]), el('span', 'diag-label', check.label),
        el('span', 'diag-value', check.value));
      if (check.help) li.append(el('div', 'mode-help diag-help', check.help));
      return li;
    }));
    const persisted = preflight.checks.find(c => c.id === 'persisted');
    persistBtn.hidden = !(persisted && persisted.persisted === false && navigator.storage?.persist);
  }

  function renderBuild() {
    const rows = [];
    if (version) {
      rows.push(statRow('Frontend', `${version.version} · ${version.webRevision}${version.local ? ' · local' : ''}`));
      rows.push(statRow('Engine', `${version.engineRevision} · ${version.build ?? '?'}`));
    } else {
      rows.push(statRow('Version', 'version.json missing', 'missing'));
    }
    if (runtime?.files) {
      for (const [name, file] of Object.entries(runtime.files).filter(([n]) => n.endsWith('.wasm'))) {
        const value = file.missing ? 'not served' : `${formatBytes(file.size)} · ${file.sha256.slice(0, 10)}`;
        const row = statRow(name, value, file.mismatch || file.missing ? 'missing' : '');
        row.title = file.mismatch ? `Served file is ${formatBytes(file.served)}; reload to fetch a matching set.` : `sha256 ${file.sha256}`;
        rows.push(row);
      }
    } else {
      rows.push(statRow('Runtime', 'no runtime.json', 'missing'));
    }
    const engine = readEngineInfo(options.getModule());
    if (!engine) {
      rows.push(statRow('Engine API', 'after the runtime starts'));
    } else if (engine.apiVersion === undefined && engine.buildInfo === undefined) {
      rows.push(statRow('Engine API', 'not exposed by this build'));
    } else {
      rows.push(statRow('Engine API', engine.apiVersion !== undefined ? `v${engine.apiVersion}` : '?'));
      const build = engine.buildInfo;
      if (build && typeof build === 'object' && !build.error) {
        for (const [key, value] of Object.entries(build).slice(0, 6)) {
          rows.push(statRow(key, typeof value === 'object' ? JSON.stringify(value) : String(value)));
        }
      } else if (build) {
        rows.push(statRow('Build', typeof build === 'string' ? build : build.error, build.error ? 'missing' : ''));
      }
    }
    const core = options.getCore?.();
    if (core) rows.push(statRow('Core', core.name));
    buildEl.replaceChildren(...rows);
  }

  function renderErrors() {
    const counts = { frontend: 0, engine: 0 };
    for (const e of errors) counts[e.origin] = (counts[e.origin] ?? 0) + 1;
    errorsEl.textContent = `${counts.frontend} frontend · ${counts.engine} engine`;
    errorsEl.classList.toggle('missing', errors.length > 0);
  }

  function stage(name, detail = '') {
    launch.stage = name;
    launch.detail = detail;
    launch.history.push({ stage: name, at: new Date().toISOString() });
    // A new launch, or frames arriving late, clears the previous failure.
    if (name === 'init' || name === 'system-files' || (name === 'running' && launch.failure?.category === 'no-frames')) {
      launch.failure = null;
    }
    renderStage();
    if (name === 'ready' || name === 'running') renderBuild();
  }

  async function fail(category, detail) {
    const failedStage = launch.stage === 'failed' ? launch.failure?.stage : launch.stage;
    launch.stage = 'failed';
    const systemFiles = await options.getSystemFileStatus?.().catch(() => null);
    const loadResult = options.getModule()?._eden_get_state?.() === 4
      ? Number(options.getModule()._eden_get_load_result()) : undefined;
    const switch2 = options.getModule()?._eden_is_switch2_title?.() === 1;
    launch.failure = classifyFailure({ stage: failedStage, category, detail, loadResult, systemFiles, preflight: preflight ?? quick, switch2 });
    launch.history.push({ stage: 'failed', at: new Date().toISOString(), category: launch.failure.category });
    renderStage();
  }

  // Engine state, polled: the boot result and first frame are only visible there.
  let bootSince = 0;
  setInterval(() => {
    const Module = options.getModule();
    if (!Module || !['boot', 'running'].includes(launch.stage)) return;
    let state;
    let fps;
    try {
      state = Module._eden_get_state();
      fps = Module._eden_get_game_fps();
    } catch {
      return;
    }
    if (state === 4) {
      fail(null, 'Boot failed');
    } else if (state === 2 && fps > 0 && launch.stage !== 'running') {
      stage('running');
    } else if (launch.stage === 'boot' && state === 2) {
      bootSince ||= Date.now();
      if (Date.now() - bootSince > NO_FRAMES_MS && !launch.failure) {
        launch.failure = classifyFailure({ stage: 'boot', category: 'no-frames', detail: `no frame after ${NO_FRAMES_MS / 1000} s` });
        renderStage();
      }
    }
  }, 1000);

  const recordError = (error, where) => {
    const origin = errorOrigin(error);
    errors.push({ time: new Date().toISOString(), origin, where, message: String(error?.message ?? error).slice(0, 500),
      stack: String(error?.stack ?? '').split('\n').slice(0, 6).join('\n') });
    if (errors.length > 50) errors.shift();
    renderErrors();
  };
  window.addEventListener('error', e => {
    // Layout's ResizeObservers can report this benign notice; it is not an error in the page.
    if (!e.error && /^ResizeObserver loop/.test(e.message)) return;
    recordError(e.error ?? `${e.message} at ${e.filename}:${e.lineno}`, 'error');
  });
  window.addEventListener('unhandledrejection', e => recordError(e.reason, 'unhandledrejection'));

  async function refreshBuild() {
    const base = runtimeBase(activeCore());
    [version, runtime] = await Promise.all([fetchJson('version.json'), fetchJson(`${base}runtime.json`)]);
    if (runtime?.files) {
      // A cached file from another build would not match the manifest.
      await Promise.all(Object.entries(runtime.files).map(async ([name, file]) => {
        const res = await fetch(`${base}${name}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
        const served = Number(res?.headers.get('content-length'));
        if (res && !res.ok) file.missing = true;
        if (served && served !== file.size) Object.assign(file, { mismatch: true, served });
      }));
    }
    renderBuild();
  }

  async function collect() {
    const crashes = await options.listCrashes?.().catch(() => []) ?? [];
    const systemFiles = await options.getSystemFileStatus?.().catch(() => null);
    const gpu = preflight?.checks.find(c => c.id === 'webgpu')?.gpu;
    return buildBundle({
      environment: {
        userAgent: navigator.userAgent,
        platform: navigator.userAgentData?.platform ?? navigator.platform,
        gpu: gpu ? { vendor: gpu.vendor, architecture: gpu.architecture, device: gpu.device, description: gpu.description } : null,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGB: navigator.deviceMemory,
        crossOriginIsolated: window.crossOriginIsolated,
        serviceWorkerIsolation: Boolean(navigator.serviceWorker?.controller),
        origin: location.origin,
        jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined,
      },
      preflight,
      version,
      runtime,
      engine: readEngineInfo(options.getModule()),
      core: options.getCore?.() ? { id: options.getCore().id, name: options.getCore().name } : null,
      gameFile: options.getGameFile?.(),
      launch,
      errors,
      systemFiles,
      crashReports: crashes.length,
      layout: layoutSummary(),
      settings: settingsSummary(),
      log: options.getLog?.() ?? [],
    });
  }

  $('btn-diag-bundle').addEventListener('click', async () => {
    const bundle = await collect();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    link.download = `eden-diagnostics-${bundle.createdAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  const summaryBtn = $('btn-diag-summary');
  summaryBtn.addEventListener('click', async () => {
    const text = summaryText(await collect());
    try {
      await navigator.clipboard.writeText(text);
      summaryBtn.textContent = 'Copied';
    } catch {
      // Clipboard access can be refused; show the text so it can be copied by hand.
      window.prompt('Copy this summary:', text);
    }
    setTimeout(() => { summaryBtn.textContent = 'Copy summary'; }, 1500);
  });
  persistBtn.addEventListener('click', async () => {
    await navigator.storage.persist().catch(() => false);
    preflight = await runPreflight();
    renderChecks();
  });

  renderStage();
  renderErrors();
  refreshBuild();
  const ready = runPreflight().then(result => {
    preflight = result;
    renderChecks();
    if (launch.stage === 'preflight') stage('init');
    return result;
  });

  return {
    stage,
    fail,
    ready,
    collect,
    /// A message when the runtime cannot start in this browser, else null.
    blockingProblem: () => blockingProblem(quick),
  };
}
