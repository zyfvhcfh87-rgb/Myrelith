/**
 * domain/linking.test.ts — Linked A/V clip pairs acceptance tests.
 *
 * Every test deep-freezes the input doc: if a function under test mutates
 * its input instead of returning a new doc, the mutation throws
 * immediately. Rejected/degraded-to-no-op calls are asserted with
 * toBe(doc) (same reference), matching operations.test.ts's style.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createLinkGroupId,
  linkedMoveClip,
  linkedPartners,
  linkedRippleDelete,
  linkedRippleTrim,
  linkedSlideClip,
  linkedSlipClip,
  linkedSplitClipAtFrame,
  linkedTrimClip,
  unlinkClip,
} from './linking'
import {
  clipFromAsset,
  insertClip,
  moveClip,
  rippleDelete,
  rippleTrim,
  splitClipAtFrame,
  trimClip,
} from './operations'
import type { Clip, MediaAsset, TimelineDoc, Track } from './schema'

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
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

function makeClip(
  id: string,
  tlStart: number,
  duration: number,
  srcStart = 0,
  linkGroupId?: string,
): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: srcStart, durationFrames: duration },
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

const PAIR1 = 'link_pair1'
const PAIR2 = 'link_pair2'
const PAIR3 = 'link_pair3'
const PAIR4 = 'link_pair4'

/**
 * Layout used by most tests (frames, half-open):
 *   V1: vClip [0,100) src[10,110) {PAIR1}   vDown [150,200)   vSplitOnly [220,280) {PAIR4}
 *   A1: aClip [0,100) src[0,100)  {PAIR1}   aDown [150,200)   aBlock [300,350)   aSplitOnly [400,450) {PAIR4}
 *   V2: vClip2 [0,60) {PAIR2}
 *   AL: aClip2 [0,60) {PAIR2}                                (LOCKED — partner-locked atomicity fixture)
 *   V3: vLeftNeighbor [0,50)   vClip3 [50,100) {PAIR3}        (touches vClip3 at 50)
 *   A3: aClip3 [50,100) {PAIR3}                                (alone on its track — no neighbor to absorb a slide)
 *   V5: (empty — insert/move target)
 *
 * PAIR1 is a "normal" linked pair with downstream clips on both tracks (for
 * move/trim/rippleTrim/slip/rippleDelete). PAIR2 is a linked pair whose
 * audio half sits on a LOCKED track (atomicity-by-lock fixture). PAIR3 is a
 * linked pair for slideClip, where only the VIDEO half has a touching
 * neighbor. PAIR4 is a linked pair whose members' ranges do NOT overlap
 * (audio half far away) — split-only-one-member fixture.
 */
function makeDoc(): TimelineDoc {
  return deepFreeze({
    schemaVersion: 1,
    id: 'doc-1',
    name: 'Test doc',
    frameRate: { num: 30000, den: 1001 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', 'video', [
        makeClip('vClip', 0, 100, 10, PAIR1),
        makeClip('vDown', 150, 50, 0),
        makeClip('vSplitOnly', 220, 60, 0, PAIR4),
      ]),
      makeTrack('A1', 'audio', [
        makeClip('aClip', 0, 100, 0, PAIR1),
        makeClip('aDown', 150, 50, 0),
        makeClip('aBlock', 300, 50, 0),
        makeClip('aSplitOnly', 400, 50, 0, PAIR4),
      ]),
      makeTrack('V2', 'video', [makeClip('vClip2', 0, 60, 0, PAIR2)]),
      makeTrack('AL', 'audio', [makeClip('aClip2', 0, 60, 0, PAIR2)], true),
      makeTrack('V3', 'video', [
        makeClip('vLeftNeighbor', 0, 50, 0),
        makeClip('vClip3', 50, 50, 0, PAIR3),
      ]),
      makeTrack('A3', 'audio', [makeClip('aClip3', 50, 50, 0, PAIR3)]),
      makeTrack('V5', 'video', []),
    ],
  })
}

function makeLinkedTransitionDoc(audioLocked = false): TimelineDoc {
  const linkGroupId = 'link_transition'
  const video = makeClip('vTransition', 0, 100, 10, linkGroupId)
  const audio = makeClip('aTransition', 0, 100, 0, linkGroupId)
  const next = makeClip('vAfter', 100, 50)
  const videoTrack: Track = {
    ...makeTrack('VT', 'video', [video, next]),
    transitions: [{
      id: 'transition-linked',
      type: 'crossfade',
      fromClipId: video.id,
      toClipId: next.id,
      durationFrames: 10,
    }],
  }

  return deepFreeze({
    schemaVersion: 1,
    id: 'doc-transition-linked',
    name: 'Linked transition test doc',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      videoTrack,
      makeTrack('AT', 'audio', [audio], audioLocked),
    ],
  })
}

function clipsOf(doc: TimelineDoc, trackId: string): Clip[] {
  const track = doc.tracks.find((t) => t.id === trackId)
  if (!track) throw new Error(`no track ${trackId}`)
  return track.clips
}

function clipIn(doc: TimelineDoc, trackId: string, clipId: string): Clip {
  const clip = clipsOf(doc, trackId).find((c) => c.id === clipId)
  if (!clip) throw new Error(`no clip ${clipId} on ${trackId}`)
  return clip
}

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'asset-9',
  fileName: 'beach.mp4',
  objectUrl: 'blob:fake',
  kind: 'video',
  durationFrames: 120,
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioSampleRate: 48000,
  audioChannels: 2,
  decoderConfigB64: null,
  ...over,
})

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

/* ------------------------------------------------------------------ */
/* clipFromAsset / insertClip — linkGroupId plumbing                    */
/* ------------------------------------------------------------------ */

describe('clipFromAsset linkGroupId', () => {
  test('omitted: the key is absent, not undefined', () => {
    const c = clipFromAsset(asset(), 0)
    expect(c.linkGroupId).toBeUndefined()
    expect('linkGroupId' in c).toBe(false)
  })

  test('provided: the clip carries it', () => {
    const c = clipFromAsset(asset(), 0, 'link_xyz')
    expect(c.linkGroupId).toBe('link_xyz')
  })
})

describe('insertClip + linkGroupId', () => {
  test('the defensive copy preserves linkGroupId', () => {
    const doc = makeDoc()
    const clip = clipFromAsset(asset(), 0, 'link_xyz')
    const out = insertClip(doc, 'V5', clip)
    expect(clipIn(out, 'V5', clip.id).linkGroupId).toBe('link_xyz')
  })

  test('JSON round-trip: present when linked, absent when not', () => {
    const doc = makeDoc()
    const linked = clipFromAsset(asset(), 0, 'link_xyz')
    const withLinked = insertClip(doc, 'V5', linked)
    const unlinked = clipFromAsset(asset(), 200)
    const out = insertClip(withLinked, 'V5', unlinked)

    const round = JSON.parse(JSON.stringify(out)) as TimelineDoc
    const v5 = round.tracks.find((t) => t.id === 'V5')
    if (!v5) throw new Error('no V5 track after round-trip')
    const linkedRound = v5.clips.find((c) => c.id === linked.id)
    const unlinkedRound = v5.clips.find((c) => c.id === unlinked.id)
    if (!linkedRound || !unlinkedRound) throw new Error('clips missing after round-trip')
    expect(linkedRound.linkGroupId).toBe('link_xyz')
    expect(unlinkedRound.linkGroupId).toBeUndefined()
    expect('linkGroupId' in unlinkedRound).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* createLinkGroupId                                                    */
/* ------------------------------------------------------------------ */

describe('createLinkGroupId', () => {
  test('mints a unique, prefixed id', () => {
    const a = createLinkGroupId()
    const b = createLinkGroupId()
    expect(a).toMatch(/^link_/)
    expect(a).not.toBe(b)
  })
})

/* ------------------------------------------------------------------ */
/* linkedPartners                                                       */
/* ------------------------------------------------------------------ */

describe('linkedPartners', () => {
  test('returns the other member(s) of the group', () => {
    const doc = makeDoc()
    const partners = linkedPartners(doc, 'vClip')
    expect(partners).toHaveLength(1)
    expect(partners[0].id).toBe('aClip')
  })

  test('empty for a clip with no linkGroupId', () => {
    const doc = makeDoc()
    expect(linkedPartners(doc, 'vDown')).toEqual([])
  })

  test('empty for an unknown clip', () => {
    const doc = makeDoc()
    expect(linkedPartners(doc, 'nope')).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* unlinkClip                                                           */
/* ------------------------------------------------------------------ */

describe('unlinkClip', () => {
  test('strips linkGroupId from every member (property absent in JSON)', () => {
    const doc = makeDoc()
    const out = unlinkClip(doc, 'vClip')
    expect(clipIn(out, 'V1', 'vClip').linkGroupId).toBeUndefined()
    expect(clipIn(out, 'A1', 'aClip').linkGroupId).toBeUndefined()

    const round = JSON.parse(JSON.stringify(out)) as TimelineDoc
    const v = round.tracks.find((t) => t.id === 'V1')?.clips.find((c) => c.id === 'vClip')
    const a = round.tracks.find((t) => t.id === 'A1')?.clips.find((c) => c.id === 'aClip')
    if (!v || !a) throw new Error('clips missing after round-trip')
    expect('linkGroupId' in v).toBe(false)
    expect('linkGroupId' in a).toBe(false)

    // Structural sharing: unrelated tracks keep their reference.
    expect(out.tracks.find((t) => t.id === 'V2')).toBe(doc.tracks.find((t) => t.id === 'V2'))
    expect(out.tracks.find((t) => t.id === 'V3')).toBe(doc.tracks.find((t) => t.id === 'V3'))
  })

  test('rejects an unlinked clip, an unknown clip, and any-member-locked (same reference each time)', () => {
    const doc = makeDoc()
    expect(unlinkClip(doc, 'vDown')).toBe(doc) // no linkGroupId
    expect(unlinkClip(doc, 'nope')).toBe(doc) // unknown clip
    expect(unlinkClip(doc, 'vClip2')).toBe(doc) // target's own track is fine; partner aClip2 sits on locked AL
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })
})

/* ------------------------------------------------------------------ */
/* linkedMoveClip                                                       */
/* ------------------------------------------------------------------ */

describe('linkedMoveClip', () => {
  test('target moves to the given track/frame; partner shifts by the same delta on its OWN track', () => {
    const doc = makeDoc()
    const out = linkedMoveClip(doc, 'vClip', 'V5', 20)

    expect(clipsOf(out, 'V1').map((c) => c.id)).toEqual(['vDown', 'vSplitOnly'])
    expect(clipsOf(out, 'V5').map((c) => c.id)).toEqual(['vClip'])
    expect(clipIn(out, 'V5', 'vClip').timelineRange).toEqual({ startFrame: 20, durationFrames: 100 })
    expect(clipIn(out, 'V5', 'vClip').sourceRange).toEqual({ startFrame: 10, durationFrames: 100 })
    expect(clipIn(out, 'V5', 'vClip').linkGroupId).toBe(PAIR1)

    // Partner never changes tracks — it stays on A1 — but shifts by the same delta.
    expect(clipIn(out, 'A1', 'aClip').timelineRange).toEqual({ startFrame: 20, durationFrames: 100 })
    expect(clipIn(out, 'A1', 'aClip').linkGroupId).toBe(PAIR1)
  })

  test('atomic: partner blocked by an overlap on its own track rolls back the whole move', () => {
    const doc = makeDoc()
    // Target alone could move to 300 on V1 (clear there); partner would
    // land on A1 at [300,400), which overlaps aBlock [300,350).
    const out = linkedMoveClip(doc, 'vClip', 'V1', 300)
    expect(out).toBe(doc) // same reference: no partial move anywhere
    expect(warnSpy).toHaveBeenCalledTimes(2) // moveClip's own warning + linking's rollback warning
  })

  test('unlinked clip: byte-identical to the plain op', () => {
    const doc = makeDoc()
    expect(linkedMoveClip(doc, 'vDown', 'V5', 500)).toEqual(moveClip(doc, 'vDown', 'V5', 500))
  })
})

/* ------------------------------------------------------------------ */
/* linkedTrimClip                                                       */
/* ------------------------------------------------------------------ */

describe('linkedTrimClip', () => {
  test('both members trim their end by the same delta', () => {
    const doc = makeDoc()
    const out = linkedTrimClip(doc, 'vClip', 'end', -20)
    expect(clipIn(out, 'V1', 'vClip').timelineRange).toEqual({ startFrame: 0, durationFrames: 80 })
    expect(clipIn(out, 'V1', 'vClip').sourceRange).toEqual({ startFrame: 10, durationFrames: 80 })
    expect(clipIn(out, 'A1', 'aClip').timelineRange).toEqual({ startFrame: 0, durationFrames: 80 })
    expect(clipIn(out, 'A1', 'aClip').sourceRange).toEqual({ startFrame: 0, durationFrames: 80 })
  })

  test('both members trim their start by the same delta', () => {
    const doc = makeDoc()
    const out = linkedTrimClip(doc, 'vClip', 'start', 5)
    expect(clipIn(out, 'V1', 'vClip').timelineRange).toEqual({ startFrame: 5, durationFrames: 95 })
    expect(clipIn(out, 'V1', 'vClip').sourceRange).toEqual({ startFrame: 15, durationFrames: 95 })
    expect(clipIn(out, 'A1', 'aClip').timelineRange).toEqual({ startFrame: 5, durationFrames: 95 })
    expect(clipIn(out, 'A1', 'aClip').sourceRange).toEqual({ startFrame: 5, durationFrames: 95 })
  })

  test('atomic: partner blocked by its locked track rolls back the whole trim', () => {
    const doc = makeDoc()
    const out = linkedTrimClip(doc, 'vClip2', 'end', -10) // target's V2 is fine; partner's AL is locked
    expect(out).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('atomic rollback restores the exact transition when a later locked partner rejects', () => {
    const doc = makeLinkedTransitionDoc(true)
    const transition = doc.tracks[0].transitions[0]
    const videoRange = clipIn(doc, 'VT', 'vTransition').timelineRange
    const audioRange = clipIn(doc, 'AT', 'aTransition').timelineRange

    const out = linkedTrimClip(doc, 'vTransition', 'end', -10)

    expect(out).toBe(doc)
    expect(out.tracks[0].transitions[0]).toBe(transition)
    expect(clipIn(out, 'VT', 'vTransition').timelineRange).toBe(videoRange)
    expect(clipIn(out, 'AT', 'aTransition').timelineRange).toBe(audioRange)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('unlinked clip: byte-identical to the plain op', () => {
    const doc = makeDoc()
    expect(linkedTrimClip(doc, 'vDown', 'end', -10)).toEqual(trimClip(doc, 'vDown', 'end', -10))
  })
})

/* ------------------------------------------------------------------ */
/* linkedRippleTrim                                                     */
/* ------------------------------------------------------------------ */

describe('linkedRippleTrim', () => {
  test('both members ripple; each track\'s OWN downstream clips shift', () => {
    const doc = makeDoc()
    const out = linkedRippleTrim(doc, 'vClip', 'end', 20)

    expect(clipIn(out, 'V1', 'vClip').timelineRange).toEqual({ startFrame: 0, durationFrames: 120 })
    expect(clipIn(out, 'V1', 'vDown').timelineRange.startFrame).toBe(170)
    expect(clipIn(out, 'V1', 'vSplitOnly').timelineRange.startFrame).toBe(240)

    expect(clipIn(out, 'A1', 'aClip').timelineRange).toEqual({ startFrame: 0, durationFrames: 120 })
    expect(clipIn(out, 'A1', 'aDown').timelineRange.startFrame).toBe(170)
    expect(clipIn(out, 'A1', 'aBlock').timelineRange.startFrame).toBe(320)
    expect(clipIn(out, 'A1', 'aSplitOnly').timelineRange.startFrame).toBe(420)
  })

  test('unlinked clip: byte-identical to the plain op', () => {
    const doc = makeDoc()
    expect(linkedRippleTrim(doc, 'vDown', 'end', 5)).toEqual(rippleTrim(doc, 'vDown', 'end', 5))
  })
})

/* ------------------------------------------------------------------ */
/* linkedSlipClip                                                       */
/* ------------------------------------------------------------------ */

describe('linkedSlipClip', () => {
  test('both members shift source material by the same delta; timeline untouched', () => {
    const doc = makeDoc()
    const out = linkedSlipClip(doc, 'vClip', 15)
    expect(clipIn(out, 'V1', 'vClip').sourceRange).toEqual({ startFrame: 25, durationFrames: 100 })
    expect(clipIn(out, 'V1', 'vClip').timelineRange).toEqual({ startFrame: 0, durationFrames: 100 })
    expect(clipIn(out, 'A1', 'aClip').sourceRange).toEqual({ startFrame: 15, durationFrames: 100 })
    expect(clipIn(out, 'A1', 'aClip').timelineRange).toEqual({ startFrame: 0, durationFrames: 100 })
  })
})

/* ------------------------------------------------------------------ */
/* linkedSlideClip                                                      */
/* ------------------------------------------------------------------ */

describe('linkedSlideClip', () => {
  test('both members slide by the same delta; only the touching side (one track) absorbs it', () => {
    const doc = makeDoc()
    const out = linkedSlideClip(doc, 'vClip3', 10)

    // V3: the touching left neighbor extends to stay glued.
    expect(clipIn(out, 'V3', 'vLeftNeighbor').timelineRange).toEqual({ startFrame: 0, durationFrames: 60 })
    expect(clipIn(out, 'V3', 'vLeftNeighbor').sourceRange.durationFrames).toBe(60)
    expect(clipIn(out, 'V3', 'vClip3').timelineRange).toEqual({ startFrame: 60, durationFrames: 50 })

    // A3: no neighbor to absorb it — the clip just moves, content untouched.
    expect(clipIn(out, 'A3', 'aClip3').timelineRange).toEqual({ startFrame: 60, durationFrames: 50 })
    expect(clipIn(out, 'A3', 'aClip3').sourceRange).toEqual({ startFrame: 0, durationFrames: 50 })
  })
})

/* ------------------------------------------------------------------ */
/* linkedRippleDelete                                                   */
/* ------------------------------------------------------------------ */

describe('linkedRippleDelete', () => {
  test('removes both members and shifts each track\'s OWN downstream clips', () => {
    const doc = makeDoc()
    const out = linkedRippleDelete(doc, 'vClip')

    expect(clipsOf(out, 'V1').map((c) => c.id)).toEqual(['vDown', 'vSplitOnly'])
    expect(clipIn(out, 'V1', 'vDown').timelineRange.startFrame).toBe(50)
    expect(clipIn(out, 'V1', 'vSplitOnly').timelineRange.startFrame).toBe(120)

    expect(clipsOf(out, 'A1').map((c) => c.id)).toEqual(['aDown', 'aBlock', 'aSplitOnly'])
    expect(clipIn(out, 'A1', 'aDown').timelineRange.startFrame).toBe(50)
    expect(clipIn(out, 'A1', 'aBlock').timelineRange.startFrame).toBe(200)
    expect(clipIn(out, 'A1', 'aSplitOnly').timelineRange.startFrame).toBe(300)
  })

  test('atomic: partner blocked by its locked track rolls back the whole delete', () => {
    const doc = makeDoc()
    const out = linkedRippleDelete(doc, 'vClip2') // target's V2 deletes fine; partner's AL is locked
    expect(out).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('unlinked clip: byte-identical to the plain op', () => {
    const doc = makeDoc()
    expect(linkedRippleDelete(doc, 'vDown')).toEqual(rippleDelete(doc, 'vDown'))
  })
})

/* ------------------------------------------------------------------ */
/* linkedSplitClipAtFrame                                               */
/* ------------------------------------------------------------------ */

describe('linkedSplitClipAtFrame', () => {
  test('pair split produces 4 clips: lefts keep the original group, rights share ONE new group, ranges match a plain split', () => {
    const doc = makeDoc()
    const plainV = splitClipAtFrame(doc, 'vClip', 40)
    const plainA = splitClipAtFrame(doc, 'aClip', 40)
    const out = linkedSplitClipAtFrame(doc, 'vClip', 40)

    expect(clipsOf(out, 'V1')).toHaveLength(4)
    expect(clipsOf(out, 'A1')).toHaveLength(5)

    const vLeft = clipIn(out, 'V1', 'vClip')
    const aLeft = clipIn(out, 'A1', 'aClip')
    const vRight = clipsOf(out, 'V1').find((c) => c.timelineRange.startFrame === 40)
    const aRight = clipsOf(out, 'A1').find((c) => c.timelineRange.startFrame === 40)
    if (!vRight || !aRight) throw new Error('right halves not found')

    // Ranges match a plain split exactly (ids/linkGroupId aside).
    const plainVLeft = clipIn(plainV, 'V1', 'vClip')
    const plainVRight = clipsOf(plainV, 'V1').find((c) => c.timelineRange.startFrame === 40)
    const plainALeft = clipIn(plainA, 'A1', 'aClip')
    const plainARight = clipsOf(plainA, 'A1').find((c) => c.timelineRange.startFrame === 40)
    if (!plainVRight || !plainARight) throw new Error('plain right halves not found')
    expect(vLeft.timelineRange).toEqual(plainVLeft.timelineRange)
    expect(vLeft.sourceRange).toEqual(plainVLeft.sourceRange)
    expect(vRight.timelineRange).toEqual(plainVRight.timelineRange)
    expect(vRight.sourceRange).toEqual(plainVRight.sourceRange)
    expect(aLeft.timelineRange).toEqual(plainALeft.timelineRange)
    expect(aLeft.sourceRange).toEqual(plainALeft.sourceRange)
    expect(aRight.timelineRange).toEqual(plainARight.timelineRange)
    expect(aRight.sourceRange).toEqual(plainARight.sourceRange)

    // Left halves keep the ORIGINAL group; right halves share ONE NEW group.
    expect(vLeft.linkGroupId).toBe(PAIR1)
    expect(aLeft.linkGroupId).toBe(PAIR1)
    expect(vRight.linkGroupId).toBeDefined()
    expect(vRight.linkGroupId).toBe(aRight.linkGroupId)
    expect(vRight.linkGroupId).not.toBe(PAIR1)
  })

  test('split via the audio member rebinds the video outgoing transition to the video right half', () => {
    const doc = makeLinkedTransitionDoc()
    const out = linkedSplitClipAtFrame(doc, 'aTransition', 40)
    const videoRight = clipsOf(out, 'VT').find(
      (clip) => clip.timelineRange.startFrame === 40,
    )
    if (!videoRight) throw new Error('video right half not found')

    expect(out.tracks[0].transitions).toEqual([{
      id: 'transition-linked',
      type: 'crossfade',
      fromClipId: videoRight.id,
      toClipId: 'vAfter',
      durationFrames: 10,
    }])
  })

  test('split where only the target contains frame: target splits, right half unlinked, partner untouched', () => {
    const doc = makeDoc()
    const plain = splitClipAtFrame(doc, 'vSplitOnly', 250)
    const out = linkedSplitClipAtFrame(doc, 'vSplitOnly', 250)

    const left = clipIn(out, 'V1', 'vSplitOnly')
    const right = clipsOf(out, 'V1').find((c) => c.timelineRange.startFrame === 250)
    const plainLeft = clipIn(plain, 'V1', 'vSplitOnly')
    const plainRight = clipsOf(plain, 'V1').find((c) => c.timelineRange.startFrame === 250)
    if (!right || !plainRight) throw new Error('right half not found')

    expect(left.timelineRange).toEqual(plainLeft.timelineRange)
    expect(right.timelineRange).toEqual(plainRight.timelineRange)
    expect(left.linkGroupId).toBe(PAIR4) // left keeps the original group
    expect(right.linkGroupId).toBeUndefined() // no partner at its new position
    expect('linkGroupId' in right).toBe(false)

    // Partner untouched: same reference all the way up to its track.
    expect(clipIn(out, 'A1', 'aSplitOnly')).toBe(clipIn(doc, 'A1', 'aSplitOnly'))
    expect(out.tracks.find((t) => t.id === 'A1')).toBe(doc.tracks.find((t) => t.id === 'A1'))
  })

  test('rejects exactly like splitClipAtFrame would: bad frame or unknown clip (same reference)', () => {
    const doc = makeDoc()
    expect(linkedSplitClipAtFrame(doc, 'vClip', 0)).toBe(doc) // boundary: empty left half
    expect(linkedSplitClipAtFrame(doc, 'vClip', 100)).toBe(doc) // boundary: empty right half
    expect(linkedSplitClipAtFrame(doc, 'vClip', 1000)).toBe(doc) // outside the clip entirely
    expect(linkedSplitClipAtFrame(doc, 'vClip', 40.5)).toBe(doc) // non-integer
    expect(linkedSplitClipAtFrame(doc, 'nope', 40)).toBe(doc) // unknown clip
    expect(warnSpy).toHaveBeenCalledTimes(5) // one warning each, straight from splitClipAtFrame
  })

  test('a partner that strictly contains frame but cannot split (locked track) rolls back the whole edit', () => {
    const doc = makeDoc()
    const out = linkedSplitClipAtFrame(doc, 'vClip2', 30) // target's V2 would split fine; partner's AL is locked
    expect(out).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2) // splitClipAtFrame's own warning + linking's rollback warning
  })
})
