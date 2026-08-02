import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../../domain/schema'
import { defaultTextProps } from '../../domain/textOverlay'
import {
  gestureBoundsForClip,
  linkedGestureBounds,
  type GestureMode,
} from './gestureBounds'

function clip(
  id: string,
  assetId: string,
  timelineStart: number,
  duration: number,
  sourceStart: number,
  linkGroupId?: string,
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: sourceStart, durationFrames: duration },
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
    volume: 1,
    effects: [],
    ...(linkGroupId === undefined ? {} : { linkGroupId }),
  }
}

function track(id: string, kind: Track['kind'], clips: Clip[]): Track {
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

function linkedDoc(
  video = clip('video', 'video-asset', 100, 70, 11, 'link_bounds'),
  audio = clip('audio', 'audio-asset', 35, 40, 2, 'link_bounds'),
): TimelineDoc {
  return {
    schemaVersion: 4,
    id: 'gesture-bounds',
    name: 'Gesture bounds',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      track('V1', 'video', [video]),
      track('A1', 'audio', [audio]),
    ],
  }
}

const durations = new Map([
  ['video-asset', 200],
  ['audio-asset', 65],
])

const durationFor = (member: Clip): number => durations.get(member.assetId) ?? 0

describe('gestureBoundsForClip', () => {
  test('keeps plain trim-start constrained by both timeline and source floors', () => {
    const member = clip('member', 'video-asset', 2, 40, 20)

    expect(gestureBoundsForClip(member, 'trim-start', 200)).toEqual({
      minDelta: -2,
      maxDelta: 39,
    })
    expect(gestureBoundsForClip(member, 'ripple-start', 200)).toEqual({
      minDelta: -20,
      maxDelta: 39,
    })
  })

  test('text clips remain extendable without a media descriptor', () => {
    const member = {
      ...clip('text', 'text', 5, 20, 0),
      text: {
        ...defaultTextProps(1920, 1080),
        content: 'Hello',
        fontFamily: 'sans-serif' as const,
        fontSizePx: 48,
        color: '#ffffff',
        align: 'center' as const,
        bold: false,
        italic: false,
      },
    }

    expect(gestureBoundsForClip(member, 'trim-end', 0).maxDelta).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  test('stills have timeline-only trim bounds and no slip interval', () => {
    const member = {
      ...clip('still', 'image-asset', 20, 150, 0),
      sourceMode: 'still' as const,
      sourceRange: { startFrame: 0, durationFrames: 1 },
    }

    expect(gestureBoundsForClip(member, 'trim-start', 150)).toEqual({
      minDelta: -20,
      maxDelta: 149,
    })
    expect(gestureBoundsForClip(member, 'ripple-start', 150)).toEqual({
      minDelta: Number.NEGATIVE_INFINITY,
      maxDelta: 149,
    })
    expect(gestureBoundsForClip(member, 'trim-end', 150)).toEqual({
      minDelta: -149,
      maxDelta: Number.POSITIVE_INFINITY,
    })
    expect(gestureBoundsForClip(member, 'ripple-end', 150)).toEqual({
      minDelta: -149,
      maxDelta: Number.POSITIVE_INFINITY,
    })
    expect(gestureBoundsForClip(member, 'slip', 150)).toEqual({
      minDelta: 0,
      maxDelta: 0,
    })
  })
})

describe('linkedGestureBounds', () => {
  test.each<[GestureMode, number, number]>([
    ['move', -35, Number.POSITIVE_INFINITY],
    ['slide', -35, Number.POSITIVE_INFINITY],
    ['trim-start', -2, 39],
    ['ripple-start', -2, 39],
    ['trim-end', -39, 23],
    ['ripple-end', -39, 23],
    ['slip', -2, 23],
  ])(
    'intersects every linked member for %s',
    (mode, minDelta, maxDelta) => {
      expect(linkedGestureBounds(linkedDoc(), 'video', mode, durationFor)).toEqual({
        minDelta,
        maxDelta,
      })
      // Whichever half owns the gesture, the group interval is identical.
      expect(linkedGestureBounds(linkedDoc(), 'audio', mode, durationFor)).toEqual({
        minDelta,
        maxDelta,
      })
    },
  )

  test('the shortest linked duration governs start-side shrinking', () => {
    const doc = linkedDoc(
      clip('video', 'video-asset', 100, 70, 11, 'link_bounds'),
      clip('audio', 'audio-asset', 35, 12, 2, 'link_bounds'),
    )

    expect(linkedGestureBounds(doc, 'video', 'trim-start', durationFor)).toEqual({
      minDelta: -2,
      maxDelta: 11,
    })
    expect(linkedGestureBounds(doc, 'video', 'ripple-start', durationFor)).toEqual({
      minDelta: -2,
      maxDelta: 11,
    })
  })

  test('unlinked clips retain their own interval and missing owners fail closed', () => {
    const doc = linkedDoc()
    delete doc.tracks[0].clips[0].linkGroupId
    delete doc.tracks[1].clips[0].linkGroupId

    expect(linkedGestureBounds(doc, 'video', 'move', durationFor)).toEqual({
      minDelta: -100,
      maxDelta: Number.POSITIVE_INFINITY,
    })
    expect(linkedGestureBounds(doc, 'missing', 'move', durationFor)).toEqual({
      minDelta: 0,
      maxDelta: 0,
    })
  })
})
