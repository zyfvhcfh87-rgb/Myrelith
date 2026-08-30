import { describe, expect, test, vi } from 'vitest'
import {
  addAdjustmentEffect,
  adjustmentEditDeltaBounds,
  clearAdjustmentOpacityAnimation,
  createAdjustmentItem,
  duplicateAdjustment,
  findAdjustment,
  insertAdjustment,
  moveAdjustment,
  resolveAdjustmentAtFrame,
  setAdjustmentEnabled,
  setAdjustmentOpacityAtFrame,
  setAdjustmentOpacityKeyframe,
  splitAdjustmentAtFrame,
  trimAdjustment,
  updateAdjustmentEffectParamsAtFrame,
} from './adjustmentItems'
import {
  createColorAdjustEffect,
  createMaskEffect,
  resolvePostCompositeEffectStack,
} from './effectStack'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import type { Clip, TimelineDoc } from './schema'
import { defaultClipAudioSettings, defaultClipVisualSettings } from './clipInspector'
import { defaultSourceTimeMap } from './sourceTimeMap'

function doc(): TimelineDoc {
  const base = createTimelineDoc('Adjustments', DEFAULT_PROJECT_SETTINGS, 'doc-adjustments')
  return structuredClone(base)
}

function clip(id: string, startFrame: number, durationFrames: number): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    sourceTimeMap: defaultSourceTimeMap(0, durationFrames),
    timelineRange: { startFrame, durationFrames },
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
    blendMode: 'normal',
    volume: 1,
    lensCorrection: null,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: { tracks: [], effectTracks: [] },
    effects: [],
  }
}

describe('bounded adjustment timeline items', () => {
  test('inserts only on an unlocked video gap without inventing media fields', () => {
    const start = doc()
    start.tracks[0]!.clips.push(clip('lower', 0, 20))
    const item = createAdjustmentItem(20, 10, 'Scene grade')
    const inserted = insertAdjustment(start, 'V1', item)

    expect(findAdjustment(inserted, item.id)).toEqual(item)
    expect(findAdjustment(inserted, item.id)).not.toHaveProperty('assetId')
    expect(findAdjustment(inserted, item.id)).not.toHaveProperty('sourceRange')
    expect(findAdjustment(inserted, item.id)).not.toHaveProperty('volume')
    expect(insertAdjustment(start, 'V1', { ...item, timelineRange: { startFrame: 10, durationFrames: 10 } }))
      .toBe(start)
    expect(insertAdjustment(start, 'A1', item)).toBe(start)
  })

  test('moves and trims within exact neighboring clip/adjustment bounds', () => {
    const start = doc()
    start.tracks[0]!.clips.push(clip('before', 0, 10), clip('after', 40, 10))
    const item = createAdjustmentItem(20, 10)
    const inserted = insertAdjustment(start, 'V1', item)

    expect(adjustmentEditDeltaBounds(inserted, item.id, 'move')).toEqual({ min: -10, max: 10 })
    expect(moveAdjustment(inserted, item.id, 'V1', 10).tracks[0]!.adjustments?.[0]
      ?.timelineRange).toEqual({ startFrame: 10, durationFrames: 10 })
    expect(moveAdjustment(inserted, item.id, 'V1', 5)).toBe(inserted)
    expect(trimAdjustment(inserted, item.id, 'start', -10).tracks[0]!.adjustments?.[0]
      ?.timelineRange).toEqual({ startFrame: 10, durationFrames: 20 })
    expect(trimAdjustment(inserted, item.id, 'end', 11)).toBe(inserted)
  })

  test('splits and duplicates with fresh item/effect identities and one local animation origin', () => {
    let start = doc()
    const item = createAdjustmentItem(10, 20)
    item.effects = [createColorAdjustEffect('fx-grade')]
    item.animation = {
      tracks: [{
        property: 'opacity',
        keyframes: [
          { frame: 0, value: 0, easing: { type: 'linear' } },
          { frame: 10, value: 1, easing: { type: 'linear' } },
        ],
      }],
      effectTracks: [],
    }
    start = insertAdjustment(start, 'V1', item)
    const split = splitAdjustmentAtFrame(start, item.id, 20)
    const [left, right] = split.tracks[0]!.adjustments!

    expect(left.id).toBe(item.id)
    expect(left.timelineRange).toEqual({ startFrame: 10, durationFrames: 10 })
    expect(right.timelineRange).toEqual({ startFrame: 20, durationFrames: 10 })
    expect(right.id).not.toBe(left.id)
    expect(right.effects[0]!.id).not.toBe(left.effects[0]!.id)
    expect(right.animation.tracks[0]!.keyframes.map((key) => key.frame)).toEqual([-10, 0])

    const duplicated = duplicateAdjustment(split, right.id, 40)
    expect(duplicated.tracks[0]!.adjustments).toHaveLength(3)
    expect(new Set(duplicated.tracks[0]!.adjustments!.map((candidate) => candidate.id)).size)
      .toBe(3)
  })

  test('supports bounded opacity/effect animation without source-time intent', () => {
    let start = doc()
    const item = createAdjustmentItem(10, 20)
    start = insertAdjustment(start, 'V1', item)
    start = setAdjustmentOpacityKeyframe(start, item.id, {
      frame: 0,
      value: 0,
      easing: { type: 'linear' },
    })
    start = setAdjustmentOpacityKeyframe(start, item.id, {
      frame: 10,
      value: 1,
      easing: { type: 'linear' },
    })
    start = setAdjustmentOpacityAtFrame(start, item.id, 15, 0.75)
    const animated = findAdjustment(start, item.id)!

    expect(animated.animation.tracks[0]!.keyframes.every(
      (keyframe) => !Object.prototype.hasOwnProperty.call(keyframe, 'sourceTimeTicks'),
    )).toBe(true)
    expect(resolveAdjustmentAtFrame(animated, 15).opacity).toBe(0.75)
    expect(clearAdjustmentOpacityAnimation(start, item.id).tracks[0]!.adjustments?.[0]
      ?.animation.tracks).toEqual([])
  })

  test('admits only declared post-composite effects while preserving unknown/source stages', () => {
    let start = doc()
    const item = createAdjustmentItem(0, 20)
    start = insertAdjustment(start, 'V1', item)
    const color = createColorAdjustEffect('fx-color')
    start = addAdjustmentEffect(start, item.id, color)
    expect(findAdjustment(start, item.id)?.effects).toHaveLength(1)
    expect(addAdjustmentEffect(start, item.id, createMaskEffect('fx-mask', 'rectangle')))
      .toBe(start)

    const imported = {
      ...findAdjustment(start, item.id)!,
      effects: [
        color,
        createMaskEffect('fx-preserved-mask', 'rectangle'),
        { id: 'fx-future', type: 'future.grade', version: 7, enabled: true, params: {} },
      ],
    }
    const resolution = resolvePostCompositeEffectStack(imported.effects, true)
    expect(resolution.effects.map((effect) => effect.status)).toEqual([
      'ready',
      'unsupported',
      'unsupported',
    ])
    expect(resolution.pixelEffects).toHaveLength(0)
  })

  test('animates supported color parameters at the exact local frame', () => {
    let start = doc()
    const item = createAdjustmentItem(10, 20)
    const color = createColorAdjustEffect('fx-color')
    start = insertAdjustment(start, 'V1', item)
    start = addAdjustmentEffect(start, item.id, color)
    const withTrack = structuredClone(start)
    withTrack.tracks[0]!.adjustments![0]!.animation.effectTracks.push({
      effectId: color.id,
      parameter: 'contrast',
      keyframes: [
        { frame: 0, value: 0, easing: { type: 'linear' } },
        { frame: 10, value: 1, easing: { type: 'linear' } },
      ],
    })
    const updated = updateAdjustmentEffectParamsAtFrame(
      withTrack,
      item.id,
      color.id,
      15,
      { contrast: 0.75 },
    )
    expect(resolveAdjustmentAtFrame(findAdjustment(updated, item.id)!, 15)
      .effects[0]!.params.contrast).toBe(0.75)
  })

  test('bypass is idempotent and rejected edits retain the exact document reference', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let start = doc()
    const item = createAdjustmentItem(0, 10)
    start = insertAdjustment(start, 'V1', item)
    const disabled = setAdjustmentEnabled(start, item.id, false)
    expect(disabled).not.toBe(start)
    expect(setAdjustmentEnabled(disabled, item.id, false)).toBe(disabled)
    expect(trimAdjustment(disabled, item.id, 'end', -10)).toBe(disabled)
  })
})
