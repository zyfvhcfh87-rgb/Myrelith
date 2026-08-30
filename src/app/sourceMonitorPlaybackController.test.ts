/**
 * Source Monitor playback owner: signed-rate clock plus exclusive handoff.
 *
 * Program and Source share one injected AudioContext clock and tick queue.
 * Starting one must stop the other before any new tick is scheduled.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'
import type { Clip, MediaAsset, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  getSourceMonitorResetRevision,
  useSourceMonitorStore,
} from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'
import {
  closeSource,
  configureSourcePlayback,
  disposeSourcePlayback,
  getSourceAudioPlaybackDiagnostics,
  jumpToStart,
  requestPlayback,
  resetSession,
  scrubPlayhead,
  stepFrame,
  stepShuttle,
} from './sourceMonitorPlaybackController'
import {
  configureTransport,
  disposeTransport,
  pauseAndDrainPlayback,
  play,
} from './transportController'
import type { TransportDeps } from './transportController'

function makeClip(id: string, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: 0, durationFrames: duration },
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

function makeTrack(id: string, clips: Clip[], kind: Track['kind'] = 'video'): Track {
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

function makeDoc(durationFrames = 120): TimelineDoc {
  return {
    schemaVersion: 17,
    id: 'doc-source-playback',
    name: 'source playback fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', [makeClip('clipA', durationFrames)]),
    ],
  }
}

function makeAsset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-source',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 300,
    durationMicroseconds: 10_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...over,
  }
}

function compatibility(): MediaCompatibilityItem {
  return {
    id: 'asset-source',
    requestId: 'req-source',
    fileName: 'clip.mp4',
    declaredMimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    status: 'ready',
    report: null,
  }
}

function makeStartAudio(clock: { currentTime: number }) {
  return vi.fn<TransportDeps['startAudio']>(async () => ({
    anchorTime: clock.currentTime,
    stop: vi.fn(async () => undefined),
    diagnostics: vi.fn(() => ({
      anchorTime: clock.currentTime,
      fromFrame: 0,
      contextTime: clock.currentTime,
      activeNodeCount: 1,
      activeDecoderCount: 1,
      pendingBufferCount: 0,
      rms: 0.25,
      peakLeft: 0.5,
      peakRight: 0.25,
      peakMaster: 0.5,
      meterSampleSize: 256,
      scheduledThroughTimelineTime: 1,
      scheduledThroughContextTime: clock.currentTime + 1,
    })),
  }))
}

function makeFakeDeps() {
  const clock = {
    currentTime: 0,
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  const fetchBlob = vi.fn(async () => new Blob(['audio']))
  const startAudio = makeStartAudio(clock)
  const sourceStartAudio = makeStartAudio(clock)
  let nextId = 1
  const pending = new Map<number, () => void>()
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
      pending.set(id, cb)
      return id
    },
    cancelMeterPoll: (id: number) => void pending.delete(id),
    now: () => 0,
    subscribeDeviceChange: () => () => undefined,
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
    startAudio,
    sourceStartAudio,
    pump,
    pendingCount: () => pending.size,
  }
}

const source = () => useSourceMonitorStore.getState()
const transport = () => useTransportStore.getState()

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function openReadySource(over: Partial<MediaAsset> = {}): void {
  const asset = makeAsset(over)
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map([
      ['asset-1', makeAsset({ id: 'asset-1' })],
      [asset.id, asset],
    ]),
    visuals: new Map(),
    compatibility: new Map(),
  })
  const result = source().openSource({
    asset,
    compatibility: compatibility(),
  })
  expect(result.status).toBe('ok')
}

async function waitForSourceClock(): Promise<void> {
  await vi.waitFor(() => expect(fake.pendingCount()).toBeGreaterThan(0))
}

async function startedSourceAudio() {
  expect(fake.sourceStartAudio).toHaveBeenCalledTimes(1)
  return fake.sourceStartAudio.mock.results[0].value
}

let fake: ReturnType<typeof makeFakeDeps>

beforeEach(() => {
  source().resetSourceMonitor()
  transport().resetTransport()
  useDocumentStore.getState().setDoc(makeDoc())
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map([
      ['asset-1', makeAsset({ id: 'asset-1' })],
      ['asset-source', makeAsset()],
    ]),
    visuals: new Map(),
    compatibility: new Map(),
  })
  fake = makeFakeDeps()
  configureTransport(fake.deps)
  configureSourcePlayback({
    scheduleTick: fake.deps.scheduleTick,
    cancelTick: fake.deps.cancelTick,
    fetchBlob: fake.deps.fetchBlob,
    startAudio: fake.sourceStartAudio,
  })
})

afterEach(async () => {
  await disposeSourcePlayback()
  await disposeTransport()
})

describe('source / program exclusive playback', () => {
  test('starting source pauses Program and does not start a second mix', async () => {
    openReadySource()
    play()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    fake.clock.currentTime = 1
    fake.pump()
    expect(transport().playheadFrame).toBe(30)
    expect(fake.startAudio).not.toHaveBeenCalled()

    source().stepShuttle('l')
    const handoff = requestPlayback('source')
    expect(handoff).toEqual({ owner: 'source', pausedOwner: 'program' })
    expect(transport().isPlaying).toBe(false)
    expect(source().playbackOwner).toBe('source')
    expect(source().session?.shuttleStep).toBe(1)
    expect(fake.startAudio).not.toHaveBeenCalled()
    expect(fake.sourceStartAudio).toHaveBeenCalledTimes(1)
    const [clock, doc, fromFrame] = fake.sourceStartAudio.mock.calls[0]
    expect(clock).toBe(fake.clock)
    expect(doc.id).toBe('source-review:asset-source')
    expect(doc.frameRate).toEqual({ num: 30, den: 1 })
    expect(fromFrame).toBe(0)
    expect(doc.tracks).toEqual([
      expect.objectContaining({
        kind: 'audio',
        muted: false,
        clips: [
          expect.objectContaining({
            assetId: 'asset-source',
            volume: 1,
            sourceRange: { startFrame: 0, durationFrames: 300 },
            timelineRange: { startFrame: 0, durationFrames: 300 },
          }),
        ],
      }),
    ])
    expect(useDocumentStore.getState().doc.id).toBe('doc-source-playback')

    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))
    fake.clock.currentTime = 1.5
    fake.pump()
    expect(source().session?.playheadFrame).toBe(15)
    expect(transport().playheadFrame).toBe(30)
    expect(fake.startAudio).not.toHaveBeenCalled()
  })

  test('Source start waits for Program audio cleanup', async () => {
    useDocumentStore.getState().setDoc({
      ...makeDoc(),
      tracks: [makeTrack('A1', [makeClip('clipA', 120)], 'audio')],
    })
    openReadySource()
    play()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    const programAudio = await fake.startAudio.mock.results[0].value
    await vi.waitFor(() => expect(fake.pendingCount()).toBeGreaterThan(0))
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
    programAudio.stop.mockReturnValueOnce(stopGate)

    source().stepShuttle('l')
    requestPlayback('source')
    await vi.waitFor(() => expect(programAudio.stop).toHaveBeenCalled())
    expect(fake.sourceStartAudio).not.toHaveBeenCalled()

    releaseStop()
    await vi.waitFor(() => expect(fake.sourceStartAudio).toHaveBeenCalledOnce())
  })

  test('overlapping Source start and Program play drains do not deadlock', async () => {
    useDocumentStore.getState().setDoc({
      ...makeDoc(),
      tracks: [makeTrack('A1', [makeClip('clipA', 120)], 'audio')],
    })
    openReadySource()
    play()
    await vi.waitFor(() => expect(fake.startAudio).toHaveBeenCalledOnce())
    const programAudio = await fake.startAudio.mock.results[0].value
    await vi.waitFor(() => expect(fake.pendingCount()).toBeGreaterThan(0))
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
    programAudio.stop.mockReturnValueOnce(stopGate)

    source().stepShuttle('l')
    requestPlayback('source')
    await vi.waitFor(() => expect(programAudio.stop).toHaveBeenCalled())
    expect(fake.sourceStartAudio).not.toHaveBeenCalled()

    play()
    const draining = pauseAndDrainPlayback()
    let settled = false
    void draining.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseStop()
    await draining
    expect(settled).toBe(true)
    expect(transport().isPlaying).toBe(false)
    expect(fake.pendingCount()).toBe(0)
  })

  test('Program play() stops the source shuttle and clock first', async () => {
    openReadySource()
    source().stepShuttle('l')
    requestPlayback('source')
    const audio = await startedSourceAudio()
    await waitForSourceClock()
    fake.clock.currentTime = 0.5
    fake.pump()
    expect(source().session?.playheadFrame).toBe(15)
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
    audio.stop.mockReturnValueOnce(stopGate)

    play()
    expect(source().session?.shuttleStep).toBe(0)
    expect(source().playbackOwner).toBe('program')
    expect(transport().isPlaying).toBe(true)
    await vi.waitFor(() => expect(audio.stop).toHaveBeenCalled())
    expect(fake.pendingCount()).toBe(0)
    releaseStop()
    await vi.waitFor(() => expect(fake.pendingCount()).toBe(1))

    fake.clock.currentTime = 1
    fake.pump()
    expect(transport().playheadFrame).toBe(15)
    expect(source().session?.playheadFrame).toBe(15)
  })

  test('requestPlayback(program) stops source without starting Program mix', async () => {
    openReadySource()
    source().stepShuttle('l')
    requestPlayback('source')
    await waitForSourceClock()
    expect(fake.pendingCount()).toBe(1)

    const handoff = requestPlayback('program')
    expect(handoff).toEqual({ owner: 'program', pausedOwner: 'source' })
    expect(source().session?.shuttleStep).toBe(0)
    expect(fake.pendingCount()).toBe(0)
    expect(transport().isPlaying).toBe(false)
    expect(fake.startAudio).not.toHaveBeenCalled()
  })

  test('scrub, step, and jump cancel source timers', async () => {
    openReadySource()
    stepShuttle('l')
    await waitForSourceClock()
    expect(fake.pendingCount()).toBe(1)

    scrubPlayhead(40)
    expect(source().session).toMatchObject({
      playheadFrame: 40,
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)

    stepShuttle('l')
    await waitForSourceClock()
    stepFrame(1)
    expect(source().session).toMatchObject({
      playheadFrame: 41,
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)

    stepShuttle('l')
    await waitForSourceClock()
    jumpToStart()
    expect(source().session).toMatchObject({
      playheadFrame: 0,
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)
  })

  test('non-clock remaps halt source playback and clear shuttle', async () => {
    openReadySource()
    stepShuttle('l')
    const audio = await startedSourceAudio()
    await waitForSourceClock()
    expect(fake.pendingCount()).toBe(1)
    expect(source().session?.shuttleStep).toBe(1)

    const remapped = source().openSource({
      asset: makeAsset({ fileName: 'renamed.mp4' }),
      compatibility: compatibility(),
    })
    expect(remapped.status).toBe('ok')
    expect(source().session).toMatchObject({
      source: { fileName: 'renamed.mp4', durationFrames: 300 },
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)
    await vi.waitFor(() => expect(audio.stop).toHaveBeenCalled())
  })

  test('reopening the same asset on a new clock stops the previous source audio', async () => {
    openReadySource()
    stepShuttle('l')
    const audio = await startedSourceAudio()
    await waitForSourceClock()
    expect(fake.pendingCount()).toBe(1)

    const remapped = source().openSource({
      asset: makeAsset({
        durationMicroseconds: 5_000_000,
        durationFrames: 150,
      }),
      compatibility: compatibility(),
    })
    expect(remapped.status).toBe('ok')
    expect(source().session).toMatchObject({
      source: { durationFrames: 150 },
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)
    await vi.waitFor(() => expect(audio.stop).toHaveBeenCalled())
  })

  test('switching assets stops the previous source clock and audio', async () => {
    openReadySource()
    stepShuttle('l')
    const audio = await startedSourceAudio()
    await waitForSourceClock()
    expect(fake.pendingCount()).toBe(1)

    openReadySource({
      id: 'asset-other',
      fileName: 'other.mp4',
      objectUrl: 'blob:other',
    })
    expect(source().session?.source.assetId).toBe('asset-other')
    expect(source().session?.shuttleStep).toBe(0)
    expect(fake.pendingCount()).toBe(0)
    await vi.waitFor(() => expect(audio.stop).toHaveBeenCalled())

    fake.clock.currentTime = 2
    fake.pump()
    expect(source().session?.playheadFrame).toBe(0)
  })

  test('close and reset stop source timers', async () => {
    openReadySource()
    stepShuttle('l')
    await waitForSourceClock()
    closeSource()
    expect(source().session).toBeNull()
    expect(fake.pendingCount()).toBe(0)

    openReadySource()
    stepShuttle('j')
    resetSession()
    expect(source().session).toMatchObject({
      playheadFrame: 0,
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)
  })

  test('project replace invalidates in-flight source ticks', async () => {
    openReadySource()
    stepShuttle('l')
    const revision = getSourceMonitorResetRevision()
    await waitForSourceClock()
    expect(fake.pendingCount()).toBe(1)

    source().resetSourceMonitor()
    expect(getSourceMonitorResetRevision()).toBe(revision + 1)
    expect(source().session).toBeNull()
    expect(fake.pendingCount()).toBe(0)

    fake.clock.currentTime = 1
    fake.pump()
    openReadySource()
    expect(source().session?.playheadFrame).toBe(0)
  })

  test('2x shuttle follows the audio clock at signed rate 2', async () => {
    openReadySource()
    stepShuttle('l')
    const audio = await startedSourceAudio()
    stepShuttle('l')
    expect(source().session?.shuttleStep).toBe(2)
    expect(fake.sourceStartAudio).toHaveBeenCalledTimes(1)
    expect(getSourceAudioPlaybackDiagnostics()).toBeNull()
    await vi.waitFor(() => expect(audio.stop).toHaveBeenCalled())

    fake.clock.currentTime = 0.5
    fake.pump()
    expect(source().session?.playheadFrame).toBe(30)
  })

  test('reverse shuttle parks on frame 0 and stops', () => {
    openReadySource()
    source().setPlayhead(10)
    stepShuttle('j')
    expect(source().session?.shuttleStep).toBe(-1)

    fake.clock.currentTime = 10 / 30
    fake.pump()
    expect(source().session?.playheadFrame).toBe(0)
    expect(source().session?.shuttleStep).toBe(0)
    expect(fake.pendingCount()).toBe(0)
  })

  test('dispose cancels source ticks and restores injected deps', async () => {
    openReadySource()
    stepShuttle('l')
    await waitForSourceClock()
    expect(fake.pendingCount()).toBe(1)
    await disposeSourcePlayback()
    expect(fake.pendingCount()).toBe(0)
    fake.clock.currentTime = 2
    fake.pump()
    expect(source().session?.playheadFrame).toBe(0)
  })

})

describe('source audio audition', () => {
  test('reverse shuttle does not start source audio', () => {
    openReadySource()
    source().setPlayhead(10)
    stepShuttle('j')
    expect(source().session?.shuttleStep).toBe(-1)
    expect(fake.sourceStartAudio).not.toHaveBeenCalled()
    expect(fake.pendingCount()).toBe(1)
  })

  test('stills without audio stay silent at 1x', () => {
    openReadySource({
      kind: 'image',
      fileName: 'still.png',
      mimeType: 'image/png',
      frameRate: null,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
      sourceBounds: {
        video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 5_000_000 },
        audio: null,
      },
    })
    stepShuttle('l')
    expect(source().session?.shuttleStep).toBe(1)
    expect(fake.sourceStartAudio).not.toHaveBeenCalled()
    expect(fake.pendingCount()).toBe(1)
  })

  test('audio-only 1x still auditions on the shared clock', async () => {
    openReadySource({
      kind: 'audio',
      fileName: 'tone.wav',
      mimeType: 'audio/wav',
      frameRate: null,
      width: null,
      height: null,
      sourceBounds: {
        video: null,
        audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
      },
    })
    stepShuttle('l')
    expect(fake.sourceStartAudio).toHaveBeenCalledTimes(1)
    const doc = fake.sourceStartAudio.mock.calls[0][1]
    expect(doc.id).toBe('source-review:asset-source')
    expect(doc.frameRate).toEqual({ num: 30, den: 1 })
    expect(fake.startAudio).not.toHaveBeenCalled()
    await waitForSourceClock()
  })

  test('pause-and-drain waits for source audio decoder cleanup', async () => {
    openReadySource()
    stepShuttle('l')
    const audio = await startedSourceAudio()
    await waitForSourceClock()
    const stopGate = deferred<void>()
    audio.stop.mockImplementationOnce(() => stopGate.promise)

    const draining = pauseAndDrainPlayback()
    let settled = false
    void draining.then(() => { settled = true })
    await Promise.resolve()

    expect(audio.stop).toHaveBeenCalledOnce()
    expect(source().session?.shuttleStep).toBe(0)
    expect(settled).toBe(false)

    stopGate.resolve()
    await draining
    expect(settled).toBe(true)
    expect(fake.pendingCount()).toBe(0)
  })

  test('K stops the 1x source audio session', async () => {
    openReadySource()
    stepShuttle('l')
    const audio = await startedSourceAudio()
    await waitForSourceClock()
    expect(getSourceAudioPlaybackDiagnostics()).toMatchObject({
      activeDecoderCount: 1,
      rms: 0.25,
    })
    stepShuttle('k')
    expect(source().session?.shuttleStep).toBe(0)
    expect(getSourceAudioPlaybackDiagnostics()).toBeNull()
    await vi.waitFor(() => expect(audio.stop).toHaveBeenCalled())
    expect(fake.pendingCount()).toBe(0)
  })
})
