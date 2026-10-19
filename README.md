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
