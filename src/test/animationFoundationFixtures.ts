import { attributeClip, ATTRIBUTE_ASSET_DESCRIPTOR } from './clipAttributeFixtures'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { createPluginVideoEffectContributionSnapshot } from '../domain/pluginVideoEffectStagePlan'
import { DEFAULT_MASK_BEZIER_PATH } from '../domain/effectStack'
import type { EffectPathAnimationTrack } from '../domain/maskPathAnimation'
import type { ClipAnimationKeyframe } from '../domain/schema'

export { ATTRIBUTE_ASSET_DESCRIPTOR }
export function scalarKey(frame: number, value: number): ClipAnimationKeyframe {
  return { frame, sourceTimeTicks: frame * 1_000_000, value, easing: { type: 'linear' } }
}
export function foundationProject() {
  const doc = structuredClone(createTimelineDoc('Animation', DEFAULT_PROJECT_SETTINGS, 'animation-foundation'))
  doc.tracks[0].clips = [attributeClip('clip')]
  return sequenceProjectFromTimeline(doc)
}
export function pathTrack(effectId = 'mask'): EffectPathAnimationTrack {
  return { effectId, parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1, keyframes: [
    { frame: 0, sourceTimeTicks: 0, value: DEFAULT_MASK_BEZIER_PATH, easing: { type: 'hold' } },
    { frame: 10, sourceTimeTicks: 10_000_000, value: 'M 0 0 C 1 0 1 1 0 0 Z', easing: { type: 'hold' } },
  ] }
}
export const PLUGIN_ANIMATION_EFFECT_TYPE = 'plugin:com.example.animation/shape'
export function animationCatalog(generation = 1, digest = '2') {
  return createPluginVideoEffectContributionSnapshot(generation, [{
    signerFingerprint: `sha256:${'1'.repeat(64)}`, packageDigest: `sha256:${digest.repeat(64)}`,
    pluginId: 'com.example.animation', pluginVersion: '1.0.0', kind: 'video-effect',
    contributionVersion: 1, contributionId: 'shape', contributionName: 'Shape', descriptorVersion: 1,
    entrypoint: 'render', parameters: [{ key: 'amount', name: 'Amount', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.2, animatable: true }],
    availability: 'ready', detail: 'Ready',
  }])
}
