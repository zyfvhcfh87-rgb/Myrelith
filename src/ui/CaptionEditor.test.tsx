import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCaptionTrack } from '../domain/captions'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import CaptionEditor from './CaptionEditor'

vi.mock('../app/captionFileController', () => ({
  captionFileController: {
    importIntoTrack: vi.fn(),
    importAsTrack: vi.fn(),
    exportTrack: vi.fn(),
  },
}))

function seededDoc(cueCount = 2) {
  const doc = createTimelineDoc('Captions', DEFAULT_PROJECT_SETTINGS, 'doc')
  return {
    ...doc,
    captionTracks: [{
      ...createCaptionTrack('track-1', 'English', 'en'),
      items: Array.from({ length: cueCount }, (_, index) => ({
        id: `cue-${index}`,
        range: { startFrame: index * 10, durationFrames: 10 },
        text: `Caption ${index}`,
      })),
    }],
  }
}

describe('CaptionEditor', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(seededDoc())
    useTransportStore.setState({ playheadFrame: 0, isPlaying: false })
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  it('exposes a labelled modal and keyboard cue navigation that seeks', () => {
    render(<CaptionEditor onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Caption editor' })).toBeInTheDocument()
    const list = screen.getByRole('listbox', { name: 'Caption cues' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })

    expect(screen.getByRole('option', { name: /10–20/u })).toHaveAttribute('aria-selected', 'true')
    expect(useTransportStore.getState().playheadFrame).toBe(10)
  })

  it('edits, splits, merges, shifts, and undoes through store actions', () => {
    render(<CaptionEditor onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save cue' }))
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items[0]?.text).toBe('Edited')

    act(() => useTransportStore.getState().setPlayheadFrame(5))
    fireEvent.click(screen.getByRole('button', { name: 'Split at playhead' }))
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Merge next' }))
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items).toHaveLength(2)

    fireEvent.change(screen.getByLabelText('Shift frames'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Shift all' }))
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items[0]?.range.startFrame).toBe(3)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items[0]?.range.startFrame).toBe(0)
  })

  it('allows intermediate track metadata drafts and validates on commit', () => {
    render(<CaptionEditor onClose={vi.fn()} />)
    const name = screen.getByLabelText('Name')
    const language = screen.getByLabelText('Language')

    fireEvent.change(name, { target: { value: '' } })
    fireEvent.change(language, { target: { value: 'e' } })
    expect(name).toHaveValue('')
    expect(language).toHaveValue('e')
    expect(useDocumentStore.getState().doc.captionTracks?.[0]).toMatchObject({
      name: 'English',
      language: 'en',
    })

    fireEvent.change(name, { target: { value: '  Spanish  ' } })
    fireEvent.blur(name)
    fireEvent.change(language, { target: { value: 'es-ES' } })
    fireEvent.blur(language)

    expect(useDocumentStore.getState().doc.captionTracks?.[0]).toMatchObject({
      name: 'Spanish',
      language: 'es-ES',
    })
  })

  it('bounds the rendered list while preserving total count and endpoint navigation', () => {
    useDocumentStore.getState().setDoc(seededDoc(250))
    render(<CaptionEditor onClose={vi.fn()} />)
    const list = screen.getByRole('listbox', { name: 'Caption cues' })

    expect(within(list).getAllByRole('option')).toHaveLength(200)
    expect(screen.getByText('250 total · 200 rendered')).toBeInTheDocument()
    fireEvent.keyDown(list, { key: 'End' })
    expect(useTransportStore.getState().playheadFrame).toBe(2_490)
    expect(screen.getByRole('option', { name: /2490–2500/u })).toHaveAttribute('aria-selected', 'true')
  })

  it('closes with Escape', () => {
    const onClose = vi.fn()
    render(<CaptionEditor onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
