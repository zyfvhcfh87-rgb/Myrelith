# WebCut — Remaining Plan (Phases 3-gate, 4, 5)

Adapted from the original implementation plan (source:
`C:\Users\Aryel\Pictures\nle-implementation-plan.md`) with corrections for
how the codebase actually evolved — trust THIS file over the original where
they differ. Companion context: [HANDOFF.md](HANDOFF.md).

## Phase 3 gate — ✅ CLOSED (2026-07-06)

- [x] Wire Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) to documentStore undo/redo —
  `app/useUndoRedoShortcuts.ts` (window listener, no subscriptions;
  guards editable targets, AltGr, IME).
- [x] User ran the manual pass (Profiler render isolation, drag → doc JSON
  → undo reverts) — confirmed 2026-07-06.
- [x] `src/dev/DecodeSandbox.tsx` and the `?sandbox` branch in `main.tsx`
  DELETED.

## Phase 4 — Trim / Split / Multi-Track Edit Ops

Goal: full editing surface + correct multi-track compositing.

### 4.0 ✅ DONE (2026-07-06) Media → timeline flow
Shipped: pure ops `insertClip(doc, trackId, clip)` + `clipFromAsset(asset,
startFrame)`, documentStore.insertClip (one undo entry; rejects push none),
HTML5 drag from MediaPool rows onto Track lanes (`ui/dnd.ts` carries the
payload contract + asset-kind↔track-kind gating; drop = pointer frame via
the ruler's px→frame mapping). Browser-verified drop/undo/redo.

### 4.0.5 ✅ DONE (2026-07-06; user-requested, not in original plan) Transport bar
Play/pause + one-frame steps between Preview and Timeline. Shipped:
`engine/playback-engine.ts` (real now, no longer a stub — injected
AudioContext clock per rule 3, floor+epsilon frame math), app/
transportController (composition root; scrub preempts playback, end
parks+pauses, play-at-end restarts), ui/TransportBar (subscribes to
isPlaying only — invariant 6 kept). Playback is silent + single-asset
until 4.1/audio; keyboard arrows still belong to 4.2.

### 4.0.6 ✅ DONE (2026-07-06; user-requested) 12-hour virtualized ruler
The 60s minimum runway ended mid-screen on wide monitors. Now
MIN_RULER_SECONDS = 12h with tick VIRTUALIZATION (only the viewport ±1
screen of ticks exist in the DOM — a full 12h runway would be ~8.6k
nodes); scroll window read from the `[data-timeline-scroll]` ancestor,
rAF-coalesced. The runway's last frame always shows a right-anchored
label so scrolling right ends on a clean 12:00:00:00 mark. Native
scrollbar is twitchy at 1px/frame over 1.3M px — acceptable until zoom
controls land (post-4.2 candidate).

### 4.1 Compositing — `pipeline/render.ts` + `workers/render.worker.ts`
Sliced into three module-turns:

- [x] **4.1a compositor core** — DONE 2026-07-06. `pipeline/render.ts`:
  `compositeFrame(doc, frame, ctx, source)` draws each visible video
  track's active clip bottom-to-top (tracks[0] first) with Transform
  (scale→rotate→translate around anchor) + clamped opacity; black
  background; text clips + opacity≤0 skipped. Canvas2D only. The 2D ctx
  (`Composite2D`) and pixels (`FrameSource.getFrame(assetId, sourceFrame)
  → Promise<ImageBitmap|null>`) are injected; all fetches for one
  composite issue CONCURRENTLY, drawing is synchronous afterwards
  (bitmap-validity window), per-clip try/finally so a dead bitmap can't
  poison the ctx stack; result reports `{drawn, missing}` clip ids so the
  caller knows to re-composite after decoders warm up. New domain
  selectors: `activeClipAt(track, frame)`, `clipSourceFrame(clip, frame)`.
  12 unit tests (order, transform math, failure isolation, concurrency).
- [ ] **4.1b render worker** — `workers/render.worker.ts`: one decode core
  per active asset (reuse createDecodeWorkerCore pieces), owns the
  transferred preview canvas sized to doc dims, implements FrameSource
  over the per-asset caches, runs compositeFrame per seek (latest-wins at
  the request layer, NEVER dropping requests within one composite — see
  render.ts contract), auto re-composites when `missing` clips decode.
  Needs a render-protocol (doc snapshot + frame + per-asset chunks).
- [ ] **4.1c previewController swap** — single-asset preview → compositor
  (DI seams were built for this); demux/config per asset used by the doc,
  not just the newest import. Browser-verify: 2 stacked clips, opacity
  blend, hidden-track toggle.

### 4.2 Split / Trim wiring
- Keyboard 'S' → documentStore.splitClipAtPlayhead(transportStore
  .getState().playheadFrame) — the store action already takes the frame as
  a param (it never reads transportStore itself).
- Clip edge-dragging in ClipView → documentStore.trimClip with the SAME
  scrub-preview-then-commit pattern (extend transportStore dragPreview or
  add a trimPreview variant; one undo entry per gesture).
- rippleDelete already exists as an op + store action; add Delete key.

### 4.3 Inspector
Add `selectedClipId` to transportStore; click-to-select in ClipView.
Inspector edits transform (x/y/scale/rotation) + opacity, committing on
blur/Enter (NOT per keystroke), via a new documentStore action
`updateClipTransform` (needs a matching pure op in domain/operations.ts —
op does not exist yet).

### Phase 4 gate
- [ ] Split a clip, trim both halves, drag one to another track —
  compositing order stays correct (cross-track moveClip already works).
- [ ] Every edit op = exactly one undo entry (no partial entries from
  drag-in-progress states).
- [ ] Frame-step (arrow keys) advances exactly one frame vs ruler timecode.
- [ ] 2 video tracks, top clip at 50% opacity — alpha blend visually correct.

## Phase 5 — Export Pipeline

### 5.1 `pipeline/export.ts`
`exportTimeline(doc, settings): AsyncGenerator<number>` (progress 0..1):
Mediabunny `Output` + `Mp4OutputFormat` + `BufferTarget`; for each output
frame call `compositeFrame` on an offscreen canvas, add via
`CanvasSource.add(timestampSec, durationSec)` AWAITING the promise
(encoder backpressure). Audio: decode+mix active audio clips per timestamp,
encode via AudioEncoder. CFR output; audio sample count must equal
`docDurationFrames(doc) / fps * sampleRate` (NOTE: duration comes from the
SELECTOR `docDurationFrames(doc)` — `doc.durationFrames` does not exist,
deliberate deviation from the original plan). Pad/trim tail by a sample or
two rather than letting rounding accumulate.
The in-browser encode pattern is already proven — see HANDOFF.md toolbox
(we generated test MP4s with Output/CanvasSource in Phase 2.5/3.4).

### 5.2 Export UI
Toolbar Export button → modal (resolution/format) → progress bar from the
generator → download via `URL.createObjectURL(new Blob([buffer]))`.

### Phase 5 / MVP gate
- [ ] Export a 30s, 3-clip, 2-track timeline w/ one crossfade + one trim.
  (Crossfade requires implementing Transition rendering in compositeFrame —
  schema exists, renderer does not yet.)
- [ ] VLC + QuickTime playback, no perceptible A/V desync.
- [ ] Spot-check exported frame at t=10s vs preview.
- [ ] `ffprobe -show_streams`: avg_frame_rate == r_frame_rate (CFR). No
  ffmpeg on this machine — user installs it or checks with another tool.
- [ ] No memory growth exporting a 2-min timeline (Chrome Task Manager).

## Test strategy per layer (unchanged from original)

domain/, state/: Vitest. pipeline/, workers/: injectable-core unit tests +
browser verification via preview tools. ui/: RTL + `<Profiler>` render-count
tests + manual QA. E2E: manual + browser-driven pointer synthesis.

## Cross-cutting reminders for new sessions

- Follow ARCHITECTURE.md dependency arrows; new store↔engine wiring goes
  through app/ composition-root controllers (previewController pattern).
- Micro-step order inside a module turn: domain → state → app/ui, tests at
  each step; browser-verify anything touching pipeline/workers/gestures.
- Original plan's per-module prompt template still applies (one file, list
  constraints, paste acceptance tests).
