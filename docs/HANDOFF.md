# WebCut — Session Handoff

Read this first in a new session. It is the deep context; [PLAN.md](PLAN.md)
holds what to build next; [../ARCHITECTURE.md](../ARCHITECTURE.md) holds the
binding rules.

## Status (2026-07-06)

| Phase | State | Proof |
|---|---|---|
| 0 — contracts & time math | ✅ done | drift-free NTSC round-trips |
| 1 — ops + undo/redo stores | ✅ done | 20-random-ops fuzz gate, 5 seeds |
| 2 — decode engine | ✅ done | user-verified: 1080p60 scrub, 0.1ms cache hits, zero leak warnings |
| 3.1–3.4 — layout/ruler/clips/preview | ✅ done | browser E2E: import → preview → scrub, 30↔60fps rescale exact |
| **3 gate** | ✅ closed | user manual pass 2026-07-06; sandbox deleted |
| 4.0 — media → timeline drag | ✅ done | browser E2E: drag asset row → clip on lane, kind-gated, 1 undo entry |
| 4.0.5 — transport bar (user request) | ✅ done | browser: ~30fps vs wall clock, pause freezes, ±1 steps, restart at end |
| 4.0.6 — 12h virtualized ruler (user request) | ✅ done | browser: 1.296M-px runway, 18–27 tick nodes at any scroll, end label flush right |
| 4.1a — compositor core (`compositeFrame`) | ✅ done | 12 unit tests: stack order, transform math, failure isolation, concurrent fetch |
| 4.1b — render worker (per-asset decoders) | ✅ done | 13 unit tests: double-buffer blit, latest-wins, PiP loan survival (mutation-tested), fault containment |
| 4.1c — render bridge + preview swap | ⬜ | browser-verify: stacked clips, opacity, hidden toggle |
| 4.2+ — trim/split UI, Inspector | ⬜ | |
| 5 — export | ⬜ | |

246 tests green · `npm run build` and `npm run lint` clean · every phase
committed separately (see `git log --oneline`). Phase 3 gate CLOSED
2026-07-06 (user manual pass; DecodeSandbox deleted).

## What works today (user-visible)

Run `npm run dev` → editor shell. Import a video in the Media Pool → row
shows real metadata, Preview draws frame 0. Click/drag the timeline ruler →
playhead moves, Preview follows (rAF-coalesced, latest-wins). Drag a media
row onto a lane (4.0): compatible lanes highlight, drop creates the clip at
the pointer, one undo entry (kind-gated: video/image → V lanes, audio → A
lanes; rows drag only after metadata arrives). Drag clips with snap-back on
illegal drops, one undo entry per drag. Transport bar between preview and
timeline (4.0.5): play/pause + one-frame steps — playback derives frames
from an AudioContext clock (rule 3), parks on the last frame, restarts
from 0 when played at the end, auto-pauses when a scrub starts.

## Map (key files, one line each)

- `src/domain/` — `schema.ts` (types, half-open TimeRange, rational rates),
  `time.ts` (conversions incl. `snapToStandardRate`, `formatTimecode`),
  `operations.ts` (pure edits; REJECT = same doc reference + console.warn),
  `selectors.ts` (`docDurationFrames`, `activeClipAt`, `clipSourceFrame` —
  all derived reads, never stored).
- `src/pipeline/render.ts` — `compositeFrame(doc, frame, ctx, source)`:
  THE compositing path (preview worker in 4.1b, export in 5 — same code).
  Injected `Composite2D` ctx + `FrameSource`; concurrent fetch phase, then
  synchronous draw; `{drawn, missing}` result; per-clip try/finally.
- `src/state/` — `documentStore` (doc + past/future undo snapshots, cap
  100; rejected ops push no entry), `transportStore` (playhead/zoom/
  `dragPreview` — the scrub-vs-commit pattern), `mediaStore` (Map of
  assets; `addAsset` placeholder → controller fills via `updateAsset`).
- `src/workers/decode-protocol.ts` — canonical worker message types.
- `src/workers/render-protocol.ts` — render-worker message types (types
  only). The MAIN side computes all µs targets; entries are keyed by exact
  (assetId, sourceFrame); setDoc must precede composites built from it.
- `src/workers/render.worker.ts` — compositing worker (4.1b): decoder +
  bitmap cache PER ASSET, FrameSource → compositeFrame on a SCRATCH canvas,
  blit→visible only if newest (double buffer), per-asset batch chains,
  loaned bitmaps (evict-proof mid-composite, epoch-checked return). Imports
  pipeline/render (sanctioned) + decode.worker types via `import type`
  ONLY (a runtime import would register the decode listener here too!).
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
- `src/app/transportController.ts` — second composition root (same
  pattern): PlaybackEngine ↔ transportStore, lazy AudioContext on first
  play (click = allowed gesture), clamps every frame vs CURRENT doc
  duration, pauses on scrub-start. `src/engine/playback-engine.ts` = the
  pure loop (injected clock/ticks; floor + 1e-6 frame epsilon so NTSC
  boundaries don't flip late; emits newest frame only, latest-wins).
  UI facade: `src/ui/TransportBar.tsx` (subscribes to isPlaying ONLY).
- `src/ui/` — components read state only; `timeline/useScrubScheduler.ts`
  = rAF coalescing reused by ruler + clip drag; `dnd.ts` = MediaPool→Track
  drag payload contract + asset-kind↔track-kind gating (kind policy lives
  here because domain/ can't see assets). `timeline/Ruler.tsx`: 12h min
  runway, ticks VIRTUALIZED against the `[data-timeline-scroll]` ancestor
  (app shell marks it; bare tests get a fallback window); the final frame
  always gets a right-anchored end label.

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
  DnD: real `new DataTransfer()` + `DragEvent` work in Chrome; jsdom has
  NEITHER (only PointerEvent), so `test/setup.ts` polyfills DragEvent as a
  MouseEvent subclass — without it drop clientX silently becomes undefined
  and tests green-light broken frame math.
- Preview server: `.claude/launch.json` → `webcut-dev`, :5173 preferred but
  `autoPort: true` + vite reading `PORT` (vite.config) let parallel chat
  sessions run their own server on an assigned port.
- HMR of worker files fully reloads the page (in-page state like
  `__testFile` dies); module-map caches stale plain-URL imports —
  cache-bust probes with `?probe=N` (this double-instances mediabunny →
  its "loaded twice" console warning; harness artifact, ignore).

## Open items (beyond PLAN.md phases)

- Playback exists but is SILENT: the AudioContext is clock-only (rule 3
  honored); audio decode/mix/output does not exist yet. Playback also
  still shows the single demuxed asset, not the timeline (4.1 compositor).
- Preview still single-asset (previewController shows the last-imported
  asset; dropped clips render as blocks but only composite in 4.1).
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
