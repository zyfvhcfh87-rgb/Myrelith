import { describe, expect, test } from 'vitest'
import { foundationProject, pathTrack, scalarKey } from '../test/animationFoundationFixtures'
import { createMaskEffect, DEFAULT_MASK_BEZIER_PATH } from './effectStack'
import { editMaskPathKeys, maskPathAnimationStatus } from './maskPathEditing'
import { editMaskParamsAtFrame, editMaskPathAnimation } from './maskEditing'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import { MASK_PATH_ANIMATION_LIMITS } from './maskPathAnimation'
import { defaultSourceTimeMap } from './sourceTimeMap'
import { expandedTitleProject } from '../test/titleOwnerFixtures'

const path = 'M 0 0 C 1 0 1 1 0 0 Z'
function fixture() {
  const project = foundationProject(), doc = project.sequences[0], clip = doc.tracks[0].clips[0]
  const effect = createMaskEffect('mask', 'bezier'); clip.effects = [effect]
  const target = { sequenceId: doc.id, clipId: clip.id, effectId: effect.id }
  return { project, doc, clip, effect, target }
}

describe('mask held path authoring', () => {
  test.each(['supported', 'future'] as const)('%s expanded titles preserve inactive mask keys and reject path authoring', (kind) => {
    const project = expandedTitleProject(), doc = project.sequences[0], clip = doc.tracks[0].clips[0]
    if (kind === 'future') clip.title = { version: 9, payload: 'Preserved title' }
    const effect = createMaskEffect('mask', 'bezier')
    clip.effects = [effect]
    clip.animation = { tracks: [], effectPathTracks: [pathTrack()] }
    const target = { sequenceId: doc.id, clipId: clip.id, effectId: effect.id }
    const before = JSON.stringify(project)
    expect(maskPathAnimationStatus(clip, effect).reason).toMatch(/stay static/)
    for (const operation of ['set', 'remove', 'clear'] as const) {
      expect(() => editMaskPathAnimation(project, target, 10, operation)).toThrow(/stay static/)
    }
    expect(() => editMaskParamsAtFrame(project, target, 10, { path })).toThrow(/stay static/)
    expect(resolveClipAnimationAtFrame(clip, 10).effects[0].params.path).toBe(DEFAULT_MASK_BEZIER_PATH)
    expect(JSON.stringify(project)).toBe(before)
  })

  test('explicit keys use target source ticks and hold; editing preserves static and opaque sibling intent', () => {
    const { project, clip, target } = fixture()
    clip.timelineRange.startFrame = 100; clip.sourceRange.startFrame = 200
    clip.sourceTimeMap = defaultSourceTimeMap(200, 60)
    const future = { property: 'future-opacity', propertyVersion: 8, keyframes: [scalarKey(0, 17)] }
    const orphan = { ...pathTrack('orphan'), valueVersion: 8 }
    clip.animation = { tracks: [future], effectPathTracks: [orphan] }
    const first = editMaskPathAnimation(project, target, 110, 'set')
    const firstClip = first.tracks[0].clips[0]
    expect(firstClip.animation?.effectPathTracks?.[1].keyframes).toEqual([
      { frame: 10, sourceTimeTicks: 210_000_000, value: DEFAULT_MASK_BEZIER_PATH, easing: { type: 'hold' } },
    ])
    const edited = editMaskParamsAtFrame({ ...project, sequences: [first] }, target, 120, { path, feather: 0.2 })
    const next = edited.tracks[0].clips[0]
    expect(next.effects[0].params).toMatchObject({ path: DEFAULT_MASK_BEZIER_PATH, feather: 0.2 })
    expect(next.animation?.tracks[0]).toBe(future)
    expect(next.animation?.effectPathTracks?.[0]).toBe(orphan)
    for (const frame of [100, 110, 119]) expect(resolveClipAnimationAtFrame(next, frame).effects[0].params.path).toBe(DEFAULT_MASK_BEZIER_PATH)
    for (const frame of [120, 130, 159]) expect(resolveClipAnimationAtFrame(next, frame).effects[0].params.path).toBe(path)
    expect(clip.animation.effectPathTracks).toEqual([orphan])
  })

  test('replacing occupied frames is bounded; removing the last key restores static fallback', () => {
    const { clip, effect } = fixture()
    clip.animation = editMaskPathKeys(clip, effect, { kind: 'set', frame: 5, value: path })
    expect(editMaskPathKeys(clip, effect, { kind: 'set', frame: 5, value: path })).toBe(clip.animation)
    expect(editMaskPathKeys(clip, effect, { kind: 'remove', frame: 6 })).toBe(clip.animation)
    const replaced = editMaskPathKeys(clip, effect, { kind: 'set', frame: 5, value: DEFAULT_MASK_BEZIER_PATH })
    expect(replaced.effectPathTracks?.[0].keyframes).toHaveLength(1)
    const removed = editMaskPathKeys(clip, effect, { kind: 'remove', frame: 5 })
    expect(removed.effectPathTracks).toEqual([])
    expect(resolveClipAnimationAtFrame({ ...clip, animation: removed }, 5).effects[0].params.path).toBe(DEFAULT_MASK_BEZIER_PATH)
  })

  test.each(['future-version', 'future-type', 'malformed', 'scalar'] as const)('%s intent refuses editing and clearing without rewriting bytes', (kind) => {
    const { project, clip, effect, target } = fixture()
    const track = pathTrack()
    if (kind === 'future-version') track.valueVersion = 2
    if (kind === 'future-type') track.valueType = 'future-shape'
    if (kind === 'malformed') track.keyframes[1].value = 'preserved malformed path'
    clip.animation = kind === 'scalar' ? { tracks: [], effectTracks: [{ effectId: effect.id, parameter: 'path', keyframes: [scalarKey(0, 4)] }] } : { tracks: [], effectPathTracks: [track] }
    const before = JSON.stringify(project)
    expect(maskPathAnimationStatus(clip, effect).reason).toBeTruthy()
    expect(() => editMaskPathKeys(clip, effect, { kind: 'set', frame: 5, value: path })).toThrow()
    expect(() => editMaskPathKeys(clip, effect, { kind: 'clear' })).toThrow()
    expect(() => editMaskParamsAtFrame(project, target, 5, { path })).toThrow()
    expect(JSON.stringify(project)).toBe(before)
  })

  test('dormant keys survive shape changes and new-path closure writes the held lane', () => {
    const { project, clip, effect, target } = fixture()
    effect.params.shape = 'rectangle'; clip.animation = { tracks: [], effectPathTracks: [pathTrack()] }
    expect(maskPathAnimationStatus(clip, effect)).toMatchObject({ dormant: true, reason: null })
    expect(() => editMaskPathAnimation(project, target, 10, 'set')).toThrow(/Bezier/)
    // The explicit path equals static fallback but differs from the dormant held key.
    const next = editMaskParamsAtFrame(project, target, 10, { shape: 'bezier', path: DEFAULT_MASK_BEZIER_PATH })
    expect(resolveClipAnimationAtFrame(next.tracks[0].clips[0], 10).effects[0].params.path).toBe(DEFAULT_MASK_BEZIER_PATH)
    expect(next.tracks[0].clips[0].animation?.effectPathTracks?.[0].keyframes[1].value).toBe(DEFAULT_MASK_BEZIER_PATH)
    const cleared = editMaskPathAnimation(project, target, 10, 'clear')
    expect(cleared.tracks[0].clips[0].effects[0]).toBe(effect)
    expect(cleared.tracks[0].clips[0].animation?.effectPathTracks).toEqual([])
  })

  test('track capacity permits replacement but rejects growth and invalid coordinates before mutation', () => {
    const { clip, effect } = fixture(), track = pathTrack()
    track.keyframes = Array.from({ length: MASK_PATH_ANIMATION_LIMITS.keysPerTrack }, (_, i) => ({ frame: i * 2, sourceTimeTicks: i * 2_000_000, value: path, easing: { type: 'hold' } }))
    clip.animation = { tracks: [], effectPathTracks: [track] }
    const before = JSON.stringify(clip)
    expect(() => editMaskPathKeys(clip, effect, { kind: 'set', frame: 1, value: path })).toThrow(/256/)
    expect(editMaskPathKeys(clip, effect, { kind: 'set', frame: 2, value: DEFAULT_MASK_BEZIER_PATH }).effectPathTracks?.[0].keyframes).toHaveLength(256)
    for (const frame of [NaN, 1.5, 1_000_000_001]) expect(() => editMaskPathKeys(clip, effect, { kind: 'set', frame, value: path })).toThrow(/integer/)
    expect(() => editMaskPathKeys(clip, effect, { kind: 'set', frame: 2, value: 'M 0 0 L 1 1 Z' })).toThrow()
    expect(JSON.stringify(clip)).toBe(before)
  })
})
