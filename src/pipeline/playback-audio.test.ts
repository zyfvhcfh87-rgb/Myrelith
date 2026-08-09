/**
 * pipeline/playback-audio.test.ts — bounded live timeline-audio scheduling.
 *
 * Media decoding, Web Audio, and timers stay behind structural fakes. These
 * tests pin the shared clock anchor, bounded lookahead, failure isolation,
 * and exact cleanup behavior without requiring browser media globals.
 */

import { describe, expect, test, vi } from 'vitest'
import type {
  Clip,
  FrameRate,
  MediaSourceBounds,
  TimelineDoc,
  Track,
  Transition,
} from '../domain/schema'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import {
  audioPlaybackAssetIds,
  audioPlaybackPlanKey,
  createMediabunnyPlaybackAudioSource,
  createEqualPowerPlaybackCurve,
  createWebAudioPlaybackOutput,
  PLAYBACK_EQUAL_POWER_CURVE_POINTS,
  startTimelineAudioPlayback,
  type PlaybackAssetResolver,
  type PlaybackAudioBuffer,
  type PlaybackAudioClipRequest,
  type PlaybackAudioCursor,
  type PlaybackAudioDeps,
  type PlaybackAudioMediaSource,
  type PlaybackAudioOutput,
  type ScheduledPlaybackAudio,
} from './playback-audio'

const F10: FrameRate = { num: 10, den: 1 }

function makeClip(
  id: string,
  timelineStart: number,
  duration: number,
  options: {
    assetId?: string
    sourceStart?: number
    volume?: number
    linkGroupId?: string
    audio?: Clip['audio']
  } = {},
): Clip {
  return {
    id,
    assetId: options.assetId ?? `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: {
      startFrame: options.sourceStart ?? 0,
      durationFrames: duration,
    },
    timelineRange: { startFrame: timelineStart, durationFrames: duration },
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
    volume: options.volume ?? 1,
    effects: [],
    ...(options.audio ? { audio: options.audio } : {}),
    ...(options.linkGroupId ? { linkGroupId: options.linkGroupId } : {}),
  }
}

function makeTrack(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  flags: Partial<Pick<Track, 'muted' | 'solo'>> = {},
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: flags.muted ?? false,
    solo: flags.solo ?? false,
    locked: false,
  }
}

function makeDoc(audioTracks: Track[], durationFrames = 30): TimelineDoc {
  return {
    schemaVersion: 8,
    id: 'doc',
    name: 'Playback audio test',
    frameRate: F10,
    width: 64,
    height: 48,
    audioSampleRate: 48_000,
    tracks: [
      makeTrack(
        'V1',
        'video',
        [makeClip('video-runway', 0, durationFrames)],
      ),
      ...audioTracks,
    ],
  }
}

function exactBounds(): MediaSourceBounds {
  return {
    video: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: 10_000_000,
    },
    audio: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: 10_000_000,
    },
  }
}

function crossfadePlaybackFixture(
  curve: Transition['audio']['curve'] = 'linear',
): { doc: TimelineDoc; catalog: SourceBoundsCatalog } {
  const videoFrom = makeClip('video-from', 0, 10, {
    assetId: 'video-from-asset',
    sourceStart: 10,
    linkGroupId: 'from-link',
  })
  const videoTo = makeClip('video-to', 10, 10, {
    assetId: 'video-to-asset',
    sourceStart: 30,
    linkGroupId: 'to-link',
  })
  const audioFrom = makeClip('audio-from', 0, 10, {
    assetId: 'audio-from-asset',
    sourceStart: 10,
    linkGroupId: 'from-link',
    volume: 0.25,
  })
  const audioTo = makeClip('audio-to', 10, 10, {
    assetId: 'audio-to-asset',
    sourceStart: 30,
    linkGroupId: 'to-link',
    volume: 0.75,
  })
  const transition: Transition = {
    id: 'crossfade',
    type: 'crossfade',
    fromClipId: videoFrom.id,
    toClipId: videoTo.id,
    durationFrames: 4,
    audio: { enabled: true, curve },
  }
  const videoTrack = makeTrack('V1', 'video', [videoFrom, videoTo])
  videoTrack.transitions = [transition]
  return {
    doc: {
      schemaVersion: 8,
      id: 'crossfade-playback',
      name: 'Crossfade playback',
      frameRate: F10,
      width: 64,
      height: 48,
      audioSampleRate: 48_000,
      tracks: [
        videoTrack,
        makeTrack('A-from', 'audio', [audioFrom]),
        makeTrack('A-to', 'audio', [audioTo]),
      ],
    },
    catalog: new Map([
      ['video-from-asset', exactBounds()],
      ['video-to-asset', exactBounds()],
      ['audio-from-asset', exactBounds()],
      ['audio-to-asset', exactBounds()],
    ]),
  }
}

function decodedBuffer(
  label: string,
  timestamp: number,
  duration: number,
  bufferDuration = duration,
): PlaybackAudioBuffer {
  const buffer = { duration: bufferDuration, label } as unknown as AudioBuffer
  return { buffer, timestamp, duration }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type CursorStep =
  | PlaybackAudioBuffer
  | Error
  | Promise<IteratorResult<PlaybackAudioBuffer, void>>

interface CursorHarness {
  cursor: PlaybackAudioCursor
}

function makeCursor(initialSteps: CursorStep[]): CursorHarness {
  const steps = [...initialSteps]
  let closed = false
  const next = vi.fn(
    async (): Promise<IteratorResult<PlaybackAudioBuffer, void>> => {
      if (closed) return { done: true, value: undefined }
      const step = steps.shift()
      if (step === undefined) return { done: true, value: undefined }
      if (step instanceof Error) throw step
      if (step instanceof Promise) return step
      return { done: false, value: step }
    },
  )
  const close = vi.fn(async () => {
    closed = true
  })
  return { cursor: { next, close } }
}

interface MediaHarness {
  source: PlaybackAudioMediaSource
  requests: PlaybackAudioClipRequest[]
  enqueue(assetId: string, response: PlaybackAudioCursor | Error): void
}

function makeMediaHarness(): MediaHarness {
  const requests: PlaybackAudioClipRequest[] = []
  const responses = new Map<string, Array<PlaybackAudioCursor | Error>>()
  const enqueue = (
    assetId: string,
    response: PlaybackAudioCursor | Error,
  ): void => {
    const queue = responses.get(assetId) ?? []
    queue.push(response)
    responses.set(assetId, queue)
  }
  const openClip = vi.fn(async (request: PlaybackAudioClipRequest) => {
    requests.push({ ...request })
    const response = responses.get(request.assetId)?.shift()
    if (!response) {
      throw new Error(`No fake audio cursor for ${request.assetId}`)
    }
    if (response instanceof Error) throw response
    return response
  })
  const close = vi.fn(async () => undefined)
  return { source: { openClip, close }, requests, enqueue }
}

interface OutputHarness {
  output: PlaybackAudioOutput
  scheduled: ScheduledPlaybackAudio[]
  setTime(value: number): void
  queueTimes(...values: number[]): void
}

function makeOutputHarness(initialTime: number): OutputHarness {
  let now = initialTime
  const queuedTimes: number[] = []
  const scheduled: ScheduledPlaybackAudio[] = []
  const currentTime = vi.fn(() => {
    const queued = queuedTimes.shift()
    if (queued !== undefined) now = queued
    return now
  })
  const schedule = vi.fn((request: ScheduledPlaybackAudio) => {
    scheduled.push(request)
  })
  const stop = vi.fn()
  const output: PlaybackAudioOutput = {
    currentTime,
    schedule,
    stop,
    diagnostics: () => ({
      contextTime: now,
      activeNodeCount: scheduled.length,
      rms: 0,
      peakLeft: 0,
      peakRight: 0,
      peakMaster: 0,
      meterSampleSize: 256,
    }),
  }
  return {
    output,
    scheduled,
    setTime: (value) => {
      now = value
    },
    queueTimes: (...values) => {
      queuedTimes.push(...values)
    },
  }
}

interface PumpEntry {
  callback: () => void
  delayMs: number
}

interface TimerHarness {
  schedulePump: PlaybackAudioDeps['schedulePump']
  cancelPump: PlaybackAudioDeps['cancelPump']
  pendingCount(): number
  runNext(): PumpEntry
}

function makeTimerHarness(): TimerHarness {
  let nextId = 1
  const pending = new Map<number, PumpEntry>()
  const schedulePump = vi.fn((callback: () => void, delayMs: number) => {
    const id = nextId++
    pending.set(id, { callback, delayMs })
    return id
  })
  const cancelPump = vi.fn((id: number) => {
    pending.delete(id)
  })
  return {
    schedulePump,
    cancelPump,
    pendingCount: () => pending.size,
    runNext: () => {
      const entry = [...pending.entries()][0]
      if (!entry) throw new Error('No fake audio pump is queued')
      pending.delete(entry[0])
      entry[1].callback()
      return entry[1]
    },
  }
}

interface PlaybackHarnessOptions {
  currentTime?: number
  lookaheadSeconds?: number
  startLeadSeconds?: number
  pumpIntervalMs?: number
}

function makePlaybackHarness(options: PlaybackHarnessOptions = {}): {
  context: AudioContext
  resolveAsset: PlaybackAssetResolver
  media: MediaHarness
  output: OutputHarness
  timers: TimerHarness
  deps: PlaybackAudioDeps
} {
  const context = {} as AudioContext
  const resolveAsset: PlaybackAssetResolver = async () => ({
    blob: new Blob(),
    budget: {
      fileBytes: 0,
      durationMicroseconds: 1_000_000,
      sampleRate: 48_000,
      channels: 2,
    },
  })
  const media = makeMediaHarness()
  const output = makeOutputHarness(options.currentTime ?? 5)
  const timers = makeTimerHarness()
  const deps: PlaybackAudioDeps = {
    createMediaSource: vi.fn(() => media.source),
    createOutput: vi.fn(() => output.output),
    schedulePump: timers.schedulePump,
    cancelPump: timers.cancelPump,
    lookaheadSeconds: options.lookaheadSeconds ?? 0.5,
    startLeadSeconds: options.startLeadSeconds ?? 0.05,
    pumpIntervalMs: options.pumpIntervalMs ?? 25,
  }
  return { context, resolveAsset, media, output, timers, deps }
}

interface FakeAudioParam {
  value: number
  cancelScheduledValues: ReturnType<typeof vi.fn>
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  setValueCurveAtTime: ReturnType<typeof vi.fn>
}

interface FakeGainNode {
  gain: FakeAudioParam
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeSourceNode {
  buffer: AudioBuffer | null
  onended: (() => void) | null
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

interface FakeChannelNode {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeAnalyserNode extends FakeChannelNode {
  fftSize: number
  smoothingTimeConstant: number
  samples: readonly number[]
  getFloatTimeDomainData: ReturnType<typeof vi.fn>
}

function makeWebAudioHarness(state: AudioContextState): {
  context: AudioContext
  gains: FakeGainNode[]
  sources: FakeSourceNode[]
  splitters: FakeChannelNode[]
  mergers: FakeChannelNode[]
  analysers: FakeAnalyserNode[]
} {
  const gains: FakeGainNode[] = []
  const sources: FakeSourceNode[] = []
  const splitters: FakeChannelNode[] = []
  const mergers: FakeChannelNode[] = []
  const analysers: FakeAnalyserNode[] = []
  const makeGain = (): FakeGainNode => ({
    gain: {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      setValueCurveAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  })
  const context = {
    currentTime: 5,
    state,
    destination: {},
    createGain: vi.fn(() => {
      const gain = makeGain()
      gains.push(gain)
      return gain
    }),
    createAnalyser: vi.fn(() => {
      const analyser: FakeAnalyserNode = {
        fftSize: 0,
        smoothingTimeConstant: 1,
        samples: [],
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn((samples: Float32Array) => {
          samples.forEach((_, index) => {
            samples[index] = analyser.samples[index] ?? 0
          })
        }),
      }
      analysers.push(analyser)
      return analyser
    }),
    createChannelSplitter: vi.fn(() => {
      const splitter = { connect: vi.fn(), disconnect: vi.fn() }
      splitters.push(splitter)
      return splitter
    }),
    createChannelMerger: vi.fn(() => {
      const merger = { connect: vi.fn(), disconnect: vi.fn() }
      mergers.push(merger)
      return merger
    }),
    createBufferSource: vi.fn(() => {
      const source: FakeSourceNode = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      sources.push(source)
      return source
    }),
  } as unknown as AudioContext
  return { context, gains, sources, splitters, mergers, analysers }
}

describe('startTimelineAudioPlayback scheduling', () => {
  test('shares one future anchor and maps a mid-buffer seek exactly', async () => {
    const doc = makeDoc([
      makeTrack('A-mid', 'audio', [
        makeClip('mid', 0, 20, {
          assetId: 'asset-mid',
          sourceStart: 10,
          volume: 0.25,
        }),
      ]),
      makeTrack('A-peer', 'audio', [
        makeClip('peer', 0, 20, { assetId: 'asset-peer' }),
      ]),
    ])
    const h = makePlaybackHarness({ currentTime: 5 })
    const mid = decodedBuffer('mid-buffer', 1, 1)
    const peer = decodedBuffer('peer-buffer', 0.5, 0.5)
    h.media.enqueue('asset-mid', makeCursor([mid]).cursor)
    h.media.enqueue('asset-peer', makeCursor([peer]).cursor)

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      5,
      h.resolveAsset,
      {},
      h.deps,
    )

    expect(h.media.requests).toEqual([
      { assetId: 'asset-mid', startTime: 1.5, endTime: 3 },
      { assetId: 'asset-peer', startTime: 0.5, endTime: 2 },
    ])
    expect(session.anchorTime).toBeCloseTo(5.05)
    expect(session.anchorTime).toBeGreaterThan(5)
    expect(h.output.scheduled).toHaveLength(2)
    expect(h.output.scheduled.map(({ when }) => when)).toEqual([
      session.anchorTime,
      session.anchorTime,
    ])

    const scheduledMid = h.output.scheduled.find(
      ({ clipId }) => clipId === 'mid',
    )
    if (!scheduledMid) throw new Error('Expected the mid-buffer event')
    expect(scheduledMid.buffer).toBe(mid.buffer)
    expect(scheduledMid.when).toBeCloseTo(session.anchorTime)
    expect(scheduledMid.offset).toBeCloseTo(0.5)
    expect(scheduledMid.duration).toBeCloseTo(0.5)
    expect(scheduledMid.volume).toBe(0.25)

    await session.stop()
  })

  test('splits authored fade boundaries and carries balance to the output', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [
        makeClip('shaped', 0, 10, {
          audio: {
            enabled: true,
            balance: -0.25,
            fadeInFrames: 2,
            fadeOutFrames: 2,
          },
        }),
      ]),
    ], 10)
    const h = makePlaybackHarness({ lookaheadSeconds: 0.5 })
    h.media.enqueue(
      'asset-shaped',
      makeCursor([decodedBuffer('shaped', 0, 1)]).cursor,
    )

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )

    expect(h.output.scheduled).toHaveLength(2)
    expect(h.output.scheduled.map((event) => ({
      start: event.timelineStartTime,
      duration: event.duration,
      clipStart: event.clipTimelineStartTime,
      clipEnd: event.clipTimelineEndTime,
      fadeInEnd: event.fadeInEndTime,
      fadeOutStart: event.fadeOutStartTime,
      balance: event.balance,
      leftGain: event.leftGain,
      rightGain: event.rightGain,
    }))).toEqual([
      {
        start: 0,
        duration: 0.2,
        clipStart: 0,
        clipEnd: 1,
        fadeInEnd: 0.2,
        fadeOutStart: 0.8,
        balance: -0.25,
        leftGain: 1,
        rightGain: 0.75,
      },
      {
        start: 0.2,
        duration: 0.3,
        clipStart: 0,
        clipEnd: 1,
        fadeInEnd: 0.2,
        fadeOutStart: 0.8,
        balance: -0.25,
        leftGain: 1,
        rightGain: 0.75,
      },
    ])

    await session.stop()
  })

  test('opens real virtual handles and carries absolute linear envelopes', async () => {
    const fixture = crossfadePlaybackFixture('linear')
    const h = makePlaybackHarness({ lookaheadSeconds: 0.4 })
    h.media.enqueue(
      'audio-from-asset',
      makeCursor([decodedBuffer('from-handle', 1.8, 0.4)]).cursor,
    )
    h.media.enqueue(
      'audio-to-asset',
      makeCursor([decodedBuffer('to-handle', 2.8, 0.4)]).cursor,
    )

    const session = await startTimelineAudioPlayback(
      h.context,
      fixture.doc,
      8,
      h.resolveAsset,
      { sourceBoundsCatalog: fixture.catalog },
      h.deps,
    )

    expect(h.media.requests).toEqual([
      { assetId: 'audio-from-asset', startTime: 1.8, endTime: 2.2 },
      { assetId: 'audio-to-asset', startTime: 2.8, endTime: 4 },
    ])
    expect(h.output.scheduled).toHaveLength(2)
    expect(h.output.scheduled.map((event) => ({
      clipId: event.clipId,
      timelineStartTime: event.timelineStartTime,
      duration: event.duration,
      volume: event.volume,
      envelope: event.envelope,
    }))).toEqual([
      {
        clipId: 'audio-from',
        timelineStartTime: 0.8,
        duration: expect.closeTo(0.4, 10),
        volume: 0.25,
        envelope: {
          startTime: 0.8,
          endTime: 1.2,
          role: 'from',
          curve: 'linear',
        },
      },
      {
        clipId: 'audio-to',
        timelineStartTime: 0.8,
        duration: expect.closeTo(0.4, 10),
        volume: 0.75,
        envelope: {
          startTime: 0.8,
          endTime: 1.2,
          role: 'to',
          curve: 'linear',
        },
      },
    ])
    expect(audioPlaybackAssetIds(fixture.doc, 11, fixture.catalog)).toEqual([
      'audio-from-asset',
      'audio-to-asset',
    ])

    await session.stop()
  })

  test('keeps virtual-handle requests and envelopes on the NTSC frame clock', async () => {
    const fixture = crossfadePlaybackFixture('equal-power')
    fixture.doc.frameRate = { num: 30_000, den: 1_001 }
    const frameSeconds = 1_001 / 30_000
    const h = makePlaybackHarness({ lookaheadSeconds: 4 * frameSeconds })
    h.media.enqueue(
      'audio-from-asset',
      makeCursor([decodedBuffer(
        'ntsc-from',
        18 * frameSeconds,
        4 * frameSeconds,
      )]).cursor,
    )
    h.media.enqueue(
      'audio-to-asset',
      makeCursor([decodedBuffer(
        'ntsc-to',
        28 * frameSeconds,
        4 * frameSeconds,
      )]).cursor,
    )

    const session = await startTimelineAudioPlayback(
      h.context,
      fixture.doc,
      8,
      h.resolveAsset,
      { sourceBoundsCatalog: fixture.catalog },
      h.deps,
    )

    expect(h.media.requests).toHaveLength(2)
    expect(h.media.requests[0].startTime).toBeCloseTo(18 * frameSeconds)
    expect(h.media.requests[0].endTime).toBeCloseTo(22 * frameSeconds)
    expect(h.media.requests[1].startTime).toBeCloseTo(28 * frameSeconds)
    const envelopes = h.output.scheduled.map((event) => event.envelope)
    expect(envelopes).toHaveLength(2)
    for (const envelope of envelopes) {
      expect(envelope?.startTime).toBeCloseTo(8 * frameSeconds)
      expect(envelope?.endTime).toBeCloseTo(12 * frameSeconds)
      expect(envelope?.curve).toBe('equal-power')
    }
    await session.stop()
  })

  test('advances envelope phase when a decoded handle arrives late', async () => {
    const fixture = crossfadePlaybackFixture('linear')
    const h = makePlaybackHarness({ currentTime: 10, lookaheadSeconds: 0.4 })
    // Anchor read, then one current-time read per sorted event.
    h.output.queueTimes(10, 10, 10.1, 10.1)
    h.media.enqueue(
      'audio-from-asset',
      makeCursor([decodedBuffer('late-from', 1.8, 0.4)]).cursor,
    )
    h.media.enqueue(
      'audio-to-asset',
      makeCursor([decodedBuffer('late-to', 2.8, 0.4)]).cursor,
    )

    const session = await startTimelineAudioPlayback(
      h.context,
      fixture.doc,
      8,
      h.resolveAsset,
      { sourceBoundsCatalog: fixture.catalog },
      h.deps,
    )

    expect(h.output.scheduled).toHaveLength(2)
    for (const event of h.output.scheduled) {
      expect(event.timelineStartTime).toBeCloseTo(0.85)
      expect(event.offset).toBeCloseTo(0.05)
      expect(event.duration).toBeCloseTo(0.35)
    }
    await session.stop()
  })

  test('fingerprints transition, link, curve, bounds, volume, audio, mute, and solo facts', () => {
    const fixture = crossfadePlaybackFixture('linear')
    const baseline = audioPlaybackPlanKey(fixture.doc, fixture.catalog)
    const variants: TimelineDoc[] = []
    const mutate = (change: (doc: TimelineDoc) => void): void => {
      const cloned = structuredClone(fixture.doc)
      change(cloned)
      variants.push(cloned)
    }
    mutate((doc) => { doc.tracks[0].transitions[0].audio.curve = 'equal-power' })
    mutate((doc) => { delete doc.tracks[1].clips[0].linkGroupId })
    mutate((doc) => { doc.tracks[1].clips[0].volume = 0.5 })
    mutate((doc) => {
      doc.tracks[1].clips[0].audio = {
        enabled: true,
        balance: 0.25,
        fadeInFrames: 2,
        fadeOutFrames: 3,
      }
    })
    mutate((doc) => { doc.tracks[1].muted = true })
    mutate((doc) => { doc.tracks[1].solo = true })
    for (const variant of variants) {
      expect(audioPlaybackPlanKey(variant, fixture.catalog)).not.toBe(baseline)
    }
    const changedBounds = new Map(fixture.catalog)
    changedBounds.set('audio-from-asset', {
      ...exactBounds(),
      audio: {
        status: 'exact',
        firstTimestampUs: 1,
        endTimestampUs: 10_000_000,
      },
    })
    expect(audioPlaybackPlanKey(fixture.doc, changedBounds)).not.toBe(baseline)
  })

  test('uses canonical selection and skips muted, disabled, and zero-volume clips', async () => {
    const doc = makeDoc([
      makeTrack('A-normal', 'audio', [
        makeClip('normal', 0, 10, { assetId: 'asset-normal' }),
      ]),
      makeTrack(
        'A-muted-solo',
        'audio',
        [makeClip('muted', 0, 10, { assetId: 'asset-muted' })],
        { muted: true, solo: true },
      ),
      makeTrack(
        'A-zero-solo',
        'audio',
        [
          makeClip('zero', 0, 10, {
            assetId: 'asset-zero',
            volume: 0,
          }),
        ],
        { solo: true },
      ),
      makeTrack(
        'A-live-solo',
        'audio',
        [
          makeClip('live', 0, 10, {
            assetId: 'asset-live',
            volume: 0.4,
          }),
        ],
        { solo: true },
      ),
      makeTrack(
        'A-disabled-solo',
        'audio',
        [
          makeClip('disabled', 0, 10, {
            assetId: 'asset-disabled',
            audio: {
              enabled: false,
              balance: 0,
              fadeInFrames: 0,
              fadeOutFrames: 0,
            },
          }),
        ],
        { solo: true },
      ),
    ])
    const h = makePlaybackHarness()
    h.media.enqueue(
      'asset-live',
      makeCursor([decodedBuffer('live', 0, 0.5)]).cursor,
    )

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )

    expect(h.media.requests).toEqual([
      { assetId: 'asset-live', startTime: 0, endTime: 1 },
    ])
    expect(h.output.scheduled.map(({ clipId, volume }) => ({
      clipId,
      volume,
    }))).toEqual([{ clipId: 'live', volume: 0.4 }])

    await session.stop()
  })

  test('bounds initial decoding to lookahead and refills only elapsed time', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('long', 0, 20)]),
    ], 20)
    const h = makePlaybackHarness({ currentTime: 2 })
    const first = decodedBuffer('first', 0, 0.5)
    const second = decodedBuffer('second', 0.5, 0.5)
    const third = decodedBuffer('third', 1, 0.5)
    const cursor = makeCursor([first, second, third])
    h.media.enqueue('asset-long', cursor.cursor)

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )

    expect(h.output.scheduled).toHaveLength(1)
    expect(h.output.scheduled[0].buffer).toBe(first.buffer)
    expect(cursor.cursor.next).toHaveBeenCalledTimes(2)
    expect(session.diagnostics().scheduledThroughTimelineTime).toBeCloseTo(0.5)
    expect(h.timers.pendingCount()).toBe(1)
    expect(h.timers.schedulePump).toHaveBeenLastCalledWith(
      expect.any(Function),
      25,
    )

    h.output.setTime(session.anchorTime + 0.25)
    const pump = h.timers.runNext()
    expect(pump.delayMs).toBe(25)
    await vi.waitFor(() => expect(h.output.scheduled).toHaveLength(2))

    const refill = h.output.scheduled[1]
    expect(refill.buffer).toBe(second.buffer)
    expect(refill.when).toBeCloseTo(session.anchorTime + 0.5)
    expect(refill.offset).toBeCloseTo(0)
    expect(refill.duration).toBeCloseTo(0.25)
    expect(cursor.cursor.next).toHaveBeenCalledTimes(2)
    expect(session.diagnostics().scheduledThroughTimelineTime).toBeCloseTo(0.75)
    expect(h.timers.pendingCount()).toBe(1)

    await session.stop()
  })

  test('opens a future clip only when it enters the rolling lookahead', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('future', 10, 10)]),
    ], 20)
    const h = makePlaybackHarness()
    h.media.enqueue(
      'asset-future',
      makeCursor([decodedBuffer('future', 0, 0.5)]).cursor,
    )

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )
    expect(h.media.requests).toHaveLength(0)

    h.output.setTime(session.anchorTime + 0.4)
    h.timers.runNext()
    await vi.waitFor(() => expect(h.timers.pendingCount()).toBe(1))
    expect(h.media.requests).toHaveLength(0)

    h.output.setTime(session.anchorTime + 0.6)
    h.timers.runNext()
    await vi.waitFor(() => expect(h.media.requests).toHaveLength(1))
    expect(h.media.requests[0]).toEqual({
      assetId: 'asset-future',
      startTime: 0,
      endTime: 1,
    })

    await session.stop()
  })

  test('trims a decoded buffer that becomes late before scheduling', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('late', 0, 10)]),
    ])
    const h = makePlaybackHarness({ currentTime: 10 })
    h.output.queueTimes(10, 10, 10.2)
    const wrapped = decodedBuffer('late', 0, 0.5)
    h.media.enqueue('asset-late', makeCursor([wrapped]).cursor)

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )

    expect(session.anchorTime).toBeCloseTo(10.05)
    expect(h.output.scheduled).toHaveLength(1)
    expect(h.output.scheduled[0].when).toBeCloseTo(10.2)
    expect(h.output.scheduled[0].offset).toBeCloseTo(0.15)
    expect(h.output.scheduled[0].duration).toBeCloseTo(0.35)

    await session.stop()
  })

  test('isolates one clip read failure while scheduling healthy clips', async () => {
    const failure = new Error('clip decode failed')
    const doc = makeDoc([
      makeTrack('A-bad', 'audio', [makeClip('bad', 0, 10)]),
      makeTrack('A-good', 'audio', [makeClip('good', 0, 10)]),
    ])
    const h = makePlaybackHarness()
    const bad = makeCursor([failure])
    const good = makeCursor([decodedBuffer('good', 0, 0.5)])
    h.media.enqueue('asset-bad', bad.cursor)
    h.media.enqueue('asset-good', good.cursor)
    const onWarning = vi.fn()

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      { onWarning },
      h.deps,
    )

    expect(onWarning).toHaveBeenCalledWith({
      scope: 'media',
      stage: 'decode',
      clipId: 'bad',
      assetId: 'asset-bad',
      trackKind: 'audio',
      reason: 'decode-failed',
      cause: failure,
    })
    expect(h.output.scheduled.map(({ clipId }) => clipId)).toEqual(['good'])

    await session.stop()
    expect(bad.cursor.close).toHaveBeenCalledOnce()
    expect(good.cursor.close).toHaveBeenCalledOnce()
  })

  test('identifies source-open and invalid decoded-timing warnings by asset', async () => {
    const openFailure = new Error('source could not be opened')
    const doc = makeDoc([
      makeTrack('A-open', 'audio', [makeClip('open', 0, 10)]),
      makeTrack('A-timing', 'audio', [makeClip('timing', 0, 10)]),
    ])
    const h = makePlaybackHarness()
    h.media.enqueue('asset-open', openFailure)
    h.media.enqueue(
      'asset-timing',
      makeCursor([decodedBuffer('invalid', Number.NaN, 0.5)]).cursor,
    )
    const onWarning = vi.fn()

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      { onWarning },
      h.deps,
    )

    expect(onWarning).toHaveBeenCalledWith({
      scope: 'media',
      stage: 'source-open',
      clipId: 'open',
      assetId: 'asset-open',
      trackKind: 'audio',
      reason: 'decode-failed',
      cause: openFailure,
    })
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'media',
      stage: 'decoded-timing',
      clipId: 'timing',
      assetId: 'asset-timing',
      cause: expect.objectContaining({
        message: 'Decoded audio buffer has invalid timing',
      }),
    }))

    await session.stop()
  })

  test('types a source Blob failure as resource-unavailable and retains its cause', async () => {
    const unavailable = new Error('playback Blob is unavailable')
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('offline', 0, 10)]),
    ])
    const h = makePlaybackHarness()
    const onWarning = vi.fn()
    const resolveAsset = vi.fn(async () => {
      throw unavailable
    })

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      resolveAsset,
      { onWarning },
      {
        ...h.deps,
        createMediaSource: createMediabunnyPlaybackAudioSource,
      },
    )

    const warning = onWarning.mock.calls[0]?.[0]
    expect(warning).toMatchObject({
      scope: 'media',
      stage: 'source-open',
      clipId: 'offline',
      assetId: 'asset-offline',
      trackKind: null,
      reason: 'resource-unavailable',
      cause: expect.objectContaining({
        assetId: 'asset-offline',
        failure: {
          surface: 'audio-playback',
          trackKind: null,
          reason: 'resource-unavailable',
          detail: unavailable.message,
        },
      }),
    })
    expect(warning.cause).toBeInstanceOf(MediaAssetRuntimeError)
    expect(warning.cause.cause).toBe(unavailable)

    await session.stop()
  })

  test('keeps output scheduling and cursor cleanup warnings global', async () => {
    const schedulingFailure = new Error('speaker rejected the buffer')
    const cleanupFailure = new Error('cursor cleanup failed')
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('global-warning', 0, 10)]),
    ])
    const h = makePlaybackHarness()
    const cursor = makeCursor([decodedBuffer('decoded', 0, 0.5)])
    cursor.cursor.close = vi.fn(async () => {
      throw cleanupFailure
    })
    h.media.enqueue('asset-global-warning', cursor.cursor)
    h.output.output.schedule = vi.fn(() => {
      throw schedulingFailure
    })
    const onWarning = vi.fn()

    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      { onWarning },
      h.deps,
    )

    expect(onWarning).toHaveBeenCalledWith({
      scope: 'global',
      stage: 'output-schedule',
      cause: schedulingFailure,
    })
    expect(onWarning).toHaveBeenCalledWith({
      scope: 'global',
      stage: 'cleanup',
      cause: cleanupFailure,
    })
    expect(onWarning.mock.calls.every(([warning]) => (
      warning.scope === 'global'
    ))).toBe(true)

    await session.stop()
  })

  test('reports a refill-pump failure as global before stopping cleanly', async () => {
    const pumpFailure = new Error('audio clock disappeared')
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('pump-warning', 0, 20)]),
    ], 20)
    const h = makePlaybackHarness()
    h.media.enqueue(
      'asset-pump-warning',
      makeCursor([
        decodedBuffer('first', 0, 0.5),
        decodedBuffer('second', 0.5, 0.5),
      ]).cursor,
    )
    const onWarning = vi.fn()
    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      { onWarning },
      h.deps,
    )
    vi.mocked(h.output.output.currentTime).mockImplementation(() => {
      throw pumpFailure
    })

    h.timers.runNext()

    await vi.waitFor(() => expect(onWarning).toHaveBeenCalledWith({
      scope: 'global',
      stage: 'pump',
      cause: pumpFailure,
    }))
    expect(onWarning.mock.calls.every(([warning]) => (
      warning.scope === 'global'
    ))).toBe(true)
    await expect(session.stop()).resolves.toBeUndefined()
  })

  test('does not reopen a clip after its decoder reaches natural EOF', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('short-media', 0, 20)]),
    ], 20)
    const h = makePlaybackHarness()
    const cursor = makeCursor([decodedBuffer('only-buffer', 0, 0.25)])
    h.media.enqueue('asset-short-media', cursor.cursor)
    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )

    expect(h.media.requests).toHaveLength(1)
    for (const elapsed of [0.25, 0.5, 0.75]) {
      h.output.setTime(session.anchorTime + elapsed)
      h.timers.runNext()
      await vi.waitFor(() => expect(h.timers.pendingCount()).toBe(1))
    }

    expect(h.media.requests).toHaveLength(1)
    expect(cursor.cursor.close).toHaveBeenCalledOnce()
    await session.stop()
  })
})

describe('startTimelineAudioPlayback ownership', () => {
  test('stop cancels refill and closes output, cursors, and media once', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('long', 0, 20)]),
    ], 20)
    const h = makePlaybackHarness()
    const cursor = makeCursor([
      decodedBuffer('first', 0, 0.5),
      decodedBuffer('pending', 0.5, 0.5),
    ])
    h.media.enqueue('asset-long', cursor.cursor)
    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )

    expect(h.timers.pendingCount()).toBe(1)
    const firstStop = session.stop()
    const secondStop = session.stop()
    expect(secondStop).toBe(firstStop)
    await firstStop
    expect(session.stop()).toBe(firstStop)

    expect(h.timers.cancelPump).toHaveBeenCalledOnce()
    expect(h.timers.pendingCount()).toBe(0)
    expect(h.output.output.stop).toHaveBeenCalledOnce()
    expect(cursor.cursor.close).toHaveBeenCalledOnce()
    expect(h.media.source.close).toHaveBeenCalledOnce()
  })

  test('abort during a deferred initial read schedules nothing and cleans up', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('deferred', 0, 20)]),
    ], 20)
    const h = makePlaybackHarness()
    const read = deferred<IteratorResult<PlaybackAudioBuffer, void>>()
    const cursor: PlaybackAudioCursor = {
      next: vi.fn(() => read.promise),
      close: vi.fn(async () => {
        read.resolve({ done: true, value: undefined })
      }),
    }
    h.media.enqueue('asset-deferred', cursor)
    const controller = new AbortController()
    const onWarning = vi.fn()

    const pending = startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      { signal: controller.signal, onWarning },
      h.deps,
    )
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.waitFor(() => expect(cursor.next).toHaveBeenCalledOnce())

    controller.abort()
    await rejection

    expect(h.output.output.schedule).not.toHaveBeenCalled()
    expect(h.timers.schedulePump).not.toHaveBeenCalled()
    expect(h.output.output.stop).toHaveBeenCalledOnce()
    expect(cursor.close).toHaveBeenCalledOnce()
    expect(h.media.source.close).toHaveBeenCalledOnce()
    expect(onWarning).not.toHaveBeenCalled()
  })

  test('stop closes media immediately while a refill read is pending', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('pending-refill', 0, 20)]),
    ], 20)
    const h = makePlaybackHarness()
    const read = deferred<IteratorResult<PlaybackAudioBuffer, void>>()
    const next = vi.fn<PlaybackAudioCursor['next']>()
      .mockResolvedValueOnce({
        done: false,
        value: decodedBuffer('first-second', 0, 1),
      })
      .mockImplementation(() => read.promise)
    const cursor: PlaybackAudioCursor = {
      next,
      close: vi.fn(async () => {
        read.resolve({ done: true, value: undefined })
      }),
    }
    h.media.enqueue('asset-pending-refill', cursor)
    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      {},
      h.deps,
    )

    h.output.setTime(session.anchorTime + 0.75)
    h.timers.runNext()
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(2))

    const stopped = session.stop()
    expect(cursor.close).toHaveBeenCalledOnce()
    expect(h.media.source.close).toHaveBeenCalledOnce()
    await stopped
    expect(h.output.output.stop).toHaveBeenCalledOnce()
  })

  test('abort after startup stops the active session exactly once', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('active', 0, 20)]),
    ], 20)
    const h = makePlaybackHarness()
    const cursor = makeCursor([decodedBuffer('active', 0, 1)])
    h.media.enqueue('asset-active', cursor.cursor)
    const controller = new AbortController()
    const session = await startTimelineAudioPlayback(
      h.context,
      doc,
      0,
      h.resolveAsset,
      { signal: controller.signal },
      h.deps,
    )

    controller.abort()
    await vi.waitFor(() => expect(cursor.cursor.close).toHaveBeenCalledOnce())
    await session.stop()

    expect(h.output.output.stop).toHaveBeenCalledOnce()
    expect(h.media.source.close).toHaveBeenCalledOnce()
  })
})

describe('createWebAudioPlaybackOutput ownership', () => {
  test('reports bounded independent channel and master sample peaks', () => {
    const h = makeWebAudioHarness('running')
    const output = createWebAudioPlaybackOutput(h.context)
    h.analysers[0].samples = [0.25, -0.75, 0.5]
    h.analysers[1].samples = [0.1, -0.2, 0.4]

    const diagnostics = output.diagnostics()
    expect(diagnostics.peakLeft).toBeCloseTo(0.75, 7)
    expect(diagnostics.peakRight).toBeCloseTo(0.4, 7)
    expect(diagnostics.peakMaster).toBeCloseTo(0.75, 7)
    expect(diagnostics.meterSampleSize).toBe(256)
    expect(h.analysers).toHaveLength(2)
    expect(h.splitters[0].connect).toHaveBeenNthCalledWith(
      1,
      h.analysers[0],
      0,
    )
    expect(h.splitters[0].connect).toHaveBeenNthCalledWith(
      2,
      h.analysers[1],
      1,
    )

    output.stop()
  })

  test('uses exact ramps for linear legs and bounded curves for equal-power legs', () => {
    const h = makeWebAudioHarness('running')
    const output = createWebAudioPlaybackOutput(h.context)
    const buffer = { duration: 1 } as AudioBuffer

    output.schedule({
      clipId: 'linear-to',
      buffer,
      timelineStartTime: 0.9,
      when: 10,
      offset: 0,
      duration: 0.2,
      volume: 0.5,
      envelope: {
        startTime: 0.8,
        endTime: 1.2,
        role: 'to',
        curve: 'linear',
      },
    })
    const linearGain = h.gains[1].gain
    expect(linearGain.setValueAtTime.mock.calls[0]?.[0]).toBeCloseTo(0.125)
    expect(linearGain.setValueAtTime.mock.calls[0]?.[1]).toBe(10)
    expect(
      linearGain.linearRampToValueAtTime.mock.calls[0]?.[0],
    ).toBeCloseTo(0.375)
    expect(linearGain.linearRampToValueAtTime.mock.calls[0]?.[1]).toBe(10.2)
    expect(linearGain.setValueCurveAtTime).not.toHaveBeenCalled()

    output.schedule({
      clipId: 'power-from',
      buffer,
      timelineStartTime: 0.8,
      when: 10.2,
      offset: 0,
      duration: 0.4,
      volume: 0.8,
      envelope: {
        startTime: 0.8,
        endTime: 1.2,
        role: 'from',
        curve: 'equal-power',
      },
    })
    const powerGain = h.gains[2].gain
    const curveCall = powerGain.setValueCurveAtTime.mock.calls[0]
    expect(curveCall?.[1]).toBe(10.2)
    expect(curveCall?.[2]).toBe(0.4)
    const curve = curveCall?.[0] as Float32Array
    expect(curve).toHaveLength(PLAYBACK_EQUAL_POWER_CURVE_POINTS)
    expect(curve[0]).toBeCloseTo(0.8)
    expect(curve.at(-1)).toBeCloseTo(0)

    let maximumInterpolationError = 0
    for (let index = 0; index < curve.length - 1; index++) {
      const interpolated = (curve[index] + curve[index + 1]) / 2
      const progress = (index + 0.5) / (curve.length - 1)
      const exact = Math.cos(progress * Math.PI / 2) * 0.8
      maximumInterpolationError = Math.max(
        maximumInterpolationError,
        Math.abs(interpolated - exact),
      )
    }
    expect(maximumInterpolationError).toBeLessThan(0.00003)
    expect(createEqualPowerPlaybackCurve('from', 0, 1, 0.8)).toEqual(curve)

    output.stop()
  })

  test('multiplies overlapping fades and routes stereo balance explicitly', () => {
    const h = makeWebAudioHarness('running')
    const output = createWebAudioPlaybackOutput(h.context)
    const buffer = { duration: 1, numberOfChannels: 2 } as AudioBuffer

    output.schedule({
      clipId: 'faded-balanced',
      buffer,
      timelineStartTime: 0,
      when: 10,
      offset: 0,
      duration: 1,
      volume: 0.8,
      envelope: null,
      clipTimelineStartTime: 0,
      clipTimelineEndTime: 1,
      fadeInEndTime: 0.75,
      fadeOutStartTime: 0.25,
      balance: 0.5,
      leftGain: 0.5,
      rightGain: 1,
    })

    const envelopeGain = h.gains[1]
    const curveCall = envelopeGain.gain.setValueCurveAtTime.mock.calls[0]
    const curve = curveCall?.[0] as Float32Array
    expect(curveCall?.[1]).toBe(10)
    expect(curveCall?.[2]).toBe(1)
    expect(curve).toHaveLength(PLAYBACK_EQUAL_POWER_CURVE_POINTS)
    expect(curve[0]).toBe(0)
    expect(curve[32]).toBeCloseTo(0.8 / 3)
    expect(curve[64]).toBeCloseTo(0.8 * 4 / 9)
    expect(curve[96]).toBeCloseTo(0.8 / 3)
    expect(curve.at(-1)).toBe(0)

    expect(h.splitters).toHaveLength(2)
    expect(h.mergers).toHaveLength(2)
    expect(envelopeGain.connect).toHaveBeenCalledWith(h.splitters[1])
    expect(h.splitters[1].connect).toHaveBeenNthCalledWith(
      1,
      h.gains[2],
      0,
    )
    expect(h.splitters[1].connect).toHaveBeenNthCalledWith(
      2,
      h.gains[3],
      1,
    )
    expect(h.gains[2].gain.value).toBe(0.5)
    expect(h.gains[3].gain.value).toBe(1)
    expect(h.gains[2].connect).toHaveBeenCalledWith(h.mergers[1], 0, 0)
    expect(h.gains[3].connect).toHaveBeenCalledWith(h.mergers[1], 0, 1)

    h.sources[0].onended?.()
    output.stop()
    expect(h.splitters[1].disconnect).toHaveBeenCalledOnce()
    expect(h.mergers[1].disconnect).toHaveBeenCalledOnce()
  })

  test('ramps in once and synchronously cleans a suspended context', () => {
    const h = makeWebAudioHarness('suspended')
    const output = createWebAudioPlaybackOutput(h.context)
    const buffer = { duration: 1 } as AudioBuffer

    output.schedule({
      clipId: 'clip-1',
      buffer,
      timelineStartTime: 0,
      when: 10,
      offset: 0,
      duration: 0.5,
      volume: 0.75,
      envelope: null,
    })
    output.schedule({
      clipId: 'clip-2',
      buffer,
      timelineStartTime: 0.5,
      when: 10.5,
      offset: 0,
      duration: 0.5,
      volume: 0.5,
      envelope: null,
    })

    const master = h.gains[0]
    expect(master.gain.setValueAtTime).toHaveBeenCalledOnce()
    expect(master.gain.setValueAtTime).toHaveBeenCalledWith(0, 10)
    expect(master.gain.linearRampToValueAtTime).toHaveBeenCalledOnce()
    expect(master.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 10.005)

    output.stop()

    expect(output.diagnostics().activeNodeCount).toBe(0)
    expect(h.sources.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true)
    expect(h.sources.every(({ disconnect }) =>
      disconnect.mock.calls.length === 1)).toBe(true)
    expect(h.gains.every(({ disconnect }) =>
      disconnect.mock.calls.length === 1)).toBe(true)
    expect(h.analysers.every(({ disconnect }) =>
      disconnect.mock.calls.length === 1)).toBe(true)
  })

  test('uses a wall-clock cleanup fallback when running nodes never end', () => {
    vi.useFakeTimers()
    try {
      const h = makeWebAudioHarness('running')
      const output = createWebAudioPlaybackOutput(h.context)
      output.schedule({
        clipId: 'clip',
        buffer: { duration: 1 } as AudioBuffer,
        timelineStartTime: 0,
        when: 10,
        offset: 0,
        duration: 1,
        volume: 1,
        envelope: null,
      })

      output.stop()
      expect(output.diagnostics().activeNodeCount).toBe(1)

      vi.advanceTimersByTime(50)
      expect(output.diagnostics().activeNodeCount).toBe(0)
      expect(h.sources[0].disconnect).toHaveBeenCalledOnce()
      expect(h.gains[0].disconnect).toHaveBeenCalledOnce()
      expect(h.analysers.every(({ disconnect }) =>
        disconnect.mock.calls.length === 1)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
