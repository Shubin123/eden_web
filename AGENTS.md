Frontend source is in `web/` and development tooling in `scripts/`. Edit UI/display,
controls, and library behavior in `web/`, then test with `npm start`.

Engine modules and compiled WebAssembly are owned by the sibling `eden_emscripten` repository
and synced into `web/runtime/` via `npm run sync`. Never edit generated engine files
or copy native C++ Eden source into this repository.

Pushes and deployments are allowed when requested by the user. Do not add agentic attribution,
AI trailers, or Co-authored-by tags in commits or PRs.

Keep commercial ROMs (NSP, XCI), cryptographic keys (`prod.keys`, `title.keys`), save data,
and telemetry caches local and ignored.

Any coding agent can run the test suites; none of them needs a particular vendor. `npm test`
runs without a browser or model. `npm run test:agent` drives games with any model behind an
OpenAI-compatible or Anthropic endpoint (default: a local Ollama `qwen2.5vl:3b`); see the
README's Game suites section for the `EDEN_AGENT_*` settings.
