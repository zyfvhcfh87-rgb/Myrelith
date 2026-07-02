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
- Sanctioned exceptions between those three (and nothing more):
  - anyone may import `workers/decode-protocol.ts` (types only, no runtime),
  - `workers/` may import `engine/frame-cache.ts` (pure class, no deps),
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
  `setDoc`, `splitClipAtPlayhead(frame)`, `trimClip(clipId, edge, delta)`,
  `moveClip(clipId, toTrackId, toFrame)`, `rippleDelete(clipId)`,
  `addEffect(clipId, effect)`, `undo`, `redo`.
  History: `past`/`future` snapshot stacks capped at 100. Rejected domain
  ops return the SAME doc reference, so they push no history entry.
  Actions take the frame as a parameter — documentStore never reads
  transportStore (UI wiring passes the playhead in).
- `TransportState` — `src/state/transportStore.ts`: `playheadFrame` (int,
  setter rounds + clamps >= 0), `isPlaying`, `isScrubbing`, `zoom`
  (px/frame, > 0), `inOut`. No history, no side effects, never touches
  documentStore.
- `MediaState` — `src/state/mediaStore.ts`: `assets: Map<AssetId,
  MediaAsset>`, `addAsset(file)` (placeholder until Phase 2 demux),
  `removeAsset(id)` (revokes the object URL). Session-scoped, not
  serialized with the project.
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
