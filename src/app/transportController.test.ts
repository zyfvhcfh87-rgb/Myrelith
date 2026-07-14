/**
 * app/transportController.test.ts — Phase 4.0.5.
 *
 * The controller under a fake clock + manual tick pump: play/pause/step
 * drive transportStore correctly, scrubbing preempts playback, and the
 * end of the doc (including mid-play shrinking) parks + pauses.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, MediaAsset, TimelineDoc, Track } from '../domain/schema'
import type { TimelineAudioPlaybackSession } from '../pipeline/playback-audio'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import {
  configureTransport,
  disposeTransport,
  pause,
  play,
  stepFrame,
  togglePlayback,
} from './transportController'
import type { TransportDeps } from './transportController'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
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
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
  }
}

function makeAudioSession(anchorTime: number): TimelineAudioPlaybackSession & {
  stop: ReturnType<typeof vi.fn>
} {
  return {
    anchorTime,
    stop: vi.fn(async () => undefined),
    diagnostics: () => ({
      anchorTime,
      fromFrame: 0,
      contextTime: anchorTime,
      activeNodeCount: 1,
      rms: 0.25,
      scheduledThroughTimelineTime: 1,
      scheduledThroughContextTime: anchorTime + 1,
    }),
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
    schemaVersion: 1,
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
  const deps = {
    createContext: () => clock,
    scheduleTick: (cb: () => void) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelTick: (id: number) => void pending.delete(id),
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
  }
}

const transport = () => useTransportStore.getState()

let fake: ReturnType<typeof makeFakeDeps>

beforeEach(() => {
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
  })
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
