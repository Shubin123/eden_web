// SPDX-License-Identifier: GPL-3.0-or-later
// Frame-time sampler injected into the page before any of its scripts run (it is serialized, so it
// must not use anything from this module's scope). It records three streams, as [epochMs, ms] pairs:
//   raf     requestAnimationFrame intervals: how smoothly the page itself runs
//   present intervals between canvas updates seen through canvas.captureStream()
//   engine  game frame times from the runtime's eden_get_frame_times, when it exports one
// It also keeps the runtime module so the harness can feature-detect engine exports, without the
// frontend having to publish it.

export function installSampler() {
  const LIMIT = 200_000;
  const lab = window.__edenLab = { raf: [], present: [], presentOn: false, module: null, memory: null };
  const now = () => performance.timeOrigin + performance.now();
  const push = (list, at, ms) => list.length < LIMIT && list.push(at, ms);

  let lastRaf = 0;
  const tick = time => {
    const at = performance.timeOrigin + time;
    if (lastRaf) push(lab.raf, at, at - lastRaf);
    lastRaf = at;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // runtime/eden.js declares `var createEdenModule`; wrapping the factory catches the instance.
  let factory;
  Object.defineProperty(window, 'createEdenModule', {
    configurable: true,
    enumerable: true,
    get: () => factory,
    set(value) {
      factory = typeof value !== 'function' ? value : (options = {}) => {
        const printErr = options.printErr;
        const onAbort = options.onAbort;
        return Promise.resolve(value({
          ...options,
          printErr(text) {
            if (/worker sent an error|Aborted\(|RuntimeError|Core\.ARM <Critical>/.test(String(text))) lab.crashed = true;
            printErr?.(text);
          },
          onAbort(reason) { lab.crashed = true; onAbort?.(reason); },
        })).then(module => (lab.module = module));
      };
    },
  });
  // The shared Memory64 the runtime creates, for reading what engine exports write.
  const Memory = WebAssembly.Memory;
  const TrackedMemory = function (descriptor) {
    const memory = new Memory(descriptor);
    if (descriptor?.shared) lab.memory = memory;
    return memory;
  };
  TrackedMemory.prototype = Memory.prototype;
  WebAssembly.Memory = TrackedMemory;

  lab.startPresent = () => {
    if (lab.presentOn) return true;
    try {
      const track = document.getElementById('canvas').captureStream().getVideoTracks()[0];
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      lab.presentOn = true;
      (async () => {
        let previous = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const stamp = value.timestamp;
          value.close();
          if (previous !== null && stamp > previous) push(lab.present, now(), (stamp - previous) / 1000);
          previous = stamp;
        }
        lab.presentOn = false;
      })().catch(() => { lab.presentOn = false; });
      return true;
    } catch (err) {
      lab.presentError = err.message;
      return false;
    }
  };

  // Engine exports take and return pointers as BigInt in a Memory64 build unless Emscripten wraps
  // them, so each call retries with the other representation of its first (pointer or size) argument.
  const call = (fn, first, ...rest) => {
    try {
      return fn(first, ...rest);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      return fn(typeof first === 'bigint' ? Number(first) : BigInt(first), ...rest);
    }
  };
  const heap = () => lab.memory?.buffer ?? lab.module?.wasmMemory?.buffer ?? lab.module?.HEAPU8?.buffer;
  const alloc = bytes => {
    const malloc = lab.module._malloc ?? lab.module._SDL_malloc;
    if (!malloc) return null;
    const pointer = call(malloc, BigInt(bytes));
    return Number(pointer) ? pointer : null;
  };

  const MAX_FRAMES = 1024;
  let frameBuffer = null;
  lab.drainEngine = () => {
    if (lab.crashed) return null;
    const fn = lab.module?._eden_get_frame_times;
    if (!fn) return null;
    frameBuffer ??= alloc(MAX_FRAMES * 8);
    if (!frameBuffer || !heap()) return null;
    const out = [];
    const at = now();
    for (let round = 0; round < 64; round++) {
      const count = Math.max(0, Math.min(MAX_FRAMES, Number(call(fn, frameBuffer, MAX_FRAMES))));
      const view = new Float64Array(heap(), Number(frameBuffer), count);
      for (const ms of view) if (Number.isFinite(ms) && ms > 0) out.push(at, ms);
      if (count < MAX_FRAMES) break;
    }
    return out;
  };

  const readString = (pointer, length = 4096) => {
    const bytes = new Uint8Array(heap(), Number(pointer), length);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(bytes.slice(0, end < 0 ? length : end));
  };
  /// What the runtime knows about the running game: JSON from eden_get_game_info, which either
  /// returns a string or fills a (buffer, size) pair.
  lab.gameInfo = () => {
    if (lab.crashed) return null;
    const fn = lab.module?._eden_get_game_info;
    if (!fn || !heap()) return null;
    let text;
    if (fn.length >= 2) {
      const buffer = alloc(4096);
      if (!buffer) return null;
      const length = Number(call(fn, buffer, 4096));
      if (length <= 0) return null;
      text = readString(buffer, Math.min(length, 4096));
    } else {
      const pointer = fn();
      if (!Number(pointer)) return null;
      text = readString(pointer);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { name: text };
    }
  };

  lab.drain = () => {
    const out = { now: now(), raf: lab.raf, present: lab.present, presentOn: lab.presentOn, engine: null };
    try {
      out.engine = lab.drainEngine();
    } catch (err) {
      out.engineError = err.message;
    }
    lab.raf = [];
    lab.present = [];
    return out;
  };
}
