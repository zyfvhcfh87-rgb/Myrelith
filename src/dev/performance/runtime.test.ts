import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PreviewRenderDiagnostic } from '../../app/previewController'
import { resolveCrossfadePlan } from '../../domain/crossfadePlan'
import { createMaskEffect } from '../../domain/effectStack'
import { validateProjectFile } from '../../domain/projectFile'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useProjectSessionStore } from '../../state/projectSessionStore'
import { useTransportStore } from '../../state/transportStore'
import {
  PlaybackDiagnosticCapture,
  DEFAULT_PERFORMANCE_RUN_OPTIONS,
  MAX_CONTINUOUS_EXPORT_FRAMES,
  MAX_CONTINUOUS_PLAYBACK_DURATION_MS,
  PERFORMANCE_FIXTURE_MEDIA_GENERATION_SETTINGS,
  aggregatePlaybackAudioUnderruns,
  captureCanonicalPerformanceRunState,
  collectChromiumProcessMemoryEvidence,
  createPerformanceExportDocument,
  createSynthetic4kVideoSamplePlan,
  diagnosticDrawsExpectedFixtureClips,
  droppedFramesForPlaybackTrial,
  expectedTerminalFrameForPlaybackTrial,
  exportRealTimeRatioMetric,
  finishPlaybackCaptureBeforeSettling,
  observeStartedPlayback,
  normalizedRunOptions,
  missingExpectedFixtureDrawnClipIds,
  preparePerformanceHarness,
  resetAndVerifyCanonicalPerformanceRunState,
  summarizeMemorySamples,
  type PerformanceHarnessPreparationDeps,
} from './runtime'
import {
  createPerformanceFixture,
  expectedFixtureDrawnClipIds,
  fingerprintPerformanceFixture,
  PERFORMANCE_FIXTURE_RATE,
  PERFORMANCE_FIXTURE_SOURCE_IN_FRAME,
  PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS,
  type PerformanceFixtureRuntimeMedia,
} from './fixture'

function fingerprintMedia(): PerformanceFixtureRuntimeMedia {
  return {
    video: new Blob(['video'], { type: 'video/mp4' }),
    png: new Blob(['png'], { type: 'image/png' }),
    wav: new Blob(['wav'], { type: 'audio/wav' }),
    generation: PERFORMANCE_FIXTURE_MEDIA_GENERATION_SETTINGS,
  }
}

function renderDiagnostic(
  frame: number,
  mode: PreviewRenderDiagnostic['mode'] = 'playback',
  drawnClipIds: readonly string[] = ['clip'],
): PreviewRenderDiagnostic {
  return {
    frame,
    mode,
    requestedAt: 0,
    presentedAt: 1,
    result: {
      status: 'drawn',
      drawnClipIds: [...drawnClipIds],
      missingClipIds: [],
      renderMs: 1,
    },
  }
}

describe('performance playback evidence', () => {
  afterEach(() => vi.useRealTimers())

  test('starts the timed observation only after the audio session exposes its clock anchor', async () => {
    let now = 0
    let audioDiagnostic: {
      anchorTime: number
      contextTime: number
      scheduledThroughContextTime: number
    } | null = null
    let startupSleeps = 0
    let observationSleeps = 0

    const observation = await observeStartedPlayback(100, {
      startPlayback: () => {
        // isPlaying can already trigger a drawn frame-0 diagnostic here, but
        // the real audio clock is intentionally still unavailable.
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
        if (milliseconds === 10) {
          startupSleeps++
          if (startupSleeps === 2) {
            audioDiagnostic = {
              anchorTime: 1,
              contextTime: 1,
              scheduledThroughContextTime: 2,
            }
          }
        } else {
          observationSleeps++
        }
      },
      getAudioDiagnostics: () => audioDiagnostic,
      getPlayheadFrame: () => 0,
    }, 50)

    expect(startupSleeps).toBe(2)
    expect(observationSleeps).toBe(4)
    expect(observation).toEqual({
      audioUnderruns: 0,
      sawAudioDiagnostics: true,
    })
  })

  test('waits for a future audio anchor before starting the trial window', async () => {
    let now = 0
    let startupSleeps = 0
    let observationSleeps = 0
    let audioContextTime = 1
    let audioDiagnostic: {
      anchorTime: number
      contextTime: number
      scheduledThroughContextTime: number
    } | null = null

    await observeStartedPlayback(50, {
      startPlayback: () => {},
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
        if (milliseconds === 10) {
          startupSleeps++
          if (startupSleeps > 1) audioContextTime += 0.02
          audioDiagnostic = {
            anchorTime: 1.05,
            contextTime: audioContextTime,
            scheduledThroughContextTime: 2,
          }
        } else {
          observationSleeps++
        }
      },
      getAudioDiagnostics: () => audioDiagnostic,
      getPlayheadFrame: () => 0,
    }, 100)

    expect(startupSleeps).toBe(4)
    expect(observationSleeps).toBe(2)
    expect(now).toBe(90)
  })

  test('uses real playhead advancement when no audio session is available', async () => {
    let now = 0
    let playheadFrame = 0
    let startupSleeps = 0

    const observation = await observeStartedPlayback(50, {
      startPlayback: () => {},
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
        if (milliseconds === 10 && ++startupSleeps === 1) playheadFrame = 1
      },
      getAudioDiagnostics: () => null,
      getPlayheadFrame: () => playheadFrame,
    }, 50)

    expect(observation).toEqual({
      audioUnderruns: 0,
      sawAudioDiagnostics: false,
    })
    expect(now).toBe(60)
  })

  test('bounds playback startup when no diagnostic arrives', async () => {
    vi.useFakeTimers()
    const observation = observeStartedPlayback(100, {
      startPlayback: vi.fn(),
      now: () => 0,
      sleep: (milliseconds) => new Promise(
        (resolve) => setTimeout(resolve, milliseconds),
      ),
      getAudioDiagnostics: () => null,
      getPlayheadFrame: () => 0,
    }, 50)

    const rejection = expect(observation).rejects.toThrow(
      'Timed out after 50 ms waiting for the playback clock to start',
    )
    await vi.advanceTimersByTimeAsync(50)
    await rejection
  })

  test('rejects empty frame evidence and includes initial, internal, and stalled tail gaps', () => {
    expect(droppedFramesForPlaybackTrial([], 0, 8)).toBeNull()
    expect(droppedFramesForPlaybackTrial([3, 4, 6], 0, 8)).toBe(6)
    expect(droppedFramesForPlaybackTrial([0, 0, 2, 1, 3], 0, 3)).toBe(1)
    expect(droppedFramesForPlaybackTrial([0, 1, 2], 0, 6)).toBe(4)
    expect(droppedFramesForPlaybackTrial([0, 1, 9], 0, 6)).toBe(5)
    expect(expectedTerminalFrameForPlaybackTrial(
      0,
      350,
      { num: 30, den: 1 },
    )).toBe(10)
    expect(expectedTerminalFrameForPlaybackTrial(
      0,
      2_000,
      { num: 30, den: 1 },
    )).toBe(59)
    expect(expectedTerminalFrameForPlaybackTrial(
      5,
      2_001,
      { num: 30, den: 1 },
    )).toBe(65)
  })

  test('marks the audio aggregate unavailable when any trial lacks diagnostics', () => {
    expect(aggregatePlaybackAudioUnderruns([
      { audioUnderruns: 0, sawAudioDiagnostics: true },
      { audioUnderruns: 0, sawAudioDiagnostics: false },
    ])).toEqual({
      audioUnderruns: null,
      unavailableReason:
        'Audio diagnostics were unavailable for playback trial 2; missing evidence was not counted as zero.',
    })
    expect(aggregatePlaybackAudioUnderruns([
      { audioUnderruns: 0, sawAudioDiagnostics: true },
      { audioUnderruns: 2, sawAudioDiagnostics: true },
    ])).toEqual({
      audioUnderruns: [0, 2],
      unavailableReason: null,
    })
  })

  test('retains bounded playback frame numbers only while a trial is active', async () => {
    const capture = new PlaybackDiagnosticCapture(2)
    capture.record(renderDiagnostic(1, 'seek'))
    capture.record(renderDiagnostic(2))
    capture.record(renderDiagnostic(3))
    capture.record(renderDiagnostic(4))

    expect(capture.retainedCount()).toBe(2)
    expect(capture.finish()).toEqual({ frames: [2, 3], overflowed: true })
    expect(capture.retainedCount()).toBe(0)

    capture.record(renderDiagnostic(5))
    expect(capture.retainedCount()).toBe(0)
  })

  test('closes capture before pause and settling can report late frames', async () => {
    const capture = new PlaybackDiagnosticCapture(4)
    capture.record(renderDiagnostic(0))

    const captured = await finishPlaybackCaptureBeforeSettling(
      capture,
      () => capture.record(renderDiagnostic(1)),
      async () => {
        await Promise.resolve()
        capture.record(renderDiagnostic(2))
      },
    )

    expect(captured).toEqual({ frames: [0], overflowed: false })
    expect(capture.retainedCount()).toBe(0)
  })

  test('counts only frames that drew every expected connected fixture contributor', () => {
    const fixture = createPerformanceFixture()
    const expectedClipIds = expectedFixtureDrawnClipIds(fixture, 0)
    const partial = renderDiagnostic(0, 'playback', expectedClipIds.slice(0, -1))
    const complete = renderDiagnostic(0, 'playback', expectedClipIds)
    const capture = new PlaybackDiagnosticCapture(
      2,
      (diagnostic) => diagnosticDrawsExpectedFixtureClips(fixture, diagnostic),
    )

    expect(expectedClipIds).toHaveLength(3)
    expect(diagnosticDrawsExpectedFixtureClips(fixture, partial)).toBe(false)
    expect(missingExpectedFixtureDrawnClipIds(fixture, partial))
      .toEqual(expectedClipIds.slice(-1))
    capture.record(partial)
    capture.record(complete)
    expect(capture.finish()).toEqual({ frames: [0], overflowed: false })
  })
})

describe('performance source-backed workloads', () => {
  test('encodes frame-rate samples across the complete supported playback source window', () => {
    const samples = createSynthetic4kVideoSamplePlan()
    const terminalFrame = expectedTerminalFrameForPlaybackTrial(
      PERFORMANCE_FIXTURE_SOURCE_IN_FRAME,
      MAX_CONTINUOUS_PLAYBACK_DURATION_MS,
      PERFORMANCE_FIXTURE_RATE,
    )
    const playbackSamples = samples.slice(
      PERFORMANCE_FIXTURE_SOURCE_IN_FRAME,
      terminalFrame + 1,
    )
    const frameDurationSeconds = PERFORMANCE_FIXTURE_RATE.den
      / PERFORMANCE_FIXTURE_RATE.num

    expect(playbackSamples).toHaveLength(60)
    expect(new Set(playbackSamples.map((sample) => sample.index)).size).toBe(60)
    expect(playbackSamples.every(
      (sample) => Math.abs(sample.durationSeconds - frameDurationSeconds) < 1e-12,
    )).toBe(true)
    expect(samples.length).toBeLessThan(100)
    const finalSample = samples.at(-1)
    expect(finalSample).toBeDefined()
    expect(
      (finalSample?.timestampSeconds ?? 0) + (finalSample?.durationSeconds ?? 0),
    ).toBeCloseTo(PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS / 1e6, 10)
  })

  test('rejects playback and export durations beyond the continuous encoded window', () => {
    expect(() => normalizedRunOptions({
      playbackDurationMs: MAX_CONTINUOUS_PLAYBACK_DURATION_MS + 1,
    })).toThrow('continuous encoded source window')
    expect(() => normalizedRunOptions({
      exportFrames: MAX_CONTINUOUS_EXPORT_FRAMES + 1,
    })).toThrow('continuous encoded source window')
    expect(normalizedRunOptions({
      playbackDurationMs: MAX_CONTINUOUS_PLAYBACK_DURATION_MS,
      exportFrames: MAX_CONTINUOUS_EXPORT_FRAMES,
    })).toMatchObject({
      playbackDurationMs: MAX_CONTINUOUS_PLAYBACK_DURATION_MS,
      exportFrames: MAX_CONTINUOUS_EXPORT_FRAMES,
    })
  })

  test('builds a valid bounded export from connected 4K video, layers, transition, and audio', () => {
    const fixture = createPerformanceFixture()
    const sourceVideo = fixture.project.document.tracks
      .find((track) => track.kind === 'video')?.clips[0]
    if (!sourceVideo) throw new Error('performance fixture has no source video')
    sourceVideo.effects = [createMaskEffect('fixture-mask', 'ellipse')]
    sourceVideo.animation = {
      tracks: [],
      effectTracks: [{
        effectId: 'fixture-mask',
        parameter: 'x',
        keyframes: [{
          frame: 0,
          sourceTimeTicks: 1_000_000,
          value: 0.25,
          easing: { type: 'linear' },
        }],
      }],
    }
    const document = createPerformanceExportDocument(fixture, 30)
    const connectedAssetIds = new Set([
      ...fixture.connectedVideoAssetIds,
      ...fixture.connectedImageAssetIds,
      ...fixture.connectedAudioAssetIds,
    ])

    expect(() => validateProjectFile({
      ...fixture.project,
      document,
    })).not.toThrow()
    expect(document.tracks.filter((track) => track.kind === 'video')).toHaveLength(3)
    expect(document.tracks.filter((track) => track.kind === 'audio')).toHaveLength(2)
    expect(document.tracks.flatMap((track) => track.clips).filter(
      (clip) => clip.text === undefined,
    ).every((clip) => connectedAssetIds.has(clip.assetId))).toBe(true)

    const primaryVideoTrack = document.tracks[0]
    const transition = primaryVideoTrack.transitions[0]
    expect(primaryVideoTrack.clips).toHaveLength(2)
    expect(transition).toMatchObject({
      type: 'crossfade',
      durationFrames: 30,
    })
    const boundsCatalog = new Map(fixture.project.assets.map((asset) => (
      [asset.id, asset.sourceBounds] as const
    )))
    expect(resolveCrossfadePlan(
      document,
      primaryVideoTrack.id,
      transition.id,
      boundsCatalog,
    ).status).toBe('available')

    const videoDescriptor = fixture.project.assets.find(
      (asset) => asset.id === primaryVideoTrack.clips[0].assetId,
    )
    expect(videoDescriptor).toMatchObject({ width: 3_840, height: 2_160 })
    expect(document.tracks.some((track) => (
      track.kind === 'video' && track.clips.some((clip) => clip.text !== undefined)
    ))).toBe(true)
    expect(document.tracks.filter((track) => track.kind === 'audio').every(
      (track) => track.clips.length === 1 && track.clips[0].timelineRange.durationFrames === 30,
    )).toBe(true)
    const remintedMasks = document.tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.effects.some((effect) => effect.type === 'builtin.mask'))
    expect(remintedMasks.length).toBeGreaterThan(0)
    expect(remintedMasks.every((clip) => (
      clip.animation?.effectTracks?.[0].effectId === clip.effects[0].id
      && clip.effects[0].id !== 'fixture-mask'
    ))).toBe(true)
  })

  test('keeps the maximum export request inside ordinary sequential video samples', () => {
    const document = createPerformanceExportDocument(
      createPerformanceFixture(),
      MAX_CONTINUOUS_EXPORT_FRAMES,
    )
    const videoSourceEnd = Math.max(...document.tracks
      .filter((track) => track.kind === 'video')
      .flatMap((track) => track.clips)
      .filter((clip) => clip.sourceMode === 'timed' && clip.text === undefined)
      .map((clip) => clip.sourceRange.startFrame + clip.sourceRange.durationFrames))
    const sequentialSampleCount = createSynthetic4kVideoSamplePlan().length - 1

    expect(videoSourceEnd).toBeLessThanOrEqual(sequentialSampleCount)
    expect(() => createPerformanceExportDocument(
      createPerformanceFixture(),
      MAX_CONTINUOUS_EXPORT_FRAMES + 1,
    )).toThrow(`1 through ${MAX_CONTINUOUS_EXPORT_FRAMES}`)
  })
})

describe('performance export availability policy', () => {
  test('records only an explicit skip as unavailable without starting export', async () => {
    const measureExport = vi.fn(async () => [1])
    const metric = await exportRealTimeRatioMetric(
      { ...DEFAULT_PERFORMANCE_RUN_OPTIONS, skipExport: true },
      measureExport,
    )

    expect(metric).toMatchObject({
      status: 'unavailable',
      reason: 'Export was explicitly skipped for this smoke run.',
    })
    expect(measureExport).not.toHaveBeenCalled()
  })

  test('rejects unexpected requested-export preflight and execution failures', async () => {
    const measureExport = vi.fn(async () => {
      throw new Error('simulated export preflight regression')
    })

    await expect(exportRealTimeRatioMetric(
      { ...DEFAULT_PERFORMANCE_RUN_OPTIONS, skipExport: false },
      measureExport,
    )).rejects.toThrow('simulated export preflight regression')
  })
})

describe('performance memory evidence', () => {
  test('does not fabricate zero growth from one plateau sample', () => {
    expect(summarizeMemorySamples([64])).toEqual({
      plateauMiB: [64],
      growthKiB: null,
    })
    expect(summarizeMemorySamples([60, 61.5])).toEqual({
      plateauMiB: [60, 61.5],
      growthKiB: [1_536],
    })
  })

  test('preserves every requested post-warmup sample and growth delta', () => {
    expect(summarizeMemorySamples([60, 61, 62, 63, 64, 65, 66])).toEqual({
      plateauMiB: [60, 61, 62, 63, 64, 65, 66],
      growthKiB: [1_024, 1_024, 1_024, 1_024, 1_024, 1_024],
    })
  })

  test('requests complete host samples exactly at memory-batch boundaries', async () => {
    const events: string[] = []
    const evidence = await collectChromiumProcessMemoryEvidence(
      { memoryBatches: 2 },
      async (batchIndex) => {
        events.push(`work:${batchIndex}`)
      },
      async ({ batchIndex }) => {
        events.push(`sample:${batchIndex}`)
        return {
          status: 'measured',
          sample: {
            batchIndex,
            source: 'cdp:SystemInfo.getProcessInfo+host-os-process',
            hostSampler: 'test:private',
            primaryMetric: 'private-bytes',
            totalBytes: batchIndex * 300,
            processes: [
              {
                pid: 10,
                type: 'renderer',
                cpuTimeSeconds: 1,
                rssBytes: batchIndex * 200,
                privateBytes: batchIndex * 100,
                metricBytes: batchIndex * 100,
              },
              {
                pid: 11,
                type: 'GPU',
                cpuTimeSeconds: 2,
                rssBytes: batchIndex * 300,
                privateBytes: batchIndex * 200,
                metricBytes: batchIndex * 200,
              },
            ],
          },
        }
      },
      'win32',
    )

    expect(events).toEqual(['work:1', 'sample:1', 'work:2', 'sample:2'])
    expect(evidence).toMatchObject({
      status: 'measured',
      platform: 'win32',
      hostSampler: 'test:private',
      primaryMetric: 'private-bytes',
    })
    expect(evidence.samples.map((sample) => sample.totalBytes)).toEqual([300, 600])
  })

  test('keeps the workload but marks process memory unavailable without a host binding', async () => {
    const batches: number[] = []
    const evidence = await collectChromiumProcessMemoryEvidence(
      { memoryBatches: 2 },
      async (batchIndex) => {
        batches.push(batchIndex)
      },
      undefined,
      'Win32',
    )

    expect(batches).toEqual([1, 2])
    expect(evidence).toMatchObject({
      status: 'unavailable',
      hostSampler: null,
      primaryMetric: null,
      samples: [],
    })
    expect(evidence.reason).toMatch(/command-line Chromium host/i)
  })

  test('rejects partial process totals instead of publishing a measured plateau', async () => {
    let sampleCalls = 0
    const evidence = await collectChromiumProcessMemoryEvidence(
      { memoryBatches: 2 },
      async () => {},
      async ({ batchIndex }) => {
        sampleCalls++
        return {
        status: 'measured',
        sample: {
          batchIndex,
          source: 'cdp:SystemInfo.getProcessInfo+host-os-process',
          hostSampler: 'test:rss',
          primaryMetric: 'rss-bytes',
          totalBytes: 100,
          processes: [{
            pid: 10,
            type: 'renderer',
            cpuTimeSeconds: 1,
            rssBytes: 100,
            privateBytes: null,
            metricBytes: 100,
          }],
        },
        }
      },
      'test',
    )

    expect(sampleCalls).toBe(2)
    expect(evidence.status).toBe('unavailable')
    expect(evidence.samples).toEqual([])
    expect(evidence.reason).toMatch(/renderer and GPU/)
  })
})

describe('performance harness isolation', () => {
  const originalOffscreenCanvas = window.OffscreenCanvas
  let initialDocument: ReturnType<typeof useDocumentStore.getState>
  let initialMedia: ReturnType<typeof useMediaStore.getState>
  let initialProjectSession: ReturnType<typeof useProjectSessionStore.getState>
  let initialTransport: ReturnType<typeof useTransportStore.getState>

  beforeEach(() => {
    initialDocument = useDocumentStore.getState()
    initialMedia = useMediaStore.getState()
    initialProjectSession = useProjectSessionStore.getState()
    initialTransport = useTransportStore.getState()
    Object.defineProperty(window, 'OffscreenCanvas', {
      configurable: true,
      value: class TestOffscreenCanvas {},
    })
  })

  afterEach(() => {
    useDocumentStore.setState(initialDocument, true)
    useMediaStore.setState(initialMedia, true)
    useProjectSessionStore.setState(initialProjectSession, true)
    useTransportStore.setState(initialTransport, true)
    Object.defineProperty(window, 'OffscreenCanvas', {
      configurable: true,
      value: originalOffscreenCanvas,
    })
    vi.restoreAllMocks()
  })

  function preparationDeps(): PerformanceHarnessPreparationDeps {
    return {
      createVideo: vi.fn(async () => new Blob(['video'], { type: 'video/mp4' })),
      createPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
      createWav: vi.fn(() => new Blob(['wav'], { type: 'audio/wav' })),
      fingerprintFixture: vi.fn(async () => `sha256:${'a'.repeat(64)}`),
    }
  }

  test('restores isolated stores and revokes every generated media URL', async () => {
    let objectUrlIndex = 0
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:performance-${++objectUrlIndex}`,
    )
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const harness = await preparePerformanceHarness(preparationDeps())

    expect(useDocumentStore.getState().doc).not.toBe(initialDocument.doc)
    expect(useMediaStore.getState().assets.size).toBe(11)

    const evidence = await harness.cleanup()

    expect(evidence).toMatchObject({
      benchmarkObjectUrlsCreated: 11,
      benchmarkObjectUrlsRevoked: 11,
      documentStoreRestored: true,
      mediaStoreRestored: true,
      transportStoreRestored: true,
      projectSessionUnchanged: true,
      storesRestored: true,
    })
    expect(createObjectUrl).toHaveBeenCalledTimes(11)
    expect(revokeObjectUrl).toHaveBeenCalledTimes(11)
    expect(useDocumentStore.getState().doc).toBe(initialDocument.doc)
    expect(useMediaStore.getState().assets).toBe(initialMedia.assets)
    expect(useProjectSessionStore.getState()).toBe(initialProjectSession)
  })

  test('reports only successful benchmark URL revocations', async () => {
    let objectUrlIndex = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:performance-${++objectUrlIndex}`,
    )
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(
      (objectUrl) => {
        if (objectUrl === 'blob:performance-6') {
          throw new Error('simulated revoke failure')
        }
      },
    )

    const harness = await preparePerformanceHarness(preparationDeps())
    const evidence = await harness.cleanup()

    expect(revokeObjectUrl).toHaveBeenCalledTimes(11)
    expect(evidence.benchmarkObjectUrlsCreated).toBe(11)
    expect(evidence.benchmarkObjectUrlsRevoked).toBe(10)
    expect(evidence.storesRestored).toBe(true)
  })

  test('resets and fingerprint-verifies canonical stores before a run', async () => {
    let objectUrlIndex = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:performance-${++objectUrlIndex}`,
    )
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const harness = await preparePerformanceHarness(preparationDeps())
    const fixture = createPerformanceFixture()
    const media = fingerprintMedia()
    const fingerprint = await fingerprintPerformanceFixture(fixture, media)
    const canonical = captureCanonicalPerformanceRunState()
    const firstDescriptorId = canonical.media.descriptors.keys().next().value

    useDocumentStore.setState({
      doc: { ...canonical.document.doc, name: 'mutated before Run' },
      past: [canonical.document.doc],
      future: [canonical.document.doc],
    })
    useTransportStore.getState().setZoom(42)
    const mutatedDescriptors = new Map(canonical.media.descriptors)
    if (firstDescriptorId) mutatedDescriptors.delete(firstDescriptorId)
    useMediaStore.setState({ descriptors: mutatedDescriptors })

    await resetAndVerifyCanonicalPerformanceRunState(
      fixture,
      fingerprint,
      canonical,
      media,
      fingerprintPerformanceFixture,
    )

    expect(useDocumentStore.getState().doc).toBe(canonical.document.doc)
    expect(useDocumentStore.getState().past).toBe(canonical.document.past)
    expect(useDocumentStore.getState().future).toBe(canonical.document.future)
    expect(useTransportStore.getState().zoom).toBe(canonical.transport.zoom)
    expect(useMediaStore.getState().descriptors.size).toBe(100)
    expect(useMediaStore.getState().assets.size).toBe(11)

    await harness.cleanup()
  })

  test('refuses an active project before creating benchmark resources', async () => {
    const deps = preparationDeps()
    useProjectSessionStore.setState({ screen: 'editor' })

    await expect(preparePerformanceHarness(deps)).rejects.toThrow(
      'Performance harness refused to replace an active project session',
    )
    expect(deps.createPng).not.toHaveBeenCalled()
    expect(deps.createWav).not.toHaveBeenCalled()
    expect(deps.createVideo).not.toHaveBeenCalled()
    expect(useDocumentStore.getState()).toBe(initialDocument)
    expect(useMediaStore.getState()).toBe(initialMedia)
  })
})
