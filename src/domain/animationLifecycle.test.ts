import { describe, expect, test, vi } from 'vitest'
import { foundationProject, pathTrack, scalarKey } from '../test/animationFoundationFixtures'
import { attributeClip } from '../test/clipAttributeFixtures'
import { clipAnimationKeyframeCount, resolveClipAnimationAtFrame } from './clipAnimation'
import { remapTitleAnimationElementIds } from './animationCollections'
import { captureClipAttributes, pasteClipAttributes } from './clipAttributes'
import { createMaskEffect } from './effectStack'
import { createTextClip, splitClipAtFrame, trimClip, slipClip, retimeClip } from './operations'
import { defaultSourceTimeMap, retimeClipAnimation, sourceTimeSpeedRateFromPercent } from './sourceTimeMap'
import { matchEmptyProjectFrameRate } from './projectSequences'
import * as maskPath from './maskPath'

function typedProject() {
  const project = foundationProject(), clip = project.sequences[0].tracks[0].clips[0]
  clip.animation = { tracks: [{ property: 'future', propertyVersion: 3, keyframes: [scalarKey(0, 1), scalarKey(10, 2)] }], effectTracks: [],
    titleTracks: [{ elementId: 'orphan', property: 'future', propertyVersion: 3, keyframes: [scalarKey(0, 2), scalarKey(10, 3)] }], effectPathTracks: [pathTrack()] }
  return project
}

describe('typed animation lifecycle integration', () => {
  test('split, trim, slip and retime transform every lane with the established source-time rules', () => {
    const project = typedProject(), doc = project.sequences[0], source = doc.tracks[0].clips[0]
    const before = JSON.stringify(doc)
    const split = splitClipAtFrame(doc, source.id, 5), right = split.tracks[0].clips[1]
    for (const animation of [right.animation!, trimClip(doc, source.id, 'start', 5).tracks[0].clips[0].animation!]) {
      expect(animation.titleTracks![0].keyframes.map((key) => key.frame)).toEqual([-5, 5])
      expect(animation.effectPathTracks![0].keyframes.map((key) => key.sourceTimeTicks)).toEqual([0, 10_000_000])
      expect(clipAnimationKeyframeCount(animation)).toBe(6)
    }
    const slipped = slipClip(doc, source.id, 5).tracks[0].clips[0].animation!
    expect(slipped.titleTracks![0].keyframes.map((key) => key.frame)).toEqual([0, 10])
    expect(slipped.effectPathTracks![0].keyframes.map((key) => key.sourceTimeTicks)).toEqual([5_000_000, 15_000_000])
    const retimed = retimeClip(doc, source.id, { numerator: 2, denominator: 1 }).tracks[0].clips[0].animation!
    expect(retimed.titleTracks![0].keyframes.map((key) => key.frame)).toEqual([0, 5])
    expect(retimed.effectPathTracks![0].keyframes.map((key) => key.frame)).toEqual([0, 5])
    expect(retimed.titleTracks![0].propertyVersion).toBe(3)
    expect(JSON.stringify(doc)).toBe(before)
    expect(matchEmptyProjectFrameRate(project, { num: 60, den: 1 })).toBeNull()
  })

  test('freeze inversion keeps the shared latest-plateau rule for title and path keys', () => {
    const source = typedProject().sequences[0].tracks[0].clips[0].animation!
    const oldMap = defaultSourceTimeMap(0, 60)
    const freeze = { ...oldMap, speedCurve: { originFrame: 0, points: [
      { frame: 0, rate: sourceTimeSpeedRateFromPercent(0), easing: 'hold' as const },
      { frame: 3, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' as const },
    ] } }
    const retimed = retimeClipAnimation(source, oldMap, freeze, 63)!
    expect(retimed.titleTracks![0].keyframes.map((key) => key.frame)).toEqual([3, 13])
    expect(retimed.effectPathTracks![0].keyframes.map((key) => key.frame)).toEqual([3, 13])
    expect(retimed.effectPathTracks![0].keyframes.map((key) => key.value)).toEqual(source.effectPathTracks![0].keyframes.map((key) => key.value))
  })

  test('procedural text split reanchors all preserved local intent; element remapping preserves versions', () => {
    const doc = foundationProject().sequences[0], clip = createTextClip(doc, 0, 60, 'Text')
    clip.animation = typedProject().sequences[0].tracks[0].clips[0].animation
    clip.effects = [createMaskEffect('mask', 'bezier')]
    expect(resolveClipAnimationAtFrame(clip, 10).effects[0].params.path).toBe(clip.effects[0].params.path)
    doc.tracks[0].clips = [clip]
    const right = splitClipAtFrame(doc, clip.id, 5, () => 'split-orphan').tracks[0].clips[1]
    expect(right.animation!.titleTracks![0].keyframes.map((key) => [key.frame, key.sourceTimeTicks])).toEqual([[-5, -5_000_000], [5, 5_000_000]])
    expect(right.animation!.effectPathTracks![0].keyframes[0].sourceTimeTicks).toBe(-5_000_000)
    const mapped = remapTitleAnimationElementIds(right.animation!, new Map([['split-orphan', 'copy']]))
    expect(mapped.titleTracks![0]).toMatchObject({ elementId: 'copy', propertyVersion: 3 })
    expect(right.animation!.titleTracks![0].elementId).toBe('split-orphan')
    expect(clip.animation!.titleTracks![0].elementId).toBe('orphan')
  })

  test('attribute paste onto an old clip without animation retains path-only and dangling keys with fresh ids', () => {
    const project = foundationProject(), source = project.sequences[0].tracks[0].clips[0]
    source.effects = [createMaskEffect('mask', 'bezier')]
    source.animation = { tracks: [], effectTracks: [], effectPathTracks: [pathTrack(), pathTrack('dangling')] }
    const destination = attributeClip('target', 100); delete destination.animation
    project.sequences[0].tracks[0].clips.push(destination)
    const captured = captureClipAttributes(source, 'video', ['effects'])
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    let id = 0
    const result = pasteClipAttributes(project, project.rootSequenceId, [destination.id], captured.template, { groups: ['effects'], effectsMode: 'append', includeAnimation: true }, () => ++id === 1 ? 'dangling' : `new-${id}`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const target = result.project.sequences[0].tracks[0].clips[1]
    expect(target.animation!.effectPathTracks).toHaveLength(2)
    expect(target.animation!.effectPathTracks![0].effectId).toBe(target.effects[0].id)
    expect(target.animation!.effectPathTracks![1].effectId).not.toBe('dangling')
    expect(target.effects[0].id).not.toBe('dangling')
  })

  test('prepared path playback does not reparse geometry and still rejects invalid mask controls', () => {
    const spy = vi.spyOn(maskPath, 'maskBezierPathValidationError')
    try {
      const clip = foundationProject().sequences[0].tracks[0].clips[0]
      clip.effects = [createMaskEffect('mask', 'bezier')]
      clip.animation = { tracks: [], effectTracks: [], effectPathTracks: [pathTrack()] }
      resolveClipAnimationAtFrame(clip, 0)
      const parsed = spy.mock.calls.length
      expect(parsed).toBe(2)
      expect(resolveClipAnimationAtFrame(clip, 10).effects[0].params.path).toBe(pathTrack().keyframes[1].value)
      expect(spy.mock.calls).toHaveLength(parsed)
      clip.effects[0].params.feather = -1
      expect(resolveClipAnimationAtFrame(clip, 10)).toBe(clip)
      expect(spy.mock.calls).toHaveLength(parsed)
    } finally { spy.mockRestore() }
  })
})
