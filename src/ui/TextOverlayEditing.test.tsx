import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTextClip, insertClip } from '../domain/operations'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { findClip } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import Inspector from './Inspector'
import TextOverlayDialog from './TextOverlayDialog'

function emptyDoc() {
  return createTimelineDoc('Text UI', DEFAULT_PROJECT_SETTINGS, 'doc-text-ui')
}

beforeEach(() => {
  useDocumentStore.setState({ doc: emptyDoc(), past: [], future: [] })
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('text overlay editing UI', () => {
  test('adds a chosen title range and selects it without requiring media', () => {
    const onClose = vi.fn()
    render(<TextOverlayDialog onClose={onClose} />)

    fireEvent.change(screen.getByLabelText('Text'), {
      target: { value: 'Creator callout' },
    })
    fireEvent.change(screen.getByLabelText('Start frame'), {
      target: { value: '42' },
    })
    fireEvent.change(screen.getByLabelText('Duration (frames)'), {
      target: { value: '75' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))

    const clip = useDocumentStore.getState().doc.tracks[0].clips[0]
    expect(clip).toMatchObject({
      name: 'Creator callout',
      timelineRange: { startFrame: 42, durationFrames: 75 },
      text: { content: 'Creator callout' },
    })
    expect(useTransportStore.getState().selectedClipId).toBe(clip.id)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('reports an overlapping range instead of silently moving it', () => {
    const first = createTextClip(emptyDoc(), 0, 90, 'First')
    useDocumentStore.setState({
      doc: insertClip(emptyDoc(), 'V1', first),
      past: [],
      future: [],
    })
    render(<TextOverlayDialog onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Start frame'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))

    expect(screen.getByRole('alert')).toHaveTextContent(/overlaps another clip/i)
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(1)
  })

  test('commits content and style edits once, and explains invalid geometry', () => {
    const clip = createTextClip(emptyDoc(), 0, 90, 'Before')
    useDocumentStore.setState({
      doc: insertClip(emptyDoc(), 'V1', clip),
      past: [],
      future: [],
    })
    useTransportStore.getState().setSelectedClip(clip.id)
    render(<Inspector />)

    const content = screen.getByTestId('inspector-text-content')
    fireEvent.change(content, { target: { value: 'After' } })
    expect(findClip(useDocumentStore.getState().doc, clip.id)?.text?.content).toBe('Before')
    fireEvent.blur(content)
    expect(findClip(useDocumentStore.getState().doc, clip.id)?.text?.content).toBe('After')
    expect(useDocumentStore.getState().past).toHaveLength(1)

    fireEvent.change(screen.getByTestId('inspector-text-font'), {
      target: { value: 'monospace' },
    })
    expect(findClip(useDocumentStore.getState().doc, clip.id)?.text?.fontFamily).toBe('monospace')

    const width = screen.getByTestId('inspector-text-width')
    fireEvent.change(width, { target: { value: '1' } })
    fireEvent.blur(width)
    expect(screen.getByRole('alert')).toHaveTextContent(/width must be from/i)
    expect(findClip(useDocumentStore.getState().doc, clip.id)?.text?.boxWidthPx).not.toBe(1)
  })

  test('deletes a selected overlay and clears its selected state', () => {
    const clip = createTextClip(emptyDoc(), 0, 90, 'Delete me')
    useDocumentStore.setState({
      doc: insertClip(emptyDoc(), 'V1', clip),
      past: [],
      future: [],
    })
    useTransportStore.getState().setSelectedClip(clip.id)
    render(<Inspector />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete text overlay' }))
    expect(findClip(useDocumentStore.getState().doc, clip.id)).toBeNull()
    expect(useTransportStore.getState().selectedClipId).toBeNull()
  })
})
