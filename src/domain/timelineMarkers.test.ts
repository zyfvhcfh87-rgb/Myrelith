import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TimelineDoc, TimelineMarker } from './schema'
import {
  addTimelineMarker,
  deleteTimelineMarker,
  duplicateTimelineMarker,
  moveTimelineMarker,
  nextTimelineMarker,
  previousTimelineMarker,
  timelineMarkers,
  updateTimelineMarker,
} from './timelineMarkers'
import { docDurationFrames, timelineDisplayDurationFrames } from './selectors'

function doc(markers: TimelineMarker[] = []): TimelineDoc {
  return {
    schemaVersion: 10,
    id: 'doc-markers',
    name: 'Markers',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [],
    markers,
  }
}

const marker = (
  id: string,
  frame: number,
  label = id,
): TimelineMarker => ({ id, frame, label, color: 'yellow' })

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))

describe('timeline markers domain', () => {
  test('adds immutable markers in deterministic frame/id order', () => {
    const original = doc([marker('z', 10)])
    const next = addTimelineMarker(original, marker('a', 10))
    const withUppercase = addTimelineMarker(next, marker('A', 10))
    const sorted = addTimelineMarker(withUppercase, marker('early', 2))

    expect(timelineMarkers(sorted).map(({ id }) => id)).toEqual(['early', 'A', 'a', 'z'])
    expect(original.markers?.map(({ id }) => id)).toEqual(['z'])
    expect(sorted).not.toBe(original)
  })

  test('edits, moves, duplicates, deletes, and rejects no-ops by reference', () => {
    const original = doc([marker('one', 12, 'One')])
    const edited = updateTimelineMarker(original, 'one', {
      label: '  Chorus  ',
      color: 'purple',
      note: '  Drop here  ',
    })
    const moved = moveTimelineMarker(edited, 'one', 240)
    const duplicated = duplicateTimelineMarker(moved, 'one', 'copy')
    const deleted = deleteTimelineMarker(duplicated, 'one')

    expect(edited.markers?.[0]).toMatchObject({
      id: 'one', label: 'Chorus', color: 'purple', note: 'Drop here',
    })
    expect(moved.markers?.[0].frame).toBe(240)
    expect(duplicated.markers).toEqual([
      { id: 'copy', frame: 240, label: 'Chorus copy', color: 'purple', note: 'Drop here' },
      { id: 'one', frame: 240, label: 'Chorus', color: 'purple', note: 'Drop here' },
    ])
    expect(deleted.markers?.map(({ id }) => id)).toEqual(['copy'])
    expect(updateTimelineMarker(edited, 'one', { label: 'Chorus' })).toBe(edited)
    expect(moveTimelineMarker(edited, 'missing', 1)).toBe(edited)
    expect(addTimelineMarker(edited, marker('bad', -1))).toBe(edited)
  })

  test('navigates equal-frame and boundary markers deterministically', () => {
    const document = doc([
      marker('a', 0),
      marker('b', 10),
      marker('c', 10),
      marker('d', 20),
    ])

    expect(nextTimelineMarker(document, 10)?.id).toBe('b')
    expect(nextTimelineMarker(document, 10, 'b')?.id).toBe('c')
    expect(previousTimelineMarker(document, 10, 'c')?.id).toBe('b')
    expect(previousTimelineMarker(document, 10)?.id).toBe('c')
    expect(previousTimelineMarker(document, 0, 'a')).toBeNull()
    expect(nextTimelineMarker(document, 20, 'd')).toBeNull()
  })

  test('keeps export duration clip-owned while the timeline reveals far markers', () => {
    const document = doc([marker('far', 10_000)])
    expect(docDurationFrames(document)).toBe(0)
    expect(timelineDisplayDurationFrames(document)).toBe(10_001)
  })
})
