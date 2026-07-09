# Architecture Rules (read before editing)

This file is the single source of truth for module boundaries and the
non-negotiable rules. Re-read it at the start of every coding session.

## Dependency direction (one-way only)

```
  ui/  →  state/  →  domain/
  engine/, pipeline/, workers/  →  domain/   (never import React)
  domain/  →  nothing (pure TS, no browser APIs)
```

- `domain/` is pure TypeScript: no React, no DOM, no WebCodecs, no browser
  globals. It must run unchanged in Node (Vitest) and in a worker.
- `state/` may import `domain/`. It must NOT import `ui/`, `engine/`,
  `pipeline/`, or `workers/`.
- `ui/` may import `state/` (and `domain/` types). It must NOT import
  `pipeline/`, `workers/`, or `engine/` directly from a `.tsx` file.
- `engine/`, `pipeline/`, `workers/` may import `domain/`. They must never
  import React or anything from `ui/` or `state/`.
- `app/` is the COMPOSITION ROOT: non-component `.ts` controllers there
  (e.g. `app/previewController.ts`) may import state/ AND engine/pipeline
  to wire them together. ui components may import those controllers as
  their facade — but still never engine/, pipeline/, or workers/ directly.
- Sanctioned exceptions between those three (and nothing more):
  - anyone may import `workers/decode-protocol.ts` and
    `workers/render-protocol.ts` (types only, no runtime),
  - `workers/` may import `engine/frame-cache.ts` (pure class, no deps),
  - `workers/render.worker.ts` may import `pipeline/render.ts` (the pure
    compositing core: imports domain/ only, no browser I/O — the worker is
    its runtime host, exactly like export.ts will be in Phase 5) and the
    STRUCTURAL TYPES exported by `workers/decode.worker.ts` via
    `import type` (erased at build time — a runtime import would register
    the decode worker's message listener inside the render worker),
  - `engine/worker-bridge.ts` references the worker FILE via
    `new Worker(new URL(...))` — a URL, not a module import; the pipeline
    chunk source reaches the bridge by injection, never by import.

## Non-negotiable rules

1. **Close every frame.** Every `VideoFrame` / `AudioData` / `ImageBitmap`
   MUST be `.close()`'d in a `finally` block or immediately after use. Never
   store one in React state or a closure that outlives the current draw call.
2. **Integer frames, not floats.** All timeline math uses integer frame
   counts + `RationalTime`, never raw floating-point seconds. Convert to
   seconds only at the boundary (encoder/decoder/audio-clock).
3. **Audio is the master clock.** Playback is driven by the audio clock
   (`AudioContext.currentTime`). Video always re-derives "which frame to
   show" from that clock — it never free-runs on its own timer.
4. **UI reads state only.** UI components import from `state/` only. A `.tsx`
   file never imports `pipeline/`, `workers/`, or `engine/` directly.
5. **One module per prompt.** If a change requires touching more than one
   layer (ui + state + domain in the same prompt), stop and split it into
   separate prompts.

## Scrubbing-vs-committed pattern

Drag/scrub interactions update only `transportStore` preview state during the
gesture (coalesced to one update per animation frame). The `documentStore`
mutation — which creates an undo-history entry — happens once, on `pointerup`.
Never write to `documentStore` on every `pointermove`.

## Data model — `src/domain/schema.ts` (canonical, implemented)

`domain/schema.ts` defines the authoritative interfaces every phase
references: `FrameRate`, `RationalTime`, `TimeRange`, `MediaAsset`,
`TimelineDoc`, `Track`, `Clip`, `Transform`, `Effect`, `Transition`,
`TextProps`. Read that file for field-level docs. Key invariants:

- `TimeRange` is **half-open** `[startFrame, startFrame + durationFrames)`;
  ranges that merely touch do not overlap. All ranges are integer frames at
  the document rate.
- MVP: clips play at speed 1.0 and assets are conformed to the doc rate, so
  `sourceRange.durationFrames === timelineRange.durationFrames` always.
- Clips on one track are sorted by `timelineRange.startFrame` and pairwise
  non-overlapping; `operations.ts` rejects violations.
- `TimelineDoc.tracks[0]` composites first (bottom layer).
- Document duration is derived (selectors), never stored.
- `TimelineDoc` must survive `JSON.stringify`/`parse` losslessly (undo
  history depends on it); `MediaAsset.objectUrl` is session-scoped.

## Store action contracts

- `DocumentState` — implemented in `src/state/documentStore.ts` (canonical):
  `setDoc`, `splitClipAtPlayhead(frame)`, `splitClipAt(clipId, frame)`,
  `insertClip(trackId, clip)`, `insertClips([{trackId, clip}...])` (atomic
  batch, one history entry — the A/V drop path), `trimClip(clipId, edge,
  delta)`,
  `rippleTrim(clipId, edge, delta)`, `slipClip(clipId, delta)`,
  `slideClip(clipId, delta)`, `moveClip(clipId, toTrackId, toFrame)`,
  `rippleDelete(clipId)`, `addEffect(clipId, effect)`,
  `addTrack(kind)`, `setTrackFlags(trackId, {hidden?, muted?, solo?,
  locked?})` (idempotent patches push no history entry; flags and
  renames WORK on locked tracks — metadata, not content),
  `renameTrack(trackId, name)`, `removeTrack(trackId)` (locked tracks
  reject), `setClipVolume(clipId, volume)` (clamped [0,2]),
  `unlinkClip(clipId)` (dissolves the clip's whole link group), `undo`,
  `redo`. The geometry actions (move/trim/rippleTrim/slip/slide/
  rippleDelete/splitClipAt/splitClipAtPlayhead) are LINK-AWARE: they
  delegate to domain/linking wrappers, so edits apply to every member of
  a `Clip.linkGroupId` group atomically (any member rejecting rolls the
  whole edit back); transform/volume edits deliberately do NOT follow
  links. History: `past`/`future` snapshot stacks capped at 100.
  Rejected domain ops return the SAME doc reference, so they push no
  history entry. Actions take the frame as a parameter — documentStore
  never reads transportStore (UI wiring passes the playhead in).
- `TransportState` — `src/state/transportStore.ts`: `playheadFrame` (int,
  setter rounds + clamps >= 0), `isPlaying`, `isScrubbing`, `zoom`
  (px/frame, > 0), `inOut`, `dragPreview` ({clipId, startFrame,
  linkGroupId?} | null — the live half of the scrubbing-vs-committed
  pattern for select-tool moves; pointerup commits ONE
  documentStore.moveClip and clears it), `tool`
  ('select'|'razor'|'trim'|'slip'|'slide'), `selectedClipId`
  (ephemeral, never in undo), `editPreview` ({clipId, kind, deltaFrames,
  linkGroupId?} | null — same live-preview contract for trim/ripple/
  slip/slide gestures). The optional linkGroupId lets partner ClipViews
  ghost a linked gesture live. No history, no side effects, never
  touches documentStore.
- `MediaState` — `src/state/mediaStore.ts`: `assets: Map<AssetId,
  MediaAsset>`, `addAsset(file)` (placeholder until Phase 2 demux),
  `removeAsset(id)` (revokes the object URL), `visuals: Map<AssetId,
  AssetVisuals>` + `setAssetVisuals(id, v)` (filmstrip/waveform images;
  the store OWNS those object URLs — revokes on removal/replacement and
  for late results after removal). Session-scoped, not serialized with
  the project.
- Worker messages — `src/workers/decode-protocol.ts` (canonical):
  `ToDecodeWorker` (`init`/`configure`/`seek`/`close`) and `FromDecodeWorker`
  (`configured`/`frameReady`/`error`). Types-only file; BOTH the worker and
  `engine/worker-bridge.ts` import it (that is the one sanctioned
  cross-import between those layers — it carries zero runtime code).
  Timestamps are integer microseconds; frame-number conversion happens on
  the bridge side. Seeks are latest-wins: only the newest seek is guaranteed
  a `frameReady`; superseded seeks are resolved by the bridge, and a
  worker `error` carrying a requestId also settles that request.

## Folder layout

```
src/
  domain/      time, schema, operations, selectors      (pure TS)
  state/       documentStore, transportStore, mediaStore (Zustand)
  engine/      playback-engine, worker-bridge, frame-cache
  workers/     decode.worker, render.worker
  pipeline/    demux, decode, render, export
  ui/          Toolbar, MediaPool, Preview, Inspector
  ui/timeline/ Timeline, Track, ClipView, Ruler, Playhead
  app/         App, layout.css
  dev/         temporary scratch harnesses — may import anything, never shipped
```
