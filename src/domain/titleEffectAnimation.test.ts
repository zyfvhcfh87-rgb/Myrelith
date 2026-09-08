import { describe, expect, test } from 'vitest'
import { titleEffectAnimationParameterSpec } from './titleEffectAnimation'
import { createColorAdjustEffect, createMaskEffect, createChromaKeyEffect, registeredEffects } from './effectStack'
import { expandedTitleProject, legacyTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import { scalarKey } from '../test/animationFoundationFixtures'
import { setEffectKeyframe, animationEditLocationResult } from './operations/animation'
import { updateEffectParamsAtFrame } from './operations/effects'
import { upgradeLegacyTextTitle } from './titleUpgrade'
import { editColorGradingParams } from './colorGradingParameterEdit'
import { COLOR_CURVES_TYPE, DEFAULT_COLOR_CURVES } from './colorCurves'

describe('completed title effect animation', () => {
  test('admits only exact registered post-composite numeric parameters on supported expanded owners', () => {
    const clip = expandedTitleProject().sequences[0].tracks[0].clips[0]
    for (const registration of registeredEffects()) {
      const effect = { id: 'effect', type: registration.type, version: registration.version, enabled: true, params: { ...registration.defaultParams } }
      for (const [parameter, spec] of Object.entries(registration.animatableParams)) {
        expect(titleEffectAnimationParameterSpec(clip, effect, parameter)).toEqual(registration.surfaces.includes('post-composite') ? spec : null)
        expect(titleEffectAnimationParameterSpec(clip, { ...effect, version: 99 }, parameter)).toBeNull()
      }
      expect(titleEffectAnimationParameterSpec(clip, effect, 'future-parameter')).toBeNull()
    }
    const color = createColorAdjustEffect('color')
    expect(titleEffectAnimationParameterSpec(legacyTitleProject().sequences[0].tracks[0].clips[0], color, 'exposure')).toBeNull()
    expect(titleEffectAnimationParameterSpec({ ...clip, title: { version: 9 } }, color, 'exposure')).toBeNull()
    expect(titleEffectAnimationParameterSpec({ ...clip, title: { version: 1, elements: [] } }, color, 'exposure')).toBeNull()
    expect(titleEffectAnimationParameterSpec(clip, { ...color, type: 'plugin:example/effect' }, 'exposure')).toBeNull()
  })

  test('existing authoring helpers and actual resolution agree without opening geometric framing', () => {
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, effects: [createColorAdjustEffect('color')] }))
    const before = project.sequences[0]
    const keyed = setEffectKeyframe(before, 'root-text', 'color', 'exposure', scalarKey(0, 0))
    const end = setEffectKeyframe(keyed, 'root-text', 'color', 'exposure', scalarKey(10, 1))
    expect(end).not.toBe(keyed)
    expect(resolveClipAnimationAtFrame(end.tracks[0].clips[0], 5).effects[0].params.exposure).toBe(0.5)
    const edited = updateEffectParamsAtFrame(end, 'root-text', 'color', 5, { exposure: 0.75 })
    expect(resolveClipAnimationAtFrame(edited.tracks[0].clips[0], 5).effects[0].params.exposure).toBe(0.75)
    expect(edited.tracks[0].clips[0].animation?.effectTracks?.[0].keyframes[1]).toMatchObject({ frame: 5, sourceTimeTicks: 5_000_000 })
    expect(animationEditLocationResult(edited, 'root-text').ok).toBe(false)
    const future = { ...edited, tracks: edited.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip, title: { version: 9 } })) })) }
    expect(setEffectKeyframe(future, 'root-text', 'color', 'exposure', scalarKey(6, 1))).toBe(future)
    expect(updateEffectParamsAtFrame(future, 'root-text', 'color', 5, { exposure: 0.2, contrast: 0.2 })).toBe(future)
    expect(resolveClipAnimationAtFrame(future.tracks[0].clips[0], 5).effects[0].params.exposure).toBe(0)
  })

  test('stored unavailable effect lanes remain intact and inactive', () => {
    const source = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const mask = createMaskEffect('mask', 'rectangle'), chroma = createChromaKeyEffect('chroma')
    const clip = { ...source, effects: [mask, chroma], animation: { tracks: [], effectTracks: [
      { effectId: 'mask', parameter: 'x', keyframes: [scalarKey(0, 0.8)] },
      { effectId: 'chroma', parameter: 'tolerance', keyframes: [scalarKey(0, 0.8)] },
    ] } }
    const resolved = resolveClipAnimationAtFrame(clip, 5)
    expect(resolved.effects).toBe(clip.effects)
    expect(resolved.animation).toBe(clip.animation)
  })

  test('an actual legacy upgrade preserves safe animated effect resolution at arbitrary seeks', () => {
    const legacy = replaceFirstTitleClip(legacyTitleProject(), (clip) => ({ ...clip, effects: [createColorAdjustEffect('color')], animation: { tracks: [], effectTracks: [
      { effectId: 'color', parameter: 'exposure', keyframes: [scalarKey(0, 0), scalarKey(10, 1)] },
    ] } }))
    const upgraded = upgradeLegacyTextTitle(legacy, 'root', 'root-text', () => 'element')
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) return
    for (const frame of [0, 8, 2, 99, 5]) expect(resolveClipAnimationAtFrame(upgraded.project.sequences[0].tracks[0].clips[0], frame).effects)
      .toEqual(resolveClipAnimationAtFrame(legacy.sequences[0].tracks[0].clips[0], frame).effects)
    const grading = replaceFirstTitleClip(upgraded.project, (clip) => ({ ...clip, effects: [{ id: 'curves', type: COLOR_CURVES_TYPE, version: 1, enabled: true, params: { ...DEFAULT_COLOR_CURVES } }],
      animation: { tracks: [], effectTracks: [{ effectId: 'curves', parameter: 'strength', keyframes: [scalarKey(0, 0)] }] } }))
    const edited = editColorGradingParams(grading, { kind: 'clip', sequenceId: 'root', clipId: 'root-text' }, 'curves', 5, { strength: 0.4 })
    expect(resolveClipAnimationAtFrame(edited.sequences[0].tracks[0].clips[0], 5).effects[0].params.strength).toBe(0.4)
    const future = replaceFirstTitleClip(grading, (clip) => ({ ...clip, title: { version: 99 } }))
    expect(() => editColorGradingParams(future, { kind: 'clip', sequenceId: 'root', clipId: 'root-text' }, 'curves', 5, { strength: 0.4 })).toThrow(/cannot receive/)
  })
})
