/**
 * state/documentStore.test.ts — Phase 1.2 acceptance tests.
 * Plan acceptance: split → undo → redo yields byte-identical JSON.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from './documentStore'

/* ------------------------------------------------------------------ */
/* Fixture                                                              */
/* ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

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

function makeTrack(id: string, kind: Track['kind'], clips: Clip[]): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, locked: false }
}

/** V1: clipA [0,300), clipB [400,100). A1: clipD [0,300). V2 empty. */
function makeDoc(): TimelineDoc {
  return deepFreeze({
    schemaVersion: 1,
    id: 'doc-1',
    name: 'Store test doc',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', 'video', [makeClip('clipA', 0, 300), makeClip('clipB', 400, 100)]),
      makeTrack('V2', 'video', []),
      makeTrack('A1', 'audio', [makeClip('clipD', 0, 300)]),
    ],
  })
}

const getState = () => useDocumentStore.getState()

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  getState().setDoc(makeDoc())
})

afterEach(() => {
  warnSpy.mockRestore()
})

/* ------------------------------------------------------------------ */
/* Plan acceptance test                                                 */
/* ------------------------------------------------------------------ */

describe('undo/redo round-trip', () => {
  test('split → undo → redo yields byte-identical JSON', () => {
    const initialJson = JSON.stringify(getState().doc)

    getState().splitClipAtPlayhead(120)
    const preUndoJson = JSON.stringify(getState().doc)
    expect(preUndoJson).not.toBe(initialJson)

    getState().undo()
    expect(JSON.stringify(getState().doc)).toBe(initialJson)

    getState().redo()
    expect(JSON.stringify(getState().doc)).toBe(preUndoJson)
  })

  test('undo restores the exact same object reference (snapshots, not rebuilds)', () => {
    const initialDoc = getState().doc
    getState().trimClip('clipA', 'end', -10)
    getState().undo()
    expect(getState().doc).toBe(initialDoc)
  })
})

/* ------------------------------------------------------------------ */
/* History behavior                                                     */
/* ------------------------------------------------------------------ */

describe('history behavior', () => {
  test('rejected operations push no history entry', () => {
    // clipA cannot move on top of clipB.
    getState().moveClip('clipA', 'V1', 450)
    expect(getState().past).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // A real edit, then a rejected one: undo jumps over the rejection
    // straight to the real edit's predecessor.
    getState().trimClip('clipA', 'end', -10)
    getState().moveClip('clipA', 'V1', 450)
    expect(getState().past).toHaveLength(1)
  })

  test('a new edit after undo clears the redo stack', () => {
    getState().trimClip('clipA', 'end', -10)
    getState().undo()
    expect(getState().future).toHaveLength(1)
    getState().trimClip('clipA', 'end', -20)
    expect(getState().future).toHaveLength(0)
  })

  test('undo/redo with empty stacks are safe no-ops', () => {
    const doc = getState().doc
    getState().undo()
    expect(getState().doc).toBe(doc)
    getState().redo()
    expect(getState().doc).toBe(doc)
  })

  test('history is capped at 100 entries', () => {
    // 105 one-frame trims: each is a real change, but only the last 100
    // snapshots survive.
    for (let i = 0; i < 105; i++) {
      getState().trimClip('clipA', 'end', -1)
    }
    expect(getState().past).toHaveLength(100)
    expect(
      getState().doc.tracks[0].clips[0].timelineRange.durationFrames,
    ).toBe(300 - 105)

    // Undo everything available: we land 100 steps back (5 trims survive),
    // not at the initial doc — the 5 oldest snapshots were evicted.
    for (let i = 0; i < 150; i++) {
      getState().undo()
    }
    expect(getState().past).toHaveLength(0)
    expect(
      getState().doc.tracks[0].clips[0].timelineRange.durationFrames,
    ).toBe(300 - 5)
  })

  test('setDoc replaces the document and clears both stacks', () => {
    getState().trimClip('clipA', 'end', -10)
    getState().undo()
    getState().setDoc(makeDoc())
    expect(getState().past).toHaveLength(0)
    expect(getState().future).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* Action delegation                                                    */
/* ------------------------------------------------------------------ */

describe('actions delegate to domain operations', () => {
  test('splitClipAtPlayhead splits every unlocked clip under the playhead in one entry', () => {
    getState().splitClipAtPlayhead(120) // inside clipA (V1) and clipD (A1), not clipB
    const doc = getState().doc
    expect(doc.tracks[0].clips).toHaveLength(3) // clipA -> two, clipB intact
    expect(doc.tracks[2].clips).toHaveLength(2) // clipD -> two
    expect(getState().past).toHaveLength(1) // ONE undo entry for the gesture
  })

  test('splitClipAtPlayhead misses every clip → no history entry', () => {
    getState().splitClipAtPlayhead(350) // in the gap between clipA and clipB
    expect(getState().past).toHaveLength(0)
  })

  test('moveClip, rippleDelete and addEffect reach the document', () => {
    getState().moveClip('clipB', 'V2', 0)
    expect(getState().doc.tracks[1].clips.map((c) => c.id)).toEqual(['clipB'])

    getState().rippleDelete('clipA')
    expect(getState().doc.tracks[0].clips).toHaveLength(0)

    getState().addEffect('clipB', {
      id: 'fx1',
      type: 'brightness',
      enabled: true,
      params: { amount: 0.5 },
    })
    expect(getState().doc.tracks[1].clips[0].effects).toHaveLength(1)
    expect(getState().past).toHaveLength(3)
  })

  test('document survives a JSON round-trip after edits', () => {
    getState().splitClipAtPlayhead(120)
    getState().trimClip('clipB', 'start', 10)
    const doc = getState().doc
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
  })

  test('insertClip lands on the track, is one undo entry, and undo removes it', () => {
    getState().insertClip('V2', makeClip('clipNew', 50, 120))
    expect(getState().doc.tracks[1].clips.map((c) => c.id)).toEqual(['clipNew'])
    expect(getState().past).toHaveLength(1)

    getState().undo()
    expect(getState().doc.tracks[1].clips).toHaveLength(0)
  })

  test('rejected insertClip (overlap) leaves doc and history untouched', () => {
    const before = getState().doc
    getState().insertClip('V1', makeClip('clipNew', 100, 50)) // inside clipA [0,300)
    expect(getState().doc).toBe(before) // same reference — nothing happened
    expect(getState().past).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
  })
})
