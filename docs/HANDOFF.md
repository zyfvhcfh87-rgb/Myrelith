# WebCut — Session Handoff

Read this first in a new session. It is the deep context; [PLAN.md](PLAN.md)
holds what to build next; [../ARCHITECTURE.md](../ARCHITECTURE.md) holds the
binding rules.

## Status (2026-07-02)

| Phase | State | Proof |
|---|---|---|
| 0 — contracts & time math | ✅ done | drift-free NTSC round-trips |
| 1 — ops + undo/redo stores | ✅ done | 20-random-ops fuzz gate, 5 seeds |
| 2 — decode engine | ✅ done | user-verified: 1080p60 scrub, 0.1ms cache hits, zero leak warnings |
| 3.1–3.4 — layout/ruler/clips/preview | ✅ done | browser E2E: import → preview → scrub, 30↔60fps rescale exact |
| **3 gate** | ⏳ OPEN | see PLAN.md "Immediate next" |
| 4 — edit ops + compositing | ⬜ | |
| 5 — export | ⬜ | |

161 tests green · `npm run build` and `npm run lint` clean · every phase
committed separately (see `git log --oneline`).

## What works today (user-visible)

Run `npm run dev` → editor shell. Import a video in the Media Pool → row
shows real metadata, Preview draws frame 0. Click/drag the timeline ruler →
playhead moves, Preview follows (rAF-coalesced, latest-wins). Seed clips via
`window.__stores` (dev only) → drag clips with snap-back on illegal drops,
one undo entry per drag. `?sandbox` = Phase 2 decode harness (delete after
the Phase 3 gate passes).

## Map (key files, one line each)

- `src/domain/` — `schema.ts` (types, half-open TimeRange, rational rates),
  `time.ts` (conversions incl. `snapToStandardRate`, `formatTimecode`),
  `operations.ts` (pure edits; REJECT = same doc reference + console.warn),
  `selectors.ts` (`docDurationFrames` — duration is derived, never stored).
- `src/state/` — `documentStore` (doc + past/future undo snapshots, cap
  100; rejected ops push no entry), `transportStore` (playhead/zoom/
  `dragPreview` — the scrub-vs-commit pattern), `mediaStore` (Map of
  assets; `addAsset` placeholder → controller fills via `updateAsset`).
- `src/workers/decode-protocol.ts` — canonical worker message types.
- `src/workers/decode.worker.ts` — injectable core (`createDecodeWorkerCore`);
  closes every VideoFrame ASAP, caches ImageBitmap copies (12) instead
  (raw frames starve the hw decoder pool!), backpressure at queue≥8,
  latest-wins seeks, catch-all error reporting.
- `src/engine/frame-cache.ts` — LRU with single-owner close discipline.
- `src/engine/worker-bridge.ts` — `DecodeWorkerBridge(worker)` +
  `setSource(rate, provider)` + `renderFrameAt(frame) → RenderResult`
  ('drawn'|'missed'|'superseded'|'error'; never rejects).
- `src/pipeline/demux.ts` — Mediabunny loadAsset + decoderConfig (de)serialize.
- `src/pipeline/decode.ts` — keyframe walk in decode order (B-frame safe,
  `verifyKeyPackets`, bounded overshoot, bytes copied for transfer).
- `src/app/previewController.ts` — THE COMPOSITION ROOT: only place stores
  meet engine/pipeline; DI seams for tests; idempotent per canvas
  (StrictMode); Phase 4 swaps its single-asset source for the compositor.
- `src/ui/` — components read state only; `timeline/useScrubScheduler.ts`
  = rAF coalescing reused by ruler + clip drag.

## Invariants that must survive refactors

1. Integer frames everywhere; seconds only at codec/clock boundaries.
2. Every VideoFrame closed the moment its pixels are used; ImageBitmaps in
   the ring buffer, closed on evict/clear. One owner at all times.
3. Rejected domain ops return the SAME doc reference (callers detect via
   `===`; store pushes no history).
4. Scrubbing/dragging writes transportStore only; pointerup commits ONE
   documentStore action.
5. Latest-wins at every async layer (bridge requestIds + worker generation).
6. Render isolation: playhead movement re-renders Playhead + Preview only —
   enforced by `<Profiler>` tests in `timeline.test.tsx`/`clipdrag.test.tsx`.

## Hard-won lessons (do not relearn these)

- **jsdom lies.** Three real bugs shipped past 127 green tests and were
  caught only by driving the actual browser: (1) bare `SharedArrayBuffer`
  reference → ReferenceError on normal pages; (2) `VideoDecoder.reset()`
  UNCONFIGURES the codec (reconfigure after every reset — see
  `resetDecoder`); (3) caching raw VideoFrames exhausted the hardware
  decoder's output pool → one-frame-per-eviction crawl. Always browser-
  verify pipeline changes (preview tools + `window.__stores`).
- **Pointer capture is not gesture truth.** Gate pointermove on your own
  session ref; capture is best-effort enhancement (it silently fails).
- **erasableSyntaxOnly** bans constructor parameter properties
  (`constructor(private x…)`) — declare fields explicitly. Bit us twice.
- **Windows/PowerShell:** multiline commit messages via file +
  `git commit -F <file>` (heredocs get mangled); tests may pass while
  `tsc -b` fails — always run both.
- Fake decoders/browsers in tests must model REAL semantics (queue growth,
  reset-unconfigures, flush-emits) or they green-light bugs.

## Dev/test toolbox

- `window.__stores.{document,transport,media}` — dev-only zustand handles
  (seed docs, read JSON, drive undo from the console or preview_eval).
- Generate a labeled test MP4 IN THE BROWSER (no ffmpeg on this machine):
  import mediabunny via `/@fs/E:/ClaudeSpace/WebCut/node_modules/mediabunny/dist/modules/src/index.js`,
  `Output` + `Mp4OutputFormat` + `BufferTarget` + `CanvasSource`, draw
  frame numbers, `File` it, then `DataTransfer` into a file input.
- Synthetic gestures: dispatch `PointerEvent`s with `bubbles: true`
  directly on elements (preview_click does NOT produce pointer events).
- Preview server: `.claude/launch.json` → `webcut-dev` on :5173. HMR of
  worker files fully reloads the page (in-page state like `__testFile`
  dies); module-map caches stale plain-URL imports — cache-bust probes
  with `?probe=N`.

## Open items (beyond PLAN.md phases)

- Phase 3 gate (keyboard undo/redo, profiler pass, user manual check) —
  then DELETE `src/dev/DecodeSandbox.tsx` + the `?sandbox` branch.
- `engine/playback-engine.ts` still a stub — audio-clock playback loop
  (ARCHITECTURE rule 3) has not started; no audio path at all yet.
- MediaPool → timeline flow (creating clips from assets) doesn't exist;
  clips are seeded via `__stores` for now. Needed early in Phase 4.
- Clip selection (`selectedClipId`) arrives with Inspector (4.3).
- `Transition`s exist in schema only. Images not previewable (video only).
- `mediaStore.addAsset` is still the placeholder path; previewController
  re-fetches the blob URL for demuxing (works; slightly wasteful).

## Working agreements (the user's explicit preferences)

- ONE module per turn, micro-steps (domain → state → ui) verified
  separately; never skip a phase gate; commit after each module with the
  message file + `-F` pattern, `Co-Authored-By: Claude Opus 4.8
  <noreply@anthropic.com>`.
- End-of-turn summaries: SHORT, plain words, low jargon (user has AuADHD —
  dense dumps fog them; they like emoji and warmth). Deep detail belongs in
  commits/docs, not the summary.
- Be honest about mistakes and rejected-first-try test runs; the user
  values the "honest notes" sections.
