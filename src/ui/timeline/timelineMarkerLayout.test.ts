import { describe, expect, test } from 'vitest'
import type { TimelineMarker } from '../../domain/schema'
import { planTimelineMarkerClusters } from './timelineMarkerLayout'

function markers(count: number, sameFrame = false): TimelineMarker[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `marker-${String(index).padStart(5, '0')}`,
    frame: sameFrame ? 10_000 : index,
    label: `Marker ${index}`,
    color: 'yellow',
  }))
}

describe('timeline marker viewport plan', () => {
  test('bounds a 20k visible marker set by pixel clusters', () => {
    const plan = planTimelineMarkerClusters(
      markers(20_000),
      0,
      1,
      0,
      1_000,
      null,
    )
    expect(plan.length).toBeLessThanOrEqual(Math.ceil(1_000 / 14) + 1)
    expect(plan.flatMap(({ markers: grouped }) => grouped).length).toBeGreaterThan(900)
  })

  test('collapses equal-frame markers and promotes the selected representative', () => {
    const plan = planTimelineMarkerClusters(
      markers(20_000, true),
      0,
      1,
      9_900,
      10_100,
      'marker-10000',
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].markers).toHaveLength(20_000)
    expect(plan[0].representative.id).toBe('marker-10000')
  })

  test('binary-searches a narrow far-frame window', () => {
    const plan = planTimelineMarkerClusters(
      markers(20_000),
      10_000,
      2,
      0,
      200,
      null,
    )
    expect(plan[0].markers[0].frame).toBe(10_000)
    expect(plan.at(-1)?.markers.at(-1)?.frame).toBeLessThanOrEqual(10_100)
  })
})
