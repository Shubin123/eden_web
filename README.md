# Eden Web — Nintendo Switch Emulator in the Browser

A WebAssembly frontend and test harness for the Eden Nintendo Switch emulator port, running Switch homebrew and decrypted ROMs directly in modern web browsers.

- **Live GitHub Pages**: [https://shubin123.github.io/eden_web/](https://shubin123.github.io/eden_web/)
- **Native/WASM Engine**: [https://github.com/Shubin123/eden_emscripten](https://github.com/Shubin123/eden_emscripten)

## Architecture

- **`web/index.html`**: Switch console simulation UI with Neon Joy-Cons, canvas screen, drop zone, WASM binary status card, and keyboard controls.
- **`web/system-files.js`**: Keys & firmware importer. Unpacks `prod.keys`/`title.keys` and firmware `.zip` dumps in the browser, persists them in IndexedDB, and mounts them into Eden's data directory before `eden_init`.
- **`web/app.js`**: Frontend runtime driver managing the WebAssembly lifecycle, mounting ROMs into the virtual filesystem (MEMFS), and stepping emulation frames.
- **`web/coi-serviceworker.js`**: Cross-Origin Isolation Service Worker enabling `SharedArrayBuffer` and multi-threading on GitHub Pages.
- **`web/runtime/`**: The Eden WebAssembly runtime (`eden.js`, `eden.wasm`) built by `eden_emscripten`. Not committed; synced locally and published as assets of the `runtime` release for Pages.
- **`scripts/server.mjs`**: Local HTTP server with COOP/COEP headers.
- **`.github/workflows/pages.yml`**: GitHub Actions deployment workflow deploying the `web/` directory to GitHub Pages.

## Getting Started

### Run Locally

1. Start the development server (configured with COOP/COEP headers for multi-threaded WebAssembly):
   ```bash
   npm start
   ```
2. Navigate to `http://localhost:8080` in Chrome, Edge, or Firefox.
3. In the **System Files** card, add your `prod.keys` (or a keys `.zip`) and a firmware `.zip` dumped from your own console.
4. Drop a decrypted Nintendo Switch ROM (`.nsp`, `.xci`) or homebrew executable (`.nro`).

### Tests

Check that the runtime in `web/runtime` is a threaded Memory64 build with the C API the frontend uses:
```bash
npm test
```

Run the browser end-to-end and regression test (Chrome, WebGPU). Without inputs it checks that the page loads,
is cross-origin isolated, and starts the core. With your own keys, firmware and game it imports them through the
UI, boots the game and compares boot time and frame rate with `tests/baseline.json`:
```bash
npm run test:e2e                                        # local build, COOP/COEP headers
npm run test:e2e -- --static                            # local build served like GitHub Pages
npm run test:e2e -- --url https://shubin123.github.io/eden_web/
EDEN_KEYS=prod.zip EDEN_FIRMWARE=firmware.zip EDEN_ROM=game.nsp npm run test:e2e -- --seconds 120
```
Reports and screenshots are written to `artifacts/`.

## Emulation cores

The **Emulation** widget picks the CPU core guest code runs on and lists each core's benefits,
downsides, tested games and credits. It also lists the other Switch emulators (Ryujinx Canary /
Ryubing, Kenji-NX, Citron, Sudachi, MeloNX, Hydra, Strato) with their status and what a browser
port would take; only Eden is built for WebAssembly, so only its cores can be selected to run:

| Core | Use it for | Trade-off |
|---|---|---|
| **Wasm JIT** (default) | Everything; needed for 3D games | Compile stutters; a JIT bug can break a game |
| **IR interpreter** | Light 2D games, and checking whether a bug is the JIT's | Several times slower |

The core is fixed when the runtime starts, so switching reloads the page (keys and firmware stay
installed). `?core=interpreter` in the URL overrides the stored choice for one load, and
`npm run test:e2e -- --core <id>` checks that the engine really runs the selected core. Cores are
defined in `web/cores.js`; add one there only after it has been tested, with its results.

## Crash recovery and in-game saves

- **In-game saves persist.** The page copies the game's save folders to IndexedDB shortly after
  the game writes them (once they have stopped changing, so a half-written save is never
  captured) and restores them every time a game boots. The **Save States** widget shows the
  latest save point and can delete it.
- **Crashes restart the game.** If the runtime aborts, a thread throws, guest code faults (as a
  JIT bug does) or frames stop for 45 s, the page records a crash report, keeps a copy of the
  game file in the origin-private file system, reloads, and boots the game again from the last
  save point. After 2 crashes in 10 minutes it stops and suggests the IR interpreter core.
  Automatic restart can be turned off in the **Emulation** widget.
- **Crash reports** (reason, game, core, versions, recent log) stay in the browser; download them
  from the Emulation widget to reproduce a crash with the headless runner.
- Right after a reload the browser may still hold the previous page's emulated memory; the page
  notices and reloads again after a short wait.

`npm run test:e2e -- --crash-at 20` simulates a crash 20 s after the first frame and checks that
the report is stored and the game restarts and draws again.

## Credits

This project stands on the work of many people:

- **Eden** by the Eden Emulator Project, continuing the **yuzu** Emulator Project.
- **dynarmic**, the ARM-to-IR CPU translator, by MerryMage and contributors.
- **WebAssembly port**, Wasm JIT, WebGPU renderer and this frontend by Shubin123.
- **libarchive** (Tim Kientzle and contributors), **xz/liblzma** (Lasse Collin and the Tukaani
  Project), **zstd** (Yann Collet and Meta), **zlib** (Jean-loup Gailly and Mark Adler) and
  **bzip2** (Julian Seward), which the archive decoder is built from.
- **Emscripten** and its contributors, which make the WebAssembly build possible.
- The other emulators in the Emulation widget are credited there: Ryujinx (gdkchan and the
  Ryujinx team), Ryubing (GreemDev and contributors), Kenji-NX (KeatonTheBot and others), Citron
  (Zephyron), Sudachi (Jarrod Norwell), MeloNX (Stossy11), Hydra (SamoZ256) and Strato (the
  Strato team, continuing Skyline).

## Versioning

Every build names exactly what it runs, in the **WebAssembly → Version** row of the page and in the
log, e.g. `0.1.0 · web 14ea2b9 · engine 8d03142`:

- **Product version**: `version` in `package.json`, bumped for user-visible releases.
- **Frontend revision**: the eden_web commit. `web/version.json` holds all three; the Pages
  workflow writes it when deploying and `npm run sync` writes a local one.
- **Engine revision**: the eden_emscripten commit the runtime was built from (`git describe`),
  recorded in `web/runtime/runtime.json` by `npm run sync` and `npm run publish-runtime`.

`npm run publish-runtime` refuses dev builds (`EDEN_DEV=1`) and engine trees with uncommitted
changes, and the Pages workflow refuses to deploy a dev build, so the deployed revision can always
be checked out and rebuilt. Local builds are marked `local` (or `local dev build`).

## Controls

| Switch Button | Keyboard Key | Joy-Con UI |
|---|---|---|
| **A / B / X / Y** | <kbd>A</kbd> / <kbd>S</kbd> / <kbd>Z</kbd> / <kbd>X</kbd> | Neon Red Right Joy-Con |
| **D-Pad** | <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Neon Blue Left Joy-Con |
| **+ (Plus)** | <kbd>Enter</kbd> | Right Joy-Con Plus Button |
| **- (Minus)** | <kbd>Backspace</kbd> | Left Joy-Con Minus Button |
| **L / R** | <kbd>Q</kbd> / <kbd>E</kbd> | Shoulder Triggers |
| **ZL / ZR** | <kbd>1</kbd> / <kbd>3</kbd> | Analog Triggers |
| **Speed Multipliers** | Click 1x / 2x / 4x | Control Toolbar |

## Synchronizing with `eden_emscripten`

To sync freshly compiled WebAssembly artifacts from `eden_emscripten`:
```bash
npm run sync
```

To deploy them to GitHub Pages, upload them to the `runtime` release and start the Pages workflow:
```bash
npm run publish-runtime -- --deploy
```
