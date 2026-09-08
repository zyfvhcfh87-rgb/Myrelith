# Issue 199 — mixed encoded G4 protocol (not yet run)

This is the next reviewable source-only protocol after accepted large evidence
8963128. Execution requires the parent's explicit shared-slot grant at the final
clean full SHA. It performs one bounded mixed case, stops at the first failure,
and does not run the existing large/gestures/editing segments or a build.

## Invocation and source boundary

After the separately granted production build, with private dependencies already
present, run from the issue199 worktree:

```
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage node scripts/issue199/g4/run.mjs --expected-head FULL_SHA
```

`--check` reads source hashes and prints protocol metadata only. Source preparation
checks are `tsc -p scripts/issue199/g4/tsconfig.json`, the focused pure fixture test,
and `node --test scripts/issue199/g4/{oracles,lifecycle}.test.mjs`. These do not encode media.

The runner uses Vite's source-module server on exclusive 127.0.0.1:5199, a fresh
private persistent Chromium profile, `--mute-audio`, and a recorded command-scoped
caffeinate helper. Every tracked production source, adapter and configuration path
is hashed before launch and rechecked after cleanup. This is a diagnostic using
actual production controllers/pipelines through source imports, **not ordinary
production-bundle or first-paint acceptance**. No new application entry, production
source import of the adapter, engine UI import, or engine resource global is introduced. One temporary data-only Playwright binding
writes partial decoded facts to the private evidence directory. Raw results identify this qualification and exact source SHA.

## Bounded mixed case

A native shared-Animation step sets a rectangle title key at frame 14, enters
-120 through the numeric field, copies it and pastes at frame 20. Each action
must create one history entry; keys retain exact local source ticks. This edited
title payload is included in the subsequent real portable reopen.

The output is 30 frames / one second at 1280×720, 30 fps, 48 kHz stereo. A local
source of 60 encoded VP9 video frames has a colored plate and moving red marker.
The project contains media transform/crop/effect keys, a Bézier mask with two held
path keys, a disabled unknown plugin descriptor, a separate audio lane, and a
supported two-element title. Canonical app retime applies 2× speed, then split at
frame 15. Undo/redo must restore exact project references. Full portable save is
serialized through the canonical domain API, reopened through the real UI, and
both source files are relinked through their real per-file inputs. Complete
sequence payload and unknown descriptor preservation are checked.

The live native Play/Pause step uses an all-zero PCM file. After playback is
paused and drained, a separate deterministic 250 Hz, amplitude 0.125 PCM source
is installed for internal encoded-output analysis. It is never played through
transport; Chromium remains muted throughout. Volume holds 0.25 before frame 15
and 0.75 afterward; balance holds hard-left then hard-right. The source WAV and
encoded video bytes are preserved with hashes. No speakers, external media,
network download, codec install or persistent power settings are involved.

The title uses literal `MOVE` text with font intent `G4 Missing Named Font` and
persisted explicit `serif` fallback, plus a colored rectangle with an ordinary
position-y title lane. Canonical generated left crawl creates position-x keys at
0 and 29. The pure fixture test requires the word box to be fully off-canvas at
both boundaries and move left across the interior. This consumes #200's accepted
renderer and title authoring contracts; #200 separately owns fallback first-paint
investigation. Before the successful output attempt, changing the persisted fallback to null
must refuse strict export with a font/fallback reason; unexpected output bytes
are preserved before failing the predicate. It must never return encoded output for that variant.

Native workspace checks open Animation, exercise the filter at 1440 and 720
pixels, retain no horizontal page overflow, and return focus to the entry control
through Back to Timeline. This is scoped workspace coverage, not a complete
responsive-layout or assistive-technology claim.

## Actual encoded output and predicates

Production `startExport` uses WebM, VP9 at 5 Mbps and Opus at 192 kbps, stereo.
The actual returned encoded bytes are saved **before** numerical acceptance.
Export and readback are separate calls: the driver saves encoded bytes and
their hash before starting any readback. Per-frame and per-buffer decoded facts
are written durably through the data-only binding, including partial failure
state. Mediabunny reopens those bytes. Decoder queries use each selected frame
center; returned timestamps must match its start within 1 ms for container
timestamp quantization and are retained with durations. Six decoded samples at frames 0, 7, 14, 15, 22 and
29 cover boundaries, interior motion and the split. Every video sample closes in
finally; inputs, temporary surfaces and export ownership are explicitly disposed.

- Video must decode as VP9 at 1280×720, exactly 30 packets and average packet rate
  within 0.001 of 30. Video duration is within 1/30000 second of one second; total
  A/V duration is within 30 ms to allow codec priming/padding.
- The reference pins project identity, generation, active sequence and canvas
  identity; its actual backing dimensions must be 1280×720. A fresh drawn event
  must contain the expected active visual clip IDs and no missing clips/errors;
  frame, project and canvas identity are rechecked after settling. The settled
  Program canvas is sampled on an 8-pixel grid. Encoded RGB mean
  absolute error must be at most 8 code values and p95 at most 20. No raw/encoded
  equality is claimed. Raw sampled RGB JSON and each decoded PNG are preserved.
- White text pixels (each RGB channel >235) must be absent at off-canvas boundary
  frames and exceed 40 at all interior samples. Encoded white coverage differs
  from the corresponding raw frame by at most 15%; centroid differs by at most
  3 pixels per axis. The decoded centroid at frame 7 must be over 100 pixels to
  the right of frame 22. The plate (#204060), red marker (#903020), and rectangle (#00b080) are the only
  non-text sources. Even at the maximum media exposure +0.8, their minimum RGB
  channel stays below 100; they cannot satisfy the all-channels >235 white glyph
  predicate. No image/text is burned into the source video. These are
  same-runtime glyph presence/placement checks,
  not cross-platform font raster equality or a new first-paint pass.
- Audio must decode as Opus, cover all 48,000 PCM sample positions, and expose
  stereo 48 kHz buffers. A 48,000-position occupancy ledger checks every sample, rejects
  nonfinite samples and interior gaps, and records all timestamps/ranges. Padding
  is limited to 960 samples beyond either boundary; overlaps are limited to one
  sample per buffer and 16 total for timestamp rounding. Gap, overlap, padding
  and nonfinite regressions run without codecs. RMS is measured in 2,400-sample windows beginning at
  200 and 700 ms. The inactive channel must be ≤0.002 RMS; first active RMS must
  exceed 0.005 and second stay below 0.15. The late/early active RMS ratio must
  be 3 within 8%. These are declared lossy gain/balance predicates, not exact
  PCM identity or a speech-quality claim. Oracle tests reject missing glyphs,
  stationary crawl, wrong gain/pan, truncated PCM, wrong fps and RGB mismatch.

## Failure and release

After awaited playback drain and export, transport and preview disposal, the final
admission snapshot is saved before asserting zero essential owners, monitor
owners, decoder slots and surface bytes, with no blockers. Earlier snapshots
during export/readback are diagnostic only; they do not establish release.
These application reservation checks and native process cleanup are separate
evidence. Neither process exit nor RSS establishes media-resource leak freedom.

Each step saves a screenshot/DOM/result and process identities. A step has a
90-second action deadline. Post-step settling, screenshot and DOM each have
5-second deadlines. Trace and context close each have a separate 5-second
deadline and cannot skip the next cleanup. ps/Git subprocesses time out at
5 seconds, port probes at 500 ms. A separate Node supervisor imposes a 300-second
overall deadline even if the driver event loop stalls; it preserves watchdog
evidence and signals only exact observed child/profile identities. Inert tests
exercise stalled trace/context cleanup and terminate a blocked disposable Node
child through the actual independent supervisor helper. Any console warning/error, page error, unexpected dialog,
source drift or failed predicate stops the run. The sole allowed dialog is the
exact private-fixture unsaved-project departure confirmation. Failed attempts
remain raw and are never reclassified by changing thresholds after observation.

Raw files live under `/private/tmp/issue199-g4/<timestamp>/`: result, exact portable
project, actual source and exported files, reference RGB/PNG, decoded PNG/facts,
trace, server log and private profile. Packaging adds a full top-level hash
manifest without rewriting original evidence. Cleanup closes the context, preview
server and scoped helper; only recorded PID/start/command matches may receive
fallback signals. Record all process identities and port 5199 release, then perform
an independent read-only release/source/sleep-window check. Report codec/runtime
qualification and this source-module boundary. No performance threshold, hardware
GPU, native Save picker or entire Gate 4 acceptance is implied by this protocol.
