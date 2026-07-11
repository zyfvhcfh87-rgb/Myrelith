# Phase 5.1 CFR Video Export Foundation Design

**Date:** 2026-07-11
**Status:** Approved for implementation

## Goal

Create the first bounded Phase 5 export slice: a video-only, constant-frame-
rate export orchestrator in `src/pipeline/export.ts`. It schedules every
document frame exactly once, composites through the existing
`compositeFrame`, respects encoder backpressure, reports progress, returns the
finished file buffer, and releases every borrowed frame and export resource.

This slice establishes the control flow and ownership contracts that the real
Mediabunny video adapters and the later audio mixer will use. It is deliberately
not yet a user-visible Export button.

## Scope and Module Boundary

This is one pipeline-module change:

- Implement `src/pipeline/export.ts`.
- Add focused tests in `src/pipeline/export.test.ts`.
- Import only domain types/selectors/time helpers and `pipeline/render.ts`.
- Keep media-store, app-controller, UI, worker, and live-playback changes out of
  this slice.

The pipeline must not import `state/mediaStore`. The document contains only
asset ids, so decoded pixels arrive through an injected media-source port. The
output canvas and encoder/muxer arrive through an injected video-sink port.
Later slices will provide their real browser/Mediabunny implementations without
changing the scheduling rules proven here.

## MVP Settings and Result

The foundation supports one explicit output profile:

- Container: MP4.
- Video codec: AVC/H.264.
- Resolution: the document's `width` by `height`.
- Frame rate: the document's exact rational `frameRate`.
- Bitrate: a positive integer supplied in settings.

Resolution scaling, additional containers/codecs, and codec auto-selection are
later UI/export-adapter work. The foundation must not silently substitute a
different format or rate.

```ts
export interface ExportSettings {
  format: 'mp4'
  videoCodec: 'avc'
  videoBitrate: number
}

export interface ExportResult {
  buffer: ArrayBuffer
  mimeType: 'video/mp4'
}
```

## Injected Ports

`compositeFrame` does not own or close returned images. Export therefore uses a
per-output-frame lease: the lease supplies every asset/source-frame image
needed by one composite and owns those images until `close()`.

```ts
export interface ExportFrameLease extends FrameSource {
  close(): void | Promise<void>
}

export interface ExportMediaSource {
  openFrame(docFrame: number): Promise<ExportFrameLease>
  close(): void | Promise<void>
}
```

The video sink owns the drawing context and the eventual encoded file. Every
`addFrame` call is a backpressure boundary and must settle before the next
timeline frame begins.

```ts
export interface ExportVideoSink {
  ctx: Composite2D
  addFrame(timestampSec: number, durationSec: number): Promise<void>
  finalize(): Promise<ExportResult>
  cancel(): Promise<void>
}

export interface ExportDeps {
  composite: typeof compositeFrame
  createVideoSink(
    doc: TimelineDoc,
    settings: ExportSettings,
  ): Promise<ExportVideoSink>
}
```

The injected dependency object is required in this foundation slice. The real
Mediabunny adapter slice will supply the production implementation while tests
continue to pass recording fakes.

## Public Generator Contract

```ts
export function exportTimeline(
  doc: TimelineDoc,
  settings: ExportSettings,
  media: ExportMediaSource,
  deps: ExportDeps,
): AsyncGenerator<number, ExportResult, void>
```

Progress values are finite, monotonic, and clamped to `[0, 1]`:

1. A non-empty export first yields `0`.
2. After frame `i` is encoded, it yields `(i + 1) / (frameCount + 1)`.
3. After finalization succeeds, it yields `1`.
4. The following `next()` completes the generator with `ExportResult`.

The future app controller must consume the generator with explicit `next()`
calls. A plain `for await` loop is not sufficient because JavaScript discards
an async generator's return value in that form.

## Frame and Timing Flow

`frameCount` is always `docDurationFrames(doc)`. An empty document is not a
valid export and rejects before a sink or frame lease is created.

For every integer document frame `frame` in `[0, frameCount)`:

1. Open exactly one frame lease for `frame`.
2. Call `compositeFrame(doc, frame, sink.ctx, lease)`.
3. Treat a non-empty `CompositeResult.missing` list as a fatal offline-export
   error; export must never hide missing source media behind black pixels.
4. Close the lease in `finally`, after compositing settles.
5. Compute `timestampSec` independently with
   `framesToSeconds(frame, doc.frameRate)`.
6. Compute the duration with `framesToSeconds(1, doc.frameRate)`.
7. Await `sink.addFrame(timestampSec, durationSec)` before opening the next
   frame lease.
8. Yield the frame's progress value.

Timestamps are derived from integer frame indices on every iteration. The
implementation must never advance a floating-point timestamp accumulator.
This keeps 30000/1001 and other rational rates drift-free at the encoder
boundary and produces a constant-frame-rate schedule.

## Ownership, Cancellation, and Errors

Once generator iteration begins, export owns the supplied media source until
the generator completes or closes.

- Every successfully opened frame lease closes exactly once on success,
  missing media, composite failure, encoder failure, or consumer cancellation.
- The media source closes exactly once after validation/finalization cleanup,
  including an empty-document rejection.
- A created sink finalizes exactly once on success.
- A created sink cancels exactly once on any failure or early
  `generator.return()`; it is not canceled after successful finalization.
- Missing clip errors identify the affected clip ids.
- Invalid settings, non-finite timing inputs, sink creation failure,
  compositing failure, `addFrame` failure, and finalization failure reject the
  generator rather than returning a partial buffer.
- The first operational failure remains the surfaced error. Cleanup is still
  awaited; a cleanup error is surfaced only when no earlier error exists.

No `VideoFrame`, `ImageBitmap`, or other decoded frame may be stored beyond its
frame lease. `ExportResult.buffer` is the only retained export artifact.

## Verification

Focused Vitest tests will prove:

- Exact frame order, timestamps, and one-frame durations at 30/1 and
  30000/1001.
- The next frame cannot open while the previous `addFrame` promise is pending.
- Progress starts at 0, stays monotonic and below 1 during frame work, reaches
  1 only after finalization, and the generator then returns `ExportResult`.
- A frame lease closes after every successful composite and on every failure
  path.
- Missing media prevents `addFrame`, reports the clip ids, cancels the sink,
  and closes all owned resources.
- Composite, encoder, and finalization failures cancel and clean up exactly
  once while preserving the original error.
- Early `generator.return()` triggers the same cleanup.
- An empty timeline rejects before sink/frame creation and still closes the
  supplied media source.
- Invalid settings reject without producing output.

The focused test, full suite, production build, and lint must pass. This slice
has no observable browser behavior, so its browser gate is deferred to the
real Mediabunny adapter slice.

## Following Phase 5 Slices

Work remains intentionally ordered as separate module turns:

1. Add real Mediabunny MP4/AVC and sequential video-decode adapters, then
   browser-export a fixture and inspect the file.
2. Extend export with bounded, integer-sample audio blocks using
   `audibleTracks`, clip source offsets, per-clip volume, resampling, channel
   conversion, and an exact final sample count.
3. Implement crossfade selection/rendering and update preview frame requests
   so preview and export continue to share `compositeFrame` truth.
4. Add the app composition-root controller.
5. Add the Export modal, progress display, and Blob download UI.
6. Run the Phase 5/MVP manual and file-inspection gate.

Live editor audio playback is not part of this export phase. The audio-mixing
contracts should remain reusable, but playback needs its own design and gate.

## Dependency Reproducibility

The repository lockfile resolves Mediabunny 1.50.3 while the current
`node_modules` folder reports 1.50.8. This foundation slice does not import
Mediabunny. Before the real adapter slice, restore the lockfile installation
and verify the adapter against the locked declarations. Do not silently change
the dependency version as part of export behavior work.

## Non-goals

- Real Mediabunny decoding, encoding, or muxing in this foundation slice.
- Audio mixing or live audio playback.
- Crossfade rendering or transition authoring UI.
- Resolution scaling or multiple export formats/codecs.
- Export modal, download flow, persistence, or background jobs.
- Streaming the final container to disk; the planned MVP still returns an
  in-memory buffer.
