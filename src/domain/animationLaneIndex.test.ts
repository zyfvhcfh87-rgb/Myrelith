import { describe, expect, test } from 'vitest'
import { buildAnimationLaneIndex, filterAnimationLanes, animationKeyGlyphs, animationCurvePoints, ANIMATION_VIEW_LIMITS } from './animationLaneIndex'
import { createAnimationSnapSession } from './animationSnapping'
import { createTimelineSnapIndex, timelineSnapNeighbors, resolveTimelineSnap, type TimelineSnapCandidate, type TimelineSnapMovingPoint } from './timelineSnapping'
import { foundationProject, scalarKey } from '../test/animationFoundationFixtures'
import { clipWithAnimationKeyframeCount } from '../test/animationBudgetFixtures'
import { isProceduralTitleClip } from './textOverlay'
import { readTitleClipElement } from './titleOwnership'
import { expandedTitleProject } from '../test/titleOwnerFixtures'

const context = { titles: { isTitleClip: isProceduralTitleClip, readElement: readTitleClipElement } }

describe('bounded animation view planning', () => {
  test('indexes 100,000 authored keys once; dense glyph queries preserve every visible key in bounded buckets', () => {
    const source = foundationProject().sequences[0]
    source.tracks[0].clips[0] = clipWithAnimationKeyframeCount(source.tracks[0].clips[0])
    const index = buildAnimationLaneIndex(source, context)
    expect(index.keyCount).toBe(100_000)
    const rows = filterAnimationLanes(index, { text: '', animatedOnly: true, kind: 'all' }).slice(0, ANIMATION_VIEW_LIMITS.rows)
    let glyphs = 0
    for (const row of rows) {
      const painted = animationKeyGlyphs(row, 0, 1024, Math.floor(ANIMATION_VIEW_LIMITS.glyphs / rows.length))
      glyphs += painted.length
      expect(painted.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(row.frames.length)
    }
    expect(glyphs).toBeLessThanOrEqual(512)
  })

  test('available title properties use the real owner adapter while stored title effects remain visibly unavailable', () => {
    const source = foundationProject().sequences[0], clip = expandedTitleProject().sequences[0].tracks[0].clips[0]
    source.tracks[0].clips = [clip]
    clip.animation = { tracks: [], effectTracks: [{ effectId: 'missing', parameter: 'amount', keyframes: [scalarKey(0, 0.4)] }] }
    const index = buildAnimationLaneIndex(source, context)
    expect(index.lanes.some((lane) => lane.address.kind === 'title' && lane.status === 'scalar')).toBe(true)
    expect(index.lanes.find((lane) => lane.address.kind === 'effect')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('title effect') })
    expect(index.lanes.filter((lane) => lane.address.kind === 'scalar').map((lane) => lane.label)).toEqual(['Opacity'])
  })

  test('dense range queries have bounded indexed reads and dense holds never acquire diagonal ramps', () => {
    const source = foundationProject().sequences[0]
    source.tracks[0].clips[0].animation = { tracks: [{ property: 'opacity', keyframes: Array.from({ length: 1024 }, (_, frame) => ({ ...scalarKey(frame, frame % 2 ? .8 : .2), easing: { type: 'hold' as const } })) }] }
    const row = buildAnimationLaneIndex(source, context).lanes.find((lane) => lane.frames.length)!
    let reads = 0
    const globalFrames = new Proxy(row.globalFrames, { get(target, property, receiver) { if (typeof property === 'string' && /^\d+$/.test(property)) reads++; return Reflect.get(target, property, receiver) } })
    expect(animationKeyGlyphs({ ...row, globalFrames }, 0, 1023, 12)).toHaveLength(12)
    expect(reads).toBeLessThan(350)
    const dense = animationCurvePoints(row, 0, 1023)
    expect(dense.dense).toBe(true); expect(dense.points.length).toBeLessThanOrEqual(256)
    for (let offset = 1; offset < dense.points.length; offset++) if (!dense.points[offset].move) expect(dense.points[offset].value).toBe(dense.points[offset - 1].value)
    expect(animationCurvePoints({ ...row, status: 'hold' }, 0, 1023).points).toEqual([])
    expect(animationCurvePoints({ ...row, status: 'unavailable' }, 0, 1023).points).toEqual([])
  })

  test('hold curves reach the old value at the boundary and start the new value without a diagonal ramp', () => {
    const source = foundationProject().sequences[0]
    source.tracks[0].clips[0].animation = { tracks: [{ property: 'opacity', keyframes: [{ ...scalarKey(0, 0.2), easing: { type: 'hold' } }, scalarKey(10, 0.8)] }] }
    const row = buildAnimationLaneIndex(source, context).lanes.find((lane) => lane.frames.length)!
    const { points } = animationCurvePoints(row, 0, 20)
    expect(points.length).toBeLessThanOrEqual(256)
    expect(points.filter((point) => point.frame === 10)).toEqual([{ frame: 10, value: 0.2, move: false }, { frame: 10, value: 0.8, move: true }])
    expect(points.filter((point) => point.frame > 0 && point.frame < 10).every((point) => point.value === 0.2 && !point.move)).toBe(true)
  })

  test('snapping excludes selected keys, uses the common eight-pixel resolver, and supports Alt bypass', () => {
    const source = foundationProject().sequences[0]
    source.tracks[0].clips[0].animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(10, 0.2), scalarKey(40, 0.8)] }] }
    const index = buildAnimationLaneIndex(source, context), row = index.lanes.find((lane) => lane.frames.length)!
    const session = createAnimationSnapSession(index, [{ lane: row.address, frame: 10 }], 100)
    expect(session.resolve(28, 2, false)).toMatchObject({ deltaFrames: 30, guide: { frame: 40, candidateKind: 'keyframe' } })
    expect(session.resolve(28, 2, true)).toMatchObject({ deltaFrames: 28, guide: null })
    expect(session.resolve(1, 2, false)).toMatchObject({ deltaFrames: 1, guide: null })
  })

  test('indexed snapping matches exhaustive ranking and checks at most six neighbors across dense candidates and delta bounds', () => {
    const candidates: TimelineSnapCandidate[] = Array.from({ length: 10_000 }, (_, index) => ({ id: `key-${index}`, kind: index % 3 ? 'keyframe' : 'marker', frame: Math.floor(index / 5), label: 'Key', trackId: 'track', trackKind: index % 2 ? 'video' : null, trackIndex: index % 4 }))
    const candidateIndex = createTimelineSnapIndex(candidates)
    for (const frame of [0, 20, 50, 999, 2000]) for (const direction of [1, -1] as const) {
      const point: TimelineSnapMovingPoint = { id: 'moving', kind: 'cursor', frame, deltaDirection: direction, trackKind: 'video', trackIndex: 0 }
      expect(timelineSnapNeighbors(candidateIndex, point).length).toBeLessThanOrEqual(6)
      const options = { candidates, movingPoints: [point], rawDeltaFrames: 5, minDeltaFrames: 6, maxDeltaFrames: 9, zoom: 2 }
      expect(resolveTimelineSnap({ ...options, candidateIndex })).toEqual(resolveTimelineSnap(options))
    }
  })
})
