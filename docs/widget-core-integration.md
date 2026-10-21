# Widget and core integration work log

## Scope and verification order

Work through the browser widgets sequentially, using the compiled engine rather than
simulating successful operations. Keep full console output, reports and screenshots
under the ignored `artifacts/widget-core/` directory. Games, system files and saves
remain local. Runtime binaries are built in `eden_emscripten` and installed here with
`npm run sync`.

| Order | Widget / flow | Initial evidence | Status |
| --- | --- | --- | --- |
| 1 | ROM / system files, including large 7z | Streaming libarchive worker and MEMFS boot path exist | Direct 7z extraction and boot verified; gameplay verification pending |
| 2 | Controls / input | Pause/resume/shutdown exports exist; Step Frame is an empty handler | Pause/resume and input verified; frame stepping needs a core API |
| 3 | Performance / renderer / core metadata | Stats, game info and capabilities exports exist; UI mostly uses original scalar API | Live API fields connected; browser checks pass |
| 4 | Audio | Native frontend explicitly chooses Null audio; UI disabled | Real output gain, mute and resume verified with Silksong |
| 5 | In-game saves / recovery / compatibility | IndexedDB save watcher, restart and result recording exist | First-save persistence/restore verified; recovery still pending |
| 6 | Save-state slots | No core serialization API exists | Backend work required; in-game saves are separate |
| 7 | Local Play | No browser LDN transport exists | Backend work required |
| 8 | Display / fullscreen / layout / logs | Browser UI implementations exist | Scaling and logging verified; fullscreen pending |

## 2026-10-21: initial audit and baseline

- Both worktrees were clean at the start. Read both repository instruction files and
  the engine AI and coding policies.
- Started the existing headful Chrome e2e harness with the requested Silksong 7z as
  the actual file input, and local system-file archives. Output:
  `artifacts/widget-core/silksong-baseline.log` and `silksong-baseline/`.
- The initial run reports cross-origin isolation, NVIDIA Pascal WebGPU, core readiness
  in 826 ms, and successful system-file imports. It streams the archive directly;
  no external extraction or raw NSP substitution is used.
- Existing baseline thresholds were measured for Captain Toad on a different host.
  Preserve them as regression evidence, but inspect actual Silksong frames, runtime
  state and errors before drawing a game-compatibility conclusion.

## Implemented and verified so far

- ROMs now mount as read-only files backed by 4 MB blocks. Native reads and seeks
  cross block boundaries without contiguous whole-game reallocation. Truncation
  cancels the source stream. Concurrent ROM selections are rejected and archive
  workers are closed on early exits.
- The actual requested 7z was streamed through the built decoder: 2,492,437,328
  bytes, matching its declared NSP size. SHA-256:
  `e3ca5a5bceb08d885dd181f0f0171fb9284c34a215cbad98306316f09af112ba`.
  Full evidence: `artifacts/widget-core/archive-integrity.log`.
- The renderer, CPU, API, game metadata, frame count, heap size and shader counters
  read the live engine. The core's JSON getters avoid UI-thread heap allocation.
- Audio now uses SDL Web Audio. The widget controls a real output gain, remembers
  volume/mute, and resumes a suspended browser context from a user gesture. The
  engine fixes SDL's Memory64 pointer conversion for current Emscripten.
- The first save written before the watcher's first poll is now persisted. The
  sequential browser test verifies write, IndexedDB persistence and restoration
  through the actual runtime filesystem in a fresh browser profile.
- Engine exceptions include readable messages/stacks. UI and test frame sampling
  stop querying a crashed engine. The e2e harness writes console output during the
  run, dismisses and records alerts, and bounds screenshot requests.
- `npm test` passes, including archive, block-reader, results, compatibility and
  diagnostics checks. `npm run test:widgets` verifies the real core, heap display,
  block-file reads, first-save restoration and screen scaling without game inputs.

## Silksong and remaining verification

The earlier end-to-end run (`silksong-audio/`) extracted directly from 7z, reached
Running and peaked at 43 FPS. It did **not** pass: captures were black and the game
later raised a worker exception. SDL's pointer conversion also produced browser
errors in that earlier build. These are not recorded as a working-game result.
The final widget/game run uses the corrected SDL bridge and safe live getters;
its output is `artifacts/widget-core/widgets-validated.log`.

A separate harness issue was found in the sequential game test: its browser
protocol timeout was shorter than Silksong's boot wait. The test now permits the
full declared boot wait instead of failing at 60 seconds.

Frame stepping, emulator save-state serialization and browser Local Play still
need native APIs/backends. Their unavailable controls remain explicit. Fullscreen,
crash recovery and sustained visible Silksong gameplay still require final runtime
verification; the passing unit checks do not establish them.

## Final sequential widget run

`widgets-validated.log` and `widgets/report.json` record 16 passing checks with no
browser errors. The supplied 7z is the actual ROM input. The test verifies core
readiness, CPU and heap widgets, real filesystem reads, first-save persistence and
restoration, scaling, system-file import, game boot, pause, resume, volume, mute,
and controller press/release forwarding. The screenshot remains black: this is
not a claim of visible gameplay. The longer `silksong-final/` run checks that
separately.
