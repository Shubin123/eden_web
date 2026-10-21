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

## Extended game result and release validation

- The corrected build's extended `silksong-final/` run failed. It reached Running
  at about 10 s, first frame activity at 54 s, and a peak of 43.5 FPS. All captured
  canvas images remained black. At about 93 s a worker raised a C++ exception.
- The emitted stack resolves through `operator new`, vector byte-buffer growth,
  `RegionCompiler::Compile`, `CompileRegion`, `BuildRegion` and `RunRegion` in the
  Wasm JIT. This establishes an allocation failure during JIT region compilation;
  it does not establish why that allocation failed. The archive had already been
  fully decoded and mounted. This game is **not verified playable**.
- Recovery did not restore a responsive page after this native failure. The test
  browser was closed after the crash and observation deadline; the harness wrote
  a failed report and result file. Neither that shutdown nor black frames are
  counted as successful gameplay.
- The release engine build completed from clean engine main `57e2a3a654`.
  Installed all four runtime artifacts with the default `npm run sync`.
  `artifacts/widget-core/engine-release-build.log` contains the complete build log.
- `npm test` passes against that release runtime. The release-only widget run
  (`widgets-release.log`) passes all eight checks without game inputs. The prior
  game/widget run (`widgets-validated.log`) passed all 16 interaction checks with
  the supplied 7z and no browser errors, including actual output gain and mute.
- Remaining work: JIT allocation failure and black rendering in Silksong,
  recovery after that failure, fullscreen verification, frame-step API, emulator
  save-state serialization and browser Local Play transport.

## File-backed ROM reader and additional widget verification

The API 4 engine and frontend now use a dedicated file reader worker and a shared
4 MB native mailbox. Raw files remain browser `File` objects. Compressed ROMs
stream into OPFS and are read from there after extraction. The older block mount
remains a compatibility fallback. Keys, firmware and saves keep their existing
filesystem and persistence paths.

The allocator investigation (`jit-malloc-repro/`, `memory-probe.json` and native-debug
logs under `artifacts/widget-core/`) found Chrome rejecting Wasm memory growth
at roughly 6.99 GB while the previous reader retained 2.49 GB of decoded ROM in
JavaScript. A no-ROM probe grew the same engine beyond that point. This is evidence
of browser memory pressure, rather than an oversized JIT code buffer. The new
reader removes that full-ROM retention. Optional native allocation diagnostics
are disabled in normal builds. JIT region allocation failure now falls back to
the interpreter for that region.

The `silksong-file-io/` run used the original 7z through the UI, reached Running
at about 10 seconds and peaked at 58.5 FPS without the earlier allocation errors.
It still failed: captures remained black and the engine terminated later. The
follow-up `renderer-fault/` run resolves the termination stack through WebGPU
`TextureCache::JoinImages` / `InsertImage`; the terminate handler reports no active
C++ exception. This localizes the next investigation but does not establish a
root cause or playable gameplay. A separate core-only Node observation ran for
180 seconds without the allocation failure, but hung during shutdown and was
terminated; it is not a passing end-to-end result.

`widgets-crash-io.log` records **25 sequential passing checks** with the actual
7z, keys and firmware imported locally, including:

- Raw and archived mailbox reads, block boundaries, EOF, and offsets above 4 GB.
- Native fullscreen entry, Escape exit, Alt+Enter entry and button exit.
- Core boot, CPU/heap display, scaling, pause/resume, real output gain/mute,
  controller press/release, and first-save persistence/restoration.
- A deliberately injected crash clears stale performance values, disables
  emulation controls and persists its report. This verifies the UI transition,
  not recovery of a terminated native worker.

The watchdog now uses the monotonic frame counter, so a stale positive FPS value
cannot hide a stalled worker. Unit checks cover long pauses, first-frame startup,
counter progress and the older-core fallback. System-file import requests a
reload only after a game has loaded. Browser UDP input polling is disabled in
the engine because this frontend uses its virtual gamepad.

Remaining work is visible Silksong rendering and the native renderer termination,
end-to-end automatic recovery after that failure, frame stepping, emulator
save-state serialization, and browser Local Play transport. Unavailable native
features are not claimed as connected. All game, key, firmware, save and telemetry
artifacts remain local and ignored.

Final release validation rebuilt both browser and headless engines with allocation
diagnostics off (`engine-file-io-release-build.log`) and installed all four runtime
files with the default `npm run sync`. `unit-file-io-release.log` records passing
`npm test` results. `widgets-file-io-release.log` and `widgets/report.json` record
**26 passing checks with no browser errors** against that release runtime and the
original 7z. The added check rejects decoder startup errors and truncated archive
output, then successfully mounts valid files. This remains widget and boot
validation; the black-rendering limitation above still applies.

## ASTC renderer failure identified and fixed

The `texture-diagnostic/` run captures the previously hidden error: Chrome rejects
an `astc-4x4-unorm` 160×176 texture because this NVIDIA Pascal device does not
expose `texture-compression-astc`. The error crosses the native texture constructor
and reaches the slot container's `noexcept` guard. Its terminate handler has no
active C++ exception, so the earlier termination message alone did not reveal
the cause. The Wasm disassembly confirms that constructor/guard path.

The engine now routes unsupported ASTC textures through its existing CPU decoder
and uploads RGBA8 pixels. The fallback uses decoded row sizes, preserves sRGB
views and counts decoded memory. Native ASTC remains available on supporting
devices and supported block sizes. The web settings explicitly disable ASTC
recompression for this upload path.

`astc-fallback/` reaches and uploads the ASTC assets without the previous texture
exception. It still **fails**: captured frames remain black and the browser later
stops responding. `astc-watch.log` and `call-trace/` reproduce the loss of response.
Local system crash records identify a Chrome renderer process receiving SIGILL;
the available core does not provide a usable native stack. This does not establish
the cause of the browser crash or prove playable gameplay.

The harness now bounds runtime sampling outside the page, records browser page
crashes, skips further runtime queries when unresponsive, and fails its final
Running check instead of accepting the last stale sample. `call-trace/` and
`unshared-uploads/` verify that an unresponsive runtime is rejected. The optional
allocator build records heap-growth start/completion and texture exceptions.

Controlled experiments remain local and have not become product workarounds:

- `astc-x11/`: X11 did not remove the black output or response failure.
- `unshared-uploads/`: copying GPU upload views into standalone buffers did not
  prevent the failure; that experimental hook was removed.
- `grow-probe.log`: the idle core's shared memory successfully grew from about
  4.44 GB to 8.73 GB, so an assumed fixed limit at 7.6 GB is not supported.
- `pregrow-watch.log`: reserving 9 GiB before game boot also failed later. No
  larger default heap was adopted.

Visible rendering, the subsequent browser/native failure, recovery and the
remaining native features still require work. Game archives, system files,
captures and diagnostic dumps remain local and ignored.

Release validation for this change: both browser and headless engines built with
diagnostics off (`engine-astc-release-build.log`), the default `npm run sync`
installed all four runtime files, and `npm test` passed (`unit-astc-release.log`).
The core-ready browser run passed 10/10 checks (`astc-core-ready/`), and the actual
7z widget run passed all 26 checks with no browser errors
(`widgets-astc-release.log`, `widgets/report.json`). These interaction tests
complete before the longer rendering failure and do not establish playability.
