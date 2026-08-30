/**
 * app/exportController.test.ts — Phase 5.2a composition-root wiring.
 *
 * Mediabunny stays behind injected factories. These tests exercise the app
 * controller's document/media snapshots, explicit generator drain, result
 * delivery, cooperative cancellation, and single-run lifecycle.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  updateExportProfile,
} from '../domain/exportProfile'
import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type { MediaAsset, TimelineDoc } from '../domain/schema'
import { createPluginVideoEffectContributionSnapshot } from '../domain/pluginVideoEffectStagePlan'
import type {
  ExportDeps as PipelineExportDeps,
  ExportMediaSource,
} from '../pipeline/export'
import type { ExportAssetResolver } from '../pipeline/export-mediabunny'
import { VideoEffectStageExecutionError } from '../pipeline/videoEffectStageExecution'
import type { ExportFileDestinationCapability } from './exportFilePicker'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  cancelExport,
  disposeExport,
  startExport,
  startPreparedExport,
  type ExportControllerDeps,
  type ExportResult,
  type ExportSettings,
} from './exportController'
import {
  PluginExportAttemptError,
  type PluginExportAttemptController,
  type PluginExportAttemptToken,
  type PluginPreparedExportExecution,
} from './pluginExportAttemptController'

const SETTINGS: ExportSettings = DEFAULT_EXPORT_PROFILE

const RESULT: ExportResult = {
  destination: 'download',
  buffer: new Uint8Array([1, 2, 3]).buffer,
  mimeType: 'video/mp4',
  fileExtension: 'mp4',
  profile: DEFAULT_EXPORT_PROFILE,
}

const FILE_SETTINGS = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
  destination: 'file',
})

const FILE_RESULT: ExportResult = {
  destination: 'file',
  fileName: 'chosen.mp4',
  byteLength: 3,
  mimeType: 'video/mp4',
  fileExtension: 'mp4',
  profile: FILE_SETTINGS,
}

function fileDestination(
  fileName = 'chosen.mp4',
): ExportFileDestinationCapability {
  return {
    fileName,
    takeFileHandle: vi.fn(() => {
      throw new Error('Controller tests must not consume the native handle')
    }),
  }
}

const DOC: TimelineDoc = {
  schemaVersion: 17,
  id: 'doc-export-controller',
  name: 'Export controller fixture',
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  audioSampleRate: 48_000,
  tracks: [
    {
      id: 'V1',
      kind: 'video',
      name: 'V1',
      clips: [
        {
          id: 'clip-1',
          assetId: 'asset-1',
          name: 'source.mp4',
          sourceMode: 'timed',
          sourceRange: { startFrame: 0, durationFrames: 2 },
          timelineRange: { startFrame: 0, durationFrames: 2 },
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
        },
      ],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    },
  ],
}

const ASSET: MediaAsset = {
  id: 'asset-1',
  fileName: 'source.mp4',
  mimeType: 'video/mp4',
  size: 1_024,
  lastModified: 1_725_000_000_000,
  objectUrl: 'blob:captured-source',
  kind: 'video',
  durationFrames: 60,
  durationMicroseconds: 2_000_000,
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
    audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
  },
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioSampleRate: 48_000,
  audioChannels: 2,
  decoderConfigB64: null,
}

function docWithSourceClipOn(
  kind: 'video' | 'audio',
  clipName = ASSET.fileName,
): TimelineDoc {
  const sourceTrack = DOC.tracks[0]
  if (!sourceTrack) throw new Error('export source-track fixture missing')
  return {
    ...DOC,
    tracks: [{
      ...sourceTrack,
      id: kind === 'video' ? 'V1' : 'A1',
      kind,
      name: kind === 'video' ? 'V1' : 'A1',
      clips: sourceTrack.clips.map((clip) => ({
        ...clip,
        name: clipName,
      })),
    }],
  }
}

type ExportRun = AsyncGenerator<number, ExportResult | undefined, void>

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function completedRun(
  progress: readonly number[] = [0, 0.4, 1],
  result: ExportResult | undefined = RESULT,
): ExportRun {
  return (async function* (): ExportRun {
    for (const value of progress) yield value
    return result
  })()
}

function observeRun(run: ExportRun): {
  run: ExportRun
  next: ReturnType<typeof vi.fn>
  returnRun: ReturnType<typeof vi.fn>
} {
  const originalNext = run.next.bind(run)
  const originalReturn = run.return.bind(run)
  const next = vi.fn(() => originalNext())
  const returnRun = vi.fn((value: ExportResult | undefined) =>
    originalReturn(value),
  )
  run.next = next as typeof run.next
  run.return = returnRun as typeof run.return
  return { run, next, returnRun }
}

interface Harness {
  deps: ExportControllerDeps
  preparePlaybackForExport: ReturnType<typeof vi.fn>
  preflightProfile: ReturnType<typeof vi.fn>
  fetchBlob: ReturnType<typeof vi.fn>
  createMediaSource: ReturnType<typeof vi.fn>
  createPipelineDeps: ReturnType<typeof vi.fn>
  runExport: ReturnType<typeof vi.fn>
  media: ExportMediaSource
  pipelineDeps: PipelineExportDeps
}

function makeHarness(
  createRun: () => ExportRun = () => completedRun(),
): Harness {
  const media: ExportMediaSource = {
    openFrame: vi.fn(async () => {
      throw new Error('The fake controller media source is not decoded')
    }),
    close: vi.fn(async () => undefined),
  }
  const pipelineDeps = {} as PipelineExportDeps
  const preparePlaybackForExport = vi.fn(async () => undefined)
  const preflightProfile = vi.fn(async () => undefined)
  const fetchBlob = vi.fn(async () => new Blob(['source']))
  const createMediaSource = vi.fn(
    (
      _doc: TimelineDoc,
      _resolver: ExportAssetResolver,
      _sourceBounds: SourceBoundsCatalog,
    ) => media,
  )
  const createPipelineDeps = vi.fn(
    (
      _resolver: ExportAssetResolver,
      _sourceBounds: SourceBoundsCatalog,
      _fileDestination?: ExportFileDestinationCapability,
    ) => pipelineDeps,
  )
  const runExport = vi.fn(
    (
      _doc: TimelineDoc,
      _settings: ExportSettings,
      _media: ExportMediaSource,
      _pipelineDeps: PipelineExportDeps,
    ) => createRun(),
  )
  const deps: ExportControllerDeps = {
    preparePlaybackForExport,
    preflightProfile,
    fetchBlob,
    createMediaSource,
    createPipelineDeps,
    runExport,
  }
  return {
    deps,
    preparePlaybackForExport,
    preflightProfile,
    fetchBlob,
    createMediaSource,
    createPipelineDeps,
    runExport,
    media,
    pipelineDeps,
  }
}

const PREPARED_TOKEN = Object.freeze({
  kind: 'plugin-export-attempt-token' as const,
}) satisfies PluginExportAttemptToken

function preparedExecution(
  overrides: Partial<PluginPreparedExportExecution> = {},
): PluginPreparedExportExecution & { readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined)
  return {
    document: DOC,
    documentGeneration: 7,
    settings: SETTINGS,
    pluginSnapshot: createPluginVideoEffectContributionSnapshot(5, []),
    videoEffectStageExecutor: {
      applyPluginEffect: vi.fn(async () => ({ status: 'bypassed' as const })),
    },
    close,
    ...overrides,
  } as PluginPreparedExportExecution & { readonly close: ReturnType<typeof vi.fn> }
}

function preparedController(
  execution: PluginPreparedExportExecution,
): Pick<PluginExportAttemptController, 'consume'> & {
  readonly consume: ReturnType<typeof vi.fn>
} {
  return {
    consume: vi.fn(async () => execution),
  }
}

beforeEach(() => {
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  useDocumentStore.setState({ doc: DOC, past: [], future: [] })
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  useMediaStore.getState().addAsset(ASSET)
})

afterEach(async () => {
  await disposeExport()
})

describe('exportController wiring and completion', () => {
  test('awaits playback decoder teardown before preflight and media allocation', async () => {
    const playbackDrain = deferred()
    const h = makeHarness()
    h.preparePlaybackForExport.mockReturnValueOnce(playbackDrain.promise)
    const pending = startExport(SETTINGS, {}, h.deps)

    await Promise.resolve()
    expect(h.preparePlaybackForExport).toHaveBeenCalledOnce()
    expect(h.preflightProfile).not.toHaveBeenCalled()
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()

    playbackDrain.resolve()
    await expect(pending).resolves.toBe(RESULT)
    expect(h.preflightProfile).toHaveBeenCalledOnce()
  })

  test('rejects an over-budget timeline before any media or pipeline allocation', async () => {
    const h = makeHarness()
    const sourceTrack = DOC.tracks[0]
    const sourceClip = sourceTrack?.clips[0]
    if (!sourceTrack || !sourceClip) throw new Error('export budget fixture missing')
    useDocumentStore.setState({
      doc: {
        ...DOC,
        tracks: [{
          ...sourceTrack,
          clips: [{
            ...sourceClip,
            sourceRange: { ...sourceClip.sourceRange, durationFrames: 5_000_001 },
            timelineRange: { ...sourceClip.timelineRange, durationFrames: 5_000_001 },
          }],
        }],
      },
      past: [],
      future: [],
    })

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      'Export work exceeds the 5000000-frame limit.',
    )
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.preflightProfile).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('rejects an over-budget prepared plugin export before its frame plans allocate', async () => {
    const h = makeHarness()
    const sourceTrack = DOC.tracks[0]
    const sourceClip = sourceTrack?.clips[0]
    if (!sourceTrack || !sourceClip) throw new Error('prepared export budget fixture missing')
    const document: TimelineDoc = {
      ...DOC,
      tracks: [{
        ...sourceTrack,
        clips: [{
          ...sourceClip,
          sourceRange: { ...sourceClip.sourceRange, durationFrames: 5_000_001 },
          timelineRange: { ...sourceClip.timelineRange, durationFrames: 5_000_001 },
        }],
      }],
    }
    const execution = preparedExecution({ document })

    await expect(startPreparedExport(
      PREPARED_TOKEN,
      preparedController(execution),
      {},
      h.deps,
    )).rejects.toThrow('Export work exceeds the 5000000-frame limit.')
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.preflightProfile).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
    expect(execution.close).toHaveBeenCalledWith('plugin-export-failed')
  })

  test('requires the prepared path for an output-contributing plugin descriptor', async () => {
    const h = makeHarness()
    const pluginDoc: TimelineDoc = {
      ...DOC,
      tracks: DOC.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
          ...clip,
          opacity: 0,
          animation: {
            tracks: [{
              property: 'opacity',
              keyframes: [{
                frame: 0,
                value: 0,
                easing: { type: 'linear' },
              }, {
                frame: 1,
                value: 1,
                easing: { type: 'linear' },
              }],
            }],
            effectTracks: [],
          },
          effects: [{
            id: 'plugin-effect',
            type: 'plugin:com.example.fixture/effect',
            version: 1,
            enabled: true,
            params: {},
          }],
        })),
      })),
    }
    useDocumentStore.setState({ doc: pluginDoc })

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      /requires a prepared one-shot attempt/,
    )
    expect(h.preflightProfile).not.toHaveBeenCalled()
    expect(h.fetchBlob).not.toHaveBeenCalled()
  })

  test('consumes a ready attempt before profile, Blob, media, sink, or pipeline creation', async () => {
    const h = makeHarness()
    const execution = preparedExecution()
    const controller = preparedController(execution)
    const order: string[] = []
    controller.consume.mockImplementationOnce(async () => {
      order.push('plugin:consume')
      return execution
    })
    h.preflightProfile.mockImplementationOnce(async () => {
      order.push('profile')
    })
    h.fetchBlob.mockImplementationOnce(async () => {
      order.push('blob')
      return new Blob(['source'])
    })
    h.createPipelineDeps.mockImplementationOnce(() => {
      order.push('pipeline-deps')
      return h.pipelineDeps
    })
    h.createMediaSource.mockImplementationOnce(() => {
      order.push('media')
      return h.media
    })
    h.runExport.mockImplementationOnce(() => {
      order.push('run')
      return completedRun()
    })

    await expect(startPreparedExport(
      PREPARED_TOKEN,
      controller,
      {},
      h.deps,
    )).resolves.toBe(RESULT)

    expect(order).toEqual([
      'plugin:consume',
      'profile',
      'blob',
      'pipeline-deps',
      'media',
      'run',
    ])
    expect(h.createMediaSource.mock.calls[0][3]).toBe(execution.pluginSnapshot)
    expect(h.createPipelineDeps.mock.calls[0][3]).toBe(
      execution.videoEffectStageExecutor,
    )
    expect(execution.close).toHaveBeenCalledExactlyOnceWith('plugin-export-complete')
  })

  test('returns ready before a direct-file capability and acquires no resource when it is absent', async () => {
    const h = makeHarness()
    const execution = preparedExecution({ settings: FILE_SETTINGS })
    const controller = preparedController(execution)

    await expect(startPreparedExport(
      PREPARED_TOKEN,
      controller,
      {},
      h.deps,
    )).rejects.toThrow(/requires a user-selected file destination/)

    expect(controller.consume).toHaveBeenCalledOnce()
    expect(h.preflightProfile).not.toHaveBeenCalled()
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(execution.close).toHaveBeenCalledExactlyOnceWith('plugin-export-failed')
  })

  test('runs plugin preflight before an encoding profile probe and retains no Blob when it fails', async () => {
    const h = makeHarness()
    const execution = preparedExecution()
    const controller = preparedController(execution)
    const profileFailure = new Error('profile unsupported')
    h.preflightProfile.mockRejectedValueOnce(profileFailure)

    await expect(startPreparedExport(
      PREPARED_TOKEN,
      controller,
      {},
      h.deps,
    )).rejects.toBe(profileFailure)

    expect(controller.consume).toHaveBeenCalledOnce()
    expect(h.preflightProfile).toHaveBeenCalledOnce()
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(execution.close).toHaveBeenCalledExactlyOnceWith('plugin-export-failed')
  })

  test('preserves a runtime/pipeline failure over ordinary plugin-session cleanup failure', async () => {
    const primary = new Error('ready plugin failed during export')
    const execution = preparedExecution({
      close: vi.fn(async () => {
        throw new Error('ordinary plugin close failure')
      }),
    })
    const h = makeHarness(() => (async function* (): ExportRun {
      yield 0
      throw primary
    })())

    await expect(startPreparedExport(
      PREPARED_TOKEN,
      preparedController(execution),
      {},
      h.deps,
    )).rejects.toBe(primary)
    expect(execution.close).toHaveBeenCalledOnce()
  })

  test('cancels a pending attempt consume without starting resource factories', async () => {
    const h = makeHarness()
    const controller = {
      consume: vi.fn((_token: PluginExportAttemptToken, signal?: AbortSignal) => (
        new Promise<PluginPreparedExportExecution>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new PluginExportAttemptError(
            'aborted',
            'Plugin export preparation was cancelled',
          )), { once: true })
        })
      )),
    }
    const completion = startPreparedExport(PREPARED_TOKEN, controller, {}, h.deps)
    await vi.waitFor(() => expect(controller.consume).toHaveBeenCalledOnce())

    const cancellation = cancelExport()
    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(h.preflightProfile).not.toHaveBeenCalled()
    expect(h.fetchBlob).not.toHaveBeenCalled()
  })

  test('closes pinned plugins immediately while an abort-ignoring profile probe settles', async () => {
    const h = makeHarness()
    const execution = preparedExecution()
    const pendingProfile = deferred<void>()
    h.preflightProfile.mockImplementationOnce(async () => pendingProfile.promise)
    const completion = startPreparedExport(
      PREPARED_TOKEN,
      preparedController(execution),
      {},
      h.deps,
    )
    await vi.waitFor(() => expect(h.preflightProfile).toHaveBeenCalledOnce())

    const cancellation = cancelExport()
    await vi.waitFor(() => expect(execution.close).toHaveBeenCalledExactlyOnceWith(
      'plugin-export-cancelled',
    ))
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    pendingProfile.resolve()

    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(execution.close).toHaveBeenCalledOnce()
  })

  test('resolves exact in-flight plugin cancellation after generator and session cleanup', async () => {
    const pluginCall = deferred<void>()
    const close = vi.fn(async () => {
      pluginCall.resolve()
    })
    const execution = preparedExecution({ close })
    const wrappedCancellation = new VideoEffectStageExecutionError(
      'Plugin effect execution failed',
      new PluginExportAttemptError('aborted', 'Plugin export execution was cancelled'),
    )
    const observed = observeRun((async function* (): ExportRun {
      yield 0
      await pluginCall.promise
      throw wrappedCancellation
    })())
    const h = makeHarness(() => observed.run)
    const completion = startPreparedExport(
      PREPARED_TOKEN,
      preparedController(execution),
      {},
      h.deps,
    )
    await vi.waitFor(() => expect(observed.next).toHaveBeenCalledTimes(2))

    const cancellation = cancelExport()

    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(execution.close).toHaveBeenCalledExactlyOnceWith('plugin-export-cancelled')
    expect(observed.returnRun).not.toHaveBeenCalled()
  })

  test('preserves a genuine in-flight plugin failure when cancellation races it', async () => {
    const pluginCall = deferred<void>()
    const primary = new VideoEffectStageExecutionError(
      'Plugin effect execution failed',
      new Error('plugin crashed'),
    )
    const execution = preparedExecution({
      close: vi.fn(async () => pluginCall.resolve()),
    })
    const observed = observeRun((async function* (): ExportRun {
      yield 0
      await pluginCall.promise
      throw primary
    })())
    const h = makeHarness(() => observed.run)
    const completion = startPreparedExport(
      PREPARED_TOKEN,
      preparedController(execution),
      {},
      h.deps,
    )
    await vi.waitFor(() => expect(observed.next).toHaveBeenCalledTimes(2))

    const cancellation = cancelExport()

    const completionCheck = expect(completion).rejects.toBe(primary)
    const cancellationCheck = expect(cancellation).rejects.toBe(primary)
    await Promise.all([completionCheck, cancellationCheck])
    expect(execution.close).toHaveBeenCalledExactlyOnceWith('plugin-export-cancelled')
  })

  test('stops after a reentrant prepared Blob cancellation without creating media or pipeline', async () => {
    const h = makeHarness()
    let cancellation: Promise<void> | null = null
    h.fetchBlob.mockImplementationOnce(async () => {
      cancellation = cancelExport()
      return new Blob(['source'])
    })

    const completion = startPreparedExport(
      PREPARED_TOKEN,
      preparedController(preparedExecution()),
      {},
      h.deps,
    )

    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(h.preflightProfile).toHaveBeenCalledOnce()
    expect(h.fetchBlob).toHaveBeenCalledOnce()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
  })

  test('requires an exact destination capability/profile pairing', async () => {
    const missing = makeHarness()
    await expect(startExport(FILE_SETTINGS, {}, missing.deps)).rejects.toThrow(
      /requires a user-selected file destination/,
    )
    expect(missing.preflightProfile).not.toHaveBeenCalled()
    expect(missing.fetchBlob).not.toHaveBeenCalled()

    const unexpected = makeHarness()
    await expect(startExport(
      SETTINGS,
      { fileDestination: fileDestination() },
      unexpected.deps,
    )).rejects.toThrow(/download export cannot use a direct file destination/)
    expect(unexpected.preflightProfile).not.toHaveBeenCalled()
    expect(unexpected.fetchBlob).not.toHaveBeenCalled()
  })

  test('snapshots and forwards the selected one-shot file capability', async () => {
    const selected = fileDestination('chosen.mp4')
    const replacement = fileDestination('replacement.mp4')
    const options: {
      fileDestination?: ExportFileDestinationCapability
    } = { fileDestination: selected }
    const h = makeHarness(() => completedRun([0, 0.5], FILE_RESULT))

    const completion = startExport(FILE_SETTINGS, options, h.deps)
    options.fileDestination = replacement

    await expect(completion).resolves.toBe(FILE_RESULT)
    expect(h.createPipelineDeps.mock.calls[0][2]).toBe(selected)
    expect(h.runExport).toHaveBeenCalledWith(
      expect.any(Object),
      FILE_SETTINGS,
      h.media,
      h.pipelineDeps,
    )
  })

  test('rejects a freshly unsupported direct profile before consuming or allocating output', async () => {
    const failure = new Error(
      'Compatibility became unavailable. No codec was substituted.',
    )
    const selected = fileDestination('unsupported.mp4')
    const h = makeHarness()
    h.preflightProfile.mockRejectedValueOnce(failure)

    await expect(startExport(
      FILE_SETTINGS,
      { fileDestination: selected },
      h.deps,
    )).rejects.toBe(failure)

    expect(h.preflightProfile).toHaveBeenCalledWith(
      DOC,
      FILE_SETTINGS,
      expect.any(AbortSignal),
    )
    expect(h.fetchBlob).toHaveBeenCalledOnce()
    expect(selected.takeFileHandle).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('rejects referenced offline media before creating export resources', async () => {
    const descriptor = useMediaStore.getState().descriptors.get(ASSET.id)
    expect(descriptor).toBeDefined()
    useMediaStore.getState().disconnectAsset(ASSET.id)
    const h = makeHarness()

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      'Reconnect 1 offline source before exporting: source.mp4.',
    )

    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('rejects an audio clip from a video-only import before fetching', async () => {
    const videoOnly: MediaAsset = {
      ...ASSET,
      partialTrackSelection: 'video-only',
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    }
    useDocumentStore.setState({
      doc: docWithSourceClipOn('audio'),
      past: [],
      future: [],
    })
    useMediaStore.setState({
      assets: new Map([[videoOnly.id, videoOnly]]),
    })
    const h = makeHarness()

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      'Audio clip "source.mp4" cannot be exported because "source.mp4" was imported without audio.',
    )

    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('audio-off ignores partial audio sources without retaining them', async () => {
    const videoOnly: MediaAsset = {
      ...ASSET,
      partialTrackSelection: 'video-only',
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    }
    useDocumentStore.setState({
      doc: docWithSourceClipOn('audio'),
      past: [],
      future: [],
    })
    useMediaStore.setState({
      assets: new Map([[videoOnly.id, videoOnly]]),
    })
    const h = makeHarness()
    const audioOff = updateExportProfile(SETTINGS, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })

    await expect(startExport(audioOff, {}, h.deps)).resolves.toBe(RESULT)

    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.runExport).toHaveBeenCalledWith(
      expect.any(Object),
      audioOff,
      h.media,
      h.pipelineDeps,
    )
  })

  test('audio-off does not require reconnecting an otherwise contributing audio source', async () => {
    useDocumentStore.setState({
      doc: docWithSourceClipOn('audio'),
      past: [],
      future: [],
    })
    useMediaStore.getState().disconnectAsset(ASSET.id)
    const h = makeHarness()
    const audioOff = updateExportProfile(SETTINGS, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })

    await expect(startExport(audioOff, {}, h.deps)).resolves.toBe(RESULT)

    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.runExport).toHaveBeenCalledOnce()
  })

  test('constant-stretch audio-only output requires reconnecting its offline source', async () => {
    const audioDoc = docWithSourceClipOn('audio')
    audioDoc.tracks[0].clips[0] = {
      ...audioDoc.tracks[0].clips[0],
      timelineRange: { startFrame: 0, durationFrames: 1 },
      sourceRange: { startFrame: 0, durationFrames: 2 },
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 2_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    }
    useDocumentStore.setState({ doc: audioDoc, past: [], future: [] })
    useMediaStore.getState().disconnectAsset(ASSET.id)
    const h = makeHarness()

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      'Reconnect 1 offline source before exporting: source.mp4.',
    )
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('constant-stretch audio-only output retains its online source blob', async () => {
    const audioDoc = docWithSourceClipOn('audio')
    audioDoc.tracks[0].clips[0] = {
      ...audioDoc.tracks[0].clips[0],
      timelineRange: { startFrame: 0, durationFrames: 1 },
      sourceRange: { startFrame: 0, durationFrames: 2 },
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 2_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    }
    useDocumentStore.setState({ doc: audioDoc, past: [], future: [] })
    const h = makeHarness()

    await expect(startExport(SETTINGS, {}, h.deps)).resolves.toBe(RESULT)
    expect(h.fetchBlob).toHaveBeenCalledOnce()
  })

  test('a retimed visual contributor still requires and retains its source', async () => {
    const videoDoc = docWithSourceClipOn('video')
    videoDoc.tracks[0].clips[0] = {
      ...videoDoc.tracks[0].clips[0],
      timelineRange: { startFrame: 0, durationFrames: 1 },
      sourceRange: { startFrame: 0, durationFrames: 2 },
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 2_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    }
    useDocumentStore.setState({ doc: videoDoc, past: [], future: [] })
    const h = makeHarness()

    await expect(startExport(SETTINGS, {}, h.deps)).resolves.toBe(RESULT)
    expect(h.fetchBlob).toHaveBeenCalledOnce()

    useMediaStore.getState().disconnectAsset(ASSET.id)
    const offlineHarness = makeHarness()
    await expect(startExport(SETTINGS, {}, offlineHarness.deps)).rejects.toThrow(
      'Reconnect 1 offline source before exporting: source.mp4.',
    )
    expect(offlineHarness.fetchBlob).not.toHaveBeenCalled()
  })

  test('rejects a video clip from an audio-only import before fetching', async () => {
    const audioOnly: MediaAsset = {
      ...ASSET,
      fileName: 'source.m4a',
      mimeType: 'audio/mp4',
      kind: 'audio',
      partialTrackSelection: 'audio-only',
      frameRate: null,
      width: null,
      height: null,
      decoderConfigB64: null,
    }
    useDocumentStore.setState({
      doc: docWithSourceClipOn('video', audioOnly.fileName),
      past: [],
      future: [],
    })
    useMediaStore.setState({
      assets: new Map([[audioOnly.id, audioOnly]]),
    })
    const h = makeHarness()

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      'Video clip "source.m4a" cannot be exported because "source.m4a" was imported as audio only.',
    )

    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('does not block export for an output-suppressed offline source', async () => {
    useMediaStore.getState().disconnectAsset(ASSET.id)
    useDocumentStore.setState({
      doc: {
        ...DOC,
        tracks: DOC.tracks.map((track) => ({ ...track, hidden: true })),
      },
    })
    const h = makeHarness(() => completedRun())

    await expect(startExport(SETTINGS, {}, h.deps)).resolves.toBe(RESULT)
  })

  test('snapshots the run, shares one cached resolver, forwards progress, and returns the buffer', async () => {
    const observed = observeRun(completedRun())
    const h = makeHarness(() => observed.run)
    const progress: number[] = []
    const mutableSettings = { ...SETTINGS }

    const completion = startExport(
      mutableSettings,
      { onProgress: (value) => progress.push(value) },
      h.deps,
    )

    // The fresh preflight owns the first async phase. Once it passes, Blob
    // retention begins before later editor changes can revoke the captured
    // asset URL. Settings were snapshotted before either phase.
    await vi.waitFor(() => {
      expect(h.fetchBlob).toHaveBeenCalledWith(ASSET.objectUrl)
    })
    mutableSettings.videoBitrate = 1
    useDocumentStore.setState({ doc: { ...DOC, name: 'Edited later' } })
    useMediaStore.getState().removeAsset(ASSET.id)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(ASSET.objectUrl)

    const resolverFromMedia = h.createMediaSource.mock.calls[0][1]
    const resolverFromSink = h.createPipelineDeps.mock.calls[0][0]
    expect(resolverFromSink).toBe(resolverFromMedia)
    const boundsFromMedia = h.createMediaSource.mock.calls[0][2]
    const boundsFromSink = h.createPipelineDeps.mock.calls[0][1]
    expect(boundsFromSink).toBe(boundsFromMedia)
    expect(boundsFromSink.get(ASSET.id)).toEqual(ASSET.sourceBounds)

    const firstBlob = resolverFromMedia(ASSET.id)
    const secondBlob = resolverFromSink(ASSET.id)
    expect(firstBlob).toBe(secondBlob)
    await expect(firstBlob).resolves.toEqual({
      blob: expect.any(Blob),
      kind: ASSET.kind,
      budget: {
        fileBytes: ASSET.size,
        durationMicroseconds: ASSET.durationMicroseconds,
        width: ASSET.width,
        height: ASSET.height,
        framesPerSecond: 30,
        sampleRate: ASSET.audioSampleRate,
        channels: ASSET.audioChannels,
      },
    })
    expect(h.fetchBlob).toHaveBeenCalledOnce()
    expect(h.fetchBlob).toHaveBeenCalledWith(ASSET.objectUrl)

    await expect(completion).resolves.toBe(RESULT)
    expect(progress).toEqual([0, 0.4, 1])
    // Three yields plus the explicit final next() that retrieves RESULT.
    expect(observed.next).toHaveBeenCalledTimes(4)
    expect(observed.returnRun).not.toHaveBeenCalled()
    expect(h.createMediaSource.mock.calls[0][0]).toBe(DOC)
    expect(h.runExport).toHaveBeenCalledWith(
      DOC,
      SETTINGS,
      h.media,
      h.pipelineDeps,
    )
    expect(h.runExport.mock.calls[0][1]).not.toBe(mutableSettings)
  })

  test('leases captured Blobs before awaiting preflight but delays codec resources', async () => {
    const gate = deferred<void>()
    const h = makeHarness()
    h.preflightProfile.mockImplementationOnce(async () => gate.promise)
    const mutableSettings = { ...SETTINGS }

    const completion = startExport(mutableSettings, {}, h.deps)
    await vi.waitFor(() => expect(h.preflightProfile).toHaveBeenCalledOnce())

    const [capturedDoc, capturedSettings, signal] = h.preflightProfile.mock.calls[0]
    expect(capturedDoc).toBe(DOC)
    expect(capturedSettings).toEqual(SETTINGS)
    expect(capturedSettings).not.toBe(mutableSettings)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(h.fetchBlob).toHaveBeenCalledOnce()
    expect(h.fetchBlob).toHaveBeenCalledWith(ASSET.objectUrl)
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()

    mutableSettings.videoBitrate = 100_000
    useMediaStore.getState().removeAsset(ASSET.id)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(ASSET.objectUrl)
    gate.resolve()
    await expect(completion).resolves.toBe(RESULT)
    expect(h.runExport).toHaveBeenCalledWith(
      DOC,
      SETTINGS,
      h.media,
      h.pipelineDeps,
    )
  })

  test('reserves the singleton slot while preflight is pending', async () => {
    const gate = deferred<void>()
    const first = makeHarness()
    first.preflightProfile.mockImplementationOnce(async () => gate.promise)

    const completion = startExport(SETTINGS, {}, first.deps)
    await vi.waitFor(() => expect(first.preflightProfile).toHaveBeenCalledOnce())
    await expect(startExport(SETTINGS, {}, makeHarness().deps)).rejects.toThrow(
      /already in progress/i,
    )

    gate.resolve()
    await expect(completion).resolves.toBe(RESULT)
  })

  test('the captured resolver reports missing assets and preserves fetch failures', async () => {
    const fetchFailure = new Error('object URL expired')
    const h = makeHarness()
    h.fetchBlob.mockRejectedValueOnce(fetchFailure)

    await startExport(SETTINGS, {}, h.deps)
    const resolver = h.createMediaSource.mock.calls[0][1]

    expect(() => resolver('missing-asset')).toThrow(/missing-asset/)
    await expect(resolver(ASSET.id)).rejects.toBe(fetchFailure)
  })

  test('rejects an unexpected natural completion without a result, then allows retry', async () => {
    const malformed = makeHarness(() =>
      (async function* (): ExportRun {
        yield 0
        return undefined
      })(),
    )
    await expect(startExport(SETTINGS, {}, malformed.deps)).rejects.toThrow(
      /without an export result/i,
    )

    const retry = makeHarness()
    await expect(startExport(SETTINGS, {}, retry.deps)).resolves.toBe(RESULT)
  })
})

describe('exportController cancellation', () => {
  test('returns a committed file when cancellation loses the terminal race', async () => {
    const finalizeGate = deferred<void>()
    const observed = observeRun(
      (async function* (): ExportRun {
        yield 0
        await finalizeGate.promise
        return FILE_RESULT
      })(),
    )
    const h = makeHarness(() => observed.run)
    const completion = startExport(
      FILE_SETTINGS,
      { fileDestination: fileDestination() },
      h.deps,
    )
    await vi.waitFor(() => expect(observed.next).toHaveBeenCalledTimes(2))

    const cancellation = cancelExport()
    finalizeGate.resolve()

    await expect(completion).resolves.toBe(FILE_RESULT)
    await expect(cancellation).resolves.toBeUndefined()
    expect(observed.returnRun).not.toHaveBeenCalled()
  })

  test('reserves the run before immediate cancellation and creates no resources', async () => {
    const observed = observeRun(
      (async function* (): ExportRun {
        yield 0
        return RESULT
      })(),
    )
    const h = makeHarness(() => observed.run)
    const progress: number[] = []

    const completion = startExport(
      SETTINGS,
      { onProgress: (value) => progress.push(value) },
      h.deps,
    )

    const cancellation = cancelExport()
    expect(observed.returnRun).not.toHaveBeenCalled()

    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(progress).toEqual([])
    expect(observed.next).not.toHaveBeenCalled()
    expect(observed.returnRun).not.toHaveBeenCalled()
    expect(h.fetchBlob).not.toHaveBeenCalled()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('aborts a pending preflight, creates no codec resources, and allows retry', async () => {
    const h = makeHarness()
    h.preflightProfile.mockImplementationOnce(async (_doc, _settings, signal) => {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })

    const completion = startExport(SETTINGS, {}, h.deps)
    await vi.waitFor(() => expect(h.preflightProfile).toHaveBeenCalledOnce())
    const signal = h.preflightProfile.mock.calls[0][2] as AbortSignal
    const cancellation = cancelExport()

    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(signal.aborted).toBe(true)
    expect(h.fetchBlob).toHaveBeenCalledOnce()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.createPipelineDeps).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()

    const retry = makeHarness()
    await expect(startExport(SETTINGS, {}, retry.deps)).resolves.toBe(RESULT)
  })

  test('waits for an abort-ignoring preflight, then suppresses all setup', async () => {
    const gate = deferred<void>()
    const h = makeHarness()
    h.preflightProfile.mockImplementationOnce(async () => gate.promise)
    const completion = startExport(SETTINGS, {}, h.deps)
    await vi.waitFor(() => expect(h.preflightProfile).toHaveBeenCalledOnce())

    let cancelSettled = false
    const cancellation = cancelExport().finally(() => {
      cancelSettled = true
    })
    await Promise.resolve()
    expect(cancelSettled).toBe(false)

    gate.resolve()
    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(h.fetchBlob).toHaveBeenCalledOnce()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('preserves a real preflight error over simultaneous cancellation', async () => {
    const gate = deferred<void>()
    const failure = new Error('fresh encoder check failed')
    const h = makeHarness()
    h.preflightProfile.mockImplementationOnce(async () => {
      await gate.promise
      throw failure
    })
    const completion = startExport(SETTINGS, {}, h.deps)
    await vi.waitFor(() => expect(h.preflightProfile).toHaveBeenCalledOnce())
    const cancellation = cancelExport()
    const completionCheck = expect(completion).rejects.toBe(failure)
    const cancellationCheck = expect(cancellation).rejects.toBe(failure)

    gate.resolve()
    await Promise.all([completionCheck, cancellationCheck])
    expect(h.fetchBlob).toHaveBeenCalledOnce()
    expect(h.createMediaSource).not.toHaveBeenCalled()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('closes newly owned media once when setup synchronously re-enters cancel', async () => {
    const h = makeHarness()
    h.createMediaSource.mockImplementationOnce(() => {
      void cancelExport()
      return h.media
    })

    await expect(startExport(SETTINGS, {}, h.deps)).resolves.toBeUndefined()

    expect(h.media.close).toHaveBeenCalledOnce()
    expect(h.runExport).not.toHaveBeenCalled()
  })

  test('waits for an in-flight frame boundary, returns once, and is idempotent', async () => {
    const frameGate = deferred<void>()
    const observed = observeRun(
      (async function* (): ExportRun {
        yield 0
        await frameGate.promise
        yield 0.5
        return RESULT
      })(),
    )
    const h = makeHarness(() => observed.run)
    const progress: number[] = []
    const completion = startExport(
      SETTINGS,
      { onProgress: (value) => progress.push(value) },
      h.deps,
    )
    await vi.waitFor(() => expect(observed.next).toHaveBeenCalledTimes(2))

    const firstCancel = cancelExport()
    const secondCancel = cancelExport()
    expect(observed.returnRun).not.toHaveBeenCalled()
    frameGate.resolve()

    await expect(completion).resolves.toBeUndefined()
    await expect(Promise.all([firstCancel, secondCancel])).resolves.toEqual([
      undefined,
      undefined,
    ])
    expect(progress).toEqual([0])
    expect(observed.returnRun).toHaveBeenCalledOnce()
    await expect(cancelExport()).resolves.toBeUndefined() // idle is safe
  })

  test('a synchronous cancel at progress one is cancellation, not success', async () => {
    const observed = observeRun(completedRun([0, 1]))
    const h = makeHarness(() => observed.run)
    const progress: number[] = []
    let cancellation: Promise<void> | undefined

    const completion = startExport(
      SETTINGS,
      {
        onProgress: (value) => {
          progress.push(value)
          if (value === 1) cancellation = cancelExport()
        },
      },
      h.deps,
    )

    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(progress).toEqual([0, 1])
    expect(observed.returnRun).toHaveBeenCalledOnce()
    expect(observed.next).toHaveBeenCalledTimes(2)
  })

  test('rejects a concurrent start until cancellation cleanup finishes, then restarts', async () => {
    const frameGate = deferred<void>()
    const first = observeRun(
      (async function* (): ExportRun {
        yield 0
        await frameGate.promise
        yield 0.5
        return RESULT
      })(),
    )
    const h = makeHarness(() => first.run)
    const running = startExport(SETTINGS, {}, h.deps)
    await vi.waitFor(() => expect(first.next).toHaveBeenCalledTimes(2))

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      /already in progress/i,
    )
    const cancellation = cancelExport()
    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      /already in progress/i,
    )
    frameGate.resolve()
    await cancellation
    await expect(running).resolves.toBeUndefined()

    const retry = makeHarness()
    await expect(startExport(SETTINGS, {}, retry.deps)).resolves.toBe(RESULT)
  })

  test('preserves an in-flight export error over a simultaneous cancel request', async () => {
    const frameGate = deferred<void>()
    const failure = new Error('encoder failed')
    const observed = observeRun(
      (async function* (): ExportRun {
        yield 0
        await frameGate.promise
        throw failure
      })(),
    )
    const h = makeHarness(() => observed.run)
    const completion = startExport(SETTINGS, {}, h.deps)
    await vi.waitFor(() => expect(observed.next).toHaveBeenCalledTimes(2))
    const cancellation = cancelExport()

    const completionCheck = expect(completion).rejects.toBe(failure)
    const cancellationCheck = expect(cancellation).rejects.toBe(failure)
    frameGate.resolve()
    await Promise.all([completionCheck, cancellationCheck])
    expect(observed.returnRun).not.toHaveBeenCalled()
  })
})

describe('exportController failures and ownership', () => {
  test('reports an asset-scoped export failure while preserving the exact rejection', async () => {
    const failure = new MediaAssetRuntimeError(ASSET.id, {
      surface: 'export',
      trackKind: 'video',
      reason: 'decode-failed',
      detail: 'video decode failed during export',
    })
    const h = makeHarness(() =>
      (async function* (): ExportRun {
        yield 0
        throw failure
      })(),
    )

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toBe(failure)

    const media = useMediaStore.getState()
    expect(media.descriptors.has(ASSET.id)).toBe(true)
    expect(media.assets.has(ASSET.id)).toBe(false)
    expect(media.compatibility.get(ASSET.id)).toMatchObject({
      id: ASSET.id,
      fileName: ASSET.fileName,
      status: 'error',
      report: {
        status: 'error',
        reason: 'decode-failed',
        detail: 'Export failed: video decode failed during export',
        runtimeFailures: [{
          surface: 'export',
          trackKind: 'video',
          reason: 'decode-failed',
          detail: 'video decode failed during export',
        }],
      },
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(ASSET.objectUrl)
  })

  test('reports an export decoder budget rejection as a resource limit', async () => {
    const failure = new MediaAssetRuntimeError(ASSET.id, {
      surface: 'export',
      trackKind: 'video',
      reason: 'resource-limit',
      detail: 'Local ProRes safety budget is incomplete.',
    })
    const h = makeHarness(() =>
      (async function* (): ExportRun {
        yield 0
        throw failure
      })(),
    )

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toBe(failure)

    expect(useMediaStore.getState().compatibility.get(ASSET.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'resource-limit',
        runtimeFailures: [{
          surface: 'export',
          trackKind: 'video',
          reason: 'resource-limit',
          detail: 'Local ProRes safety budget is incomplete.',
        }],
      },
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(ASSET.objectUrl)
  })

  test('ignores a typed failure from an export snapshot after the asset is relinked', async () => {
    const gate = deferred<void>()
    const failure = new MediaAssetRuntimeError(ASSET.id, {
      surface: 'export',
      trackKind: 'audio',
      reason: 'resource-unavailable',
      detail: 'old captured source disappeared',
    })
    const observed = observeRun(
      (async function* (): ExportRun {
        yield 0
        await gate.promise
        throw failure
      })(),
    )
    const h = makeHarness(() => observed.run)
    const completion = startExport(SETTINGS, {}, h.deps)
    await vi.waitFor(() => expect(observed.next).toHaveBeenCalledTimes(2))

    const replacement = {
      ...ASSET,
      objectUrl: 'blob:replacement-source',
    }
    useMediaStore.getState().disconnectAsset(ASSET.id)
    expect(useMediaStore.getState().connectAsset(replacement)).toBe(true)
    gate.resolve()

    await expect(completion).rejects.toBe(failure)
    const media = useMediaStore.getState()
    expect(media.assets.get(ASSET.id)).toBe(replacement)
    expect(media.compatibility.has(ASSET.id)).toBe(false)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(
      replacement.objectUrl,
    )
  })

  test('does not publish ordinary encoder or observer failures as media failures', async () => {
    const failure = new Error('encoder failed globally')
    const h = makeHarness(() =>
      (async function* (): ExportRun {
        yield 0
        throw failure
      })(),
    )

    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toBe(failure)
    expect(useMediaStore.getState().assets.get(ASSET.id)).toBe(ASSET)
    expect(useMediaStore.getState().compatibility.size).toBe(0)
  })

  test('a progress callback failure closes the generator and remains primary', async () => {
    const callbackFailure = new Error('progress consumer failed')
    const cleanupFailure = new Error('cleanup also failed')
    const observed = observeRun(
      (async function* (): ExportRun {
        yield 0
        return RESULT
      })(),
    )
    observed.returnRun.mockRejectedValueOnce(cleanupFailure)
    const h = makeHarness(() => observed.run)

    await expect(
      startExport(
        SETTINGS,
        {
          onProgress: () => {
            throw callbackFailure
          },
        },
        h.deps,
      ),
    ).rejects.toBe(callbackFailure)
    expect(observed.returnRun).toHaveBeenCalledOnce()

    // The failed run released the singleton slot.
    const retry = makeHarness()
    await expect(startExport(SETTINGS, {}, retry.deps)).resolves.toBe(RESULT)
  })

  test('closes controller-owned media if setup fails before iteration starts', async () => {
    const setupFailure = new Error('could not create generator')
    const cleanupFailure = new Error('pre-start media close failed')
    const closeGate = deferred<void>()
    const h = makeHarness()
    vi.mocked(h.media.close).mockImplementationOnce(async () => {
      await closeGate.promise
      throw cleanupFailure
    })
    h.runExport.mockImplementationOnce(() => {
      throw setupFailure
    })

    const completion = startExport(SETTINGS, {}, h.deps)
    const completionCheck = completion.then(
      () => {
        throw new Error('setup failure unexpectedly resolved')
      },
      (cause) => expect(cause).toBe(setupFailure),
    )
    await vi.waitFor(() => expect(h.media.close).toHaveBeenCalledOnce())
    await expect(startExport(SETTINGS, {}, h.deps)).rejects.toThrow(
      /already in progress/i,
    )
    closeGate.resolve()
    await completionCheck

    const retry = makeHarness()
    await expect(startExport(SETTINGS, {}, retry.deps)).resolves.toBe(RESULT)
  })

  test('surfaces cancellation cleanup failures to both cancellation and completion', async () => {
    const frameGate = deferred<void>()
    const returnGate = deferred<IteratorResult<number, ExportResult | undefined>>()
    const cleanupFailure = new Error('cancel cleanup failed')
    const observed = observeRun(
      (async function* (): ExportRun {
        yield 0
        await frameGate.promise
        yield 0.5
        return RESULT
      })(),
    )
    observed.returnRun.mockImplementationOnce(() => returnGate.promise)
    const h = makeHarness(() => observed.run)
    const completion = startExport(SETTINGS, {}, h.deps)
    await vi.waitFor(() => expect(observed.next).toHaveBeenCalledTimes(2))
    const cancellation = cancelExport()

    const completionCheck = expect(completion).rejects.toBe(cleanupFailure)
    const cancellationCheck = expect(cancellation).rejects.toBe(cleanupFailure)
    frameGate.resolve()
    await vi.waitFor(() => expect(observed.returnRun).toHaveBeenCalledOnce())

    let completionSettled = false
    let cancellationSettled = false
    void completion.finally(() => {
      completionSettled = true
    }).catch(() => undefined)
    void cancellation.finally(() => {
      cancellationSettled = true
    }).catch(() => undefined)
    await Promise.resolve()
    expect(completionSettled).toBe(false)
    expect(cancellationSettled).toBe(false)

    returnGate.reject(cleanupFailure)
    await Promise.all([completionCheck, cancellationCheck])
    expect(observed.returnRun).toHaveBeenCalledOnce()
  })
})
