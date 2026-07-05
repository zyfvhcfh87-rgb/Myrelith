# WebCut — Remaining Plan (Phases 3-gate, 4, 5)

Adapted from the original implementation plan (source:
`C:\Users\Aryel\Pictures\nle-implementation-plan.md`) with corrections for
how the codebase actually evolved — trust THIS file over the original where
they differ. Companion context: [HANDOFF.md](HANDOFF.md).

## Immediate next: Phase 3 gate

- [ ] Wire Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) to documentStore undo/redo —
  a small app-level keyboard hook (app/ or ui/, reads state only).
- [ ] Verify with React DevTools Profiler in the browser: 5s of scrubbing
  re-renders ONLY Playhead + Preview (automated Profiler tests exist;
  this is the manual confirmation pass).
- [ ] Dragging a clip updates the doc JSON (inspect via
  `window.__stores.document.getState().doc`) and undo visibly reverts it.
- [ ] User runs the manual pass; then DELETE `src/dev/DecodeSandbox.tsx`
  and the `?sandbox` branch in `main.tsx`.

## Phase 4 — Trim / Split / Multi-Track Edit Ops

Goal: full editing surface + correct multi-track compositing.

### 4.0 (added; not in original plan) Media → timeline flow
Dragging/adding an asset from MediaPool onto a track (creates a Clip via a
new domain op `insertClip(doc, trackId, clip)` + documentStore action).
Without this nothing else in Phase 4 is user-reachable. Keep the op pure,
reject overlaps like every other op.

### 4.1 Compositing — `pipeline/render.ts` + `workers/render.worker.ts`
Implement `compositeFrame(doc, frame)`: draw each track's active clip at
`frame` bottom-to-top (tracks[0] first), applying Transform
(translate/scale/rotate around anchor) + opacity via ctx.globalAlpha before
drawImage. Skip `hidden` tracks. Canvas2D only — no WebGL yet.
Sources: per-asset decode (reuse VideoChunkSource / decode-worker pattern;
design decision needed: one decoder per active asset inside render.worker,
reusing createDecodeWorkerCore pieces where possible).
Then swap `app/previewController.ts` from single-asset preview to the
compositor (its DI seams were built for exactly this swap).

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
