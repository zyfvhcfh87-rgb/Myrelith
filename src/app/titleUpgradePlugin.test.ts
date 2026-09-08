import { describe, expect, test, vi } from 'vitest'
import { createTitleUpgradeController } from './titleUpgradeController'
import { commitPortableProjectEdit } from './portableProjectEdit'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { legacyTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { scalarKey } from '../test/animationFoundationFixtures'
import { createPluginVideoEffectContributionSnapshot, resolveVideoEffectStagePlan } from '../domain/pluginVideoEffectStagePlan'
import { upgradeLegacyTextTitle } from '../domain/titleUpgrade'
import { createMaskEffect } from '../domain/effectStack'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'

const effectType = 'plugin:com.example.title/title'
const identity = { version: 1, effectType, descriptorVersion: 1, contributionId: 'title', contributionVersion: 1, packageDigest: `sha256:${'2'.repeat(64)}` }
const plugins = createPluginVideoEffectContributionSnapshot(1, [{ signerFingerprint: `sha256:${'1'.repeat(64)}`, packageDigest: identity.packageDigest,
  pluginId: 'com.example.title', pluginVersion: '1.0.0', kind: 'video-effect', contributionId: 'title', contributionVersion: 1,
  contributionName: 'Title', descriptorVersion: 1, entrypoint: 'myrelith_effect_title', availability: 'ready', detail: 'Ready',
  parameters: [{ key: 'strength', name: 'Strength', kind: 'number', default: 0.2, min: 0, max: 1, step: 0.1, animatable: true }],
}])
function projectWithPlugin() {
  return replaceFirstTitleClip(legacyTitleProject(), (clip) => ({ ...clip,
    effects: [{ id: 'plugin', type: effectType, version: 1, enabled: true, params: { strength: 0.2 } }],
    animation: { tracks: [], effectTracks: [{ effectId: 'plugin', parameter: 'strength', parameterIdentity: identity,
      keyframes: [scalarKey(0, 0), scalarKey(10, 1)] }] },
  }))
}
describe('legacy plugin animation upgrade compatibility', () => {
  test('refuses an actually resolved mask scalar change without replacing the compact clip or clearing redo', () => {
    const project = replaceFirstTitleClip(legacyTitleProject(), (clip) => ({ ...clip, effects: [createMaskEffect('mask', 'rectangle')],
      animation: { tracks: [], effectTracks: [{ effectId: 'mask', parameter: 'x', keyframes: [scalarKey(0, 0.1), scalarKey(10, 0.9)] }] },
    }))
    const clip = project.sequences[0].tracks[0].clips[0]
    const frames = [0, 5, 10].map((frame) => resolveClipAnimationAtFrame(clip, frame).effects)
    expect(frames.map((effects) => effects[0].params.x)).toEqual([0.1, 0.5, 0.9])
    useDocumentStore.getState().setProject(project)
    useMediaStore.setState({ descriptors: new Map(), collections: [] })
    const state = useDocumentStore.getState(), renamed = replaceFirstTitleClip(project, (clip) => ({ ...clip, name: 'Rename' }))
    expect(commitPortableProjectEdit(project, state.projectGeneration, renamed)).toBeNull()
    useDocumentStore.getState().undo()
    const before = useDocumentStore.getState(), allocate = vi.fn(() => 'element'), controller = createTitleUpgradeController(allocate)
    expect(controller.upgrade(controller.begin(clip.id))).toMatch(/could change stored source-effect animation/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(before.future).toEqual([renamed])
    expect(allocate).not.toHaveBeenCalled()
    expect([0, 5, 10].map((frame) => resolveClipAnimationAtFrame(before.doc.tracks[0].clips[0], frame).effects)).toEqual(frames)
  })
  test.each(['disabled', 'future-effect', 'bound', 'out-of-bounds', 'empty', 'static-value', 'unknown-parameter'] as const)('retains %s mask lanes through upgrade', (kind) => {
    const mask = createMaskEffect('mask', 'rectangle')
    const project = replaceFirstTitleClip(legacyTitleProject(), (clip) => ({ ...clip,
      effects: [{ ...mask, enabled: kind !== 'disabled', version: kind === 'future-effect' ? 99 : 1 }],
      animation: { tracks: [], effectTracks: [{ effectId: 'mask', parameter: kind === 'unknown-parameter' ? 'future' : 'x',
        ...(kind === 'bound' ? { parameterIdentity: { ...identity, effectType: mask.type } } : {}),
        keyframes: kind === 'empty' ? [] : [scalarKey(0, kind === 'out-of-bounds' ? 99 : kind === 'static-value' ? mask.params.x as number : 0.2)],
      }] },
    }))
    const result = upgradeLegacyTextTitle(project, 'root', 'root-text', () => 'element')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.project.sequences[0].tracks[0].clips[0].animation?.effectTracks).toEqual(project.sequences[0].tracks[0].clips[0].animation?.effectTracks)
  })
  test('refuses a potentially active bound lane without changing pixels intent, history or consuming identities', () => {
    const project = projectWithPlugin(), clip = project.sequences[0].tracks[0].clips[0]
    const beforeStages = [0, 5, 10].map((frame) => resolveVideoEffectStagePlan(clip, frame, plugins))
    expect(beforeStages[1]?.stages[0]).toMatchObject({ execution: { parameterRecord: { strength: 0.5 } } })
    useDocumentStore.getState().setProject(project)
    useMediaStore.setState({ descriptors: new Map(), collections: [] })
    const state = useDocumentStore.getState()
    const edited = replaceFirstTitleClip(project, (clip) => ({ ...clip, name: 'A rename' }))
    expect(commitPortableProjectEdit(project, state.projectGeneration, edited)).toBeNull()
    useDocumentStore.getState().undo()
    const before = useDocumentStore.getState(), allocate = vi.fn(() => 'new-element')
    const controller = createTitleUpgradeController(allocate)
    expect(controller.upgrade(controller.begin(clip.id))).toMatch(/could change stored plugin animation/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(before.future).toEqual([edited])
    expect(allocate).not.toHaveBeenCalled()
    expect([0, 5, 10].map((frame) => resolveVideoEffectStagePlan(before.doc.tracks[0].clips[0], frame, plugins))).toEqual(beforeStages)
    // Pure refusal does not depend on which catalog happens to be installed.
    expect(upgradeLegacyTextTitle(project, 'root', clip.id, allocate).ok).toBe(false)
  })
  test.each(['disabled', 'unbound', 'future-binding', 'mismatched-type', 'mismatched-version', 'empty'] as const)('preserves %s intent without a generic refusal', (kind) => {
    const project = replaceFirstTitleClip(projectWithPlugin(), (clip) => {
      const track = clip.animation!.effectTracks![0]
      return { ...clip, effects: clip.effects.map((effect) => ({ ...effect, enabled: kind !== 'disabled' })), animation: { tracks: [], effectTracks: [{ ...track,
        parameterIdentity: kind === 'unbound' ? undefined : { ...identity, version: kind === 'future-binding' ? 99 : 1,
          effectType: kind === 'mismatched-type' ? 'plugin:com.example.other/other' : effectType,
          descriptorVersion: kind === 'mismatched-version' ? 2 : 1 },
        keyframes: kind === 'empty' ? [] : track.keyframes,
      }] } }
    })
    const result = upgradeLegacyTextTitle(project, 'root', 'root-text', () => 'new-element')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.project.sequences[0].tracks[0].clips[0].animation?.effectTracks).toEqual(project.sequences[0].tracks[0].clips[0].animation?.effectTracks)
  })
})
