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

function makeClip(id: string, tlStart: number, duration: number, linkGroupId?: string): Clip {
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
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

function makeTrack(id: string, kind: Track['kind'], clips: Clip[], locked = false): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked }
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

  test('insertClips places the whole batch as ONE undo entry', () => {
    // The A/V drop shape: same range on a video and an audio lane.
    getState().insertClips([
      { trackId: 'V2', clip: makeClip('vHalf', 500, 120) },
      { trackId: 'A1', clip: makeClip('aHalf', 500, 120) },
    ])
    expect(getState().doc.tracks[1].clips.map((c) => c.id)).toEqual(['vHalf'])
    expect(getState().doc.tracks[2].clips.map((c) => c.id)).toEqual(['clipD', 'aHalf'])
    expect(getState().past).toHaveLength(1)

    getState().undo() // one undo removes BOTH halves
    expect(getState().doc.tracks[1].clips).toHaveLength(0)
    expect(getState().doc.tracks[2].clips.map((c) => c.id)).toEqual(['clipD'])
  })

  test('insertClips is atomic: one rejected insert drops the whole batch', () => {
    const before = getState().doc
    getState().insertClips([
      { trackId: 'V2', clip: makeClip('vHalf', 100, 120) }, // V2 is free — would succeed
      { trackId: 'A1', clip: makeClip('aHalf', 100, 120) }, // inside clipD [0,300) — rejected
    ])
    expect(getState().doc).toBe(before) // nothing landed, not even the video half
    expect(getState().past).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
  })

  test('insertClips with an empty batch is a no-op with no history entry', () => {
    const before = getState().doc
    getState().insertClips([])
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* Phase 4.2 editing actions                                            */
/* ------------------------------------------------------------------ */

describe('Phase 4.2 editing actions', () => {
  // Fixture: V1 = clipA [0,300) + clipB [400,500); A1 = clipD [0,300).

  test('splitClipAt razors ONE clip (unlike splitClipAtPlayhead)', () => {
    getState().splitClipAt('clipA', 100)
    const v1 = getState().doc.tracks[0]
    const a1 = getState().doc.tracks[2]
    expect(v1.clips).toHaveLength(3) // A left, A right, B
    expect(v1.clips[0].timelineRange).toEqual({ startFrame: 0, durationFrames: 100 })
    expect(v1.clips[1].timelineRange).toEqual({ startFrame: 100, durationFrames: 200 })
    expect(a1.clips).toHaveLength(1) // clipD crosses frame 100 but is untouched
    expect(getState().past).toHaveLength(1) // one undo entry
  })

  test('rippleTrim commits one entry and shifts downstream', () => {
    getState().rippleTrim('clipA', 'end', -50)
    const v1 = getState().doc.tracks[0]
    expect(v1.clips[0].timelineRange.durationFrames).toBe(250)
    expect(v1.clips[1].timelineRange.startFrame).toBe(350) // followed left
    expect(getState().past).toHaveLength(1)

    getState().undo()
    expect(JSON.stringify(getState().doc)).toBe(JSON.stringify(makeDoc()))
  })

  test('slipClip shifts source only; a rejected slip pushes no history', () => {
    getState().slipClip('clipA', 10)
    const clip = getState().doc.tracks[0].clips[0]
    expect(clip.sourceRange.startFrame).toBe(10)
    expect(clip.timelineRange).toEqual({ startFrame: 0, durationFrames: 300 })
    expect(getState().past).toHaveLength(1)

    const before = getState().doc
    getState().slipClip('clipA', -100) // source would go below 0
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(1) // unchanged
    expect(warnSpy).toHaveBeenCalled()
  })

  test('updateClipTransform commits one entry; rejects push none', () => {
    getState().updateClipTransform('clipA', { transform: { x: 25 }, opacity: 0.4 })
    const clip = getState().doc.tracks[0].clips[0]
    expect(clip.transform.x).toBe(25)
    expect(clip.opacity).toBe(0.4)
    expect(getState().past).toHaveLength(1)

    const before = getState().doc
    getState().updateClipTransform('clipA', {}) // empty patch → rejected
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  test('slideClip moves over gaps and rejects collisions without history', () => {
    getState().slideClip('clipB', -50) // gap [300,400) absorbs it
    expect(getState().doc.tracks[0].clips[1].timelineRange.startFrame).toBe(350)
    expect(getState().past).toHaveLength(1)

    const before = getState().doc
    getState().slideClip('clipA', 150) // [150,450) would overlap clipB [350,450)
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/* Track actions (timeline header upgrade)                              */
/* ------------------------------------------------------------------ */

describe('track actions', () => {
  // Fixture: tracks = [V1, V2, A1].

  test('addTrack commits one undo entry; undo removes the track exactly', () => {
    const initialJson = JSON.stringify(getState().doc)

    getState().addTrack('video')
    expect(getState().doc.tracks.map((t) => t.id)).toEqual(['V1', 'V2', 'V3', 'A1'])
    expect(getState().past).toHaveLength(1)

    getState().addTrack('audio')
    expect(getState().doc.tracks.map((t) => t.id)).toEqual(['V1', 'V2', 'V3', 'A1', 'A2'])
    expect(getState().past).toHaveLength(2)

    getState().undo()
    getState().undo()
    expect(JSON.stringify(getState().doc)).toBe(initialJson)
  })

  test('setTrackFlags commits one entry; the idempotent toggle pushes none', () => {
    getState().setTrackFlags('V1', { hidden: true })
    expect(getState().doc.tracks[0].hidden).toBe(true)
    expect(getState().past).toHaveLength(1)

    const before = getState().doc
    getState().setTrackFlags('V1', { hidden: true }) // already hidden
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(1) // no new entry, no warning
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('setTrackFlags on an unknown track warns and pushes no history', () => {
    const before = getState().doc
    getState().setTrackFlags('V9', { locked: true })
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('a clip edit on a track locked via setTrackFlags is rejected', () => {
    getState().setTrackFlags('V1', { locked: true })
    getState().trimClip('clipA', 'end', -10)
    expect(getState().doc.tracks[0].clips[0].timelineRange.durationFrames).toBe(300)
    expect(getState().past).toHaveLength(1) // only the lock itself
  })

  test('renameTrack commits one entry; same-name renames push none', () => {
    getState().renameTrack('V1', 'Main cam')
    expect(getState().doc.tracks[0].name).toBe('Main cam')
    expect(getState().doc.tracks[0].id).toBe('V1') // id untouched
    expect(getState().past).toHaveLength(1)

    getState().renameTrack('V1', ' Main cam ') // trims to the current name
    expect(getState().past).toHaveLength(1) // no new entry

    getState().undo()
    expect(getState().doc.tracks[0].name).toBe('V1')
  })

  test('removeTrack is ONE entry; one undo restores the track AND its clips', () => {
    const initialJson = JSON.stringify(getState().doc)

    getState().removeTrack('V1') // carries clipA + clipB
    expect(getState().doc.tracks.map((t) => t.id)).toEqual(['V2', 'A1'])
    expect(getState().past).toHaveLength(1)

    getState().undo()
    expect(JSON.stringify(getState().doc)).toBe(initialJson)
  })

  test('removeTrack on a locked track warns and pushes no history', () => {
    getState().setTrackFlags('A1', { locked: true })
    const before = getState().doc
    getState().removeTrack('A1')
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(1) // only the lock
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('setClipVolume commits one entry; idempotent sets push none', () => {
    getState().setClipVolume('clipD', 0.4) // clipD is on A1
    expect(getState().doc.tracks[2].clips[0].volume).toBe(0.4)
    expect(getState().past).toHaveLength(1)

    getState().setClipVolume('clipD', 0.4) // unchanged
    expect(getState().past).toHaveLength(1)

    getState().setClipVolume('clipD', 99) // domain clamps to 2
    expect(getState().doc.tracks[2].clips[0].volume).toBe(2)
    expect(getState().past).toHaveLength(2)
  })

  test('solo flows through setTrackFlags with the same history contract', () => {
    getState().setTrackFlags('A1', { solo: true })
    expect(getState().doc.tracks[2].solo).toBe(true)
    expect(getState().past).toHaveLength(1)
    getState().setTrackFlags('A1', { solo: true }) // idempotent
    expect(getState().past).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* Linked clips (Phase 4.3.8)                                          */
/* ------------------------------------------------------------------ */

const PAIR1 = 'link_pair1'
const PAIR2 = 'link_pair2'

/**
 * V1: vClip [0,200) {PAIR1}   vDown [300,350)
 * A1: aClip [0,200) {PAIR1}   aDown [300,350)
 * V2: vClip2 [0,100) {PAIR2}
 * AL: aClip2 [0,100) {PAIR2}  (LOCKED — partner-blocked atomicity fixture)
 */
function makeLinkedDoc(): TimelineDoc {
  return deepFreeze({
    schemaVersion: 1,
    id: 'doc-linked',
    name: 'Linked test doc',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', 'video', [makeClip('vClip', 0, 200, PAIR1), makeClip('vDown', 300, 50)]),
      makeTrack('A1', 'audio', [makeClip('aClip', 0, 200, PAIR1), makeClip('aDown', 300, 50)]),
      makeTrack('V2', 'video', [makeClip('vClip2', 0, 100, PAIR2)]),
      makeTrack('AL', 'audio', [makeClip('aClip2', 0, 100, PAIR2)], true),
    ],
  })
}

describe('linked geometry actions', () => {
  beforeEach(() => {
    getState().setDoc(makeLinkedDoc())
  })

  test('moveClip on a linked video half moves both halves by the same delta, one entry, undo restores both exactly', () => {
    const initialDoc = getState().doc

    getState().moveClip('vClip', 'V1', 50)
    expect(getState().doc.tracks[0].clips[0].timelineRange.startFrame).toBe(50) // vClip
    expect(getState().doc.tracks[1].clips[0].timelineRange.startFrame).toBe(50) // aClip, own track
    expect(getState().past).toHaveLength(1)

    getState().undo()
    expect(getState().doc).toBe(initialDoc)
  })

  test('trimClip on a linked half trims both halves, one entry', () => {
    getState().trimClip('vClip', 'end', -20)
    expect(getState().doc.tracks[0].clips[0].timelineRange.durationFrames).toBe(180)
    expect(getState().doc.tracks[1].clips[0].timelineRange.durationFrames).toBe(180)
    expect(getState().past).toHaveLength(1)
  })

  test('rippleTrim on a linked half ripples both halves and each track\'s own downstream clip, one entry', () => {
    getState().rippleTrim('vClip', 'end', 20)
    expect(getState().doc.tracks[0].clips[0].timelineRange.durationFrames).toBe(220)
    expect(getState().doc.tracks[0].clips[1].timelineRange.startFrame).toBe(320) // vDown followed
    expect(getState().doc.tracks[1].clips[0].timelineRange.durationFrames).toBe(220)
    expect(getState().doc.tracks[1].clips[1].timelineRange.startFrame).toBe(320) // aDown followed
    expect(getState().past).toHaveLength(1)
  })

  test('slipClip shifts source on both halves, timeline untouched, one entry', () => {
    getState().slipClip('vClip', 10)
    expect(getState().doc.tracks[0].clips[0].sourceRange.startFrame).toBe(10)
    expect(getState().doc.tracks[0].clips[0].timelineRange.startFrame).toBe(0)
    expect(getState().doc.tracks[1].clips[0].sourceRange.startFrame).toBe(10)
    expect(getState().past).toHaveLength(1)
  })

  test('slideClip moves both halves by the same delta, one entry', () => {
    getState().slideClip('vClip', 50)
    expect(getState().doc.tracks[0].clips[0].timelineRange.startFrame).toBe(50)
    expect(getState().doc.tracks[1].clips[0].timelineRange.startFrame).toBe(50)
    expect(getState().past).toHaveLength(1)
  })

  test('rippleDelete on a linked half removes both halves, one entry, undo restores both exactly', () => {
    const initialDoc = getState().doc

    getState().rippleDelete('vClip')
    expect(getState().doc.tracks[0].clips.map((c) => c.id)).toEqual(['vDown'])
    expect(getState().doc.tracks[1].clips.map((c) => c.id)).toEqual(['aDown'])
    expect(getState().past).toHaveLength(1)

    getState().undo()
    expect(getState().doc).toBe(initialDoc)
  })

  test('a linked action whose partner is blocked (locked track) is rejected atomically: no history, warn fired', () => {
    const before = getState().doc
    getState().trimClip('vClip2', 'end', -10) // target's V2 is fine; partner's AL is locked
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('unlinkClip', () => {
  beforeEach(() => {
    getState().setDoc(makeLinkedDoc())
  })

  test('dissolves the group: both halves lose linkGroupId, one entry, undo restores both exactly', () => {
    const initialDoc = getState().doc

    getState().unlinkClip('vClip')
    expect(getState().doc.tracks[0].clips[0].linkGroupId).toBeUndefined()
    expect(getState().doc.tracks[1].clips[0].linkGroupId).toBeUndefined()
    expect(getState().past).toHaveLength(1)

    getState().undo()
    expect(getState().doc).toBe(initialDoc)
    expect(getState().doc.tracks[0].clips[0].linkGroupId).toBe(PAIR1)
  })

  test('on an unlinked clip: no history entry, warn fired', () => {
    const before = getState().doc
    getState().unlinkClip('vDown') // vDown has no linkGroupId
    expect(getState().doc).toBe(before)
    expect(getState().past).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('splitClipAtPlayhead with linked groups', () => {
  const PAIR_A = 'link_pairA'
  const PAIR_B = 'link_pairB'

  /** V1/A1: a linked pair under the playhead. V2/A2: a second linked pair
   * well outside it. */
  function makeTwoPairsDoc(): TimelineDoc {
    return deepFreeze({
      schemaVersion: 1,
      id: 'doc-split-pairs',
      name: 'Split pairs test doc',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks: [
        makeTrack('V1', 'video', [makeClip('vA', 0, 100, PAIR_A)]),
        makeTrack('A1', 'audio', [makeClip('aA', 0, 100, PAIR_A)]),
        makeTrack('V2', 'video', [makeClip('vB', 500, 100, PAIR_B)]),
        makeTrack('A2', 'audio', [makeClip('aB', 500, 100, PAIR_B)]),
      ],
    })
  }

  /** V1/A1: a linked pair under the playhead. V2: an unlinked clip ALSO
   * under the playhead. */
  function makeMixedDoc(): TimelineDoc {
    return deepFreeze({
      schemaVersion: 1,
      id: 'doc-split-mixed',
      name: 'Split mixed test doc',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks: [
        makeTrack('V1', 'video', [makeClip('vA', 0, 100, PAIR_A)]),
        makeTrack('A1', 'audio', [makeClip('aA', 0, 100, PAIR_A)]),
        makeTrack('V2', 'video', [makeClip('vLoner', 0, 100)]),
      ],
    })
  }

  test('splits a linked pair into 4 clips (lefts keep the original group, rights share one new group); a second pair off-playhead is untouched', () => {
    const doc = makeTwoPairsDoc()
    getState().setDoc(doc)

    getState().splitClipAtPlayhead(40)
    const out = getState().doc

    expect(out.tracks[0].clips).toHaveLength(2) // vA -> left + right
    expect(out.tracks[1].clips).toHaveLength(2) // aA -> left + right

    const vLeft = out.tracks[0].clips[0]
    const vRight = out.tracks[0].clips[1]
    const aLeft = out.tracks[1].clips[0]
    const aRight = out.tracks[1].clips[1]

    expect(vLeft.id).toBe('vA')
    expect(aLeft.id).toBe('aA')
    expect(vLeft.linkGroupId).toBe(PAIR_A)
    expect(aLeft.linkGroupId).toBe(PAIR_A)
    expect(vRight.linkGroupId).toBeDefined()
    expect(vRight.linkGroupId).toBe(aRight.linkGroupId)
    expect(vRight.linkGroupId).not.toBe(PAIR_A)

    // Second pair, well outside the playhead: byte-identical track references.
    expect(out.tracks[2]).toBe(doc.tracks[2])
    expect(out.tracks[3]).toBe(doc.tracks[3])

    expect(getState().past).toHaveLength(1) // one entry for the whole gesture
  })

  test('a linked pair plus an unlinked clip under the playhead all split in one entry', () => {
    getState().setDoc(makeMixedDoc())

    getState().splitClipAtPlayhead(40)
    const out = getState().doc

    expect(out.tracks[0].clips).toHaveLength(2) // vA -> left + right
    expect(out.tracks[1].clips).toHaveLength(2) // aA -> left + right
    expect(out.tracks[2].clips).toHaveLength(2) // vLoner -> left + right (unlinked)

    expect(getState().past).toHaveLength(1)
  })
})
