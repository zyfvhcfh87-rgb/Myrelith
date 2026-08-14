import { describe, expect, test } from 'vitest'
import type { Clip } from '../../domain/schema'
import {
  defaultSourceTimeMap,
  sourceTimeMapWithSpeedPoint,
  sourceTimeSpeedRateFromPercent,
} from '../../domain/sourceTimeMap'
import { clipAutomationMarkers, clipSpeedSegments } from './clipAutomationPlan'

function clip(): Clip {
  return {
    id: 'clip-automation',
    assetId: 'asset-1',
    name: 'automation.mp4',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 100 },
    sourceTimeMap: defaultSourceTimeMap(0, 100),
    timelineRange: { startFrame: 25, durationFrames: 100 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

describe('clip automation timeline planning', () => {
  test('merges ordinary and effect keys at each exact in-range frame', () => {
    const input = clip()
    input.animation = {
      tracks: [{
        property: 'scale-x',
        keyframes: [
          { frame: 10, value: 1, easing: { type: 'linear' } },
          { frame: 50, value: 2, easing: { type: 'linear' } },
        ],
      }],
      effectTracks: [{
        effectId: 'effect-1',
        parameter: 'amount',
        keyframes: [
          { frame: 50, value: 0.5, easing: { type: 'linear' } },
          { frame: 99, value: 1, easing: { type: 'linear' } },
          { frame: 100, value: 0, easing: { type: 'linear' } },
        ],
      }],
    }

    expect(clipAutomationMarkers(input)).toEqual([
      { frame: 10, kinds: ['property'] },
      { frame: 50, kinds: ['effect', 'property'] },
      { frame: 99, kinds: ['effect'] },
    ])
  })

  test('turns held speed boundaries into visible normal, slow, and fast sections', () => {
    const input = clip()
    let map = sourceTimeMapWithSpeedPoint(
      input.sourceTimeMap!,
      20,
      sourceTimeSpeedRateFromPercent(50),
      'hold',
    )
    map = sourceTimeMapWithSpeedPoint(
      map,
      40,
      sourceTimeSpeedRateFromPercent(100),
      'hold',
    )
    map = sourceTimeMapWithSpeedPoint(
      map,
      70,
      sourceTimeSpeedRateFromPercent(200),
      'hold',
    )
    input.sourceTimeMap = map

    expect(clipSpeedSegments(input)).toEqual([
      expect.objectContaining({ startFrame: 0, endFrame: 20, label: '100%', tone: 'normal' }),
      expect.objectContaining({ startFrame: 20, endFrame: 40, label: '50%', tone: 'slow' }),
      expect.objectContaining({ startFrame: 40, endFrame: 70, label: '100%', tone: 'normal' }),
      expect.objectContaining({ startFrame: 70, endFrame: 100, label: '200%', tone: 'fast' }),
    ])
  })
})
