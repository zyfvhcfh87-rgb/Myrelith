import { beforeEach, describe, expect, test } from 'vitest'
import { createTextClip, insertClip } from '../domain/operations'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { findClip } from '../domain/selectors'
import { clipVisualSettings } from '../domain/clipInspector'
import { useDocumentStore } from './documentStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from './transportStore'

function textDocument() {
  const empty = createTimelineDoc('Store text', DEFAULT_PROJECT_SETTINGS, 'doc-store-text')
  const clip = createTextClip(empty, 0, 90, 'Before')
  return { clip, doc: insertClip(empty, 'V1', clip) }
}

beforeEach(() => {
  const { doc } = textDocument()
  useDocumentStore.getState().setDoc(doc)
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
})

describe('text overlay stores', () => {
  test('one text edit is one undoable document commit', () => {
    const clipId = useDocumentStore.getState().doc.tracks[0].clips[0].id
    useDocumentStore.getState().updateTextClip(clipId, {
      content: 'After',
      color: '#ff00aa',
    })
    expect(findClip(useDocumentStore.getState().doc, clipId)?.text).toMatchObject({
      content: 'After',
      color: '#ff00aa',
    })
    expect(useDocumentStore.getState().past).toHaveLength(1)

    useDocumentStore.getState().undo()
    expect(findClip(useDocumentStore.getState().doc, clipId)?.text?.content).toBe('Before')
    useDocumentStore.getState().redo()
    expect(findClip(useDocumentStore.getState().doc, clipId)?.text?.content).toBe('After')
  })

  test('preview geometry stays ephemeral and is defensively copied', () => {
    const clip = useDocumentStore.getState().doc.tracks[0].clips[0]
    const transform = { ...clip.transform, x: 55 }
    useTransportStore.getState().setTextOverlayPreview({ clipId: clip.id, transform })
    transform.x = 999

    expect(useTransportStore.getState().textOverlayPreview?.transform?.x).toBe(55)
    expect(findClip(useDocumentStore.getState().doc, clip.id)?.transform.x).toBe(0)
    expect(useDocumentStore.getState().past).toEqual([])

    useTransportStore.getState().resetTransport()
    expect(useTransportStore.getState().textOverlayPreview).toBeNull()
  })

  test('visual preview geometry stays ephemeral, deeply copied, and resettable', () => {
    const clip = useDocumentStore.getState().doc.tracks[0].clips[0]
    const transform = { ...clip.transform, rotation: 35 }
    const visual = {
      ...clipVisualSettings(clip),
      crop: { ...clipVisualSettings(clip).crop, left: 0.2 },
    }
    useTransportStore.getState().setClipVisualPreview({
      clipId: clip.id,
      transform,
      visual,
    })
    transform.rotation = 90
    visual.crop.left = 0.8

    expect(useTransportStore.getState().clipVisualPreview).toMatchObject({
      transform: { rotation: 35 },
      visual: { crop: { left: 0.2 } },
    })
    expect(findClip(useDocumentStore.getState().doc, clip.id)?.transform.rotation).toBe(0)
    expect(useDocumentStore.getState().past).toEqual([])

    useTransportStore.getState().resetTransport()
    expect(useTransportStore.getState().clipVisualPreview).toBeNull()
  })
})
