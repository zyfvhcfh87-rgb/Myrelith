/**
 * app/exportController.test.ts — Phase 5.2a composition-root wiring.
 *
 * Mediabunny stays behind injected factories. These tests exercise the app
 * controller's document/media snapshots, explicit generator drain, result
 * delivery, cooperative cancellation, and single-run lifecycle.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import type { MediaAsset, TimelineDoc } from '../domain/schema'
import type {
  ExportDeps as PipelineExportDeps,
  ExportMediaSource,
} from '../pipeline/export'
import type { ExportAssetResolver } from '../pipeline/export-mediabunny'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  cancelExport,
  disposeExport,
  startExport,
  type ExportControllerDeps,
  type ExportResult,
  type ExportSettings,
} from './exportController'

const SETTINGS: ExportSettings = {
  format: 'mp4',
  videoCodec: 'avc',
  videoBitrate: 8_000_000,
}

const RESULT: ExportResult = {
  buffer: new Uint8Array([1, 2, 3]).buffer,
  mimeType: 'video/mp4',
}

const DOC: TimelineDoc = {
  schemaVersion: 1,
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
  const fetchBlob = vi.fn(async () => new Blob(['source']))
  const createMediaSource = vi.fn(
    (_doc: TimelineDoc, _resolver: ExportAssetResolver) => media,
  )
  const createPipelineDeps = vi.fn(
    (_resolver: ExportAssetResolver) => pipelineDeps,
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
    fetchBlob,
    createMediaSource,
    createPipelineDeps,
    runExport,
  }
  return {
    deps,
    fetchBlob,
    createMediaSource,
    createPipelineDeps,
    runExport,
    media,
    pipelineDeps,
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

    // Blob retention begins synchronously, before later editor changes can
    // revoke the captured asset URL. Settings are snapshotted too.
    expect(h.fetchBlob).toHaveBeenCalledWith(ASSET.objectUrl)
    mutableSettings.videoBitrate = 1
    useDocumentStore.setState({ doc: { ...DOC, name: 'Edited later' } })
    useMediaStore.getState().removeAsset(ASSET.id)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(ASSET.objectUrl)

    const resolverFromMedia = h.createMediaSource.mock.calls[0][1]
    const resolverFromSink = h.createPipelineDeps.mock.calls[0][0]
    expect(resolverFromSink).toBe(resolverFromMedia)

    const firstBlob = resolverFromMedia(ASSET.id)
    const secondBlob = resolverFromSink(ASSET.id)
    expect(firstBlob).toBe(secondBlob)
    await firstBlob
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
  test('starts iteration before immediate cancellation and suppresses unobserved progress', async () => {
    const initialGate = deferred<void>()
    const observed = observeRun(
      (async function* (): ExportRun {
        await initialGate.promise
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
    expect(observed.next).toHaveBeenCalledOnce()

    const cancellation = cancelExport()
    expect(observed.returnRun).not.toHaveBeenCalled()
    initialGate.resolve()

    await expect(completion).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBeUndefined()
    expect(progress).toEqual([])
    expect(observed.returnRun).toHaveBeenCalledOnce()
    expect(observed.returnRun).toHaveBeenCalledWith(undefined)
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
    const completionCheck = expect(completion).rejects.toBe(setupFailure)
    expect(h.media.close).toHaveBeenCalledOnce()
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
