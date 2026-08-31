/**
 * app/transportController.test.ts — Phase 4.0.5.
 *
 * The controller under a fake clock + manual tick pump: play/pause/step
 * drive transportStore correctly, scrubbing preempts playback, and the
 * end of the doc (including mid-play shrinking) parks + pauses.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { Clip, MediaAsset, TimelineDoc, Track } from '../domain/schema'
import type {
  PlaybackAssetResolver,
  TimelineAudioPlaybackDiagnostics,
  TimelineAudioPlaybackSession,
  TimelineAudioPlaybackWarning,
} from '../pipeline/playback-audio'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import { useAudioMeterStore } from '../state/audioMeterStore'
import {
  configureTransport,
  disposeTransport,
  pause,
  pauseAndDrainPlayback,
  play,
  resetAudioMeterOverload,
  stepFrame,
  togglePlayback,
} from './transportController'
import type { TransportDeps } from './transportController'

function makeClip(
  id: string,
  tlStart: number,
  duration: number,
  options: {
    assetId?: string
    sourceStart?: number
    linkGroupId?: string
  } = {},
): Clip {
  return {
    id,
    assetId: options.assetId ?? 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: {
      startFrame: options.sourceStart ?? 0,
      durationFrames: duration,
    },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
    ...(options.linkGroupId ? { linkGroupId: options.linkGroupId } : {}),
  }
}

function makeTrack(
  id: string,
  clips: Clip[],
  kind: Track['kind'] = 'video',
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function makeAudibleDoc(durationFrames = 120): TimelineDoc {
  return {
    ...makeDoc(durationFrames),
    tracks: [
      makeTrack('V1', [makeClip('clipV', 0, durationFrames)]),
      makeTrack('A1', [makeClip('clipA', 0, durationFrames)], 'audio'),
    ],
  }
}

function makeAsset(id = 'asset-1'): MediaAsset {
  return {
    id,
    fileName: 'fixture.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: `blob:${id}`,
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 4_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
  }
}

function makeCrossfadeAudibleDoc(): TimelineDoc {
  const videoFrom = makeClip('video-from', 0, 60, {
    assetId: 'video-from-asset',
    sourceStart: 20,
    linkGroupId: 'from-link',
  })
  const videoTo = makeClip('video-to', 60, 60, {
    assetId: 'video-to-asset',
    sourceStart: 40,
    linkGroupId: 'to-link',
  })
  const audioFrom = makeClip('audio-from', 0, 60, {
    assetId: 'audio-from-asset',
    sourceStart: 20,
    linkGroupId: 'from-link',
  })
  const audioTo = makeClip('audio-to', 60, 60, {
    assetId: 'audio-to-asset',
    sourceStart: 40,
    linkGroupId: 'to-link',
  })
  const videoTrack = makeTrack('V1', [videoFrom, videoTo])
  videoTrack.transitions = [{
    id: 'crossfade',
    type: 'crossfade',
    fromClipId: videoFrom.id,
    toClipId: videoTo.id,
    durationFrames: 10,
    audio: { enabled: true, curve: 'linear' },
  }]
  return {
    ...makeDoc(),
    schemaVersion: 18,
    tracks: [
      videoTrack,
      makeTrack('A-from', [audioFrom], 'audio'),
      makeTrack('A-to', [audioTo], 'audio'),
    ],
  }
}

function descriptorFrom(asset: MediaAsset): PortableAssetDescriptor {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    durationMicroseconds: asset.durationMicroseconds,
    sourceBounds: asset.sourceBounds,
    nativeFrameRate: asset.frameRate,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
  }
}

function readyAudioTrack(): MediaTrackCompatibility {
  return {
    kind: 'audio',
    number: 1,
    primary: true,
    codec: 'aac',
    codecParameter: 'mp4a.40.2',
    internalCodecId: 'mp4a',
    decoderConfig: {
      codec: 'mp4a.40.2',
      descriptionBytes: 2,
      codedWidth: null,
      codedHeight: null,
      sampleRate: 48_000,
      channels: 2,
    },
    decoderPath: 'native',
    decodable: true,
    reason: null,
    detail: null,
    width: null,
    height: null,
    codedWidth: null,
    codedHeight: null,
    frameRate: null,
    sampleRate: 48_000,
    channels: 2,
  }
}

function readyCompatibility(
  asset: MediaAsset,
  requestId: string,
): MediaCompatibilityItem {
  const report: MediaCompatibilityReport = {
    status: 'ready',
    container: {
      name: 'MPEG-4',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    },
    durationMicroseconds: asset.durationMicroseconds,
    tracks: [readyAudioTrack()],
    reason: null,
    detail: null,
  }
  return {
    id: asset.id,
    requestId,
    fileName: asset.fileName,
    declaredMimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    status: 'ready',
    report,
  }
}

function seedReadyAsset(
  asset = makeAsset(),
  requestId = 'compat-audio-1',
): MediaCompatibilityItem {
  const compatibility = readyCompatibility(asset, requestId)
  useMediaStore.setState({
    descriptors: new Map([[asset.id, descriptorFrom(asset)]]),
    assets: new Map([[asset.id, asset]]),
    visuals: new Map(),
    compatibility: new Map([[asset.id, compatibility]]),
  })
  return compatibility
}

function makeAudioSession(
  anchorTime: number,
  diagnosticOverrides: Partial<TimelineAudioPlaybackDiagnostics> = {},
): TimelineAudioPlaybackSession & {
  stop: ReturnType<typeof vi.fn>
  diagnostics: ReturnType<typeof vi.fn>
} {
  return {
    anchorTime,
    stop: vi.fn(async () => undefined),
    diagnostics: vi.fn(() => ({
      anchorTime,
      fromFrame: 0,
      contextTime: anchorTime,
      activeNodeCount: 1,
      activeDecoderCount: 1,
      pendingBufferCount: 0,
      rms: 0.25,
      peakLeft: 0.5,
      peakRight: 0.25,
      peakMaster: 0.5,
      meterSampleSize: 256,
      scheduledThroughTimelineTime: 1,
      scheduledThroughContextTime: anchorTime + 1,
      ...diagnosticOverrides,
    })),
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** One 120-frame clip at 30fps → duration 120, last frame 119. */
function makeDoc(durationFrames = 120): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'doc-transport',
    name: 'transport fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', durationFrames > 0 ? [makeClip('clipA', 0, durationFrames)] : []),
    ],
  }
}

/** Fake AudioContext clock + manual rAF pump. */
function makeFakeDeps() {
  const clock = {
    currentTime: 0,
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  const fetchBlob = vi.fn(async () => new Blob(['audio']))
  const startAudio = vi.fn<TransportDeps['startAudio']>(
    async () => makeAudioSession(clock.currentTime),
  )
  let nextId = 1
  const pending = new Map<number, () => void>()
  const meterPending = new Map<number, () => void>()
  let nowMs = 0
  let deviceChange: (() => void) | null = null
  const unsubscribeDeviceChange = vi.fn()
  const deps = {
    createContext: () => clock,
    scheduleTick: (cb: () => void) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelTick: (id: number) => void pending.delete(id),
    scheduleMeterPoll: (cb: () => void) => {
      const id = nextId++
      meterPending.set(id, cb)
      return id
    },
    cancelMeterPoll: (id: number) => void meterPending.delete(id),
    now: () => nowMs,
    subscribeDeviceChange: (cb: () => void) => {
      deviceChange = cb
      return unsubscribeDeviceChange
    },
    fetchBlob,
    startAudio,
  }
  const pump = () => {
    const cbs = [...pending.values()]
    pending.clear()
    for (const cb of cbs) cb()
  }
  return {
    clock,
    deps,
    fetchBlob,
    startAudio,
    pump,
    pendingCount: () => pending.size,
    pumpMeter: (elapsedMs = 100) => {
      nowMs += elapsedMs
      const cbs = [...meterPending.values()]
      meterPending.clear()
      for (const cb of cbs) cb()
    },
    meterPendingCount: () => meterPending.size,
    fireDeviceChange: () => deviceChange?.(),
    unsubscribeDeviceChange,
  }
}

const transport = () => useTransportStore.getState()

let fake: ReturnType<typeof makeFakeDeps>

beforeEach(() => {
  useAudioMeterStore.getState().resetAudioMeter()
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
  })
  useDocumentStore.getState().setDoc(makeDoc())
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map([['asset-1', makeAsset()]]),
    visuals: new Map(),
    compatibility: new Map(),
  })
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  fake = makeFakeDeps()
  configureTransport(fake.deps)
})

afterEach(async () => {
  await disposeTransport()
})

describe('play / pause', () => {
  test('play flips isPlaying and the playhead follows the audio clock', () => {
    play()
    expect(transport().isPlaying).toBe(true)
    expect(fake.clock.resume).toHaveBeenCalled()

    fake.clock.currentTime = 1
    fake.pump()
    expect(transport().playheadFrame).toBe(30)

    fake.clock.currentTime = 2
    fake.pump()
    expect(transport().playheadFrame).toBe(60)
  })

  test('pause halts exactly where it is; clock keeps running harmlessly', () => {
    play()
    fake.clock.currentTime = 1
    fake.pump()
    pause()
    expect(transport().isPlaying).toBe(false)

    fake.clock.currentTime = 3
    fake.pump()
    expect(transport().playheadFrame).toBe(30) // unmoved

    // Resuming re-anchors: half a second later, 15 frames further.
    play()
    fake.clock.currentTime = 3.5
    fake.pump()
    expect(transport().playheadFrame).toBe(45)
  })

  test('reaching the last frame parks there and stops playing', () => {
    play()
    fake.clock.currentTime = 60 // way past a 4s doc
    fake.pump()
    expect(transport().playheadFrame).toBe(119)
    expect(transport().isPlaying).toBe(false)
    expect(fake.pendingCount()).toBe(0)
  })

  test('play with the playhead at the end restarts from frame 0', () => {
    transport().setPlayheadFrame(119)
    play()
    expect(transport().playheadFrame).toBe(0)
    fake.clock.currentTime = 0.5
    fake.pump()
    expect(transport().playheadFrame).toBe(15)
  })

  test('empty doc: play is a safe no-op', () => {
    useDocumentStore.getState().setDoc(makeDoc(0))
    play()
    expect(transport().isPlaying).toBe(false)
    expect(fake.pendingCount()).toBe(0)
  })

  test('togglePlayback alternates', () => {
    togglePlayback()
    expect(transport().isPlaying).toBe(true)
    togglePlayback()
    expect(transport().isPlaying).toBe(false)
  })

  test('play while already playing is a no-op (no re-anchor jump)', () => {
    play()
    fake.clock.currentTime = 1
    fake.pump()
    play() // must not re-anchor to t=1
    fake.clock.currentTime = 2
    fake.pump()
    expect(transport().playheadFrame).toBe(60)
  })
})

describe('live audio integration', () => {
  test('refuses to resolve a video-only asset for audio playback before fetching', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const videoOnly = {
      ...makeAsset(),
      partialTrackSelection: 'video-only' as const,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    }
    useMediaStore.setState({
      assets: new Map([[videoOnly.id, videoOnly]]),
    })
    let resolveAsset!: PlaybackAssetResolver
    fake.startAudio.mockImplementationOnce(async (
      _context,
      _doc,
      _fromFrame,
      resolver,
    ) => {
      resolveAsset = resolver
      return makeAudioSession(0)
    })

    play()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())

    expect(() => resolveAsset(videoOnly.id)).toThrow(
      'Playback media asset "fixture.mp4" has no imported audio track',
    )
    expect(fake.fetchBlob).not.toHaveBeenCalled()
  })

  test('audible playback waits for priming and shares the session anchor exactly', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const prime = deferred<TimelineAudioPlaybackSession>()
    const session = makeAudioSession(100.25)
    fake.startAudio.mockImplementationOnce(() => prime.promise)
    fake.clock.currentTime = 2

    play()

    expect(transport().isPlaying).toBe(true)
    expect(fake.pendingCount()).toBe(0)
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    expect(fake.startAudio.mock.calls[0][2]).toBe(0)

    // Time can move considerably while decoding. Video must still use the
    // AUDIO session's future anchor, not the context time at click/resolve.
    fake.clock.currentTime = 50
    prime.resolve(session)
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    fake.clock.currentTime = 100.75
    fake.pump()
    expect(transport().playheadFrame).toBe(15)
  })

  test('pause during pending prime aborts startup and stops its late session', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const prime = deferred<TimelineAudioPlaybackSession>()
    const lateSession = makeAudioSession(80)
    fake.startAudio.mockImplementationOnce(() => prime.promise)

    play()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    const options = fake.startAudio.mock.calls[0][4]

    pause()
    expect(options.signal?.aborted).toBe(true)
    expect(transport().isPlaying).toBe(false)
    expect(fake.pendingCount()).toBe(0)

    prime.resolve(lateSession)
    await vi.waitFor(() => expect(lateSession.stop).toHaveBeenCalledOnce())
    expect(fake.pendingCount()).toBe(0)

    fake.clock.currentTime = 1_000
    fake.pump()
    expect(transport().playheadFrame).toBe(0)
  })

  test('an audio-plan change replaces a pending prime without reviving it', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    transport().setPlayheadFrame(24)
    const firstPrime = deferred<TimelineAudioPlaybackSession>()
    const staleSession = makeAudioSession(5)
    const currentSession = makeAudioSession(6)
    fake.startAudio
      .mockImplementationOnce(() => firstPrime.promise)
      .mockResolvedValueOnce(currentSession)

    play()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    const firstSignal = fake.startAudio.mock.calls[0][4].signal

    const original = useDocumentStore.getState().doc
    useDocumentStore.getState().setDoc({
      ...original,
      tracks: original.tracks.map((track) =>
        track.id === 'A1'
          ? {
              ...track,
              clips: track.clips.map((clip) => ({ ...clip, volume: 0.5 })),
            }
          : track,
      ),
    })

    expect(firstSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledTimes(2))
    expect(fake.startAudio.mock.calls[1][2]).toBe(24)
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    firstPrime.resolve(staleSession)
    await vi.waitFor(() => expect(staleSession.stop).toHaveBeenCalledOnce())
    expect(currentSession.stop).not.toHaveBeenCalled()
    expect(transport().isPlaying).toBe(true)
    expect(fake.pendingCount()).toBe(1)
  })

  test('keeps audio alive through the final frame and stops at the exclusive end', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const session = makeAudioSession(0)
    fake.startAudio.mockResolvedValueOnce(session)

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    fake.clock.currentTime = 119 / 30
    fake.pump()
    expect(transport().playheadFrame).toBe(119)
    expect(transport().isPlaying).toBe(true)
    expect(session.stop).not.toHaveBeenCalled()

    fake.clock.currentTime = 4
    fake.pump()
    expect(transport().playheadFrame).toBe(119)
    expect(transport().isPlaying).toBe(false)
    expect(session.stop).toHaveBeenCalledOnce()
  })

  test.each(['pause', 'scrub', 'step'] as const)(
    '%s stops an active audio session',
    async (action) => {
      useDocumentStore.getState().setDoc(makeAudibleDoc())
      const session = makeAudioSession(0)
      fake.startAudio.mockResolvedValueOnce(session)

      play()
      await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

      if (action === 'pause') pause()
      else if (action === 'scrub') transport().setIsScrubbing(true)
      else stepFrame(1)

      expect(session.stop).toHaveBeenCalledOnce()
      expect(fake.pendingCount()).toBe(0)
      expect(transport().isPlaying).toBe(false)
      expect(transport().playheadFrame).toBe(action === 'step' ? 1 : 0)
    },
  )

  test('pause-and-drain waits for active audio decoder cleanup', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const stopGate = deferred<void>()
    const session = makeAudioSession(0)
    session.stop.mockImplementationOnce(() => stopGate.promise)
    fake.startAudio.mockResolvedValueOnce(session)

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    const draining = pauseAndDrainPlayback()
    let settled = false
    void draining.then(() => { settled = true })
    await Promise.resolve()

    expect(session.stop).toHaveBeenCalledOnce()
    expect(transport().isPlaying).toBe(false)
    expect(settled).toBe(false)

    stopGate.resolve()
    await draining
    expect(settled).toBe(true)
  })

  test('audio-plan changes re-prime from the current frame; video transforms do not', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const first = makeAudioSession(0)
    const second = makeAudioSession(1.05)
    fake.startAudio
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    fake.clock.currentTime = 1
    fake.pump()
    expect(transport().playheadFrame).toBe(30)

    const original = useDocumentStore.getState().doc
    const audioChanged: TimelineDoc = {
      ...original,
      tracks: original.tracks.map((track) =>
        track.id === 'A1'
          ? {
              ...track,
              clips: track.clips.map((clip) => ({ ...clip, volume: 0.5 })),
            }
          : track,
      ),
    }
    useDocumentStore.getState().setDoc(audioChanged)

    expect(first.stop).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledTimes(2))
    expect(fake.startAudio.mock.calls[1][2]).toBe(30)
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    const videoOnlyChange: TimelineDoc = {
      ...audioChanged,
      tracks: audioChanged.tracks.map((track) =>
        track.id === 'V1'
          ? {
              ...track,
              clips: track.clips.map((clip) => ({
                ...clip,
                transform: { ...clip.transform, x: clip.transform.x + 25 },
              })),
            }
          : track,
      ),
    }
    useDocumentStore.getState().setDoc(videoOnlyChange)
    await Promise.resolve()

    expect(fake.startAudio).toHaveBeenCalledTimes(2)
    expect(second.stop).not.toHaveBeenCalled()
  })

  test('transition, link, and source-bound edits replace live crossfade audio generations', async () => {
    const doc = makeCrossfadeAudibleDoc()
    useDocumentStore.getState().setDoc(doc)
    const ids = [
      'video-from-asset',
      'video-to-asset',
      'audio-from-asset',
      'audio-to-asset',
    ]
    const assets = new Map(ids.map((id) => [id, makeAsset(id)]))
    const descriptors = new Map(
      [...assets].map(([id, asset]) => [id, descriptorFrom(asset)]),
    )
    useMediaStore.setState({ assets, descriptors })

    const first = makeAudioSession(0)
    const second = makeAudioSession(0.1)
    const third = makeAudioSession(0.2)
    const fourth = makeAudioSession(0.3)
    fake.startAudio
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third)
      .mockResolvedValueOnce(fourth)

    play()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    expect(fake.startAudio.mock.calls[0][4].sourceBoundsCatalog?.size).toBe(4)

    const curveChanged = structuredClone(doc)
    curveChanged.tracks[0].transitions[0].audio.curve = 'equal-power'
    useDocumentStore.getState().setDoc(curveChanged)
    expect(first.stop).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    const linkChanged = structuredClone(curveChanged)
    delete linkChanged.tracks[1].clips[0].linkGroupId
    useDocumentStore.getState().setDoc(linkChanged)
    expect(second.stop).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    const nextDescriptors = new Map(descriptors)
    const changed = structuredClone(nextDescriptors.get('audio-from-asset'))
    if (!changed || changed.sourceBounds.audio?.status !== 'exact') {
      throw new Error('Expected exact audio descriptor bounds')
    }
    changed.sourceBounds.audio.endTimestampUs -= 1
    nextDescriptors.set(changed.id, changed)
    useMediaStore.setState({ descriptors: nextDescriptors })
    expect(third.stop).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    pause()
    expect(fourth.stop).toHaveBeenCalledOnce()
    expect(fake.pendingCount()).toBe(0)
  })

  test('audible asset replacement re-primes; unrelated media changes do not', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const first = makeAudioSession(0)
    const second = makeAudioSession(1.05)
    fake.startAudio
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    fake.clock.currentTime = 1
    fake.pump()
    expect(transport().playheadFrame).toBe(30)

    const replacement = {
      ...makeAsset(),
      objectUrl: 'blob:replacement',
    }
    const replacementAssets = new Map([['asset-1', replacement]])
    useMediaStore.setState({ assets: replacementAssets })

    expect(first.stop).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledTimes(2))
    expect(fake.startAudio.mock.calls[1][2]).toBe(30)
    await fake.startAudio.mock.calls[1][3]('asset-1')
    expect(fake.fetchBlob).toHaveBeenLastCalledWith('blob:replacement')

    const unrelatedAssets = new Map(replacementAssets)
    unrelatedAssets.set('asset-2', makeAsset('asset-2'))
    useMediaStore.setState({ assets: unrelatedAssets })
    await Promise.resolve()

    expect(fake.startAudio).toHaveBeenCalledTimes(2)
    expect(second.stop).not.toHaveBeenCalled()
  })

  test('audio startup failure logs once and falls back to clock-driven video', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.startAudio.mockRejectedValueOnce(new Error('decoder unavailable'))
    fake.clock.currentTime = 2

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    expect(transport().isPlaying).toBe(true)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('audio playback disabled; continuing with video'),
      'decoder unavailable',
    )
    fake.clock.currentTime = 3
    fake.pump()
    expect(transport().playheadFrame).toBe(30)
    warning.mockRestore()
  })

  test('an asset-scoped audio decode warning publishes a guarded runtime failure', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const asset = makeAsset()
    seedReadyAsset(asset)
    const failure = new Error('hardware decoder reset')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.startAudio.mockImplementationOnce(async (
      _context,
      _doc,
      _fromFrame,
      _resolveAsset,
      options,
    ) => {
      options.onWarning?.({
        scope: 'media',
        stage: 'decode',
        clipId: 'clipA',
        assetId: asset.id,
        trackKind: 'audio',
        reason: 'decode-failed',
        cause: failure,
      })
      return makeAudioSession(0)
    })

    play()

    await vi.waitFor(() => {
      expect(useMediaStore.getState().compatibility.get(asset.id)?.status)
        .toBe('error')
    })
    const media = useMediaStore.getState()
    expect(media.assets.has(asset.id)).toBe(false)
    expect(media.descriptors.has(asset.id)).toBe(true)
    expect(media.compatibility.get(asset.id)?.report).toMatchObject({
      status: 'error',
      reason: 'decode-failed',
      detail: 'Audio playback failed: hardware decoder reset',
      tracks: [expect.objectContaining({
        kind: 'audio',
        decodable: false,
        reason: 'decode-failed',
        detail: 'hardware decoder reset',
      })],
      runtimeFailures: [{
        surface: 'audio-playback',
        trackKind: 'audio',
        reason: 'decode-failed',
        detail: 'hardware decoder reset',
      }],
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(asset.objectUrl)
    expect(warning).toHaveBeenCalledWith(
      '[transportController] audio clip "clipA" decode failed:',
      'hardware decoder reset',
    )
    warning.mockRestore()
  })

  test('an audio decoder budget warning stays an exact resource limit', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const asset = makeAsset()
    seedReadyAsset(asset)
    const failure = new Error('Local E-AC-3 safety budget is incomplete.')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.startAudio.mockImplementationOnce(async (
      _context,
      _doc,
      _fromFrame,
      _resolveAsset,
      options,
    ) => {
      options.onWarning?.({
        scope: 'media',
        stage: 'source-open',
        clipId: 'clipA',
        assetId: asset.id,
        trackKind: 'audio',
        reason: 'resource-limit',
        cause: failure,
      })
      return makeAudioSession(0)
    })

    play()

    await vi.waitFor(() => {
      expect(useMediaStore.getState().compatibility.get(asset.id)?.status)
        .toBe('error')
    })
    expect(useMediaStore.getState().compatibility.get(asset.id)?.report)
      .toMatchObject({
        reason: 'resource-limit',
        tracks: [expect.objectContaining({
          kind: 'audio',
          decodable: false,
          reason: 'resource-limit',
        })],
        runtimeFailures: [{
          surface: 'audio-playback',
          trackKind: 'audio',
          reason: 'resource-limit',
          detail: failure.message,
        }],
      })
    warning.mockRestore()
  })

  test('a pre-track audio source warning stays file-level and resource-unavailable', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const asset = makeAsset()
    seedReadyAsset(asset)
    const failure = new Error('captured playback Blob disappeared')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.startAudio.mockImplementationOnce(async (
      _context,
      _doc,
      _fromFrame,
      _resolveAsset,
      options,
    ) => {
      options.onWarning?.({
        scope: 'media',
        stage: 'source-open',
        clipId: 'clipA',
        assetId: asset.id,
        trackKind: null,
        reason: 'resource-unavailable',
        cause: failure,
      })
      return makeAudioSession(0)
    })

    play()

    await vi.waitFor(() => {
      expect(useMediaStore.getState().compatibility.get(asset.id)?.status)
        .toBe('error')
    })
    expect(useMediaStore.getState().compatibility.get(asset.id)?.report)
      .toMatchObject({
        reason: 'resource-unavailable',
        tracks: [expect.objectContaining({
          kind: 'audio',
          decodable: true,
          reason: null,
        })],
        runtimeFailures: [{
          surface: 'audio-playback',
          trackKind: null,
          reason: 'resource-unavailable',
          detail: failure.message,
        }],
      })
    warning.mockRestore()
  })

  test('an offline audio clip stays silent without disabling an online sibling', async () => {
    const online = makeAsset('asset-online')
    const offline = makeAsset('asset-offline')
    const onlineClip = { ...makeClip('online', 0, 120), assetId: online.id }
    const offlineClip = { ...makeClip('offline', 0, 120), assetId: offline.id }
    useDocumentStore.getState().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', []),
        makeTrack('A1', [onlineClip, offlineClip], 'audio'),
      ],
    })
    useMediaStore.setState({
      descriptors: new Map([
        [online.id, descriptorFrom(online)],
        [offline.id, descriptorFrom(offline)],
      ]),
      assets: new Map([[online.id, online]]),
      visuals: new Map(),
      compatibility: new Map([[
        online.id,
        readyCompatibility(online, 'compat-online'),
      ]]),
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.startAudio.mockImplementationOnce(async (
      _context,
      _doc,
      _fromFrame,
      resolveAsset,
      options,
    ) => {
      await expect(resolveAsset(online.id)).resolves.toMatchObject({
        blob: expect.any(Blob),
        budget: {
          fileBytes: online.size,
          durationMicroseconds: online.durationMicroseconds,
          width: online.width,
          height: online.height,
          framesPerSecond: online.frameRate
            ? online.frameRate.num / online.frameRate.den
            : null,
          sampleRate: online.audioSampleRate,
          channels: online.audioChannels,
        },
      })
      expect(() => resolveAsset(offline.id)).toThrow(
        `Playback media asset "${offline.id}" is missing from the media pool`,
      )
      options.onWarning?.({
        scope: 'media',
        stage: 'source-open',
        clipId: offlineClip.id,
        assetId: offline.id,
        trackKind: null,
        reason: 'resource-unavailable',
        cause: new Error('offline source'),
      })
      return makeAudioSession(0)
    })

    play()

    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    expect(fake.fetchBlob).toHaveBeenCalledOnce()
    expect(fake.fetchBlob).toHaveBeenCalledWith(online.objectUrl)
    expect(fake.startAudio).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().assets.get(online.id)).toBe(online)
    expect(transport().isPlaying).toBe(true)
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith(
        '[transportController] audio clip "offline" source open failed:',
        'offline source',
      )
    })
    warning.mockRestore()
  })

  test('global audio output and cleanup warnings do not blame the media asset', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const asset = makeAsset()
    const compatibility = seedReadyAsset(asset)
    const outputFailure = new Error('speaker scheduling failed')
    const cleanupFailure = new Error('cursor close failed')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.startAudio.mockImplementationOnce(async (
      _context,
      _doc,
      _fromFrame,
      _resolveAsset,
      options,
    ) => {
      options.onWarning?.({
        scope: 'global',
        stage: 'output-schedule',
        cause: outputFailure,
      })
      options.onWarning?.({
        scope: 'global',
        stage: 'cleanup',
        cause: cleanupFailure,
      })
      return makeAudioSession(0)
    })

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    expect(useMediaStore.getState().assets.get(asset.id)).toBe(asset)
    expect(useMediaStore.getState().compatibility.get(asset.id))
      .toBe(compatibility)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(
      '[transportController] audio output scheduling failed:',
      'speaker scheduling failed',
    )
    expect(warning).toHaveBeenCalledWith(
      '[transportController] audio cleanup failed:',
      'cursor close failed',
    )
    warning.mockRestore()
  })

  test('a late audio warning cannot downgrade a newer source generation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const original = makeAsset()
    seedReadyAsset(original, 'compat-old')
    let onWarning:
      | ((warning: TimelineAudioPlaybackWarning) => void)
      | undefined
    fake.startAudio.mockImplementationOnce(async (
      _context,
      _doc,
      _fromFrame,
      _resolveAsset,
      options,
    ) => {
      onWarning = options.onWarning
      return makeAudioSession(0)
    })

    play()
    await vi.waitFor(() => expect(onWarning).toBeDefined())
    pause()

    const replacement = { ...original, objectUrl: 'blob:replacement' }
    const replacementCompatibility = readyCompatibility(
      replacement,
      'compat-new',
    )
    useMediaStore.setState({
      assets: new Map([[replacement.id, replacement]]),
      compatibility: new Map([[
        replacement.id,
        replacementCompatibility,
      ]]),
    })

    onWarning?.({
      scope: 'media',
      stage: 'source-open',
      clipId: 'clipA',
      assetId: original.id,
      trackKind: null,
      reason: 'resource-unavailable',
      cause: new Error('late old-source failure'),
    })

    expect(useMediaStore.getState().assets.get(original.id)).toBe(replacement)
    expect(useMediaStore.getState().compatibility.get(original.id))
      .toBe(replacementCompatibility)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(
      '[transportController] audio clip "clipA" source open failed:',
      'late old-source failure',
    )
    warning.mockRestore()
  })

  test('a rejected AudioContext resume stops silent playback cleanly', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.clock.resume.mockRejectedValueOnce(new Error('autoplay blocked'))

    play()
    await vi.waitFor(() => expect(transport().isPlaying).toBe(false))

    expect(fake.pendingCount()).toBe(0)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('AudioContext resume failed'),
      'autoplay blocked',
    )
    warning.mockRestore()
  })

  test('resume rejection aborts a pending prime and stops its late session', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const resume = deferred<undefined>()
    const prime = deferred<TimelineAudioPlaybackSession>()
    const lateSession = makeAudioSession(10)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.clock.resume.mockReturnValueOnce(resume.promise)
    fake.startAudio.mockImplementationOnce(() => prime.promise)

    play()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    const signal = fake.startAudio.mock.calls[0][4].signal
    resume.reject(new Error('resume rejected'))

    await vi.waitFor(() => expect(transport().isPlaying).toBe(false))
    expect(signal?.aborted).toBe(true)
    expect(fake.pendingCount()).toBe(0)

    prime.resolve(lateSession)
    await vi.waitFor(() => expect(lateSession.stop).toHaveBeenCalledOnce())
    expect(fake.pendingCount()).toBe(0)
    warning.mockRestore()
  })

  test('resume rejection stops an already-primed audio session', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const resume = deferred<undefined>()
    const session = makeAudioSession(3)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.clock.resume.mockReturnValueOnce(resume.promise)
    fake.startAudio.mockResolvedValueOnce(session)

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    resume.reject(new Error('resume rejected after prime'))

    await vi.waitFor(() => expect(session.stop).toHaveBeenCalledOnce())
    expect(transport().isPlaying).toBe(false)
    expect(fake.pendingCount()).toBe(0)
    warning.mockRestore()
  })

  test('a stale resume rejection cannot cancel a newer play generation', async () => {
    const firstResume = deferred<undefined>()
    fake.clock.resume
      .mockReturnValueOnce(firstResume.promise)
      .mockResolvedValueOnce(undefined)

    play()
    pause()
    play()
    firstResume.reject(new Error('old rejection'))
    await Promise.resolve()
    await Promise.resolve()

    expect(transport().isPlaying).toBe(true)
    expect(fake.pendingCount()).toBe(1)
  })

  test('AudioContext construction failure restores the stopped state', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    configureTransport({
      createContext: () => {
        throw new Error('context unavailable')
      },
    })

    expect(() => play()).not.toThrow()
    expect(transport().isPlaying).toBe(false)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('playback clock initialization failed'),
      'context unavailable',
    )
    warning.mockRestore()
  })

  test('disposing the transport closes its AudioContext', async () => {
    play()
    expect(fake.clock.close).not.toHaveBeenCalled()

    await disposeTransport()

    expect(fake.clock.close).toHaveBeenCalledOnce()
  })

  test('disposing waits for active audio cleanup before closing the context', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const stopGate = deferred<void>()
    const session = makeAudioSession(0)
    session.stop.mockImplementationOnce(() => stopGate.promise)
    fake.startAudio.mockResolvedValueOnce(session)

    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    const disposing = disposeTransport()
    await Promise.resolve()

    expect(session.stop).toHaveBeenCalledOnce()
    expect(fake.clock.close).not.toHaveBeenCalled()

    stopGate.resolve()
    await disposing
    expect(fake.clock.close).toHaveBeenCalledOnce()
  })
})

describe('bounded audio meter telemetry', () => {
  test('publishes at 10 Hz, latches overload, and stops cleanly on pause', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const session = makeAudioSession(0, {
      peakLeft: 1.25,
      peakRight: 0.5,
      peakMaster: 1.25,
    })
    fake.startAudio.mockResolvedValueOnce(session)

    play()
    await vi.waitFor(() => expect(fake.meterPendingCount()).toBe(1))
    expect(useAudioMeterStore.getState()).toMatchObject({
      status: 'active',
      sampleWindowSize: 256,
      readout: {
        overloadLatched: { left: true, right: false, master: true },
      },
    })
    const firstSequence = useAudioMeterStore.getState().sequence

    for (let index = 0; index < 5; index++) fake.pumpMeter()
    expect(session.diagnostics).toHaveBeenCalledTimes(6)
    expect(useAudioMeterStore.getState().sequence - firstSequence).toBe(5)
    expect(fake.meterPendingCount()).toBe(1)

    pause()
    const pausedSequence = useAudioMeterStore.getState().sequence
    expect(fake.meterPendingCount()).toBe(0)
    expect(useAudioMeterStore.getState()).toMatchObject({
      status: 'idle',
      readout: {
        db: { left: -60, right: -60, master: -60 },
        overloadLatched: { left: true, right: false, master: true },
      },
    })
    fake.pumpMeter(500)
    expect(useAudioMeterStore.getState().sequence).toBe(pausedSequence)

    resetAudioMeterOverload()
    expect(useAudioMeterStore.getState().readout.overloadLatched.master)
      .toBe(false)
  })

  test('reports unavailable without audio and does not schedule a meter loop', () => {
    play()

    expect(useAudioMeterStore.getState()).toMatchObject({
      status: 'unavailable',
      reason: 'No audible audio at the playhead',
    })
    expect(fake.meterPendingCount()).toBe(0)
  })

  test('device change supersedes the session, timer, and graph generation', async () => {
    useDocumentStore.getState().setDoc(makeAudibleDoc())
    const first = makeAudioSession(0, { peakMaster: 0.25 })
    const second = makeAudioSession(1, { peakMaster: 0.75 })
    fake.startAudio
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)

    play()
    await vi.waitFor(() => expect(fake.meterPendingCount()).toBe(1))
    fake.fireDeviceChange()

    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(second.diagnostics).toHaveBeenCalledOnce())
    expect(first.stop).toHaveBeenCalledOnce()
    expect(fake.meterPendingCount()).toBe(1)

    await disposeTransport()
    expect(fake.meterPendingCount()).toBe(0)
    expect(fake.unsubscribeDeviceChange).toHaveBeenCalledOnce()
    expect(useAudioMeterStore.getState().sequence).toBe(0)
  })
})

describe('interactions with the rest of the transport', () => {
  test('starting a scrub pauses playback', () => {
    play()
    expect(transport().isPlaying).toBe(true)
    transport().setIsScrubbing(true)
    expect(transport().isPlaying).toBe(false)

    fake.clock.currentTime = 5
    fake.pump()
    expect(transport().playheadFrame).toBe(0) // engine stopped, no writes
  })

  test('mid-play doc shrink clamps to the new end and pauses', () => {
    play()
    fake.clock.currentTime = 1
    fake.pump()
    expect(transport().playheadFrame).toBe(30)

    useDocumentStore.getState().setDoc(makeDoc(20)) // now last frame = 19
    fake.clock.currentTime = 1.1
    fake.pump()
    expect(transport().playheadFrame).toBe(19)
    expect(transport().isPlaying).toBe(false)
  })
})

describe('stepFrame', () => {
  test('moves exactly one frame each way', () => {
    transport().setPlayheadFrame(50)
    stepFrame(1)
    expect(transport().playheadFrame).toBe(51)
    stepFrame(-1)
    stepFrame(-1)
    expect(transport().playheadFrame).toBe(49)
  })

  test('clamps at 0 and at the last content frame', () => {
    stepFrame(-1)
    expect(transport().playheadFrame).toBe(0)
    transport().setPlayheadFrame(119)
    stepFrame(1)
    expect(transport().playheadFrame).toBe(119)
    // A playhead parked beyond the content (ruler allows it) steps back in.
    transport().setPlayheadFrame(500)
    stepFrame(1)
    expect(transport().playheadFrame).toBe(119)
  })

  test('stepping while playing pauses first, then moves one frame', () => {
    play()
    fake.clock.currentTime = 1
    fake.pump()
    stepFrame(1)
    expect(transport().isPlaying).toBe(false)
    expect(transport().playheadFrame).toBe(31)

    fake.clock.currentTime = 2
    fake.pump()
    expect(transport().playheadFrame).toBe(31) // really paused
  })
})
