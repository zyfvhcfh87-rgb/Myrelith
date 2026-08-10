/**
 * state/phase1-gate.test.ts — the Phase 1 exit gate.
 *
 * Plan: "perform 20 random split/trim/move operations, undo all 20, assert
 * final doc equals initial doc."
 *
 * The randomness is SEEDED (deterministic LCG) so every run exercises the
 * exact same sequences — a failure here is always reproducible. Rejected
 * operations (overlaps etc.) push no history entry by contract, so the test
 * keeps drawing random ops until 20 have actually succeeded, then undoes
 * exactly 20 times.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from './documentStore'

/* ------------------------------------------------------------------ */
/* Deterministic PRNG                                                   */
/* ------------------------------------------------------------------ */

function makeRng(seed: number) {
  let s = seed >>> 0
  return {
    /** float in [0, 1) */
    next(): number {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x1_0000_0000
    },
    /** integer in [min, max] inclusive */
    int(min: number, max: number): number {
      return min + Math.floor(this.next() * (max - min + 1))
    },
    pick<T>(items: readonly T[]): T {
      return items[this.int(0, items.length - 1)]
    },
  }
}

/* ------------------------------------------------------------------ */
/* Fixture: enough clips/gaps that random ops both succeed and fail     */
/* ------------------------------------------------------------------ */

function makeClip(id: string, tlStart: number, duration: number, srcStart = 20): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: srcStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, kind: Track['kind'], clips: Clip[]): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked: false }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 11,
    id: 'doc-gate',
    name: 'Gate fixture',
    frameRate: { num: 30000, den: 1001 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', 'video', [
        makeClip('a', 0, 100),
        makeClip('b', 150, 60),
        makeClip('c', 300, 90),
      ]),
      makeTrack('V2', 'video', [makeClip('x', 0, 50)]),
      makeTrack('A1', 'audio', [makeClip('d', 0, 200)]),
      makeTrack('A2', 'audio', [makeClip('e', 250, 100)]),
    ],
  }
}

const getState = () => useDocumentStore.getState()

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Rejections are expected by the dozen here; keep the output quiet.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  getState().setDoc(makeDoc())
})

afterEach(() => {
  warnSpy.mockRestore()
})

/* ------------------------------------------------------------------ */
/* The gate                                                             */
/* ------------------------------------------------------------------ */

/** All clips currently in the doc, with their track. */
function allClips(doc: TimelineDoc): Array<{ track: Track; clip: Clip }> {
  return doc.tracks.flatMap((track) =>
    track.clips.map((clip) => ({ track, clip })),
  )
}

function runRandomOp(rng: ReturnType<typeof makeRng>): void {
  const doc = getState().doc
  const candidates = allClips(doc)
  if (candidates.length === 0) return
  const { track, clip } = rng.pick(candidates)

  switch (rng.int(0, 2)) {
    case 0: // split somewhere on the timeline
      getState().splitClipAtPlayhead(rng.int(0, 450))
      break
    case 1: {
      // trim either edge by a small signed delta (never 0)
      const delta = rng.pick([-10, -5, -2, -1, 1, 2, 5, 10])
      getState().trimClip(clip.id, rng.pick(['start', 'end']), delta)
      break
    }
    case 2: {
      // move to a random same-kind track at a random frame
      const sameKind = doc.tracks.filter((t) => t.kind === track.kind)
      getState().moveClip(clip.id, rng.pick(sameKind).id, rng.int(0, 450))
      break
    }
  }
}

describe('Phase 1 gate', () => {
  test.each([11, 23, 47, 90, 1337])(
    '20 random successful ops then 20 undos restores the initial doc (seed %i)',
    (seed) => {
      const rng = makeRng(seed)
      const initialJson = JSON.stringify(getState().doc)

      let successes = 0
      let attempts = 0
      while (successes < 20) {
        attempts++
        expect(attempts).toBeLessThan(500) // safety: fixture must allow ops
        const pastBefore = getState().past.length
        runRandomOp(rng)
        if (getState().past.length > pastBefore) successes++
      }

      expect(JSON.stringify(getState().doc)).not.toBe(initialJson)

      for (let i = 0; i < 20; i++) {
        getState().undo()
      }

      expect(JSON.stringify(getState().doc)).toBe(initialJson)
      expect(getState().past).toHaveLength(0)
    },
  )

  test('documentStore round-trips through JSON.stringify/parse with no loss', () => {
    const rng = makeRng(7)
    for (let i = 0; i < 10; i++) runRandomOp(rng)
    const doc = getState().doc
    const roundTripped = JSON.parse(JSON.stringify(doc)) as TimelineDoc
    expect(roundTripped).toEqual(doc)
    // And the revived doc is fully usable as a document again:
    getState().setDoc(roundTripped)
    expect(JSON.stringify(getState().doc)).toBe(JSON.stringify(doc))
  })
})
