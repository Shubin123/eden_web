# eden_web

Browser frontend, WebAssembly runner, and test harness for the Eden Nintendo Switch emulator port.

## Architecture

- **`web/`**: HTML5, Canvas/WebGL2/WebGPU display, audio, gamepad/touch controls, and ROM loader.
- **`web/runtime/`**: Compiled WebAssembly and JS runtime modules synced from the sibling `eden_emscripten` repository.
- **`scripts/`**: Local development server and asset synchronization tooling.

## Getting Started

1. Start the development server (configured with COOP/COEP headers for multi-threaded WebAssembly):
   ```bash
   npm start
   ```
2. Navigate to `http://localhost:8080` in Chrome/Edge/Firefox.
3. Drop a decrypted NSP/XCI or homebrew NRO to test execution.

## Syncing Runtime from `eden_emscripten`

To sync built WebAssembly artifacts from `../eden_emscripten`:
```bash
npm run sync
```
