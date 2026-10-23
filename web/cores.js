// SPDX-License-Identifier: GPL-3.0-or-later
// Emulation cores: the CPU cores this runtime can run guest code on, with what each is good and bad
// at and how it did in testing, followed by the other Switch emulators for comparison. Only Eden is
// built for WebAssembly, so only its cores are `available`; the others are listed with credit to
// the people who make them and what a browser port would take. The choice is applied before the
// runtime starts (as EDEN_* environment variables, and `runtime`, the folder of the engine build to
// load), so changing it takes a page reload. Mark a core available only once it runs here and has
// been tested.

const STORAGE_KEY = 'eden-cpu-core';

const EDEN_CREDITS = 'Eden Emulator Project, continuing the yuzu Emulator Project; CPU translation by '
  + 'dynarmic (MerryMage and contributors); WebAssembly port, Wasm JIT and WebGPU renderer by Shubin123';

// Results from the e2e and headless runners on an x86 desktop with a GTX 1080 Ti (Chrome).
export const CPU_CORES = [
  {
    id: 'jit',
    name: 'Wasm JIT',
    emulator: 'Eden',
    available: true,
    credits: EDEN_CREDITS,
    links: ['https://git.eden-emu.dev/eden-emu/eden', 'https://github.com/Shubin123/eden_emscripten'],
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
    id: 'fused',
    name: 'Wasm JIT, fused build',
    emulator: 'Eden (fused)',
    available: true,
    runtime: 'runtime/fused/',
    credits: `${EDEN_CREDITS}; fixes ported from Citron Neo by borb, cheezwiz7899, Zephyron, hopesuffers and collecting (citron Emulator Project)`,
    links: ['https://github.com/Shubin123/eden_emscripten/releases/tag/fused-2026.10.22', 'https://github.com/citron-neo/emulator'],
    summary: 'The Wasm JIT on the fused engine build: Eden\'s frame-pacing refactor plus eight fixes ported from Citron Neo. Optional while it is tried on more devices.',
    env: {},
    pros: [
      'Display buffers go back to the game sooner, so frame times are steadier in some games',
      'Citron fixes for GPU semaphores, instruction-cache invalidation and a Tears of the Kingdom crash',
    ],
    cons: [
      'Measured on one machine so far; results on other architectures may differ',
    ],
    tested: [
      { game: 'Hollow Knight: Silksong', result: 'In-game 32-36 fps with lower frame-time spikes (26-33 fps on the default build), Apple Silicon' },
      { game: 'Tears of the Kingdom', result: 'Same speed as the default build (~8.5 fps)' },
    ],
  },
  {
    id: 'interpreter',
    name: 'IR interpreter',
    emulator: 'Eden',
    available: true,
    credits: EDEN_CREDITS,
    links: ['https://git.eden-emu.dev/eden-emu/eden', 'https://github.com/Shubin123/eden_emscripten'],
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
  // Other Switch emulators. Status as of October 2026.
  {
    id: 'ryubing',
    name: 'Ryujinx Canary (Ryubing)',
    emulator: 'Ryubing',
    available: false,
    summary: 'The most active continuation of Ryujinx, the C# emulator discontinued in October 2024.',
    credits: 'Ryujinx created by gdkchan and the Ryujinx team; Ryubing fork led by GreemDev with contributors (MIT)',
    links: ['https://git.ryujinx.app/projects/Ryubing'],
    pros: ['Ryujinx lineage known for accuracy', 'Rolling Canary builds for Windows, Linux and macOS'],
    cons: ['Written in C#/.NET; its ARMeilleure JIT emits x86/ARM machine code, which browsers cannot run'],
    browser: 'Needs a WebAssembly CPU backend for ARMeilleure, a WebGPU renderer and a .NET-on-WebAssembly host with threads.',
  },
  {
    id: 'kenji-nx',
    name: 'Kenji-NX',
    emulator: 'Kenji-NX',
    available: false,
    summary: 'Ryujinx fork between Ryubing and the preservation mirrors, with a strong Android build.',
    credits: 'Based on Ryujinx by gdkchan; developed by KeatonTheBot with GreemDev and others (MIT)',
    links: ['https://github.com/Kenji-NX'],
    pros: ['Optimized for recent Android chips', 'Desktop and Android release channels'],
    cons: ['Same C#/.NET and native-JIT design as Ryujinx'],
    browser: 'Same blockers as Ryubing: a WebAssembly CPU backend, a WebGPU renderer and a .NET-on-WebAssembly host.',
  },
  {
    id: 'citron',
    name: 'Citron',
    emulator: 'Citron',
    available: false,
    summary: 'Actively developed yuzu fork for PC and Android, with a rewritten Vulkan pipeline since 0.7.',
    credits: 'Lead developer Zephyron, building on the yuzu Emulator Project (GPL-3.0)',
    links: ['https://git.citron-emu.org/citron/emulator'],
    pros: ['Active development', 'Shares yuzu\'s C++ code base with Eden'],
    cons: ['Desktop and Android only; no WebAssembly build'],
    browser: 'The most feasible port: being a yuzu fork like Eden, it could reuse this project\'s Wasm JIT, WebGPU renderer and browser layer.',
  },
  {
    id: 'sudachi',
    name: 'Sudachi',
    emulator: 'Sudachi',
    available: false,
    summary: 'yuzu fork for Windows, Linux and Android; development ended in August 2025.',
    credits: 'Developed by Jarrod Norwell, building on the yuzu Emulator Project',
    links: ['https://sudachiemu.org/about'],
    pros: ['Was one of the most reliable yuzu forks while active'],
    cons: ['No longer maintained; its developer recommends Eden'],
    browser: 'Not worth porting: inactive, and Eden covers the same code base.',
  },
  {
    id: 'melonx',
    name: 'MeloNX',
    emulator: 'MeloNX',
    available: false,
    summary: 'Ryujinx-based emulator for iPhone and iPad with a Metal renderer.',
    credits: 'Lead developer Stossy11, based on Ryujinx by gdkchan',
    links: ['https://melonx.org/'],
    pros: ['Brings Switch emulation to iOS'],
    cons: ['iOS only; needs JIT permissions on the device'],
    browser: 'Same blockers as Ryujinx, plus a Metal-only renderer.',
  },
  {
    id: 'hydra',
    name: 'Hydra',
    emulator: 'Hydra',
    available: false,
    summary: 'Experimental emulator written from scratch, focused on macOS.',
    credits: 'Developed by SamoZ256',
    links: ['https://github.com/SamoZ256/hydra'],
    pros: ['Independent, from-scratch design'],
    cons: ['Early stage: some homebrew and a few games run', 'macOS focus'],
    browser: 'Too early to port; game support would need to mature first.',
  },
  {
    id: 'strato',
    name: 'Strato',
    emulator: 'Strato',
    available: false,
    summary: 'Android emulator continuing Skyline; inactive since 2024.',
    credits: 'Strato team, continuing Skyline',
    links: ['https://github.com/strato-emu/strato'],
    pros: ['Designed for ARMv8 Android devices'],
    cons: ['No longer active', 'Relies on running ARM code natively, which browsers cannot do'],
    browser: 'Its native-execution design does not carry over to WebAssembly.',
  },
];

export const DEFAULT_CORE = CPU_CORES[0];

export function findCore(id) {
  return CPU_CORES.find(core => core.id === id);
}

/// Only cores this runtime can run may be selected to run.
function runnableCore(id) {
  const core = findCore(id);
  return core?.available ? core : undefined;
}

/// The core for this page load: ?core= in the URL wins (handy for tests and links), then the
/// stored choice, then the default.
export function activeCore() {
  const fromUrl = runnableCore(new URLSearchParams(location.search).get('core'));
  if (fromUrl) return fromUrl;
  try {
    return runnableCore(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_CORE;
  } catch {
    return DEFAULT_CORE;
  }
}

export function storeCore(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}

/// The folder of the engine build a core runs on.
export function runtimeBase(core) {
  return core.runtime ?? 'runtime/';
}

/// preRun hook for createEdenModule that exports the core's environment to the runtime.
export function coreEnvironment(core) {
  return module => Object.assign(module.ENV, core.env);
}
