import { beforeEach, describe, expect, it } from 'vitest'
import { createCaptionTrack } from '../domain/captions'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { useDocumentStore } from './documentStore'

describe('caption document-store history', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(
      createTimelineDoc('Captions', DEFAULT_PROJECT_SETTINGS, 'doc'),
    )
  })

  it('makes track, cue, split, merge, and batch edits independently undoable', () => {
    const store = useDocumentStore.getState()
    store.addCaptionTrack(createCaptionTrack('track-1', 'English', 'en'))
    store.addCaptionItem('track-1', {
      id: 'cue-1',
      range: { startFrame: 10, durationFrames: 20 },
      text: 'Hello',
    })
    store.splitCaptionItem('track-1', 'cue-1', 20, 'cue-2')
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items).toHaveLength(2)

    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items).toHaveLength(1)
    useDocumentStore.getState().redo()
    useDocumentStore.getState().mergeCaptionWithNext('track-1', 'cue-1')
    useDocumentStore.getState().shiftCaptionItems('track-1', null, 5)

    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items[0]).toMatchObject({
      id: 'cue-1',
      range: { startFrame: 15, durationFrames: 20 },
      text: 'Hello\nHello',
    })
    expect(useDocumentStore.getState().past).toHaveLength(5)
  })

  it('commits imported whole-document replacements through normal history', () => {
    const before = useDocumentStore.getState().doc
    const next = {
      ...before,
      captionTracks: [createCaptionTrack('track-1', 'Imported')],
    }
    useDocumentStore.getState().setDocWithHistory(next)
    expect(useDocumentStore.getState().doc).toBe(next)
    expect(useDocumentStore.getState().past.at(-1)?.sequences[0]).toBe(before)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc).toBe(before)
  })
})
