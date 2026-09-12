import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  cancelOtioInterchange,
  commitOtioImport,
  downloadStagedOtioExport,
  getOtioInterchangeSnapshot,
  resetOtioInterchangeForTests,
  setOtioDownloadHandlerForTests,
  stageOtioExport,
  stageOtioImport,
} from './otioInterchangeController'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/otio')

function otioFile(name: string, contents?: string): File {
  const text = contents ?? readFileSync(join(fixturesDir, name), 'utf8')
  return new File([text], name, { type: 'application/json' })
}

function resetEditor(): void {
  resetOtioInterchangeForTests()
  useDocumentStore.getState().setProject(
    sequenceProjectFromTimeline(
      createTimelineDoc('Untitled', DEFAULT_PROJECT_SETTINGS, 'doc_default'),
    ),
  )
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
    collections: [],
    collectionPast: [],
    collectionFuture: [],
  })
}

describe('otioInterchangeController', () => {
  afterEach(() => {
    resetEditor()
    vi.restoreAllMocks()
  })

  test('rejects otioz packages before mutating the project', async () => {
    resetEditor()
    const file = new File(['not json'], 'timeline.otioz', { type: 'application/zip' })
    await stageOtioImport(file)
    expect(getOtioInterchangeSnapshot().phase).toBe('error')
    expect(getOtioInterchangeSnapshot().error).toMatch(/otioz/i)
    expect(useDocumentStore.getState().project.sequences).toHaveLength(1)
  })

  test('stages a preview without mutating the project', async () => {
    resetEditor()
    await stageOtioImport(otioFile('simple_cut.otio'))
    const snap = getOtioInterchangeSnapshot()
    expect(snap.phase).toBe('preview')
    expect(snap.importPreview?.sequences).toHaveLength(1)
    expect(snap.importPreview?.sequences[0]?.clips).toBe(4)
    expect(snap.importPreview?.media).toHaveLength(4)
    expect(useDocumentStore.getState().project.sequences).toHaveLength(1)
    expect(useMediaStore.getState().descriptors.size).toBe(0)
  })

  test('commits imported sequences and offline media in one undoable edit', async () => {
    resetEditor()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await stageOtioImport(otioFile('simple_cut.otio'))
    commitOtioImport()
    const project = useDocumentStore.getState().project
    expect(getOtioInterchangeSnapshot().phase).toBe('idle')
    expect(project.sequences).toHaveLength(2)
    expect(
      [...useMediaStore.getState().descriptors.values()].some(
        (item) => item.fileName === 'titles.mov',
      ),
    ).toBe(true)
    expect(useDocumentStore.getState().activeSequenceId).toBe(project.sequences[1]!.id)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project.sequences).toHaveLength(1)
    expect(
      [...useMediaStore.getState().descriptors.values()].some(
        (item) => item.fileName === 'titles.mov',
      ),
    ).toBe(true)
  })

  test('leaves the project untouched when staging malformed JSON', async () => {
    resetEditor()
    await stageOtioImport(otioFile('bad.otio', '{'))
    expect(getOtioInterchangeSnapshot().phase).toBe('error')
    expect(getOtioInterchangeSnapshot().error).toMatch(/valid JSON/i)
    expect(useDocumentStore.getState().project.sequences).toHaveLength(1)
    expect(useMediaStore.getState().descriptors.size).toBe(0)
  })

  test('cancels a staged plan without committing', async () => {
    resetEditor()
    await stageOtioImport(otioFile('simple_cut.otio'))
    cancelOtioInterchange()
    expect(getOtioInterchangeSnapshot().phase).toBe('idle')
    expect(useDocumentStore.getState().project.sequences).toHaveLength(1)
  })

  test('drops a staged import when the project generation changes', async () => {
    resetEditor()
    await stageOtioImport(otioFile('simple_cut.otio'))
    useDocumentStore.getState().setProject(useDocumentStore.getState().project)
    expect(getOtioInterchangeSnapshot().phase).toBe('error')
    expect(getOtioInterchangeSnapshot().error).toMatch(/project changed/i)
  })

  test('stages an OTIO export with a loss report and downloads after review', () => {
    resetEditor()
    const downloads: Array<{ fileName: string; mediaType: string; content: string }> = []
    setOtioDownloadHandlerForTests((fileName, mediaType, content) => {
      downloads.push({ fileName, mediaType, content })
    })
    stageOtioExport()
    const snap = getOtioInterchangeSnapshot()
    expect(snap.phase).toBe('export-preview')
    expect(snap.exportPreview?.schemaLabel).toBe('0.17.0')
    expect(downloads).toHaveLength(0)
    downloadStagedOtioExport()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.fileName.endsWith('.otio')).toBe(true)
    expect(downloads[0]?.content).toContain('"OTIO_SCHEMA": "Timeline.1"')
    expect(getOtioInterchangeSnapshot().phase).toBe('idle')
  })
})
