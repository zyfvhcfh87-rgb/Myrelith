import { describe, expect, test } from 'vitest'
import type { MulticamDefinition } from './schema'
import {
  createMulticamPlanner,
  multicamAudioSegments,
  rollMulticamCut,
  setMulticamCut,
} from './multicam'

function definition(): MulticamDefinition {
  return {
    id: 'concert-cameras',
    name: 'Concert cameras',
    durationFrames: 120,
    angles: [
      {
        id: 'wide',
        name: 'Wide',
        assetId: 'asset-wide',
        coverage: { startFrame: 0, durationFrames: 120 },
        sourceStartFrame: 300,
      },
      {
        id: 'close',
        name: 'Close',
        assetId: 'asset-close',
        coverage: { startFrame: 10, durationFrames: 100 },
        sourceStartFrame: 800,
      },
    ],
    switches: [
      { frame: 0, videoAngleId: 'wide' },
      { frame: 30, videoAngleId: 'close' },
    ],
    audioPolicy: { kind: 'fixed', angleId: 'wide' },
  }
}

describe('multicam definition planner seam', () => {
  test('switches video while fixed-master audio stays on its chosen angle', () => {
    const planner = createMulticamPlanner(definition())

    expect(planner.select(30)).toEqual({
      frame: 30,
      switchFrame: 30,
      video: {
        angleId: 'close',
        assetId: 'asset-close',
        sourceFrame: 820,
      },
      audio: {
        angleId: 'wide',
        assetId: 'asset-wide',
        sourceFrame: 330,
      },
      switchComparisons: 1,
    })
  })

  test('authors and changes an exact cut without retaining redundant switches', () => {
    const added = setMulticamCut(definition(), 70, 'wide')
    expect(added.switches).toEqual([
      { frame: 0, videoAngleId: 'wide' },
      { frame: 30, videoAngleId: 'close' },
      { frame: 70, videoAngleId: 'wide' },
    ])

    const changed = setMulticamCut(added, 30, 'wide')
    expect(changed.switches).toEqual([
      { frame: 0, videoAngleId: 'wide' },
    ])
  })

  test('rolls an existing cut only inside its neighbouring cut interval', () => {
    const rolled = rollMulticamCut(
      setMulticamCut(definition(), 70, 'wide'),
      30,
      45,
    )
    expect(rolled.switches).toEqual([
      { frame: 0, videoAngleId: 'wide' },
      { frame: 45, videoAngleId: 'close' },
      { frame: 70, videoAngleId: 'wide' },
    ])
    expect(() => rollMulticamCut(rolled, 45, 70)).toThrow(/neighbouring cuts/)
  })

  test('keeps missing follow-video coverage silent instead of repeating a sample', () => {
    const value = {
      ...definition(),
      audioPolicy: { kind: 'follow-video' as const },
    }
    expect(createMulticamPlanner(value).select(5)).toMatchObject({
      video: { angleId: 'wide', sourceFrame: 305 },
      audio: { angleId: 'wide', sourceFrame: 305 },
    })
    expect(multicamAudioSegments(value, 25, 115)).toEqual([
      {
        angleId: 'wide',
        assetId: 'asset-wide',
        startFrame: 25,
        endFrame: 30,
        sourceStartFrame: 325,
        sourceEndFrame: 330,
      },
      {
        angleId: 'close',
        assetId: 'asset-close',
        startFrame: 30,
        endFrame: 110,
        sourceStartFrame: 820,
        sourceEndFrame: 900,
      },
    ])
    expect(createMulticamPlanner(value).select(115)).toMatchObject({
      audio: { angleId: 'close', sourceFrame: null },
    })
  })

  test('selects among 32k authored switches with logarithmic comparisons', () => {
    const angles = Array.from({ length: 8 }, (_, index) => ({
      id: `angle-${index}`,
      name: `Angle ${index + 1}`,
      assetId: `asset-${index}`,
      coverage: { startFrame: 0, durationFrames: 40_000 },
      sourceStartFrame: 0,
    }))
    const switches = Array.from({ length: 32_768 }, (_, frame) => ({
      frame,
      videoAngleId: angles[frame % angles.length].id,
    }))
    const planner = createMulticamPlanner({
      id: 'large-switch-list',
      name: 'Eight angles',
      durationFrames: 40_000,
      angles,
      switches,
      audioPolicy: { kind: 'follow-video' },
    })

    const selected = planner.select(31_337)
    expect(selected.video.angleId).toBe(angles[31_337 % 8].id)
    expect(selected.switchComparisons).toBeLessThanOrEqual(16)
  })

  test('reuses one validated planner for audio-window resolution', () => {
    const value = definition()
    value.switches = [
      { frame: 0, videoAngleId: 'wide' },
      { frame: 60, videoAngleId: 'close' },
    ]
    value.audioPolicy = { kind: 'follow-video' }

    const planner = createMulticamPlanner(value)
    expect(planner.audioSegments(55, 65)).toEqual([
      expect.objectContaining({ angleId: 'wide', startFrame: 55, endFrame: 60 }),
      expect.objectContaining({ angleId: 'close', startFrame: 60, endFrame: 65 }),
    ])
    expect(planner.videoSegments(55, 65)).toEqual([
      expect.objectContaining({ angleId: 'wide', startFrame: 55, endFrame: 60 }),
      expect.objectContaining({ angleId: 'close', startFrame: 60, endFrame: 65 }),
    ])
  })
})
