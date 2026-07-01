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

## Data model (filled in Phase 0 — `domain/schema.ts`)

Phase 0 implements these interfaces in `domain/schema.ts` and they become the
authoritative contract other phases reference:

- `RationalTime`, `TimeRange`
- `MediaAsset`, `TimelineDoc`, `Track`, `Clip`
- `Transform`, `Effect`, `Transition`, `TextProps`

## Store action contracts (filled in Phase 1)

- `DocumentActions`: `splitClipAtPlayhead`, `trimClip`, `moveClip`,
  `addEffect`, `undo`, `redo`.
- Worker message unions `ToWorker` / `FromWorker` (filled in Phase 2).

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
```
