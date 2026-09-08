import { describe, expect, test } from 'vitest'
import { freeze } from 'immer'
import { foundationProject, scalarKey } from '../test/animationFoundationFixtures'
import { certifyProjectCropAnimation } from './projectCropAnimation'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import { createAdjustmentItem, setAdjustmentOpacityKeyframe, resolveAdjustmentAtFrame } from './adjustmentItems'
import { removeAnimationKeyframe } from './clipAnimation'

describe('crop snapshot ownership and held tails', () => {
  test('caches only the exact deeply frozen proof inputs, never a mutable nested crop', () => {
    const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
    clip.animation = { tracks: [{ property: 'crop-left', keyframes: [scalarKey(0, 0.3)] }], effectTracks: [] }
    Object.freeze(project)
    expect(certifyProjectCropAnimation(project).ok).toBe(true)
    clip.visual!.crop.right = 0.8
    expect(certifyProjectCropAnimation(project)).toMatchObject({ ok: false, reason: 'unsafe-crop' })
    clip.visual!.crop.right = 0.2
    freeze(project.sequences, true)
    const certificate = certifyProjectCropAnimation(project)
    expect(certificate.ok).toBe(true)
    expect(certifyProjectCropAnimation(project)).toBe(certificate)
    const changed = structuredClone(project)
    changed.sequences[0].tracks[0].clips[0].visual!.crop.right = 0.8
    expect(certifyProjectCropAnimation(freeze(changed, true))).toMatchObject({ ok: false, reason: 'unsafe-crop' })
  })

  test('certifies held tails for valid clip durations beyond the authored-key frame bound', () => {
    const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
    clip.timelineRange.durationFrames = 2_000_000_000
    clip.animation = { tracks: [{ property: 'crop-left', keyframes: [scalarKey(-1_000_000_000, 0.1), scalarKey(1_000_000_000, 0.2)] }], effectTracks: [] }
    const result = certifyProjectCropAnimation(project)
    expect(result.ok).toBe(true)
    expect(resolveClipAnimationAtFrame(clip, 1_999_999_999).visual!.crop.left).toBe(0.2)
    clip.animation.tracks.push({ property: 'crop-right', keyframes: [scalarKey(1_000_000_000, 0.9)] })
    expect(certifyProjectCropAnimation(project)).toMatchObject({ ok: false, reason: 'unsafe-crop' })
  })

  test('key removal preserves explicit version metadata and unavailable adjustment values stay inert', () => {
    const animation = { tracks: [{ property: 'opacity', propertyVersion: 7, keyframes: [scalarKey(0, 25), scalarKey(10, 30)] }], effectTracks: [] }
    expect(removeAnimationKeyframe(animation, 'opacity', 0)?.tracks[0].propertyVersion).toBe(7)
    const doc = foundationProject().sequences[0]
    doc.tracks[0].clips = []
    const item = createAdjustmentItem(0, 60, 'adjustment')
    item.animation.tracks = [{ property: 'opacity', propertyVersion: 7, keyframes: [{ frame: 0, value: 25, easing: { type: 'linear' } }] }]
    doc.tracks[0].adjustments = [item]
    expect(resolveAdjustmentAtFrame(item, 0).opacity).toBe(1)
    expect(setAdjustmentOpacityKeyframe(doc, item.id, { frame: 1, value: 0.5, easing: { type: 'linear' } })).toBe(doc)
  })
})
