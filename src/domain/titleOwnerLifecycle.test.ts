import { describe, expect, test } from 'vitest'
import { expandedTitleProject, legacyTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { scalarKey } from '../test/animationFoundationFixtures'
import { createTitleElementIdAllocator, copyTitleForNewOwner, projectTitleOwnershipError, readTitleClipElement, titleDefinitionUsage } from './titleOwnership'
import { isProceduralTitleClip, proceduralTextAssetId } from './textOverlay'
import { readTitleDefinition, type TitleDefinitionV1 } from './titleElements'
import { duplicateProjectSequence } from './projectSequences'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from './projectFile'
import { slideClip, splitClipAtFrame, trimClip } from './operations/geometry'
import { insertClip } from './operations/creation'
import { tryRollSequence, applySequenceEdit } from './threePointApply'
import { videoStabilizationAvailabilityReason } from './videoStabilization'
import { captureClipAttributes, pasteClipAttributes } from './clipAttributes'
import { forEachAnimationTrack } from './animationCollections'
import { SOURCE_TIME_TICKS_PER_FRAME } from './sourceTimeMap'
import type { Clip } from './schema'

function definition(clip: Clip): TitleDefinitionV1 {
  const result = readTitleDefinition(clip.title)
  if (result.status !== 'supported') throw new Error('Expected v1 title fixture')
  return result.title
}
function multiElementProject() {
  return replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip,
    title: { version: 1, elements: [
      { ...definition(clip).elements[0], enabled: false },
      { id: 'future-element', version: 9, kind: 'future', name: 'Opaque', enabled: false, payload: { value: 'untouched' } },
    ] },
    animation: { ...clip.animation!,
      tracks: [{ property: 'opacity', keyframes: [scalarKey(-3, 0.1), scalarKey(140, 0.9)] }],
      effectTracks: [{ effectId: 'missing-effect', parameter: 'future', keyframes: [scalarKey(-3, 1), scalarKey(140, 9)] }],
      effectPathTracks: [{ effectId: 'missing-path', parameter: 'future-path', valueType: 'future-path', valueVersion: 9, keyframes: [
        { frame: -3, sourceTimeTicks: -3 * SOURCE_TIME_TICKS_PER_FRAME, value: 'opaque', easing: { type: 'hold' } },
      ] }],
      titleTracks: ['root-element', 'future-element', 'orphan'].map((elementId) => ({
      elementId, propertyVersion: 9, property: 'future', keyframes: [scalarKey(-3, 1), scalarKey(140, 9)],
    })) },
  }))
}

describe('title ownership reader and copying lifecycle', () => {
  test('the shared adapter returns only the exact supported element, including disabled elements', () => {
    const clip = multiElementProject().sequences[0].tracks[0].clips[0]
    expect(readTitleClipElement(clip, 'root-element')).toMatchObject({ id: 'root-element', kind: 'text', enabled: false })
    expect(readTitleClipElement(clip, 'future-element')).toBeUndefined()
    expect(readTitleClipElement(clip, 'missing')).toBeUndefined()
    expect(readTitleClipElement({ ...clip, title: { version: 99, elements: definition(clip).elements } }, 'root-element')).toBeUndefined()
    expect(readTitleClipElement(legacyTitleProject().sequences[0].tracks[0].clips[0], 'root-element')).toBeUndefined()
    expect(isProceduralTitleClip(clip)).toBe(true)
    expect(isProceduralTitleClip({ title: { version: 99 } })).toBe(true)
    expect(isProceduralTitleClip({})).toBe(false)
    expect(videoStabilizationAvailabilityReason(multiElementProject().sequences[0], clip, null)).toMatch(/only for timed video/)
  })

  test('remints supported, future-element and orphan IDs together while reserving dormant targets', () => {
    const project = multiElementProject()
    project.sequences[1].tracks[0].clips[0].animation = { tracks: [], effectTracks: [], titleTracks: [
      { elementId: 'dormant-orphan', propertyVersion: 9, property: 'future', keyframes: [scalarKey(0, 1)] },
    ] }
    const attempts = ['root-element', 'future-element', 'orphan', 'dormant-orphan', 'fresh-a', 'fresh-b', 'fresh-c']
    const allocator = createTitleElementIdAllocator(project, () => attempts.shift() ?? 'exhausted')
    const clip = project.sequences[0].tracks[0].clips[0]
    const copied = copyTitleForNewOwner(clip, allocator)!
    expect(titleDefinitionUsage(copied.title!).elementIds).toEqual(['fresh-a', 'fresh-b'])
    expect(copied.animation.titleTracks?.map((lane) => lane.elementId)).toEqual(['fresh-a', 'fresh-b', 'fresh-c'])
    expect(definition({ ...clip, title: copied.title }).elements[1]).toEqual({ ...definition(clip).elements[1], id: 'fresh-b' })
    expect(copied.animation.titleTracks?.[2].keyframes).toEqual(clip.animation?.titleTracks?.[2].keyframes)
    expect(clip.animation?.titleTracks?.[2].elementId).toBe('orphan')
    expect(() => createTitleElementIdAllocator(project, () => 'dormant-orphan')()).toThrow(/unique/)

    let next = 0, titleAttempt = 0
    const duplicate = duplicateProjectSequence(project, 'root', 'Copy', (kind) => kind === 'title-element' && titleAttempt++ === 0 ? 'dormant-orphan' : `fresh-${kind}-${next++}`)
    expect(duplicate.failure).toBeNull()
    expect(projectTitleOwnershipError(duplicate.project)).toBeNull()
    const added = duplicate.project.sequences.at(-1)!.tracks[0].clips[0]
    expect(added.animation?.titleTracks?.some((lane) => ['root-element', 'future-element', 'orphan', 'dormant-orphan'].includes(lane.elementId))).toBe(false)
    expect(() => serializeProjectFile(createProjectFileSnapshot(duplicate.project, []))).not.toThrow()
  })

  test('future whole definitions round-trip unchanged and refuse copies with unknowable identity semantics', () => {
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, title: { version: 8, futureIdentity: { id: 'opaque' } } }))
    const clip = project.sequences[0].tracks[0].clips[0]
    expect(parseProjectFile(serializeProjectFile(createProjectFileSnapshot(project, []))).sequences[0].tracks[0].clips[0].title).toEqual(clip.title)
    expect(copyTitleForNewOwner(clip, () => { throw new Error('Do not interpret opaque IDs') })).toBeNull()
    expect(splitClipAtFrame(project.sequences[0], clip.id, 50)).toBe(project.sequences[0])
    expect(duplicateProjectSequence(project, 'root', 'Copy', (kind, source) => `${kind}-${source}-copy`).project).toBe(project)
  })

  test('insert copies supported authored data and rejects a second live owner with the same element IDs', () => {
    const project = expandedTitleProject(), source = project.sequences[0].tracks[0].clips[0]
    const empty = { ...project.sequences[0], tracks: project.sequences[0].tracks.map((track) => ({ ...track, clips: [] })) }
    const inserted = insertClip(empty, empty.tracks[0].id, source)
    const copied = inserted.tracks[0].clips[0]
    expect(copied.title).toEqual(source.title)
    expect(copied.title).not.toBe(source.title)
    expect(definition(copied).elements[0].transform).not.toBe(definition(source).elements[0].transform)
    const duplicate = { ...source, id: 'copy', assetId: proceduralTextAssetId('copy'), timelineRange: { startFrame: 100, durationFrames: 100 } }
    expect(insertClip(inserted, inserted.tracks[0].id, duplicate)).toBe(inserted)
  })

  test('attribute clipboard preserves title data and inactive lanes while refusing outer geometry authoring', () => {
    const project = replaceFirstTitleClip(multiElementProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, tracks: [
      { property: 'position-x', keyframes: [scalarKey(0, 100)] },
    ] } }))
    const source = { ...legacyTitleProject().sequences[0].tracks[0].clips[0], opacity: 0.25 }
    const captured = captureClipAttributes(source, 'video', ['opacity', 'transform'])
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    const options = { groups: ['opacity'] as const, includeAnimation: false, effectsMode: 'append' as const }
    const pasted = pasteClipAttributes(project, 'root', ['root-text'], captured.template, options, () => 'unused')
    expect(pasted.ok).toBe(true)
    if (!pasted.ok) return
    const changed = pasted.project.sequences[0].tracks[0].clips[0], original = project.sequences[0].tracks[0].clips[0]
    expect(changed.opacity).toBe(0.25)
    expect(changed.title).toBe(original.title)
    expect(changed.animation?.titleTracks).toEqual(original.animation?.titleTracks)
    expect(changed.animation?.tracks).toEqual(original.animation?.tracks)
    expect(pasteClipAttributes(project, 'root', ['root-text'], captured.template, { ...options, groups: ['transform'] }, () => 'unused').ok).toBe(false)
    expect(source.text).toBeDefined()
    expect(source.title).toBeUndefined()
  })

  test('roll, slide, trim and implicit range splits preserve outside keys with exact local ticks', () => {
    const project = multiElementProject(), doc = project.sequences[0]
    let serial = 0
    const allocate = createTitleElementIdAllocator(project, () => `copy-${serial++}`)
    const second = splitClipAtFrame(doc, 'root-text', 30, allocate)
    const three = splitClipAtFrame(second, second.tracks[0].clips[1].id, 60, allocate)
    const [left, middle, right] = three.tracks[0].clips
    const check = (changed: typeof doc, rightId: string, shiftedFirst: number) => {
      const clip = changed.tracks[0].clips.find((clip) => clip.id === rightId)!
      expect(clip.animation!.titleTracks![0].keyframes[0].frame).toBe(shiftedFirst)
      forEachAnimationTrack(clip.animation!, (lane) => {
        for (const key of lane.keyframes) expect(key.sourceTimeTicks).toBe(key.frame * SOURCE_TIME_TICKS_PER_FRAME)
      })
      expect(projectTitleOwnershipError({ sequences: [changed] })).toBeNull()
    }
    const rolled = tryRollSequence(three, [[middle.id, right.id]], 5, new Map())
    expect(rolled.status).toBe('ok')
    if (rolled.status === 'ok') check(rolled.doc, right.id, -68)
    check(slideClip(three, middle.id, 5), right.id, -68)
    const isolated = { ...three, tracks: three.tracks.map((track, index) => index ? track : { ...track, clips: [right] }) }
    check(trimClip(isolated, right.id, 'start', -5), right.id, -58)
    const tail = trimClip(three, right.id, 'end', 10)
    check(tail, right.id, -63)
    expect(tail.tracks[0].clips[2].animation?.titleTracks).toEqual(right.animation?.titleTracks)
    const lifted = applySequenceEdit(doc, { status: 'ok', kind: 'lift', trackIds: [doc.tracks[0].id], timelineRange: { startFrame: 20, durationFrames: 30 } }, null, new Map(), allocate)
    expect(lifted.tracks[0].clips).toHaveLength(2)
    expect(lifted.tracks[0].clips[0].id).toBe(left.id)
    check(lifted, lifted.tracks[0].clips[1].id, -53)
  })
})
