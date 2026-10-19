# Eden Web — Nintendo Switch Emulator in the Browser

A WebAssembly frontend and test harness for the Eden Nintendo Switch emulator port, running Switch homebrew and decrypted ROMs directly in modern web browsers.

- **Live GitHub Pages**: [https://shubin123.github.io/eden_web/](https://shubin123.github.io/eden_web/)
- **Native/WASM Engine**: [https://github.com/Shubin123/eden_emscripten](https://github.com/Shubin123/eden_emscripten)

## Architecture

- **`web/index.html`**: Switch console simulation UI with Neon Joy-Cons, canvas screen, drop zone, WASM binary status card, and keyboard controls.
- **`web/system-files.js`**: Keys & firmware importer. Unpacks `prod.keys`/`title.keys` and firmware `.zip` dumps in the browser, persists them in IndexedDB, and mounts them into Eden's data directory before `eden_init`.
- **`web/app.js`**: Frontend runtime driver managing the WebAssembly lifecycle, mounting ROMs into the virtual filesystem (MEMFS), and stepping emulation frames.
- **`web/eden.js` & `web/eden.wasm`**: Compiled WebAssembly binary artifacts providing the C API exports (`eden_init`, `eden_load_rom`, `eden_step_frame`, etc.).
- **`web/coi-serviceworker.js`**: Cross-Origin Isolation Service Worker enabling `SharedArrayBuffer` and multi-threading on GitHub Pages.
- **`web/runtime/`**: Synchronized runtime copies of WebAssembly binaries.
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

### Smoke Tests

To verify that the WebAssembly binary artifacts and exports are intact:
```bash
npm test
```

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
