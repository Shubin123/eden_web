Frontend source is in `web/` and development tooling in `scripts/`. Edit UI/display,
controls, and library behavior in `web/`, then test with `npm start`.

Engine modules and compiled WebAssembly are owned by the sibling `eden_emscripten` repository
and synced into `web/runtime/` via `npm run sync`. Never edit generated engine files
or copy native C++ Eden source into this repository.

Keep commercial ROMs (NSP, XCI), cryptographic keys (`prod.keys`, `title.keys`), save data,
and telemetry caches local and ignored. Do not push or deploy without user authorization.
