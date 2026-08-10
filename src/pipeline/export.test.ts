/**
 * pipeline/export.test.ts — video-only CFR export orchestration.
 *
 * Browser codecs and canvas are injected behind recording fakes. These tests
 * prove integer-frame scheduling, backpressure, progress, and ownership; the
 * real Mediabunny adapter receives its own browser gate in the next slice.
 */

import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  updateExportProfile,
} from '../domain/exportProfile'
import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import type { PresentationProfile } from '../domain/presentationProfile'
import type {
  Clip,
  FrameRate,
  TimelineDoc,
  Track,
} from '../domain/schema'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import type {
  Composite2D,
  CompositeResult,
  FrameSource,
  TransitionSurfaceProvider,
} from './render'
import type {
  ExportDeps,
  ExportFrameLease,
  ExportMediaSource,
  ExportResult,
  ExportSettings,
  ExportVideoSink,
} from './export'
import {
  ExportCleanupIntegrityError,
  createBufferedExportResult,
  createDirectFileExportResult,
  exportTimeline,
} from './export'

const SETTINGS: ExportSettings = DEFAULT_EXPORT_PROFILE

const RESULT: ExportResult = {
  destination: 'download',
  buffer: Uint8Array.from([1, 2, 3]).buffer,
  mimeType: 'video/mp4',
  fileExtension: 'mp4',
  profile: DEFAULT_EXPORT_PROFILE,
}

function makeClip(durationFrames: number): Clip {
  return {
    id: 'clip-a',
    assetId: 'asset-a',
    name: 'clip-a',
    sourceMode: 'timed',
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
    schemaVersion: 13,
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
  composite?: (
    frame: number,
    source: FrameSource,
  ) => Promise<CompositeResult>
  getFrame?: (
    assetId: string,
    sourceFrame: number,
  ) => Promise<ImageBitmap | null>
  addFrame?: (
    timestampSec: number,
    durationSec: number,
    index: number,
  ) => Promise<void>
  finalize?: () => Promise<ExportResult>
  cancel?: (reason?: unknown) => Promise<void>
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
        plan: { frame: docFrame, items: [] },
        getFrame: async (
          assetId: string,
          sourceFrame: number,
        ): Promise<ImageBitmap | null> =>
          (await options.getFrame?.(assetId, sourceFrame)) ?? null,
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
      plan: VideoCompositionPlan,
      _ctx: Composite2D,
      _source: FrameSource,
      _transitionSurfaceProvider: TransitionSurfaceProvider,
      _presentation?: PresentationProfile,
    ): Promise<CompositeResult> => {
      events.push('composite:' + plan.frame)
      return (
        (await options.composite?.(plan.frame, _source)) ?? {
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

  const cancel = vi.fn(async (reason?: unknown): Promise<void> => {
    events.push('sink:cancel')
    await options.cancel?.(reason)
  })

  const sink: ExportVideoSink = {
    ctx,
    transitionSurfaceProvider: {
      get: () => {
        throw new Error('fake composite unexpectedly requested surfaces')
      },
    },
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
    sink,
    createVideoSink,
    addFrame,
    finalize,
    cancel,
  }
}

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

describe('createBufferedExportResult', () => {
  test('derives canonical frozen metadata from a detached concrete profile', () => {
    const buffer = Uint8Array.from([4, 5, 6]).buffer
    const mutableProfile = { ...DEFAULT_EXPORT_PROFILE }
    const result = createBufferedExportResult(buffer, mutableProfile)
    mutableProfile.videoBitrate = 100_000

    expect(result).toEqual({
      destination: 'download',
      buffer,
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      profile: DEFAULT_EXPORT_PROFILE,
    })
    expect(result.profile).not.toBe(mutableProfile)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.profile)).toBe(true)
  })

  test('rejects non-buffers and the not-yet-buffered file destination', () => {
    expect(() => createBufferedExportResult(
      new ArrayBuffer(0),
      updateExportProfile(DEFAULT_EXPORT_PROFILE, { destination: 'file' }),
    )).toThrow(/download destination/)
    expect(() => createBufferedExportResult(
      {} as ArrayBuffer,
      DEFAULT_EXPORT_PROFILE,
    )).toThrow(/ArrayBuffer/)
  })
})

describe('createDirectFileExportResult', () => {
  test('returns frozen metadata without exposing a buffer or file handle', () => {
    const mutableProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    const result = createDirectFileExportResult(
      'My project.mp4',
      4_294_967_301,
      mutableProfile,
    )

    expect(result).toEqual({
      destination: 'file',
      fileName: 'My project.mp4',
      byteLength: 4_294_967_301,
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      profile: mutableProfile,
    })
    expect(result).not.toHaveProperty('buffer')
    expect(result).not.toHaveProperty('handle')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.profile)).toBe(true)
  })

  test('rejects invalid names, sizes, and buffered destinations', () => {
    const fileProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    expect(() => createDirectFileExportResult('', 1, fileProfile))
      .toThrow(/file name/)
    expect(() => createDirectFileExportResult('movie.mp4', -1, fileProfile))
      .toThrow(/byte length/)
    expect(() => createDirectFileExportResult(
      'movie.mp4',
      1,
      DEFAULT_EXPORT_PROFILE,
    )).toThrow(/file destination/)
  })
})

describe('exportTimeline CFR scheduling', () => {
  test('renders every document frame in order and returns the finalized result', async () => {
    const doc = makeDoc(3)
    const h = makeHarness()

    const completed = await drain(exportTimeline(doc, SETTINGS, h.media, h.deps))

    expect(h.createVideoSink).toHaveBeenCalledOnce()
    expect(h.createVideoSink).toHaveBeenCalledWith(doc, SETTINGS)
    expect(h.openFrame.mock.calls.map(([frame]) => frame)).toEqual([0, 1, 2])
    expect(h.composite.mock.calls.map((call) => call[1].frame)).toEqual([0, 1, 2])
    expect(h.composite.mock.calls.every(
      (call) => call[4] === h.sink.transitionSurfaceProvider,
    )).toBe(true)
    expect(h.composite.mock.calls.every((call) => (
      call[5]?.reason === 'export'
      && call[5].resolvedQuality === 'full'
      && call[5].outputWidth === doc.width
      && call[5].outputHeight === doc.height
    ))).toBe(true)
    expect(h.addFrame.mock.calls).toEqual([
      [0, 1 / 30],
      [1 / 30, 1 / 30],
      [2 / 30, 1 / 30],
    ])
    expect(h.leaseClose).toHaveBeenCalledTimes(3)
    expect(h.finalize).toHaveBeenCalledOnce()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
    expect(completed.progress).toEqual([0, 1 / 4, 2 / 4, 3 / 4])
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
      'media:close',
      'sink:finalize',
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

    await generator.return(undefined)
  })
})

describe('exportTimeline validation', () => {
  test.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid video bitrate %s before creating a sink',
    async (videoBitrate) => {
      const h = makeHarness()
      const settings: ExportSettings = { ...SETTINGS, videoBitrate }
      const generator = exportTimeline(makeDoc(1), settings, h.media, h.deps)

      await expect(generator.next()).rejects.toThrow(
        'Export video bitrate',
      )
      expect(h.createVideoSink).not.toHaveBeenCalled()
      expect(h.openFrame).not.toHaveBeenCalled()
      expect(h.closeMedia).toHaveBeenCalledOnce()
    },
  )

  test('rejects unsupported runtime format and codec values', async () => {
    const invalidSettings = [
      { ...SETTINGS, container: 'webm' } as unknown as ExportSettings,
      { ...SETTINGS, videoCodec: 'vp9' } as unknown as ExportSettings,
    ]

    for (const settings of invalidSettings) {
      const h = makeHarness()
      const generator = exportTimeline(makeDoc(1), settings, h.media, h.deps)

      await expect(generator.next()).rejects.toThrow('Unsupported export codec pair')
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

  test('rejects a billion-frame caption extent before creating export resources', async () => {
    const h = makeHarness()
    const doc = makeDoc(1)
    doc.captionTracks = [{
      id: 'captions',
      name: 'Captions',
      language: 'en',
      role: 'captions',
      stylePreset: 'classic',
      hidden: false,
      items: [{
        id: 'far-future',
        range: { startFrame: 999_999_999, durationFrames: 1 },
        text: 'Still here',
      }],
    }]
    const generator = exportTimeline(doc, SETTINGS, h.media, h.deps)

    await expect(generator.next()).rejects.toThrow('frame limit')
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

describe('exportTimeline ownership and failures', () => {
  test('preserves a frame-source failure softened into missing by the compositor', async () => {
    const sourceFailure = new MediaAssetRuntimeError('asset-a', {
      surface: 'export',
      trackKind: null,
      reason: 'decode-failed',
      detail: 'Export could not decode the image source.',
    })
    const h = makeHarness({
      getFrame: async () => {
        throw sourceFailure
      },
      composite: async (_frame, source) => {
        const image = await source.getFrame('asset-a', 0).catch(() => null)
        return {
          drawn: image ? ['clip-a'] : [],
          missing: image ? [] : ['clip-a'],
        }
      },
    })

    await expect(
      drain(exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)),
    ).rejects.toBe(sourceFailure)

    expect(h.leaseClose).toHaveBeenCalledOnce()
    expect(h.addFrame).not.toHaveBeenCalled()
    expect(h.finalize).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

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
    await expect(generator.return(undefined)).resolves.toEqual({
      value: undefined,
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
    await generator.return(undefined)

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
    await expect(generator.return(undefined)).rejects.toBe(cancelError)

    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('media cleanup completes before the sink can commit its result', async () => {
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

    expect(h.finalize).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('surfaces an output-integrity cleanup failure over an outer operation', async () => {
    const primary = new Error('composite failed')
    const integrity = new ExportCleanupIntegrityError(
      'selected file may be incomplete',
    )
    const cancel = vi.fn(async (reason?: unknown) => {
      expect(reason).toBe(primary)
      throw integrity
    })
    const h = makeHarness({
      composite: async () => {
        throw primary
      },
      cancel,
    })

    await expect(
      drain(exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)),
    ).rejects.toBe(integrity)

    expect(cancel).toHaveBeenCalledWith(primary)
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })

  test('returns completion without a cancellable post-commit progress yield', async () => {
    const h = makeHarness()
    const generator = exportTimeline(makeDoc(1), SETTINGS, h.media, h.deps)

    await expect(generator.next()).resolves.toEqual({ value: 0, done: false })
    await expect(generator.next()).resolves.toEqual({
      value: 1 / 2,
      done: false,
    })
    await expect(generator.next()).resolves.toEqual({
      value: RESULT,
      done: true,
    })
    await expect(generator.return(undefined)).resolves.toEqual({
      value: undefined,
      done: true,
    })

    expect(h.finalize).toHaveBeenCalledOnce()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.closeMedia).toHaveBeenCalledOnce()
  })
})
