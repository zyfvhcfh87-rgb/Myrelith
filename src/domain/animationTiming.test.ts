/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { mapAnimationTrackKeyframes } from './animationTiming'
import { shiftClipAnimation } from './clipAnimation'
import type { ClipAnimation, SourceTimeMap } from './schema'
import { retimeClipAnimation, shiftClipAnimationSourceTimeIntent } from './sourceTimeMap'

interface TimingBaseline {
  oldMap: SourceTimeMap
  newMaps: SourceTimeMap[]
  animations: ClipAnimation[]
  shiftSamples: { animationIndex: number; delta: number; expected: ClipAnimation | null }[]
  retimeSamples: { animationIndex: number; mapIndex: number; expected: ClipAnimation | null }[]
}
const baseline = JSON.parse(readFileSync(
  resolve('src/test/fixtures/animation-timing-baseline.json'), 'utf8',
)) as TimingBaseline

describe('value-independent animation timing', () => {
  test('preserves immutable typed payload and track metadata without interpreting strings', () => {
    const keyframes: readonly {
      readonly frame: number
      readonly sourceTimeTicks: number
      readonly value: string
      readonly extra: number
    }[] = Object.freeze([
      Object.freeze({ frame: 8, sourceTimeTicks: 80, value: 'future payload', extra: 7 }),
      Object.freeze({ frame: -2, sourceTimeTicks: -20, value: 'second payload', extra: 8 }),
    ])
    const input = [Object.freeze({
      identity: Object.freeze({ type: 'opaque-test', version: 9 }),
      keyframes,
    })]
    const mapped = mapAnimationTrackKeyframes(input, (key) => ({ ...key, frame: key.frame - 3 }))
    expect(mapped?.[0].identity).toBe(input[0].identity)
    expect(mapped?.[0].keyframes).toEqual([
      { frame: 5, sourceTimeTicks: 80, value: 'future payload', extra: 7 },
      { frame: -5, sourceTimeTicks: -20, value: 'second payload', extra: 8 },
    ])
    expect(input[0].keyframes[0].frame).toBe(8)
    expect(mapped?.[0].keyframes).not.toBe(input[0].keyframes)
  })

  test('sorts unique destinations per lane and rejects a collision without a partial result', () => {
    const input = [{ keyframes: [{ frame: 3, value: 'a' }, { frame: 1, value: 'b' }] },
      { keyframes: [{ frame: 3, value: 'c' }] }]
    expect(mapAnimationTrackKeyframes(input, (key) => ({ ...key }), 'sorted-unique'))
      .toEqual([{ keyframes: [{ frame: 1, value: 'b' }, { frame: 3, value: 'a' }] }, input[1]])
    expect(mapAnimationTrackKeyframes(input, (key) => ({ ...key, frame: 0 }), 'sorted-unique')).toBeNull()
    expect(mapAnimationTrackKeyframes(input, (key) => key.value === 'c' ? null : { ...key })).toBeNull()
    expect(input[0].keyframes.map((key) => key.frame)).toEqual([3, 1])
  })

  test('preserves all 36 frozen-master source reanchor and retime outcomes exactly', () => {
    for (const sample of baseline.shiftSamples) {
      const input = baseline.animations[sample.animationIndex]
      const before = JSON.stringify(input)
      expect(shiftClipAnimationSourceTimeIntent(input, baseline.oldMap, sample.delta),
        `shift ${sample.animationIndex} by ${sample.delta}`).toEqual(sample.expected)
      expect(JSON.stringify(input)).toBe(before)
    }
    for (const sample of baseline.retimeSamples) {
      const input = baseline.animations[sample.animationIndex]
      const before = JSON.stringify(input)
      expect(retimeClipAnimation(input, baseline.oldMap, baseline.newMaps[sample.mapIndex], 120),
        `retime ${sample.animationIndex} to map ${sample.mapIndex}`).toEqual(sample.expected)
      expect(JSON.stringify(input)).toBe(before)
    }
  })

  test('origin shifts retain source ticks, clone easing and reject unsafe frame growth', () => {
    const input = baseline.animations[1]
    const shifted = shiftClipAnimation(input, -4)
    expect(shifted?.tracks[0].keyframes.map((key) => key.frame)).toEqual([-9, -4, -1, 3, 86])
    expect(shifted?.effectTracks?.[0].keyframes[0].frame).toBe(-13)
    expect(shifted?.tracks[0].keyframes[0].easing).not.toBe(input.tracks[0].keyframes[0].easing)
    expect(shiftClipAnimation(input, 1_000_000_000)).toBeNull()
    expect(shiftClipAnimation(input, Number.MAX_SAFE_INTEGER)).toBeNull()
    expect(shiftClipAnimation(input, 0.5)).toBeNull()
  })
})
