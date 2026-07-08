/**
 * app/transportController.test.ts — Phase 4.0.5.
 *
 * The controller under a fake clock + manual tick pump: play/pause/step
 * drive transportStore correctly, scrubbing preempts playback, and the
 * end of the doc (including mid-play shrinking) parks + pauses.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import {
  configureTransport,
  disposeTransport,
  pause,
  play,
  stepFrame,
  togglePlayback,
} from './transportController'

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

function makeTrack(id: string, clips: Clip[]): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
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
  const clock = { currentTime: 0, resume: vi.fn(async () => {}) }
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
  }
  const pump = () => {
    const cbs = [...pending.values()]
    pending.clear()
    for (const cb of cbs) cb()
  }
  return { clock, deps, pump, pendingCount: () => pending.size }
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
  fake = makeFakeDeps()
  configureTransport(fake.deps)
})

afterEach(() => {
  disposeTransport()
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
