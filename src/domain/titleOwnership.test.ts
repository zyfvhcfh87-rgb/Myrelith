import { describe, expect, test } from 'vitest'
import { legacyTitleProject, expandedTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { scalarKey } from '../test/animationFoundationFixtures'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile, CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import { projectTitleOwnershipError, titleDefinitionUsage } from './titleOwnership'
import { projectTitleAnimationOwners } from './animationProjectBudget'
import { upgradeLegacyTextTitle } from './titleUpgrade'
import { defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { readTitleDefinition, readTitleElement } from './titleElements'
import { projectMediaAssetIds, duplicateProjectSequence } from './projectSequences'
import { clipContributesAudioOutput, clipContributesVisualOutput } from './selectors'
import { splitClipAtFrame, trimClip, retimeClip, slipClip } from './operations/geometry'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import { updateClipVisual } from './operations/visual'
import { setClipKeyframe } from './operations/animation'
import { SOURCE_TIME_TICKS_PER_FRAME } from './sourceTimeMap'

function wire(project: ReturnType<typeof legacyTitleProject>): string {
  return serializeProjectFile(createProjectFileSnapshot(project, []))
}

describe('schema23 title ownership', () => {
  test('upgrades explicitly with exact legacy fields and remains idempotent', () => {
    let original = legacyTitleProject()
    original = replaceFirstTitleClip(original, (clip) => ({ ...clip, opacity: 0.5,
      transform: { x: 8.25, y: -9.5, scaleX: 0, scaleY: 0.125, rotation: 33, anchorX: 0, anchorY: 1 },
      visual: { crop: { left: 0.1, right: 0.2, top: 0.15, bottom: 0.25 }, flipHorizontal: true, flipVertical: false, scaleLocked: false },
    }))
    const clip = original.sequences[0].tracks[0].clips[0]
    const result = upgradeLegacyTextTitle(original, 'root', clip.id, () => 'fresh-element')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const changed = result.project.sequences[0].tracks[0].clips[0]
    expect(changed.text).toBeUndefined()
    expect(changed.transform).toEqual(defaultClipTransform())
    expect(changed.visual).toEqual(defaultClipVisualSettings())
    expect(changed.opacity).toBe(0.5)
    expect(changed.assetId).toBe(clip.assetId)
    const definition = readTitleDefinition(changed.title)
    expect(definition.status).toBe('supported')
    if (definition.status !== 'supported') return
    const element = readTitleElement(definition.title.elements[0])
    expect(element.status).toBe('supported')
    if (element.status !== 'supported' || element.element.kind !== 'text') return
    expect(element.element.transform).toEqual(clip.transform)
    expect(element.element.visual).toEqual(clip.visual)
    expect({ ...element.element.text, fontFamily: element.element.font.family }).toEqual(clip.text)
    expect(element.element.opacity).toBe(1)
    expect(original.sequences[0].tracks[0].clips[0]).toBe(clip)
    const repeated = upgradeLegacyTextTitle(result.project, 'root', clip.id, () => { throw new Error('No allocation on repeat') })
    expect(repeated).toMatchObject({ ok: true, project: result.project, elementId: null })
    expect(parseProjectFile(wire(result.project)).sequences[0].schemaVersion).toBe(CURRENT_TIMELINE_SCHEMA_VERSION)
  })

  test('puts title and lanes in one accounting owner, never in media usage', () => {
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: {
      ...clip.animation!, titleTracks: [{ elementId: 'root-element', propertyVersion: 1, property: 'opacity', keyframes: [scalarKey(0, 0.5)] }],
    } }))
    const clip = project.sequences[0].tracks[0].clips[0]
    const owners = projectTitleAnimationOwners(project)
    expect(owners).toHaveLength(1)
    expect(owners[0].title).toBe(clip.title)
    expect(owners[0].titleTracks).toBe(clip.animation?.titleTracks)
    expect(projectMediaAssetIds(project).size).toBe(0)
    expect(clipContributesAudioOutput(clip)).toBe(false)
    expect(clipContributesVisualOutput(clip)).toBe(false)
    expect(projectTitleOwnershipError(project)).toBeNull()
    expect(wire(project)).toContain('"title"')
  })

  test('rejects mixed owners, nonidentity outer geometry, invalid padding keys and nonlocal ticks', () => {
    const base = expandedTitleProject(), legacy = legacyTitleProject().sequences[0].tracks[0].clips[0]
    for (const project of [
      replaceFirstTitleClip(base, (clip) => ({ ...clip, text: legacy.text })),
      replaceFirstTitleClip(base, (clip) => ({ ...clip, transform: { ...clip.transform, x: 2 } })),
      replaceFirstTitleClip(base, (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [{ elementId: 'root-element', propertyVersion: 1, property: 'box-width', keyframes: [scalarKey(0, 16)] }] } })),
      replaceFirstTitleClip(base, (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [{ elementId: 'orphan', propertyVersion: 2, property: 'future', keyframes: [{ ...scalarKey(5, 1), sourceTimeTicks: 123 }] }] } })),
    ]) {
      expect(projectTitleOwnershipError(project)).not.toBeNull()
      expect(() => wire(project)).toThrow()
    }
  })

  test('preserves bounded future data, reserves its cost, and rejects duplicate element IDs across sequences', () => {
    const base = expandedTitleProject()
    const future = { version: 2, content: 'Future title', extension: { preserved: ['opaque', 4] } }
    const opaque = replaceFirstTitleClip(base, (clip) => ({ ...clip, title: future }))
    expect(parseProjectFile(wire(opaque)).sequences[0].tracks[0].clips[0].title).toEqual(future)
    expect(titleDefinitionUsage(future)).toMatchObject({ elements: 16, elementIds: [] })
    const title = base.sequences[0].tracks[0].clips[0].title
    const duplicate = { ...base, sequences: [base.sequences[0], { ...base.sequences[1], tracks: base.sequences[1].tracks.map((track, index) => index ? track : {
      ...track, clips: track.clips.map(({ text: _text, ...clip }) => ({ ...clip, title })),
    }) }] }
    expect(projectTitleOwnershipError(duplicate)).toMatch(/unique across/)
    expect(() => wire(duplicate)).toThrow(/unique across/)
  })

  test('outer opacity alone is editable and evaluated while incoming ineligible lanes survive', () => {
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, tracks: [
      { property: 'position-x', keyframes: [scalarKey(0, 200)] },
      { property: 'crop-left', keyframes: [scalarKey(0, 0.9)] },
      { property: 'crop-right', keyframes: [scalarKey(0, 0.9)] },
      { property: 'opacity', keyframes: [scalarKey(0, 0.25)] },
    ] } }))
    const clip = parseProjectFile(wire(project)).sequences[0].tracks[0].clips[0]
    expect(clip.animation?.tracks).toHaveLength(4)
    expect(resolveClipAnimationAtFrame(clip, 0)).toMatchObject({ opacity: 0.25, transform: { x: 0 }, visual: { crop: { left: 0, right: 0 } } })
    const doc = expandedTitleProject().sequences[0]
    expect(updateClipVisual(doc, 'root-text', { transform: { x: 4 } })).toBe(doc)
    expect(setClipKeyframe(doc, 'root-text', 'position-x', scalarKey(0, 12))).toBe(doc)
    expect(setClipKeyframe(doc, 'root-text', 'opacity', scalarKey(0, 0.5))).not.toBe(doc)
  })

  test('split/trim keep fixed-local ticks, remap copied identities and prohibit media retiming', () => {
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [
      { elementId: 'root-element', propertyVersion: 1, property: 'position-x', keyframes: [scalarKey(-5, -10), scalarKey(120, 200)] },
    ] } }))
    const doc = project.sequences[0]
    const split = splitClipAtFrame(doc, 'root-text', 40, () => 'right-element')
    expect(split).not.toBe(doc)
    const [left, right] = split.tracks[0].clips
    expect(left.title).toBe(doc.tracks[0].clips[0].title)
    expect(right.animation?.titleTracks?.[0].elementId).toBe('right-element')
    expect(right.animation?.titleTracks?.[0].keyframes.map((key) => [key.frame, key.sourceTimeTicks])).toEqual([[-45, -45 * SOURCE_TIME_TICKS_PER_FRAME], [80, 80 * SOURCE_TIME_TICKS_PER_FRAME]])
    expect(() => wire({ ...project, sequences: [split, project.sequences[1]] })).not.toThrow()
    const trimmed = trimClip(doc, 'root-text', 'start', 10)
    expect(trimmed.tracks[0].clips[0].animation?.titleTracks?.[0].keyframes[0].frame).toBe(-15)
    expect(trimmed.tracks[0].clips[0].animation?.titleTracks?.[0].keyframes[0].sourceTimeTicks).toBe(-15 * SOURCE_TIME_TICKS_PER_FRAME)
    expect(retimeClip(doc, 'root-text', { numerator: 2, denominator: 1 })).toBe(doc)
    expect(slipClip(doc, 'root-text', 5)).toBe(doc)
    const duplicated = duplicateProjectSequence(project, 'root', 'Copy', (kind, source) => `${kind}-copy-${source ?? 'new'}`)
    expect(duplicated.failure).toBeNull()
    expect(duplicated.project).not.toBe(project)
    expect(() => wire(duplicated.project)).not.toThrow()
  })
})
