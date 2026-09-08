import { describe, expect, it } from 'vitest'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile, CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import { captionProjectIntentError } from './captionIntentBudget'
import { mergeCaptionWithNext, splitCaptionItem, updateCaptionItem } from './captions'
import { duplicateProjectSequence, sequenceProjectReservedIds, sequenceProjectWithinEditBudget } from './projectSequences'
import { captionBudgetProject, captionIntentProject } from '../test/captionIntentFixtures'

describe('schema24 caption persistence', () => {
  it('migrates schema23 without injecting new intent or rewriting existing caption paint inputs', () => {
    const project = captionIntentProject()
    for (const doc of project.sequences) for (const track of doc.captionTracks!) {
      delete track.style; delete track.origin
      for (const item of track.items) { delete item.style; delete item.origin }
    }
    const file = createProjectFileSnapshot(project, [])
    const before = JSON.stringify(file.sequences.map((doc) => doc.captionTracks))
    for (const doc of file.sequences) doc.schemaVersion = 23
    const reopened = parseProjectFile(JSON.stringify(file))
    expect(reopened.sequences.every((doc) => doc.schemaVersion === CURRENT_TIMELINE_SCHEMA_VERSION)).toBe(true)
    expect(JSON.stringify(reopened.sequences.map((doc) => doc.captionTracks))).toBe(before)
  })
  it('copies and round-trips supported and whole future track/cue intent in dormant sequences', () => {
    const project = captionIntentProject()
    const snapshot = createProjectFileSnapshot(project, [])
    expect(snapshot.sequences[0].captionTracks![0].origin).not.toBe(project.sequences[0].captionTracks![0].origin)
    const reopened = parseProjectFile(serializeProjectFile(snapshot))
    expect(reopened.sequences.map((doc) => doc.captionTracks)).toEqual(project.sequences.map((doc) => doc.captionTracks))
    expect(serializeProjectFile(reopened)).toBe(serializeProjectFile(snapshot))
  })
  it('retains historical origin through text/timing changes, splits and compatible merges', () => {
    const project = captionIntentProject(), doc = project.sequences[0]
    const origin = doc.captionTracks![0].items[0].origin
    const edited = updateCaptionItem(doc, 'captions', 'cue-a', { text: 'Edited', range: { startFrame: 0, durationFrames: 25 } })
    const split = splitCaptionItem(edited, 'captions', 'cue-a', 10, 'split-right')
    expect(split.captionTracks![0].items.slice(0, 2).every((item) => item.origin === origin)).toBe(true)
    const merged = mergeCaptionWithNext(doc, 'captions', 'cue-a')
    expect(merged.captionTracks![0].items[0].origin?.params.sourceSampleCount).toBe(32_000)
    const mismatch = { ...doc, captionTracks: doc.captionTracks!.map((track) => ({ ...track, items: track.items.map((item, index) => index ? { ...item, style: { version: 1, params: { bold: false } } } : item) })) }
    expect(() => mergeCaptionWithNext(mismatch, 'captions', 'cue-a')).toThrow(/equal style/)
  })
  it('duplicates future intent with new project-wide IDs while retaining historical run identities', () => {
    const project = captionIntentProject()
    let serial = 0
    const result = duplicateProjectSequence(project, 'dormant', 'Copy', (kind) => `${kind}-${++serial}`)
    expect(result).not.toBeNull()
    if (!result) return
    const original = project.sequences[1].captionTracks![0].items[0]
    const duplicate = result.project.sequences.at(-1)!.captionTracks![0].items[0]
    expect(duplicate.id).not.toBe(original.id)
    expect(duplicate.style).toEqual(original.style)
    expect(duplicate.origin).toEqual(original.origin)
    expect(() => serializeProjectFile(createProjectFileSnapshot(result.project, []))).not.toThrow()
    expect(sequenceProjectReservedIds(result.project).has('dormant-cue')).toBe(true)
  })
  it('admits exactly 2 MiB across real active and dormant cues and rejects one extra byte', () => {
    const exact = captionBudgetProject(2_097_152), over = captionBudgetProject(2_097_153)
    expect(captionProjectIntentError(exact)).toBeNull()
    const file = serializeProjectFile(createProjectFileSnapshot(exact, []))
    expect(file.length).toBeLessThan(10_000_000)
    expect(parseProjectFile(file).sequences).toHaveLength(2)
    expect(captionProjectIntentError(over)).toMatch(/2 MiB/)
    expect(sequenceProjectWithinEditBudget(over)).toBe(false)
    expect(() => createProjectFileSnapshot(over, [])).toThrow(/2 MiB/)
  })
  it('rejects malformed known intent and orphan cue origins before save or live admission', () => {
    const project = captionIntentProject()
    project.sequences[1].captionTracks![0].items[0].style = { version: 1, params: { bold: 'yes' } }
    expect(() => createProjectFileSnapshot(project, [])).toThrow(/bold/)
    expect(sequenceProjectWithinEditBudget(project)).toBe(false)
    const orphan = captionIntentProject()
    delete orphan.sequences[0].captionTracks![0].origin
    expect(() => createProjectFileSnapshot(orphan, [])).toThrow(/requires/)
  })
})
