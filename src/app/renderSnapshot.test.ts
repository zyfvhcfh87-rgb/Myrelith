import { afterEach, describe, expect, test } from 'vitest'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from '../domain/projectFile'
import { createTimelineDoc } from '../domain/projectSettings'
import { sequenceProjectFromTimeline, type SequenceProject } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  clearActiveLocalProjectBindingId,
  setActiveLocalProjectBindingId,
} from './localProjectProvenance'
import { captureRenderSnapshot } from './renderSnapshot'

afterEach(() => {
  clearActiveLocalProjectBindingId()
})

describe('render snapshot revisions', () => {
  test('keeps one digest across portable project round trips', async () => {
    const document = structuredClone(createTimelineDoc('Digest', {
      width: 1280,
      height: 720,
      frameRate: { num: 30_000, den: 1_001 },
      audioSampleRate: 96_000,
    }, 'digest-sequence'))
    document.markers = [{
      id: 'marker',
      frame: 4,
      label: 'In',
      color: 'blue',
    }]
    const project = sequenceProjectFromTimeline(document)

    const serialized = serializeProjectFile(createProjectFileSnapshot(project, []))
    const reopened = parseProjectFile(serialized)
    const recovered: SequenceProject = {
      id: reopened.id,
      name: reopened.name,
      rootSequenceId: reopened.rootSequenceId,
      sequences: reopened.sequences,
      multicams: reopened.multicams,
      colorLuts: reopened.colorLuts,
    }

    useMediaStore.getState().clearAssets()
    setActiveLocalProjectBindingId('local-project:digest')
    useDocumentStore.getState().setProject(project)
    const original = await captureRenderSnapshot()
    useDocumentStore.getState().setProject(recovered)
    const reopenedSnapshot = await captureRenderSnapshot()
    expect(reopenedSnapshot.project).toBe(recovered)
    expect(reopenedSnapshot.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(reopenedSnapshot.revision).toBe(original.revision)
  })
})
