# Phase 5.1 CFR Video Export Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a video-only constant-frame-rate export orchestrator that composites every derived document frame in order, awaits encoder backpressure, reports progress, returns the finished MP4 buffer contract, and cleans up every borrowed resource.

**Architecture:** Keep the slice entirely in the pipeline layer. The export orchestrator consumes injected per-frame media leases and an injected video sink, reuses compositeFrame for pixels, derives timestamps from integer document frames, and owns cancellation/cleanup from first iteration through generator completion.

**Tech Stack:** TypeScript 6 with erasableSyntaxOnly, Vitest 4, existing domain selectors/time helpers, and the existing pipeline compositeFrame contract. Mediabunny is intentionally not imported in this foundation slice.

## Global Constraints

- Re-read ARCHITECTURE.md before editing.
- Change only the pipeline module: src/pipeline/export.ts and its focused src/pipeline/export.test.ts.
- Do not import state, app, UI, engine, workers, React, or Mediabunny.
- Derive frame count only from docDurationFrames(doc); TimelineDoc has no durationFrames field.
- Keep all timeline scheduling in integer document frames. Convert each frame index to seconds independently with framesToSeconds only at the sink boundary.
- Use the document's exact width, height, and rational frame rate. The only settings profile is MP4 + AVC/H.264 + a positive integer bitrate.
- Reuse compositeFrame; do not duplicate compositing or inspect tracks inside export.ts.
- Treat any non-empty CompositeResult.missing list as fatal. Offline export must not encode silent black substitutions for missing clips.
- Every successfully opened ExportFrameLease closes exactly once, including all failure paths.
- Once iteration starts, ExportMediaSource closes exactly once. A created, unfinalized sink cancels exactly once on failure or early generator.return().
- Preserve the first operational error over later cleanup errors; surface the first cleanup error only when no operational error exists.
- Yield finite monotonic progress: 0 first, (frame + 1) / (frameCount + 1) after each encoded frame, then 1 after finalization and media cleanup. Return ExportResult on natural completion; after iteration starts, cancellation uses return(undefined) and completes with undefined.
- Follow TDD: observe each newly introduced behavior fail before expanding production code.
- Run focused tests after every red/green cycle, then run the full suite, production build, and lint.
- This foundation has no observable browser behavior; browser verification belongs to the real Mediabunny adapter slice.
- Do not reinstall or change dependencies in this slice. The lockfile's Mediabunny 1.50.3 versus installed 1.50.8 drift is handled before the real adapter slice.
- Preserve the user's untracked AGENTS.md; never edit or stage it.
- Commit with author Aryel <286477813+zyfvhcfh87-rgb@users.noreply.github.com> and trailer Co-Authored-By: Codex Opus 4.8 <noreply@anthropic.com>, using a message file and git commit -F.

---

## File Map

- Create src/pipeline/export.test.ts: recording fakes for media leases, compositing, the video sink, progress consumption, backpressure, validation, failure cleanup, and cancellation.
- Modify src/pipeline/export.ts: public export contracts, validation, CFR scheduling, progress generator, per-frame lease ownership, sink finalization/cancellation, and cleanup precedence.

### Task 1: Video-only CFR export orchestration

**Files:**
- Create: src/pipeline/export.test.ts
- Modify: src/pipeline/export.ts
- Test: src/pipeline/export.test.ts

**Interfaces:**
- Consumes: docDurationFrames(doc: TimelineDoc): number; framesToSeconds(frames: number, rate: FrameRate): number; compositeFrame(doc, frame, ctx, source): Promise<CompositeResult>; FrameSource; Composite2D.
- Produces: ExportSettings, ExportResult, ExportFrameLease, ExportMediaSource, ExportVideoSink, ExportDeps, and exportTimeline(doc, settings, media, deps): AsyncGenerator<number, ExportResult | undefined, void>.

- [ ] **Step 1: Re-read the architecture and confirm the exact working-tree scope**

Run each command separately:

~~~powershell
Get-Content -Raw ARCHITECTURE.md
git status --short --branch
Get-Content -Raw docs/superpowers/specs/2026-07-11-phase-5-1-cfr-video-export-foundation-design.md
~~~

Expected: the dependency arrows and frame-closing rules are fresh; HEAD contains the approved design commit 0bde998; only the user's pre-existing untracked AGENTS.md is outside Git. Do not stage or edit AGENTS.md.

- [ ] **Step 2: Create the initial failing tests for CFR scheduling, progress, result delivery, lease ownership, and backpressure**

Create src/pipeline/export.test.ts with this complete content:

~~~ts
/**
 * pipeline/export.test.ts — video-only CFR export orchestration.
 *
 * Browser codecs and canvas are injected behind recording fakes. These tests
 * prove integer-frame scheduling, backpressure, progress, and ownership; the
 * real Mediabunny adapter receives its own browser gate in the next slice.
 */

import { describe, expect, test, vi } from 'vitest'
import type {
  Clip,
  FrameRate,
  TimelineDoc,
  Track,
} from '../domain/schema'
import type {
  Composite2D,
  CompositeResult,
  FrameSource,
} from './render'
import type {
  ExportDeps,
  ExportFrameLease,
  ExportMediaSource,
  ExportResult,
  ExportSettings,
  ExportVideoSink,
} from './export'
import { exportTimeline } from './export'

const SETTINGS: ExportSettings = {
  format: 'mp4',
  videoCodec: 'avc',
  videoBitrate: 8_000_000,
}

const RESULT: ExportResult = {
  buffer: Uint8Array.from([1, 2, 3]).buffer,
  mimeType: 'video/mp4',
}

function makeClip(durationFrames: number): Clip {
  return {
    id: 'clip-a',
    assetId: 'asset-a',
    name: 'clip-a',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame: 0, durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeDoc(
  durationFrames = 3,
  frameRate: FrameRate = { num: 30, den: 1 },
): TimelineDoc {
  const tracks: Track[] =
    durationFrames === 0
      ? []
      : [
          {
            id: 'V1',
            kind: 'video',
            name: 'V1',
            clips: [makeClip(durationFrames)],
            transitions: [],
            hidden: false,
            muted: false,
            solo: false,
            locked: false,
          },
        ]

  return {
    schemaVersion: 1,
    id: 'doc',
    name: 'doc',
    frameRate,
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
  }
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

interface HarnessOptions {
  composite?: (frame: number) => Promise<CompositeResult>
  addFrame?: (
    timestampSec: number,
    durationSec: number,
    index: number,
  ) => Promise<void>
  finalize?: () => Promise<ExportResult>
  cancel?: () => Promise<void>
  closeMedia?: () => Promise<void>
  closeLease?: (frame: number) => Promise<void>
  createSinkError?: Error
}

function makeHarness(options: HarnessOptions = {}) {
  const events: string[] = []
  const ctx = {} as Composite2D
  let addIndex = 0

  const leaseClose = vi.fn(async (frame: number): Promise<void> => {
    events.push('lease:close:' + frame)
    await options.closeLease?.(frame)
  })

  const openFrame = vi.fn(
    async (docFrame: number): Promise<ExportFrameLease> => {
      events.push('open:' + docFrame)
      return {
        getFrame: async (
          _assetId: string,
          _sourceFrame: number,
        ): Promise<ImageBitmap | null> => null,
        close: () => leaseClose(docFrame),
      }
    },
  )

  const closeMedia = vi.fn(async (): Promise<void> => {
    events.push('media:close')
    await options.closeMedia?.()
  })

  const media: ExportMediaSource = {
    openFrame,
    close: closeMedia,
  }

  const composite = vi.fn(
    async (
      _doc: TimelineDoc,
      frame: number,
      _ctx: Composite2D,
      _source: FrameSource,
    ): Promise<CompositeResult> => {
      events.push('composite:' + frame)
      return (
        (await options.composite?.(frame)) ?? {
          drawn: ['clip-a'],
          missing: [],
        }
      )
    },
  )

  const addFrame = vi.fn(
    async (timestampSec: number, durationSec: number): Promise<void> => {
      const index = addIndex++
      events.push('add:' + index)
      await options.addFrame?.(timestampSec, durationSec, index)
    },
  )

  const finalize = vi.fn(async (): Promise<ExportResult> => {
    events.push('sink:finalize')
    return (await options.finalize?.()) ?? RESULT
  })

  const cancel = vi.fn(async (): Promise<void> => {
    events.push('sink:cancel')
    await options.cancel?.()
  })

  const sink: ExportVideoSink = {
    ctx,
    addFrame,
    finalize,
    cancel,
  }

  const createVideoSink = vi.fn(
    async (
      _doc: TimelineDoc,
      _settings: ExportSettings,
    ): Promise<ExportVideoSink> => {
      events.push('sink:create')
      if (options.createSinkError) throw options.createSinkError
      return sink
    },
  )

  const deps: ExportDeps = {
    composite,
    createVideoSink,
  }

  return {
    events,
    media,
    deps,
    openFrame,
    closeMedia,
    leaseClose,
    composite,
    createVideoSink,
    addFrame,
    finalize,
    cancel,
  }
}

async function drain(
  generator: AsyncGenerator<number, ExportResult, void>,
): Promise<{ progress: number[]; result: ExportResult }> {
  const progress: number[] = []
  for (;;) {
    const step = await generator.next()
    if (step.done) return { progress, result: step.value }
    progress.push(step.value)
  }
}

describe('exportTimeline CFR scheduling', () => {
  test('renders every document frame in order and returns the finalized result', async () => {
    const doc = makeDoc(3)
    const h = makeHarness()

    const completed = await drain(exportTimeline(doc, SETTINGS, h.media, h.deps))

    expect(h.createVideoSink).toHaveBeenCalledOnce()
    expect(h.createVideoSink).toHaveBeenCalledWith(doc, SETTINGS)
    expect(h.openFrame.mock.calls.map(([frame]) => frame)).toEqual([0, 1, 2])
    expect(h.composite.mock.calls.map((call) => call[1])).toEqual([0, 1, 2])
    expect(h.addFrame.mock.calls).toEqual([
      [0, 1 / 30],
      [1 / 30, 1 / 30],
      [2 / 30, 1 / 30],
    ])
    expect(h.leaseClose).toHaveBeenCalledTimes(3)
    expect(h.finalize).toHaveBeenCalledOnce()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
    expect(completed.progress).toEqual([0, 1 / 4, 2 / 4, 3 / 4, 1])
    expect(completed.result).toBe(RESULT)
    expect(h.events).toEqual([
      'sink:create',
      'open:0',
      'composite:0',
      'lease:close:0',
      'add:0',
      'open:1',
      'composite:1',
      'lease:close:1',
      'add:1',
      'open:2',
      'composite:2',
      'lease:close:2',
      'add:2',
      'sink:finalize',
      'media:close',
    ])
  })

  test('derives NTSC timestamps from each integer frame without accumulation', async () => {
    const h = makeHarness()

    await drain(
      exportTimeline(
        makeDoc(3, { num: 30_000, den: 1_001 }),
        SETTINGS,
        h.media,
        h.deps,
      ),
    )

    const frameDuration = 1_001 / 30_000
    expect(h.addFrame.mock.calls).toEqual([
      [0, frameDuration],
      [1_001 / 30_000, frameDuration],
      [2_002 / 30_000, frameDuration],
    ])
  })

  test('does not open the next frame until encoder backpressure settles', async () => {
    const firstAdd = deferredVoid()
    const h = makeHarness({
      addFrame: async (_timestampSec, _durationSec, index) => {
        if (index === 0) await firstAdd.promise
      },
    })
    const generator = exportTimeline(makeDoc(2), SETTINGS, h.media, h.deps)

    await expect(generator.next()).resolves.toEqual({ value: 0, done: false })
    const firstProgress = generator.next()
    await vi.waitFor(() => expect(h.addFrame).toHaveBeenCalledOnce())

    expect(h.openFrame).toHaveBeenCalledOnce()
    expect(h.openFrame).toHaveBeenCalledWith(0)

    firstAdd.resolve()
    await expect(firstProgress).resolves.toEqual({ value: 1 / 3, done: false })

    await expect(generator.next()).resolves.toEqual({
      value: 2 / 3,
      done: false,
    })
    expect(h.openFrame.mock.calls.map(([frame]) => frame)).toEqual([0, 1])

    await generator.return(RESULT)
  })
})
~~~

- [ ] **Step 3: Run the focused test and confirm the first red state**

Run:

~~~powershell
npm test -- src/pipeline/export.test.ts
~~~

Expected: FAIL during module loading because src/pipeline/export.ts does not export ExportSettings, ExportResult, the injected port types, or exportTimeline. This is the correct red state; do not weaken the tests to match the two-line stub.

- [ ] **Step 4: Implement the minimal happy-path CFR generator**

Replace src/pipeline/export.ts with this complete first implementation:

~~~ts
/**
 * pipeline/export.ts — video-only CFR export orchestration.
 *
 * Browser decoding and muxing are injected. This module owns integer-frame
 * scheduling, compositeFrame reuse, encoder backpressure, progress, and
 * per-frame image leases.
 */

import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  compositeFrame,
  type Composite2D,
  type FrameSource,
} from './render'

export interface ExportSettings {
  format: 'mp4'
  videoCodec: 'avc'
  videoBitrate: number
}

export interface ExportResult {
  buffer: ArrayBuffer
  mimeType: 'video/mp4'
}

export interface ExportFrameLease extends FrameSource {
  close(): void | Promise<void>
}

export interface ExportMediaSource {
  openFrame(docFrame: number): Promise<ExportFrameLease>
  close(): void | Promise<void>
}

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

export async function* exportTimeline(
  doc: TimelineDoc,
  settings: ExportSettings,
  media: ExportMediaSource,
  deps: ExportDeps,
): AsyncGenerator<number, ExportResult, void> {
  const frameCount = docDurationFrames(doc)
  yield 0

  try {
    const sink = await deps.createVideoSink(doc, settings)
    const frameDurationSec = framesToSeconds(1, doc.frameRate)

    for (let frame = 0; frame < frameCount; frame++) {
      const lease = await media.openFrame(frame)
      let result
      try {
        result = await deps.composite(doc, frame, sink.ctx, lease)
      } finally {
        await lease.close()
      }
      if (result.missing.length > 0) {
        throw new Error(
          'Missing source media for clips: ' + result.missing.join(', '),
        )
      }

      await sink.addFrame(
        framesToSeconds(frame, doc.frameRate),
        frameDurationSec,
      )
      yield (frame + 1) / (frameCount + 1)
    }

    const result = await sink.finalize()
    yield 1
    return result
  } finally {
    await media.close()
  }
}
~~~

- [ ] **Step 5: Run the focused test and confirm the first green state**

Run:

~~~powershell
npm test -- src/pipeline/export.test.ts
~~~

Expected: PASS with 3 tests. The deferred addFrame test proves the implementation awaits backpressure rather than merely producing the correct final call list.

- [ ] **Step 6: Append failing validation and empty-timeline tests**

Append this exact block to src/pipeline/export.test.ts:

~~~ts

describe('exportTimeline validation', () => {
  test.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid video bitrate %s before creating a sink',
    async (videoBitrate) => {
      const h = makeHarness()
      const settings: ExportSettings = { ...SETTINGS, videoBitrate }
      const generator = exportTimeline(makeDoc(1), settings, h.media, h.deps)

      await expect(generator.next()).rejects.toThrow(
        'videoBitrate must be a positive safe integer',
      )
      expect(h.createVideoSink).not.toHaveBeenCalled()
      expect(h.openFrame).not.toHaveBeenCalled()
      expect(h.closeMedia).toHaveBeenCalledOnce()
    },
  )

  test('rejects unsupported runtime format and codec values', async () => {
    const invalidSettings = [
      { ...SETTINGS, format: 'webm' } as unknown as ExportSettings,
      { ...SETTINGS, videoCodec: 'vp9' } as unknown as ExportSettings,
    ]

    for (const settings of invalidSettings) {
      const h = makeHarness()
      const generator = exportTimeline(makeDoc(1), settings, h.media, h.deps)

      await expect(generator.next()).rejects.toThrow('Unsupported export')
      expect(h.createVideoSink).not.toHaveBeenCalled()
      expect(h.closeMedia).toHaveBeenCalledOnce()
    }
  })

  test('rejects an empty timeline before yielding or creating resources', async () => {
    const h = makeHarness()
    const generator = exportTimeline(makeDoc(0), SETTINGS, h.media, h.deps)

    await expect(generator.next()).rejects.toThrow(
      'Cannot export an empty or invalid timeline',
    )
    expect(h.createVideoSink).not.toHaveBeenCalled()
    expect(h.openFrame).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('rejects invalid frame timing before creating a sink', async () => {
    const h = makeHarness()
    const generator = exportTimeline(
      makeDoc(1, { num: 0, den: 1 }),
      SETTINGS,
      h.media,
      h.deps,
    )

    await expect(generator.next()).rejects.toThrow('Invalid FrameRate 0/1')
    expect(h.createVideoSink).not.toHaveBeenCalled()
    expect(h.openFrame).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })
})
~~~

- [ ] **Step 7: Run the focused test and confirm the validation red state**

Run:

~~~powershell
npm test -- src/pipeline/export.test.ts
~~~

Expected: FAIL. The first implementation yields 0 for empty/invalid settings and may create a sink before invalid frame timing is discovered. The new assertions must fail for those specific missing validations.

- [ ] **Step 8: Implement explicit settings, duration, and frame-rate guards before the first progress yield**

Replace src/pipeline/export.ts with this complete second implementation:

~~~ts
/**
 * pipeline/export.ts — video-only CFR export orchestration.
 *
 * Browser decoding and muxing are injected. This module owns validation,
 * integer-frame scheduling, compositeFrame reuse, encoder backpressure,
 * progress, and per-frame image leases.
 */

import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  compositeFrame,
  type Composite2D,
  type CompositeResult,
  type FrameSource,
} from './render'

export interface ExportSettings {
  format: 'mp4'
  videoCodec: 'avc'
  videoBitrate: number
}

export interface ExportResult {
  buffer: ArrayBuffer
  mimeType: 'video/mp4'
}

export interface ExportFrameLease extends FrameSource {
  close(): void | Promise<void>
}

export interface ExportMediaSource {
  openFrame(docFrame: number): Promise<ExportFrameLease>
  close(): void | Promise<void>
}

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

function assertSettings(settings: ExportSettings): void {
  if (typeof settings !== 'object' || settings === null) {
    throw new TypeError('Export settings must be an object')
  }
  if (settings.format !== 'mp4') {
    throw new TypeError('Unsupported export format: ' + settings.format)
  }
  if (settings.videoCodec !== 'avc') {
    throw new TypeError(
      'Unsupported export video codec: ' + settings.videoCodec,
    )
  }
  if (
    !Number.isSafeInteger(settings.videoBitrate) ||
    settings.videoBitrate <= 0
  ) {
    throw new TypeError('videoBitrate must be a positive safe integer')
  }
}

function exportFrameCount(doc: TimelineDoc): number {
  const frameCount = docDurationFrames(doc)
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError('Cannot export an empty or invalid timeline')
  }
  return frameCount
}

function assertBoundaryTime(
  value: number,
  label: 'timestamp' | 'duration',
): number {
  if (
    !Number.isFinite(value) ||
    (label === 'timestamp' ? value < 0 : value <= 0)
  ) {
    throw new RangeError('Invalid export frame ' + label + ': ' + value)
  }
  return value
}

export async function* exportTimeline(
  doc: TimelineDoc,
  settings: ExportSettings,
  media: ExportMediaSource,
  deps: ExportDeps,
): AsyncGenerator<number, ExportResult, void> {
  try {
    assertSettings(settings)
    const frameCount = exportFrameCount(doc)
    const frameDurationSec = assertBoundaryTime(
      framesToSeconds(1, doc.frameRate),
      'duration',
    )
    yield 0

    const sink = await deps.createVideoSink(doc, settings)
    for (let frame = 0; frame < frameCount; frame++) {
      const lease = await media.openFrame(frame)
      let result: CompositeResult
      try {
        result = await deps.composite(doc, frame, sink.ctx, lease)
      } finally {
        await lease.close()
      }
      if (result.missing.length > 0) {
        throw new Error(
          'Missing source media for clips: ' + result.missing.join(', '),
        )
      }

      const timestampSec = assertBoundaryTime(
        framesToSeconds(frame, doc.frameRate),
        'timestamp',
      )
      await sink.addFrame(timestampSec, frameDurationSec)
      yield (frame + 1) / (frameCount + 1)
    }

    const result = await sink.finalize()
    yield 1
    return result
  } finally {
    await media.close()
  }
}
~~~

- [ ] **Step 9: Run the focused test and confirm the validation green state**

Run:

~~~powershell
npm test -- src/pipeline/export.test.ts
~~~

Expected: PASS with 10 tests: the 3 scheduling tests, four bitrate cases, and the format/codec, empty-timeline, and invalid-rate tests.

- [ ] **Step 10: Append failing ownership, cancellation, and error-precedence tests**

Append this exact block to src/pipeline/export.test.ts:

~~~ts

describe('exportTimeline ownership and failures', () => {
  test('missing source media is fatal and cancels the sink', async () => {
    const h = makeHarness({
      composite: async () => ({
        drawn: [],
        missing: ['clip-a', 'clip-b'],
      }),
    })

    await expect(
      drain(exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)),
    ).rejects.toThrow('Missing source media for clips: clip-a, clip-b')

    expect(h.leaseClose).toHaveBeenCalledOnce()
    expect(h.addFrame).not.toHaveBeenCalled()
    expect(h.finalize).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('preserves a composite failure over lease and export cleanup failures', async () => {
    const primary = new Error('composite failed')
    const h = makeHarness({
      composite: async () => {
        throw primary
      },
      closeLease: async () => {
        throw new Error('lease close failed')
      },
      cancel: async () => {
        throw new Error('cancel failed')
      },
      closeMedia: async () => {
        throw new Error('media close failed')
      },
    })

    await expect(
      drain(exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)),
    ).rejects.toBe(primary)

    expect(h.leaseClose).toHaveBeenCalledOnce()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('surfaces a lease-close failure when compositing succeeded', async () => {
    const leaseError = new Error('lease close failed')
    const h = makeHarness({
      closeLease: async () => {
        throw leaseError
      },
    })

    await expect(
      drain(exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)),
    ).rejects.toBe(leaseError)

    expect(h.addFrame).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('cancels after an encoder failure without reopening or leaking the lease', async () => {
    const addError = new Error('encoder failed')
    const h = makeHarness({
      addFrame: async () => {
        throw addError
      },
    })

    await expect(
      drain(exportTimeline(makeDoc(2), SETTINGS, h.media, h.deps)),
    ).rejects.toBe(addError)

    expect(h.openFrame).toHaveBeenCalledOnce()
    expect(h.leaseClose).toHaveBeenCalledOnce()
    expect(h.finalize).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('cancels after finalization fails', async () => {
    const finalizeError = new Error('finalize failed')
    const h = makeHarness({
      finalize: async () => {
        throw finalizeError
      },
    })

    await expect(
      drain(exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)),
    ).rejects.toBe(finalizeError)

    expect(h.finalize).toHaveBeenCalledOnce()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('preserves sink-creation failure over media cleanup failure', async () => {
    const createError = new Error('sink creation failed')
    const h = makeHarness({
      createSinkError: createError,
      closeMedia: async () => {
        throw new Error('media close failed')
      },
    })

    await expect(
      drain(exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)),
    ).rejects.toBe(createError)

    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('early return cancels a created sink and closes media', async () => {
    const h = makeHarness()
    const generator = exportTimeline(makeDoc(2), SETTINGS, h.media, h.deps)

    await expect(generator.next()).resolves.toEqual({ value: 0, done: false })
    await expect(generator.next()).resolves.toEqual({
      value: 1 / 3,
      done: false,
    })
    await expect(generator.return(RESULT)).resolves.toEqual({
      value: RESULT,
      done: true,
    })

    expect(h.finalize).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('early return at initial progress closes media without creating a sink', async () => {
    const h = makeHarness()
    const generator = exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)

    await expect(generator.next()).resolves.toEqual({ value: 0, done: false })
    await generator.return(RESULT)

    expect(h.createVideoSink).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('early-return cleanup surfaces the first cleanup error', async () => {
    const cancelError = new Error('cancel failed')
    const h = makeHarness({
      cancel: async () => {
        throw cancelError
      },
      closeMedia: async () => {
        throw new Error('media close failed')
      },
    })
    const generator = exportTimeline(makeDoc(2), SETTINGS, h.media, h.deps)

    await generator.next()
    await generator.next()
    await expect(generator.return(RESULT)).rejects.toBe(cancelError)

    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('media cleanup completes before progress reaches one', async () => {
    const mediaError = new Error('media close failed')
    const h = makeHarness({
      closeMedia: async () => {
        throw mediaError
      },
    })
    const generator = exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)

    await expect(generator.next()).resolves.toEqual({ value: 0, done: false })
    await expect(generator.next()).resolves.toEqual({
      value: 1 / 2,
      done: false,
    })
    await expect(generator.next()).rejects.toBe(mediaError)

    expect(h.finalize).toHaveBeenCalledOnce()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })
})
~~~

- [ ] **Step 11: Run the focused test and confirm the cleanup red state**

Run:

~~~powershell
npm test -- src/pipeline/export.test.ts
~~~

Expected: FAIL in the new ownership block. In particular, cancel is never called by the second implementation, a throwing finally can replace the original composite/sink-creation error, and media cleanup happens after progress 1 rather than before it.

- [ ] **Step 12: Implement exact-once cleanup, cancellation, and first-error preservation**

Replace src/pipeline/export.ts with this complete final implementation:

~~~ts
/**
 * pipeline/export.ts — video-only CFR export orchestration.
 *
 * Browser decoding and muxing are injected. This module owns validation,
 * integer-frame scheduling, compositeFrame reuse, encoder backpressure,
 * progress, and exact-once cleanup for per-frame and whole-export resources.
 */

import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  compositeFrame,
  type Composite2D,
  type FrameSource,
} from './render'

export interface ExportSettings {
  format: 'mp4'
  videoCodec: 'avc'
  videoBitrate: number
}

export interface ExportResult {
  buffer: ArrayBuffer
  mimeType: 'video/mp4'
}

export interface ExportFrameLease extends FrameSource {
  close(): void | Promise<void>
}

export interface ExportMediaSource {
  openFrame(docFrame: number): Promise<ExportFrameLease>
  close(): void | Promise<void>
}

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

function assertSettings(settings: ExportSettings): void {
  if (typeof settings !== 'object' || settings === null) {
    throw new TypeError('Export settings must be an object')
  }
  if (settings.format !== 'mp4') {
    throw new TypeError('Unsupported export format: ' + settings.format)
  }
  if (settings.videoCodec !== 'avc') {
    throw new TypeError(
      'Unsupported export video codec: ' + settings.videoCodec,
    )
  }
  if (
    !Number.isSafeInteger(settings.videoBitrate) ||
    settings.videoBitrate <= 0
  ) {
    throw new TypeError('videoBitrate must be a positive safe integer')
  }
}

function exportFrameCount(doc: TimelineDoc): number {
  const frameCount = docDurationFrames(doc)
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError('Cannot export an empty or invalid timeline')
  }
  return frameCount
}

function assertBoundaryTime(
  value: number,
  label: 'timestamp' | 'duration',
): number {
  if (
    !Number.isFinite(value) ||
    (label === 'timestamp' ? value < 0 : value <= 0)
  ) {
    throw new RangeError('Invalid export frame ' + label + ': ' + value)
  }
  return value
}

async function compositeAndCloseLease(
  doc: TimelineDoc,
  frame: number,
  sink: ExportVideoSink,
  lease: ExportFrameLease,
  composite: typeof compositeFrame,
): Promise<void> {
  let failed = false
  let failure: unknown

  try {
    const result = await composite(doc, frame, sink.ctx, lease)
    if (result.missing.length > 0) {
      throw new Error(
        'Missing source media for clips: ' + result.missing.join(', '),
      )
    }
  } catch (cause) {
    failed = true
    failure = cause
  }

  try {
    await lease.close()
  } catch (cause) {
    if (!failed) {
      failed = true
      failure = cause
    }
  }

  if (failed) throw failure
}

export async function* exportTimeline(
  doc: TimelineDoc,
  settings: ExportSettings,
  media: ExportMediaSource,
  deps: ExportDeps,
): AsyncGenerator<number, ExportResult, void> {
  let sink: ExportVideoSink | null = null
  let sinkFinalized = false
  let mediaClosed = false
  let operationalFailure = false

  const closeMedia = async (): Promise<void> => {
    if (mediaClosed) return
    mediaClosed = true
    await media.close()
  }

  try {
    assertSettings(settings)
    const frameCount = exportFrameCount(doc)
    const frameDurationSec = assertBoundaryTime(
      framesToSeconds(1, doc.frameRate),
      'duration',
    )
    yield 0

    sink = await deps.createVideoSink(doc, settings)
    for (let frame = 0; frame < frameCount; frame++) {
      const lease = await media.openFrame(frame)
      await compositeAndCloseLease(
        doc,
        frame,
        sink,
        lease,
        deps.composite,
      )

      const timestampSec = assertBoundaryTime(
        framesToSeconds(frame, doc.frameRate),
        'timestamp',
      )
      await sink.addFrame(timestampSec, frameDurationSec)
      yield (frame + 1) / (frameCount + 1)
    }

    const result = await sink.finalize()
    sinkFinalized = true
    await closeMedia()
    yield 1
    return result
  } catch (cause) {
    operationalFailure = true
    throw cause
  } finally {
    let cleanupFailed = false
    let cleanupFailure: unknown

    if (sink !== null && !sinkFinalized) {
      try {
        await sink.cancel()
      } catch (cause) {
        cleanupFailed = true
        cleanupFailure = cause
      }
    }

    try {
      await closeMedia()
    } catch (cause) {
      if (!cleanupFailed) {
        cleanupFailed = true
        cleanupFailure = cause
      }
    }

    if (!operationalFailure && cleanupFailed) throw cleanupFailure
  }
}
~~~

- [ ] **Step 13: Run the focused test and confirm the final green state**

Run:

~~~powershell
npm test -- src/pipeline/export.test.ts
~~~

Expected: PASS with 20 tests. Confirm there are no unhandled rejection messages, console warnings, or tests left pending.

- [ ] **Step 14: Re-read the spec against the implementation diff**

Run each command separately:

~~~powershell
git diff --check
git diff -- src/pipeline/export.ts src/pipeline/export.test.ts
rg -n "state/|app/|ui/|engine/|workers/|mediabunny" src/pipeline/export.ts
~~~

Expected:

- git diff --check exits 0.
- Only src/pipeline/export.ts and src/pipeline/export.test.ts contain implementation changes.
- The dependency search returns no forbidden runtime import. A comment containing one of the search terms is harmless; inspect any match rather than deleting useful documentation.
- Every public interface exactly matches the approved design.
- The final generator closes media before yielding 1 and returns ExportResult only on the following next().

- [ ] **Step 15: Run the complete automated quality gate**

Run each command separately:

~~~powershell
npm test
npm run build
npm run lint
~~~

Expected:

- The complete Vitest suite exits 0 with all existing tests plus the 20 export tests passing.
- npm run build completes tsc -b and the Vite production build with exit code 0.
- npm run lint exits 0.

No browser pass is required for this non-observable injected foundation. Do not start the real Mediabunny adapter or UI in this task.

- [ ] **Step 16: Review and commit the pipeline module**

Run each command separately:

~~~powershell
git diff --check
git status --short
git diff --stat
~~~

Expected: only src/pipeline/export.ts and src/pipeline/export.test.ts are modified/untracked. The user's AGENTS.md remains untracked and unstaged.

Create .git/CODEX_PHASE_5_1_EXPORT_FOUNDATION_COMMIT_MSG with this exact content using apply_patch:

~~~text
Export: add CFR orchestration foundation

Schedule every derived document frame through the shared compositor with exact
rational timestamps, awaited sink backpressure, monotonic progress, and an
explicit returned buffer contract.

Close per-frame media leases exactly once and cancel unfinished exports without
letting cleanup errors hide the first operational failure.

Co-Authored-By: Codex Opus 4.8 <noreply@anthropic.com>
~~~

Then run each command separately:

~~~powershell
git add -- src/pipeline/export.ts src/pipeline/export.test.ts
git diff --cached --check
git diff --cached --name-status
git -c user.name="Aryel" -c user.email="286477813+zyfvhcfh87-rgb@users.noreply.github.com" commit --author="Aryel <286477813+zyfvhcfh87-rgb@users.noreply.github.com>" -F .git/CODEX_PHASE_5_1_EXPORT_FOUNDATION_COMMIT_MSG
git status --short --branch
~~~

Expected: the commit succeeds with Aryel as author/committer and the required Codex Opus 4.8 co-author trailer. No tracked changes remain; the pre-existing untracked AGENTS.md remains untouched.

### Post-implementation review correction: distinguish cancellation from completion

The independent quality review found that the original
AsyncGenerator<number, ExportResult, void> contract forced callers to pass a
fabricated ExportResult to return() merely to cancel. Complete this correction
before treating Task 1 as reviewed: natural completion returns ExportResult,
while cancellation after iteration starts returns undefined.

- [ ] **Step 17: Write the cancellation-result tests and confirm the type-level red state**

In src/pipeline/export.test.ts, change drain to this exact implementation:

~~~ts
async function drain(
  generator: AsyncGenerator<number, ExportResult | undefined, void>,
): Promise<{ progress: number[]; result: ExportResult }> {
  const progress: number[] = []
  for (;;) {
    const step = await generator.next()
    if (step.done) {
      if (step.value === undefined) {
        throw new Error('Export completed without a result')
      }
      return { progress, result: step.value }
    }
    progress.push(step.value)
  }
}
~~~

Change every cancellation call from return(RESULT) to return(undefined). The
created-sink cancellation assertion must be:

~~~ts
await expect(generator.return(undefined)).resolves.toEqual({
  value: undefined,
  done: true,
})
~~~

Append this exact test to the ownership-and-failures describe block:

~~~ts
test('return after progress one remains cancellation, not completion', async () => {
  const h = makeHarness()
  const generator = exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)

  await expect(generator.next()).resolves.toEqual({ value: 0, done: false })
  await expect(generator.next()).resolves.toEqual({
    value: 1 / 2,
    done: false,
  })
  await expect(generator.next()).resolves.toEqual({ value: 1, done: false })
  await expect(generator.return(undefined)).resolves.toEqual({
    value: undefined,
    done: true,
  })

  expect(h.finalize).toHaveBeenCalledOnce()
  expect(h.cancel).not.toHaveBeenCalled()
  expect(h.closeMedia).toHaveBeenCalledOnce()
})
~~~

Run:

~~~powershell
npm run build
~~~

Expected: FAIL with five TS2345 errors because the production generator still
requires ExportResult as its return() value. This is the review correction's
red state.

- [ ] **Step 18: Make cancellation an explicit undefined completion**

Change only the exportTimeline return annotation in src/pipeline/export.ts:

~~~ts
export async function* exportTimeline(
  doc: TimelineDoc,
  settings: ExportSettings,
  media: ExportMediaSource,
  deps: ExportDeps,
): AsyncGenerator<number, ExportResult | undefined, void> {
~~~

Do not add an AbortSignal or session wrapper in this slice. The future app
controller must call next() at least once before exposing cancel, then use
return(undefined) and treat done plus undefined as cancellation.

- [ ] **Step 19: Rerun all gates after the review correction**

Run each command separately:

~~~powershell
npm test -- src/pipeline/export.test.ts
npm test
npm run build
npm run lint
git diff --check
~~~

Expected:

- Focused export tests pass 21/21.
- Full suite passes 34 files and 488 tests.
- Build exits 0.
- Lint exits 0 with no warning.
- Diff check exits 0.

- [ ] **Step 20: Commit the reviewed cancellation protocol**

Create .git/CODEX_PHASE_5_1_EXPORT_CANCEL_COMMIT_MSG with:

~~~text
Export: distinguish cancellation from completion

Allow controller cancellation to close the async generator with undefined
instead of fabricating an ExportResult, while completed drains still require a
real finalized result.

Cover cancellation after final progress without canceling an already finalized
sink or closing media more than once.

Co-Authored-By: Codex Opus 4.8 <noreply@anthropic.com>
~~~

Then run:

~~~powershell
git add -- src/pipeline/export.ts src/pipeline/export.test.ts
git diff --cached --check
git -c user.name="Aryel" -c user.email="286477813+zyfvhcfh87-rgb@users.noreply.github.com" commit --author="Aryel <286477813+zyfvhcfh87-rgb@users.noreply.github.com>" -F .git/CODEX_PHASE_5_1_EXPORT_CANCEL_COMMIT_MSG
~~~

Expected: follow-up commit succeeds, and cancellation can no longer masquerade
as a successful ExportResult.
