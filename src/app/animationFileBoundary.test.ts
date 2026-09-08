import { describe, expect, test } from 'vitest'
import { createTextClip } from '../domain/operations/creation'
import { updateTextClip } from '../domain/operations/audioText'
import { proceduralTextAssetId } from '../domain/textOverlay'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile, PROJECT_FILE_LIMITS, CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { attributeClip } from '../test/clipAttributeFixtures'
import { ATTRIBUTE_ASSET_DESCRIPTOR, scalarKey, pathTrack, animationCatalog } from '../test/animationFoundationFixtures'
import { commitPortableProjectEdit } from './portableProjectEdit'
import type { SequenceProject } from '../domain/projectSequences'
import type { Clip } from '../domain/schema'
import { createMaskEffect } from '../domain/effectStack'
import { useTransportStore } from '../state/transportStore'
import { commitMaskParams } from './maskEditingController'

function exactLegacyFile(characters: number, scalar: boolean): string {
  const sequences = ['root', 'dormant'].map((id) => structuredClone(createTimelineDoc(id, DEFAULT_PROJECT_SETTINGS, id)))
  for (const sequence of sequences) {
    for (const track of sequence.tracks) track.id = `${sequence.id}-${track.id}`
    for (let index = 0; index < 300; index++) {
      const clip = createTextClip(sequence, 60 + index * 30, 30, '')
      clip.id = `${sequence.id}-text-${index}`; clip.assetId = proceduralTextAssetId(clip.id)
      clip.name = 'A'.repeat(77) + '...'
      sequence.tracks[0].clips.push(clip)
    }
  }
  sequences[0].tracks[0].clips[0].effects = [createMaskEffect('boundary-mask', 'rectangle')]
  if (scalar) {
    const clip = attributeClip('legacy-scalar')
    clip.animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.5), scalarKey(10, 1)] }], effectTracks: [] }
    sequences[1].tracks[0].clips.unshift(clip)
  }
  const file = createProjectFileSnapshot({ id: 'boundary', name: 'Boundary', rootSequenceId: 'root', sequences, multicams: [], colorLuts: [] }, scalar ? [ATTRIBUTE_ASSET_DESCRIPTOR] : [])
  let remaining = characters - serializeProjectFile(file).length
  for (const sequence of file.sequences) for (const clip of sequence.tracks[0].clips) if (clip.text) {
    const count = Math.min(20_000, remaining)
    clip.text.content = 'A'.repeat(count); remaining -= count
  }
  expect(remaining).toBe(0)
  // Real old wire shape: migration changes two digits only, adding no track fields.
  const encoded = serializeProjectFile(file).replaceAll(`"schemaVersion":${CURRENT_TIMELINE_SCHEMA_VERSION}`, '"schemaVersion":21')
  expect(encoded.length).toBe(characters)
  expect(encoded).not.toMatch(/titleTracks|effectPathTracks|propertyVersion|parameterIdentity/)
  return encoded
}
function currentFile(project: SequenceProject): string {
  const media = useMediaStore.getState()
  return serializeProjectFile(createProjectFileSnapshot(project, media.descriptors.values(), media.collections))
}
function withFirstClip(project: SequenceProject, edit: (clip: Clip) => Clip): SequenceProject {
  const root = project.sequences[0], track = root.tracks[0]
  return { ...project, sequences: [{ ...root, tracks: [{ ...track, clips: [edit(track.clips[0]), ...track.clips.slice(1)] }, ...root.tracks.slice(1)] }, ...project.sequences.slice(1)] }
}

describe('schema22 production file and history boundary', () => {
  test.each([
    [9_999_999, false], [10_000_000, false], [9_999_999, true], [10_000_000, true],
  ] as const)('migrates %i characters (legacy scalar %s), edits and undoes without growth', (characters, scalar) => {
    expect(PROJECT_FILE_LIMITS.maxSerializedCharacters).toBe(10_000_000)
    const legacy = exactLegacyFile(characters, scalar), file = parseProjectFile(legacy)
    const migrated = serializeProjectFile(file)
    expect(migrated === legacy.replaceAll('"schemaVersion":21', `"schemaVersion":${CURRENT_TIMELINE_SCHEMA_VERSION}`)).toBe(true)
    expect(migrated.length).toBe(characters)
    if (characters === 10_000_000) {
      const oneOver = { ...file, name: `${file.name}x` }
      const oneOverWire = JSON.stringify(oneOver)
      expect(oneOverWire.length).toBe(10_000_001)
      expect(() => parseProjectFile(oneOverWire)).toThrow(/exceeds 10000000 characters/)
      expect(() => serializeProjectFile(oneOver)).toThrow(/exceeds 10000000 characters/)
    }
    useMediaStore.setState({ descriptors: new Map(file.assets.map((asset) => [asset.id, asset])), collections: file.collections })
    const project: SequenceProject = { id: file.id, name: file.name, rootSequenceId: file.rootSequenceId, sequences: file.sequences, multicams: file.multicams, colorLuts: file.colorLuts }
    useDocumentStore.getState().setProject(project)
    const original = useDocumentStore.getState(), text = original.doc.tracks[0].clips[0]
    const editedDoc = updateTextClip(original.doc, text.id, { content: 'B' + text.text!.content.slice(1), color: '#eeeeee' })
    const edited = { ...project, sequences: [editedDoc, project.sequences[1]] }
    expect(commitPortableProjectEdit(project, original.projectGeneration, edited)).toBeNull()
    expect(currentFile(useDocumentStore.getState().project).length).toBe(characters)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useDocumentStore.getState().past[0]).toBe(project)
    useDocumentStore.getState().undo()
    const undo = useDocumentStore.getState()
    expect(undo.project).toBe(project)
    expect(currentFile(undo.project) === migrated).toBe(true)
    // Every new wire collection/metadata field must fail before the populated redo is cleared.
    const declaration = animationCatalog().declarations[0]
    const parameterIdentity = { version: 1, effectType: declaration.effectType, descriptorVersion: declaration.descriptorVersion, contributionId: declaration.contributionId, contributionVersion: declaration.contributionVersion, packageDigest: declaration.packageDigest }
    const candidates = [
      withFirstClip(project, (clip) => ({ ...clip, animation: { ...clip.animation!, effectTracks: [{ effectId: 'unavailable', parameter: 'amount', parameterIdentity, keyframes: [scalarKey(0, 0.5)] }] } })),
      withFirstClip(project, (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [{ elementId: 'unavailable', propertyVersion: 2, property: 'future', keyframes: [scalarKey(0, 1)] }] } })),
      withFirstClip(project, (clip) => ({ ...clip, animation: { ...clip.animation!, effectPathTracks: [pathTrack('unavailable')] } })),
      withFirstClip(project, (clip) => ({ ...clip, animation: { ...clip.animation!, tracks: [{ property: 'opacity', propertyVersion: 1, keyframes: [scalarKey(0, 1)] }] } })),
    ]
    for (const candidate of candidates) {
      expect(commitPortableProjectEdit(project, undo.projectGeneration, candidate)).toMatch(/exceeds 10000000 characters/)
      expect(useDocumentStore.getState()).toBe(undo)
    }
    // The integrated mask gesture uses this same real file preflight while
    // retaining its project/sequence/selection guard and populated redo.
    const target = { sequenceId: 'root', clipId: text.id, effectId: 'boundary-mask' }
    useTransportStore.getState().resetTransport()
    useTransportStore.getState().setPlayheadFrame(text.timelineRange.startFrame)
    useTransportStore.getState().setSelectedClip(text.id)
    useTransportStore.getState().setMaskEditorTarget(target)
    expect(commitMaskParams(target, { x: 0.2 })).toMatch(/exceeds 10000000 characters/)
    expect(useDocumentStore.getState()).toBe(undo)
    expect(useTransportStore.getState().maskPreview).toBeNull()
    useTransportStore.getState().resetTransport()
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().project).toBe(edited)
    expect(currentFile(edited).length).toBe(characters)
  }, 30_000)
})
