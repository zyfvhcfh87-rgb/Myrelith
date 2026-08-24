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
    schemaVersion: 14,
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

function makeFakeDeps() {
  const clock = {
    currentTime: 0,
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  const fetchBlob = vi.fn(async () => new Blob(['audio']))
  const startAudio = vi.fn<TransportDeps['startAudio']>(async () => ({
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
    pump,
    pendingCount: () => pending.size,
  }
}

const source = () => useSourceMonitorStore.getState()
const transport = () => useTransportStore.getState()

function openReadySource(): void {
  const result = source().openSource({
    asset: makeAsset(),
    compatibility: compatibility(),
  })
  expect(result.status).toBe('ok')
}

let fake: ReturnType<typeof makeFakeDeps>

beforeEach(() => {
  source().resetSourceMonitor()
  transport().resetTransport()
  useDocumentStore.getState().setDoc(makeDoc())
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map([['asset-1', makeAsset({ id: 'asset-1' })]]),
    visuals: new Map(),
    compatibility: new Map(),
  })
  fake = makeFakeDeps()
  configureTransport(fake.deps)
  configureSourcePlayback({
    scheduleTick: fake.deps.scheduleTick,
    cancelTick: fake.deps.cancelTick,
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

    fake.clock.currentTime = 1.5
    fake.pump()
    expect(source().session?.playheadFrame).toBe(15)
    expect(transport().playheadFrame).toBe(30)
    expect(fake.startAudio).not.toHaveBeenCalled()
  })

  test('Program play() stops the source shuttle and clock first', async () => {
    openReadySource()
    source().stepShuttle('l')
    requestPlayback('source')
    fake.clock.currentTime = 0.5
    fake.pump()
    expect(source().session?.playheadFrame).toBe(15)

    play()
    expect(source().session?.shuttleStep).toBe(0)
    expect(source().playbackOwner).toBe('program')
    expect(transport().isPlaying).toBe(true)

    fake.clock.currentTime = 1
    fake.pump()
    expect(transport().playheadFrame).toBe(15)
    expect(source().session?.playheadFrame).toBe(15)
  })

  test('requestPlayback(program) stops source without starting Program mix', () => {
    openReadySource()
    source().stepShuttle('l')
    requestPlayback('source')
    expect(fake.pendingCount()).toBe(1)

    const handoff = requestPlayback('program')
    expect(handoff).toEqual({ owner: 'program', pausedOwner: 'source' })
    expect(source().session?.shuttleStep).toBe(0)
    expect(fake.pendingCount()).toBe(0)
    expect(transport().isPlaying).toBe(false)
    expect(fake.startAudio).not.toHaveBeenCalled()
  })

  test('scrub, step, and jump cancel source timers', () => {
    openReadySource()
    stepShuttle('l')
    expect(fake.pendingCount()).toBe(1)

    scrubPlayhead(40)
    expect(source().session).toMatchObject({
      playheadFrame: 40,
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)

    stepShuttle('l')
    stepFrame(1)
    expect(source().session).toMatchObject({
      playheadFrame: 41,
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)

    stepShuttle('l')
    jumpToStart()
    expect(source().session).toMatchObject({
      playheadFrame: 0,
      shuttleStep: 0,
    })
    expect(fake.pendingCount()).toBe(0)
  })

  test('close and reset stop source timers', () => {
    openReadySource()
    stepShuttle('l')
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

  test('project replace invalidates in-flight source ticks', () => {
    openReadySource()
    stepShuttle('l')
    const revision = getSourceMonitorResetRevision()
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

  test('2x shuttle follows the audio clock at signed rate 2', () => {
    openReadySource()
    stepShuttle('l')
    stepShuttle('l')
    expect(source().session?.shuttleStep).toBe(2)

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
    expect(fake.pendingCount()).toBe(1)
    await disposeSourcePlayback()
    expect(fake.pendingCount()).toBe(0)
    fake.clock.currentTime = 2
    fake.pump()
    expect(source().session?.playheadFrame).toBe(0)
  })
})
