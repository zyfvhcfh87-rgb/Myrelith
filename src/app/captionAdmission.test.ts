import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CaptionEditSession } from './captionEditingController'
import { CaptionFileController } from './captionFileController'
import { commitPortableProjectEdit } from './portableProjectEdit'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { captionIntentOwners, captionRetentionError } from '../domain/captionIntentBudget'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from '../domain/projectFile'
import { captionBudgetProject, captionIntentProject } from '../test/captionIntentFixtures'
import { exactLegacyTitleFile, titleProjectFromFile } from '../test/titleFileBoundaryFixtures'
import { ATTRIBUTE_ASSET_DESCRIPTOR } from '../test/animationFoundationFixtures'
import { createCaptionTrack } from '../domain/captions'
import { planCaptionAssExport } from '../domain/captionAss'

const sessions: CaptionEditSession[] = []
function begin() { const session = new CaptionEditSession(); sessions.push(session); return session }
beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useDocumentStore.getState().setProject(captionIntentProject())
})
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); useDocumentStore.setState({ retainedCaptionOwners: {} }) })

describe('whole-project caption review and retention', () => {
  it('previews without history changes and applies exactly one undoable edit with origin preserved on reopen', () => {
    const source = useDocumentStore.getState().project, session = begin()
    const review = session.prepareBatch('captions', { kind: 'selected', ids: ['cue-a'] }, { kind: 'split', plans: [
      { itemId: 'cue-a', frame: 10, textOffset: 5, rightId: 'split-right' },
    ] })!
    expect(useDocumentStore.getState().project).toBe(source)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    expect(review.preview[0].after.map((cue) => cue.text)).toEqual(['Hello', 'world'])
    expect(Object.isFrozen(review.preview[0].after[0].origin?.params)).toBe(true)
    expect(session.apply(review)).toBeNull()
    const applied = useDocumentStore.getState().project
    expect(useDocumentStore.getState().past).toEqual([source])
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
    useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(source)
    useDocumentStore.getState().redo(); expect(useDocumentStore.getState().project).toBe(applied)
    const saved = parseProjectFile(serializeProjectFile(createProjectFileSnapshot(applied, [])))
    useDocumentStore.getState().setProject(saved)
    expect(useDocumentStore.getState().doc.captionTracks![0].items[1].origin).toEqual(source.sequences[0].captionTracks![0].items[0].origin)
  })
  it.each(['dormant', 'generation', 'navigation'] as const)('rejects a stale %s change without clearing redo', (kind) => {
    const session = begin(), review = session.prepareStyle('captions', null, { version: 1, params: { italic: true } })!
    const state = useDocumentStore.getState()
    if (kind === 'dormant') useDocumentStore.setState({ project: { ...state.project, name: 'Changed dormant project' } })
    else if (kind === 'generation') state.setProject(state.project)
    else state.switchSequence('dormant')
    const before = useDocumentStore.getState()
    expect(session.apply(review)).toMatch(/project changed/)
    expect(useDocumentStore.getState()).toBe(before)
  })
  it('bounds ID factories and reserves dormant cues, tracks and other entity categories', () => {
    const session = begin()
    expect(() => session.createId(() => 'dormant-cue')).toThrow(/100 attempts/)
    expect(() => session.prepareBatch('captions', { kind: 'selected', ids: ['cue-a'] }, { kind: 'split', plans: [
      { itemId: 'cue-a', frame: 10, textOffset: 5, rightId: 'dormant' },
    ] })).toThrow(/reserved/)
    const id = session.createId(() => 'fresh', 'dormant-cue')
    expect(id).toBe('fresh')
    expect(() => session.createId(() => 'fresh')).toThrow(/100 attempts/)
  })
  it('invalidates replaced/no-op reviews and retains old owners on failed replacement', () => {
    const session = begin(), old = session.prepareStyle('captions', null, { version: 1, params: { italic: true } })!
    const before = useDocumentStore.getState()
    expect(() => session.prepareStyle('captions', null, { version: 1, params: { italic: 'yes' } })).toThrow(/italic/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(session.prepareBatch('captions', { kind: 'all' }, { kind: 'shift', deltaFrames: 0 })).toBeNull()
    expect(session.apply(old)).toMatch(/replaced/)
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })
  it('counts actual dormant payload, both history branches and separate clipboard occurrences at 32 MiB and one byte over', () => {
    const project = captionBudgetProject(2_097_152), half = captionBudgetProject(1_048_576), halfPlus = captionBudgetProject(1_048_577)
    for (const source of [project, half, halfPlus]) expect(parseProjectFile(serializeProjectFile(createProjectFileSnapshot(source, []))).sequences).toHaveLength(2)
    useDocumentStore.getState().setProject(project)
    const past = Array.from({ length: 7 }, (_, i) => ({ ...project, name: `Past ${i}` }))
    const future = Array.from({ length: 6 }, (_, i) => ({ ...project, name: `Future ${i}` }))
    const clipboardA = captionIntentOwners(half), clipboardB = captionIntentOwners(halfPlus)
    useDocumentStore.setState({ past, future, retainedCaptionOwners: { clipboardA, clipboardB } })
    const candidate = { ...project, name: 'One edit' }, before = useDocumentStore.getState()
    expect(captionRetentionError(before)).toBeNull()
    expect(commitPortableProjectEdit(project, before.projectGeneration, candidate)).toMatch(/32 MiB/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(useDocumentStore.getState().future).toBe(future)
    useDocumentStore.setState({ retainedCaptionOwners: { clipboardA, clipboardB: captionIntentOwners(half) } })
    expect(captionRetentionError(useDocumentStore.getState(), candidate)).toBeNull()
    expect(commitPortableProjectEdit(project, before.projectGeneration, candidate)).toBeNull()
    expect(useDocumentStore.getState().past.at(-1)).toBe(project)
    expect(useDocumentStore.getState().future).toEqual([])
  })
  it('charges captures and preview copies, preserves prior owners on rejection, and checks undo/redo without charging a moved snapshot twice', () => {
    const project = captionBudgetProject(2_097_152)
    useDocumentStore.getState().setProject(project)
    useDocumentStore.setState({ past: Array.from({ length: 7 }, () => project), future: Array.from({ length: 7 }, () => project), retainedCaptionOwners: {} })
    const session = begin() // current + 14 histories + captured project = exactly 32 MiB
    const captured = useDocumentStore.getState()
    expect(captionRetentionError(captured)).toBeNull()
    expect(() => begin()).toThrow(/32 MiB/)
    expect(() => session.prepareStyle('root-captions', null, { version: 1, params: { italic: true } })).toThrow(/project limits/)
    expect(useDocumentStore.getState()).toBe(captured)
    captured.undo()
    expect(useDocumentStore.getState().past).toHaveLength(6)
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().past).toHaveLength(7)
    // An externally over-budget retained owner cannot make undo silently discard it.
    useDocumentStore.setState({ retainedCaptionOwners: { ...captured.retainedCaptionOwners, excess: [{ style: { version: 9, params: {} } }] } })
    const before = useDocumentStore.getState()
    before.undo(); expect(useDocumentStore.getState()).toBe(before)
    before.redo(); expect(useDocumentStore.getState()).toBe(before)
  })
  it('revalidates the complete current media envelope at Apply, after the preview passed', () => {
    const file = parseProjectFile(exactLegacyTitleFile(9_998_000))
    const project = titleProjectFromFile(file), root = project.sequences[0]
    project.sequences[0] = { ...root, captionTracks: [{ ...createCaptionTrack('captions', 'Captions'), items: [
      { id: 'cue', text: 'Hello', range: { startFrame: 0, durationFrames: 10 } },
    ] }] }
    useMediaStore.setState({ descriptors: new Map([[ATTRIBUTE_ASSET_DESCRIPTOR.id, ATTRIBUTE_ASSET_DESCRIPTOR]]) })
    useDocumentStore.getState().setProject(project)
    const session = begin(), review = session.prepareStyle('captions', null, { version: 1, params: { italic: true } })!
    const before = useDocumentStore.getState()
    useMediaStore.setState({ descriptors: new Map([[ATTRIBUTE_ASSET_DESCRIPTOR.id, { ...ATTRIBUTE_ASSET_DESCRIPTOR, fileName: 'x'.repeat(4096) }]]) })
    expect(session.apply(review)).toMatch(/serialized|characters|10000000/i)
    expect(useDocumentStore.getState()).toBe(before)
  }, 30_000)
  it('requires explicit new style/origin loss acceptance before a plain subtitle download', () => {
    const downloads: string[] = [], controller = new CaptionFileController({ createId: () => 'unused', download: (_name, _type, content) => downloads.push(content) })
    expect(() => controller.exportTrack('captions', 'srt')).toThrow(/omit.*style.*origin/)
    expect(downloads).toEqual([])
    controller.exportTrack('captions', 'srt', true)
    expect(downloads).toHaveLength(1)
    expect(useDocumentStore.getState().doc.captionTracks![0].origin).toBeDefined()
  })
  it('keeps ASS import pending until its exact loss review is accepted, with no empty lane on rejection', async () => {
    const planned = planCaptionAssExport({ stylePreset: 'minimal', scriptWidth: 2000, scriptHeight: 1000,
      style: { version: 1, params: { fontFamily: 'sans-serif', fontSizePermille: 50, color: '#ffffffff', outlineColor: '#000000ff',
        backgroundColor: '#000000ff', bold: false, italic: false, backgroundEnabled: false, outlineEnabled: true, shadowEnabled: false,
        outlinePermille: 2, align: 'center', position: 'bottom', marginXPermille: 20, marginYPermille: 20 } },
      items: [{ id: 'import', text: 'Imported', range: { startFrame: 60, durationFrames: 30 } }],
    }, useDocumentStore.getState().doc.frameRate)
    expect(planned.kind).not.toBe('rejected')
    if (planned.kind === 'rejected') return
    const text = planned.text.split('\n').map((line) => {
      if (!line.startsWith('Style: ')) return line
      const columns = line.slice(7).split(','); columns[17] = '2'
      return `Style: ${columns.join(',')}`
    }).join('\n')
    const file = { size: text.length, text: async () => text } as File
    let serial = 0
    const controller = new CaptionFileController({ createId: (prefix) => `${prefix}-${++serial}`, download: () => { throw new Error('Unexpected download') } })
    const source = useDocumentStore.getState().project
    const prepared = await controller.prepareAssImport(file, { name: 'ASS', language: 'en', role: 'subtitles', stylePreset: 'classic' })
    if (prepared.kind !== 'review' && prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared.report))
    sessions.push(prepared.session)
    expect(prepared.kind).toBe('review')
    const before = useDocumentStore.getState()
    expect(prepared.session.apply(prepared.review)).toMatch(/Accept.*losses/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(prepared.session.apply(prepared.review, true)).toBeNull()
    expect(useDocumentStore.getState().past).toEqual([source])
    const track = useDocumentStore.getState().doc.captionTracks!.at(-1)!
    expect(track.id).toBe(prepared.trackId)
    expect(track.style?.params.shadowEnabled).toBe(false)
    expect(track.items[0].text).toBe('Imported')
  })
})
