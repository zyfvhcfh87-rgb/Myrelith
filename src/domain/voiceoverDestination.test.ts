import { describe, expect, test } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import {
  checkVoiceoverDestination, pinVoiceoverDestination, resolveVoiceoverKeepDestination,
  type VoiceoverDestinationContext,
} from './voiceoverDestination'

function context(): VoiceoverDestinationContext {
  return { projectId: 'project', projectGeneration: 3, editRevision: 9,
    doc: createTimelineDoc('Capture', DEFAULT_PROJECT_SETTINGS, 'sequence') }
}

function pin(live = context(), startFrame = 20) {
  const result = pinVoiceoverDestination(live, 'A1', startFrame)
  if (result.status !== 'pinned') throw new Error(result.reason)
  return result.destination
}

describe('pinned voiceover destination', () => {
  test('copies immutable intent and preserves the selected lane and integer frame', () => {
    const live = context()
    const destination = pin(live)
    expect(destination).toMatchObject({ projectId: 'project', projectGeneration: 3,
      sequenceId: 'sequence', trackId: 'A1', startFrame: 20, editRevision: 9 })
    expect(destination.frameRate).not.toBe(live.doc.frameRate)
    expect(Object.isFrozen(destination)).toBe(true)
    expect(Object.isFrozen(destination.frameRate)).toBe(true)
    expect(resolveVoiceoverKeepDestination(destination, live, 10, true))
      .toEqual({ status: 'place', trackId: 'A1', startFrame: 20 })
  })

  test.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])('rejects invalid start %s before permission', (start) => {
    expect(pinVoiceoverDestination(context(), 'A1', start).status).toBe('reject')
  })

  test('rejects missing, locked and video lanes at pin and revalidation', () => {
    const live = context()
    const destination = pin(live)
    expect(pinVoiceoverDestination(live, 'missing', 20)).toEqual({ status: 'reject', reason: 'missing-track' })
    expect(pinVoiceoverDestination(live, 'V1', 20)).toEqual({ status: 'reject', reason: 'wrong-kind' })
    const locked = { ...live, doc: { ...live.doc,
      tracks: live.doc.tracks.map((track) => track.id === 'A1' ? { ...track, locked: true } : track) } }
    expect(checkVoiceoverDestination(destination, locked)).toEqual({ status: 'reject', reason: 'locked-track' })
    expect(pinVoiceoverDestination(locked, 'A1', 20)).toEqual({ status: 'reject', reason: 'locked-track' })
  })

  test('distinguishes project reload, sequence switch, edits and rate changes', () => {
    const live = context()
    const destination = pin(live)
    const cases = [
      [{ ...live, projectId: 'other' }, 'stale-project'],
      [{ ...live, projectGeneration: 4 }, 'stale-project'],
      [{ ...live, doc: { ...live.doc, id: 'other-sequence' } }, 'stale-sequence'],
      [{ ...live, editRevision: 10 }, 'stale-edit'],
      [{ ...live, doc: { ...live.doc, frameRate: { num: 24_000, den: 1_001 } } }, 'changed-rate'],
      [{ ...live, doc: { ...live.doc, audioSampleRate: 44_100 } }, 'changed-rate'],
    ] as const
    for (const [current, reason] of cases) {
      expect(checkVoiceoverDestination(destination, current)).toEqual({ status: 'reject', reason })
    }
    // Even a return to identical document data after undo/navigation is stale.
    expect(checkVoiceoverDestination(destination, { ...live, editRevision: 11 }))
      .toEqual({ status: 'reject', reason: 'stale-edit' })
    const rate = live.doc.frameRate
    expect(checkVoiceoverDestination(destination, { ...live,
      doc: { ...live.doc, frameRate: { num: rate.num * 2, den: rate.den * 2 } } })).toEqual({ status: 'valid' })
  })

  test('rechecks the entire take, including compound occupancy and half-open adjacency', () => {
    const initial = context()
    const live: VoiceoverDestinationContext = { ...initial, doc: { ...initial.doc,
      tracks: initial.doc.tracks.map((track) => track.id !== 'A1' ? track : { ...track,
        sequenceInstances: [{ kind: 'sequence', id: 'compound', name: 'Compound audio', sequenceId: 'child',
          sourceStartFrame: 0, timelineRange: { startFrame: 30, durationFrames: 10 } }],
      }),
    } }
    const destination = pin(live) // insertion point 20 is clear
    expect(checkVoiceoverDestination(destination, live, 10)).toEqual({ status: 'valid' })
    expect(checkVoiceoverDestination(destination, live, 11)).toEqual({ status: 'reject', reason: 'overlap' })
    expect(pinVoiceoverDestination(live, 'A1', 30)).toEqual({ status: 'reject', reason: 'overlap' })
    expect(resolveVoiceoverKeepDestination(destination, live, 11, true))
      .toEqual({ status: 'pool-only', reason: 'overlap' })
    expect(checkVoiceoverDestination(pin(live, 40), live, 1)).toEqual({ status: 'valid' })
  })

  test('keeps stale placements in the original Pool but never imports into a replacement project', () => {
    const live = context()
    const destination = pin(live)
    expect(resolveVoiceoverKeepDestination(destination, { ...live, editRevision: 10 }, 20, true))
      .toEqual({ status: 'pool-only', reason: 'stale-edit' })
    expect(resolveVoiceoverKeepDestination(destination, live, 20, false))
      .toEqual({ status: 'pool-only', reason: null })
    for (const place of [false, true]) {
      expect(resolveVoiceoverKeepDestination(destination, { ...live, projectGeneration: 4 }, 20, place))
        .toEqual({ status: 'retain-draft', reason: 'stale-project' })
    }
  })

  test('rejects malformed revisions, rates and duration overflow without normalizing them', () => {
    const live = context()
    const destination = pin(live)
    expect(checkVoiceoverDestination(destination, { ...live, editRevision: Number.NaN }))
      .toEqual({ status: 'reject', reason: 'invalid-destination' })
    expect(checkVoiceoverDestination({ ...destination, frameRate: { num: 0, den: 1 } }, live))
      .toEqual({ status: 'reject', reason: 'invalid-destination' })
    for (const duration of [0, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(checkVoiceoverDestination(destination, live, duration))
        .toEqual({ status: 'reject', reason: 'invalid-duration' })
    }
  })
})
