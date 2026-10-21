// SPDX-License-Identifier: GPL-3.0-or-later
// CPU cores the runtime can run guest code on, with what each is good and bad at and how it did
// in testing. The choice is applied before the runtime starts (as EDEN_* environment variables),
// so changing it takes a page reload. Add a core here once it has been tested.

const STORAGE_KEY = 'eden-cpu-core';

// Results from the e2e and headless runners on an x86 desktop with a GTX 1080 Ti (Chrome).
export const CPU_CORES = [
  {
    id: 'jit',
    name: 'Wasm JIT',
    summary: 'Compiles hot guest code into WebAssembly. Use this unless a game misbehaves.',
    env: {},
    pros: [
      'Fastest by far: hot ARM code becomes WebAssembly the browser optimizes',
      'Needed for 3D games to reach playable speed',
    ],
    cons: [
      'Short stutters while new code regions compile',
      'A JIT bug can break a game that runs correctly on the interpreter',
    ],
    tested: [
      { game: 'Captain Toad: Treasure Tracker', result: 'Playable: 60 fps menus, ~15 fps in levels; occasionally hangs after ~70 s' },
      { game: 'Blaster Master Zero 3', result: 'Full speed (60 fps)' },
      { game: 'Pikmin 1', result: 'Boots; stops after the first frame (renderer issue)' },
    ],
  },
  {
    id: 'interpreter',
    name: 'IR interpreter',
    summary: 'Executes every instruction directly. The reference the JIT is tested against.',
    env: { EDEN_INTERP_JIT: '0' },
    pros: [
      'Reference behavior: no compiled code that could be wrong',
      'No compile stutters',
      'Diagnostic: if a game works here but not on the JIT, it is a JIT bug worth reporting',
    ],
    cons: [
      'Several times slower; only light 2D games reach full speed',
      '3D games may not get past their loading screens',
    ],
    tested: [
      { game: 'Blaster Master Zero 3', result: 'Full speed (60 fps)' },
      { game: 'Captain Toad: Treasure Tracker', result: 'Too slow: no gameplay within 90 s' },
      { game: 'Pikmin 1', result: 'Boots through system services; no frames within 90 s' },
    ],
  },
];

export const DEFAULT_CORE = CPU_CORES[0];

export function findCore(id) {
  return CPU_CORES.find(core => core.id === id);
}

/// The core for this page load: ?core= in the URL wins (handy for tests and links), then the
/// stored choice, then the default.
export function activeCore() {
  const fromUrl = findCore(new URLSearchParams(location.search).get('core'));
  if (fromUrl) return fromUrl;
  try {
    return findCore(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_CORE;
  } catch {
    return DEFAULT_CORE;
  }
}

export function storeCore(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}

/// preRun hook for createEdenModule that exports the core's environment to the runtime.
export function coreEnvironment(core) {
  return module => Object.assign(module.ENV, core.env);
}
