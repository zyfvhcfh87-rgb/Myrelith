import { describe, expect, test } from 'vitest'
import { foundationProject, pathTrack, scalarKey, ATTRIBUTE_ASSET_DESCRIPTOR, animationCatalog, PLUGIN_ANIMATION_EFFECT_TYPE } from '../test/animationFoundationFixtures'
import { clipAnimationKeyframeCount, clipAnimationValidationError, cloneClipAnimation, remapEffectAnimationIds, resolveClipAnimationAtFrame, shiftClipAnimation, upsertAnimationKeyframe } from './clipAnimation'
import { animationWithSourceTimeIntent, defaultSourceTimeMap, reanchorProceduralAnimation, retimeClipAnimation } from './sourceTimeMap'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from './projectFile'
import { createMaskEffect } from './effectStack'
import { duplicateProjectSequence, sequenceProjectWithinEditBudget } from './projectSequences'
import { bindPluginAnimationParameter } from './animationParameterBinding'
import { resolveVideoEffectStagePlan } from './pluginVideoEffectStagePlan'
import { resolveScalarAnimationProperty, resolveTitleElementAnimation } from './animationPropertyCatalog'
import { defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { defaultTextProps } from './textOverlay'
import type { ClipAnimation } from './schema'
import type { TitleTextElementV1 } from './titleElements'
import { certifyProjectCropAnimation } from './projectCropAnimation'
import { maskPathAnimationSnapshotBudget } from './maskPathAnimation'

function allTracks(): ClipAnimation {
  return {
    tracks: [{ property: 'future-opacity', propertyVersion: 7, keyframes: [scalarKey(0, -100), scalarKey(10, 50)] }],
    effectTracks: [{ effectId: 'color', parameter: 'future', keyframes: [scalarKey(0, 3)] }],
    titleTracks: [{ elementId: 'orphan-element', property: 'future-shape', propertyVersion: 3, keyframes: [scalarKey(0, -3), scalarKey(10, 8)] }],
    effectPathTracks: [pathTrack()],
  }
}

describe('schema22 canonical animation foundation', () => {
  test('clones, counts, shifts, reanchors and remaps every typed lane without changing values', () => {
    const source = allTracks(), before = JSON.stringify(source)
    const clone = cloneClipAnimation(source)
    expect(clone).toEqual(source)
    expect(clone.titleTracks?.[0]).not.toBe(source.titleTracks?.[0])
    expect(clipAnimationKeyframeCount(source)).toBe(7)
    const shifted = shiftClipAnimation(source, -5)!
    expect(shifted.titleTracks?.[0].keyframes.map((key) => key.frame)).toEqual([-5, 5])
    expect(shifted.effectPathTracks?.[0].keyframes[0]).toMatchObject({ frame: -5, sourceTimeTicks: 0, value: source.effectPathTracks![0].keyframes[0].value })
    const titleTime = reanchorProceduralAnimation(shifted)
    expect(titleTime.titleTracks?.[0].keyframes[0].sourceTimeTicks).toBe(-5_000_000)
    expect(titleTime.effectPathTracks?.[0].keyframes[0].sourceTimeTicks).toBe(-5_000_000)
    const remapped = remapEffectAnimationIds(source, new Map([['mask', 'new-mask']]))
    expect(remapped.effectPathTracks?.[0].effectId).toBe('new-mask')
    expect(remapped.titleTracks).toEqual(source.titleTracks)
    expect(JSON.stringify(source)).toBe(before)
  })

  test('preserves absent optional collections and explicit implicit-version metadata', () => {
    const legacy: ClipAnimation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.5)] }], effectTracks: [] }
    for (const value of [cloneClipAnimation(legacy), shiftClipAnimation(legacy, 0)!, animationWithSourceTimeIntent(legacy, defaultSourceTimeMap(0, 60))]) {
      expect(JSON.stringify(value)).toBe(JSON.stringify(legacy))
      expect(Object.hasOwn(value, 'titleTracks')).toBe(false)
      expect(Object.hasOwn(value, 'effectPathTracks')).toBe(false)
      expect(Object.hasOwn(value.tracks[0], 'propertyVersion')).toBe(false)
    }
    const explicit = { tracks: [{ ...legacy.tracks[0], propertyVersion: 1 }], effectTracks: [] }
    expect(upsertAnimationKeyframe(explicit, 'opacity', scalarKey(5, 0.7))!.tracks[0].propertyVersion).toBe(1)
  })

  test('preserves a future property version but refuses competing current tracks or numeric reinterpretation', () => {
    const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
    clip.animation = { tracks: [{ property: 'opacity', propertyVersion: 2, keyframes: [scalarKey(0, 25)] }], effectTracks: [] }
    expect(clipAnimationValidationError(clip.animation)).toBeNull()
    expect(resolveClipAnimationAtFrame(clip, 0).opacity).toBe(1)
    expect(upsertAnimationKeyframe(clip.animation, 'opacity', scalarKey(0, 0.4))).toBeNull()
    expect(clipAnimationValidationError({ ...clip.animation, tracks: [...clip.animation.tracks, { property: 'opacity', keyframes: [scalarKey(0, 0.5)] }] })).toMatch(/duplicate/)
    expect(resolveScalarAnimationProperty({ kind: 'clip', clip, trackKind: 'video', property: 'opacity', propertyVersion: 2 }).status).toBe('unavailable')
  })

  test('uses semantic target tuples even when ids contain separators, and rejects scalar/path competition', () => {
    const scalar: ClipAnimation = { tracks: [], effectTracks: [
      { effectId: 'a\u0000b', parameter: 'c', keyframes: [scalarKey(0, 1)] },
      { effectId: 'a', parameter: 'b\u0000c', keyframes: [scalarKey(0, 1)] },
    ] }
    expect(clipAnimationValidationError(scalar)).toBeNull()
    expect(clipAnimationValidationError({ tracks: [], effectTracks: [{ effectId: 'mask', parameter: 'path', keyframes: [scalarKey(0, 1)] }], effectPathTracks: [pathTrack()] })).toMatch(/compete/)
    const titles = allTracks().titleTracks!
    expect(clipAnimationValidationError({ tracks: [], titleTracks: [titles[0], { ...titles[0], propertyVersion: 4 }] })).toMatch(/duplicate/)
    expect(maskPathAnimationSnapshotBudget({ tracks: [pathTrack('dangling'), pathTrack('dangling')] }).ok).toBe(true)
  })

  test('rejects a retime collision in a path lane atomically with scalar/title intent intact', () => {
    const source = allTracks()
    source.effectPathTracks![0].keyframes[1] = { ...source.effectPathTracks![0].keyframes[1], frame: 1, sourceTimeTicks: 1_000_000 }
    const before = JSON.stringify(source)
    const oldMap = defaultSourceTimeMap(0, 60), fastMap = { ...oldMap, rate: { numerator: 4, denominator: 1 } }
    expect(retimeClipAnimation(source, oldMap, fastMap, 15)).toBeNull()
    expect(JSON.stringify(source)).toBe(before)
  })

  test('round-trips future/title/path data across dormant sequences and duplicates path effect ids', () => {
    const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
    clip.animation = allTracks()
    clip.effects = [createMaskEffect('mask', 'bezier')]
    let id = 0
    const duplicate = duplicateProjectSequence(project, project.rootSequenceId, 'Duplicate', () => `new-${++id}`)
    expect(duplicate.failure).toBeNull()
    const copied = duplicate.project.sequences[1].tracks[0].clips[0]
    expect(copied.animation?.effectPathTracks?.[0].effectId).toBe(copied.effects[0].id)
    const snapshot = createProjectFileSnapshot(duplicate.project, [ATTRIBUTE_ASSET_DESCRIPTOR])
    const encoded = serializeProjectFile(snapshot), reopened = parseProjectFile(encoded)
    expect(serializeProjectFile(reopened)).toBe(encoded)
    expect(reopened.sequences[1].tracks[0].clips[0].animation?.titleTracks).toEqual(clip.animation.titleTracks)
  })

  test('resolves held mask keys through the same clip result without rebasing for crop', () => {
    const clip = foundationProject().sequences[0].tracks[0].clips[0]
    clip.effects = [createMaskEffect('mask', 'bezier')]
    clip.animation = { tracks: [{ property: 'crop-left', keyframes: [scalarKey(0, 0.1), scalarKey(20, 0.3)] }], effectPathTracks: [pathTrack()] }
    expect(resolveClipAnimationAtFrame(clip, 9).effects[0].params.path).toBe(pathTrack().keyframes[0].value)
    const resolved = resolveClipAnimationAtFrame(clip, 10)
    expect(resolved.effects[0].params.path).toBe(pathTrack().keyframes[1].value)
    expect(resolved.visual?.crop.left).toBeCloseTo(0.2, 12)
    expect(clip.visual?.crop.left).toBe(0)
    clip.animation.effectPathTracks![0].keyframes[1].value = 'future malformed path'
    expect(resolveClipAnimationAtFrame(clip, 10).effects[0].params.path).toBe(clip.effects[0].params.path)
  })

  test('rejects unsafe crops consumed only by a transition handle in a dormant sequence', () => {
    const project = foundationProject(), doc = project.sequences[0], from = doc.tracks[0].clips[0]
    const to = structuredClone(from); to.id = 'to'; to.timelineRange.startFrame = 60
    from.animation = { tracks: [
      { property: 'crop-left', keyframes: [{ ...scalarKey(0, 0.2), easing: { type: 'hold' } }, scalarKey(60, 0.8)] },
      { property: 'crop-right', keyframes: [scalarKey(0, 0.3)] },
    ], effectTracks: [] }
    doc.tracks[0].clips.push(to)
    expect(certifyProjectCropAnimation(project).ok).toBe(true)
    doc.tracks[0].transitions = [{ id: 'fade', type: 'crossfade', fromClipId: from.id, toClipId: to.id, durationFrames: 4, audio: { enabled: false, curve: 'linear' } }]
    const root = foundationProject().sequences[0]; root.id = 'empty-root'; root.tracks = []
    project.sequences.unshift(root); project.rootSequenceId = root.id
    expect(certifyProjectCropAnimation(project)).toMatchObject({ ok: false, reason: 'unsafe-crop', frame: 60 })
    expect(sequenceProjectWithinEditBudget(project)).toBe(false)
    expect(() => createProjectFileSnapshot(project, [ATTRIBUTE_ASSET_DESCRIPTOR])).toThrow(/crop/)
  })

  test('title adapters share scalar evaluation and honor padding-exclusive bounds', () => {
    const { fontFamily, ...text } = defaultTextProps(1920, 1080, 'Title')
    const element: TitleTextElementV1 = { id: 'element', version: 1, kind: 'text', name: 'Text', enabled: true, transform: defaultClipTransform(), visual: defaultClipVisualSettings(), opacity: 1, text: { ...text, paddingPx: 20 }, font: { family: fontFamily, fallbackFamily: null } }
    const tracks = [{ elementId: element.id, property: 'position-x', propertyVersion: 1, keyframes: [scalarKey(0, 0), scalarKey(10, 100)] }]
    expect(resolveTitleElementAnimation(element, tracks, 5).element.transform.x).toBe(50)
    const invalid = [{ elementId: element.id, property: 'box-width', propertyVersion: 1, keyframes: [scalarKey(0, 40)] }]
    expect(resolveTitleElementAnimation(element, invalid, 0).element).toBe(element)
    expect(resolveTitleElementAnimation(element, invalid, 0).unavailable).not.toHaveLength(0)
  })

  test('plugin keys stay unverified until explicit binding, then become unavailable after package drift', () => {
    const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
    clip.effects = [{ id: 'plugin', type: PLUGIN_ANIMATION_EFFECT_TYPE, version: 1, enabled: true, params: { amount: 0.2 } }]
    clip.animation = { tracks: [], effectTracks: [{ effectId: 'plugin', parameter: 'amount', keyframes: [scalarKey(0, 0), scalarKey(10, 1)] }] }
    const catalog = animationCatalog()
    expect(resolveVideoEffectStagePlan(clip, 5, catalog)?.stages[0]).toMatchObject({ detail: expect.stringContaining('unverified'), execution: { parameterRecord: { amount: 0.2 } } })
    const result = bindPluginAnimationParameter(project, project.rootSequenceId, clip.id, 'plugin', 'amount', catalog.declarations[0])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const bound = result.project.sequences[0].tracks[0].clips[0]
    expect(resolveVideoEffectStagePlan(bound, 5, catalog)?.stages[0]).toMatchObject({ execution: { parameterRecord: { amount: 0.5 } } })
    expect(resolveVideoEffectStagePlan(bound, 5, animationCatalog(2, '3'))?.stages[0]).toMatchObject({ detail: expect.stringContaining('does not match'), execution: { parameterRecord: { amount: 0.2 } } })
    expect(clip.animation.effectTracks![0].parameterIdentity).toBeUndefined()
  })
})
