import { describe, expect, test } from 'vitest'
import type { MulticamDefinition, MulticamInstance } from '../domain/schema'
import {
  createMulticamInstancePresentation,
  multicamInstanceVisibleRange,
} from './multicamPresentation'

describe('multicam state projection', () => {
  test('compiles one definition and keeps playhead lookups logarithmic', () => {
    const switches = Array.from({ length: 32_768 }, (_, frame) => ({
      frame,
      videoAngleId: frame % 2 === 0 ? 'wide' : 'close',
    }))
    const definition: MulticamDefinition = {
      id: 'concert',
      name: 'Concert',
      durationFrames: 32_768,
      angles: [
        {
          id: 'wide',
          name: 'Wide',
          assetId: 'wide-asset',
          coverage: { startFrame: 0, durationFrames: 32_768 },
          sourceStartFrame: 0,
        },
        {
          id: 'close',
          name: 'Close',
          assetId: 'close-asset',
          coverage: { startFrame: 0, durationFrames: 32_768 },
          sourceStartFrame: 0,
        },
      ],
      switches,
      audioPolicy: { kind: 'follow-video' },
    }
    const instance: MulticamInstance = {
      kind: 'multicam',
      id: 'concert-instance',
      name: 'Concert',
      multicamId: definition.id,
      sourceStartFrame: 0,
      timelineRange: { startFrame: 100, durationFrames: 32_768 },
    }

    const presentation = createMulticamInstancePresentation(definition, instance)
    expect(presentation.atPlayhead(32_867)).toEqual({
      inside: true,
      definitionFrame: 32_767,
      selectedAngleId: 'close',
      switchFrame: 32_767,
      switchComparisons: 15,
    })
    expect(presentation.atPlayhead(32_868)).toMatchObject({
      inside: false,
      definitionFrame: 32_767,
    })
    expect(multicamInstanceVisibleRange(instance, 110, 120)).toEqual({
      startFrame: 110,
      endFrame: 120,
    })
  })
})
