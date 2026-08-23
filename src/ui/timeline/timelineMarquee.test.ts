import { describe, expect, test } from 'vitest'
import {
  marqueeRectFromPoints,
  selectedClipIdsInMarquee,
} from './timelineMarquee'

describe('timeline marquee geometry', () => {
  test('normalizes every drag direction into one positive rectangle', () => {
    expect(marqueeRectFromPoints({ x: 90, y: 70 }, { x: 20, y: 10 })).toEqual({
      left: 20,
      top: 10,
      right: 90,
      bottom: 70,
      width: 70,
      height: 60,
    })
  })

  test('selects intersecting selectable clips in candidate order', () => {
    const marquee = marqueeRectFromPoints({ x: 15, y: 15 }, { x: 75, y: 75 })

    expect(selectedClipIdsInMarquee(marquee, [
      { clipId: 'outside', rect: { left: 0, top: 0, right: 10, bottom: 10 } },
      { clipId: 'first', rect: { left: 10, top: 10, right: 30, bottom: 30 } },
      { clipId: 'locked', selectable: false, rect: { left: 20, top: 20, right: 40, bottom: 40 } },
      { clipId: 'second', rect: { left: 70, top: 70, right: 100, bottom: 100 } },
      { clipId: 'edge-only', rect: { left: 75, top: 20, right: 90, bottom: 40 } },
    ])).toEqual(['first', 'second'])
  })

  test('a zero-area empty-lane click selects nothing', () => {
    const marquee = marqueeRectFromPoints({ x: 20, y: 20 }, { x: 20, y: 20 })
    expect(selectedClipIdsInMarquee(marquee, [
      { clipId: 'A', rect: { left: 10, top: 10, right: 30, bottom: 30 } },
    ])).toEqual([])
  })
})
