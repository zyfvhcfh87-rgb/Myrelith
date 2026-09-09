import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCaptionTrack } from '../domain/captions'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import CaptionEditor from './CaptionEditor'

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
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'all' } })
    const before = useDocumentStore.getState().doc
    fireEvent.click(screen.getByRole('button', { name: 'Review shift' }))
    expect(useDocumentStore.getState().doc).toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'Apply caption edit' }))
    expect(useDocumentStore.getState().doc.captionTracks?.[0]?.items[0]?.range.startFrame).toBe(3)
    act(() => useDocumentStore.getState().undo())
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

  it.each(['SRT', 'VTT', 'ASS'])('reviews %s download losses and restores focus on cancel', format => {
    render(<CaptionEditor onClose={vi.fn()} />)
    const before = useDocumentStore.getState().project
    const trigger = screen.getByRole('button', { name: `Export ${format}` })
    fireEvent.click(trigger)
    expect(screen.getByRole('heading', { name: 'Review caption download' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Download caption file' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'I accept the disclosed download losses' }))
    expect(screen.getByRole('button', { name: 'Download caption file' })).toBeEnabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(useDocumentStore.getState().project).toBe(before)
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('reads an SRT locally, reviews replacement loss, and applies one undoable edit', async () => {
    render(<CaptionEditor onClose={vi.fn()} />)
    const before = useDocumentStore.getState()
    const file = new File(['1\n00:00:00,000 --> 00:00:01,000\nImported words\n'], 'captions.srt')
    fireEvent.change(screen.getByLabelText('Import SRT/VTT/ASS'), { target: { files: [file] } })
    expect(await screen.findByRole('heading', { name: 'Review SRT import' })).toHaveFocus()
    expect(useDocumentStore.getState().project).toBe(before.project)
    const apply = screen.getByRole('button', { name: 'Apply caption edit' })
    expect(apply).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'I accept the disclosed caption losses' }))
    fireEvent.click(apply)
    expect(useDocumentStore.getState().doc.captionTracks![0]!.items.map(cue => cue.text)).toEqual(['Imported words'])
    expect(useDocumentStore.getState().past).toHaveLength(before.past.length + 1)
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
    act(() => useDocumentStore.getState().undo())
    expect(useDocumentStore.getState().project).toBe(before.project)
  })

  it('requires an explicit ASS font mapping and loss review before creating its track', async () => {
    render(<CaptionEditor onClose={vi.fn()} />)
    const before = useDocumentStore.getState().project
    const source = `[Script Info]
ScriptType: v4.00+
PlayResX: 2000
PlayResY: 1000
WrapStyle: 1
ScaledBorderAndShadow: yes
YCbCr Matrix: None
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Example Sans,50,&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,40,40,20,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Imported ASS`
    fireEvent.change(screen.getByLabelText('Import SRT/VTT/ASS'), { target: { files: [new File([source], 'captions.ass')] } })
    const mapping = await screen.findByLabelText('Replace “Example Sans”')
    expect(screen.getByRole('button', { name: 'Review font substitutions' })).toBeDisabled()
    fireEvent.change(mapping, { target: { value: 'serif' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review font substitutions' }))
    expect(screen.getByRole('heading', { name: 'Review ASS import' })).toHaveFocus()
    expect(useDocumentStore.getState().project).toBe(before)
    expect(screen.getByRole('button', { name: 'Apply caption edit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'I accept the disclosed caption losses' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply caption edit' }))
    const tracks = useDocumentStore.getState().doc.captionTracks!
    expect(tracks).toHaveLength(2)
    expect(tracks[1]!.style?.params.fontFamily).toBe('serif')
    expect(tracks[1]!.items[0]!.text).toBe('Imported ASS')
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('keeps modal keydowns from reaching window editor shortcuts', () => {
    render(<CaptionEditor onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Caption editor' })
    const leakedShortcut = vi.fn()
    window.addEventListener('keydown', leakedShortcut)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Save cue' }), {
      key: 'z',
      ctrlKey: true,
    })
    fireEvent.keyDown(screen.getByLabelText('Text'), {
      key: 'k',
      ctrlKey: true,
    })
    fireEvent.keyDown(dialog, { key: 'Delete' })

    expect(leakedShortcut).not.toHaveBeenCalled()
    window.removeEventListener('keydown', leakedShortcut)
  })

  it('reviews a keyboard range selection and applies exactly those cues as one undoable edit', () => {
    useDocumentStore.getState().setDoc(seededDoc(3))
    render(<CaptionEditor onClose={vi.fn()} />)
    const list = screen.getByRole('listbox', { name: 'Caption cues' })
    fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true })
    expect(within(list).getAllByRole('option', { selected: true })).toHaveLength(2)
    const button = screen.getByRole('button', { name: 'Review shift' })
    button.focus()
    const before = useDocumentStore.getState()
    fireEvent.click(button)
    const dialog = screen.getByRole('dialog', { name: 'Review caption shift' })
    expect(screen.getByRole('heading', { name: 'Review caption shift' })).toHaveFocus()
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(within(dialog).getByText('0–10: Caption 0')).toBeInTheDocument()
    expect(within(dialog).getByText('11–21: Caption 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply caption edit' }))
    expect(useDocumentStore.getState().doc.captionTracks![0]!.items.map(cue => cue.range.startFrame)).toEqual([1, 11, 20])
    expect(useDocumentStore.getState().past).toHaveLength(before.past.length + 1)
    expect(button).toHaveFocus()
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
    act(() => useDocumentStore.getState().undo())
    expect(useDocumentStore.getState().project).toBe(before.project)
  })

  it('cancels review with Escape, restores focus, and keeps its Tab cycle inside review', () => {
    const close = vi.fn()
    render(<CaptionEditor onClose={close} />)
    const button = screen.getByRole('button', { name: 'Review shift' })
    button.focus(); fireEvent.click(button)
    const heading = screen.getByRole('heading', { name: 'Review caption shift' })
    fireEvent.keyDown(heading, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: 'Apply caption edit' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Cancel review' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('prevents stale review Apply after a document replacement and releases review on unmount in StrictMode', () => {
    const view = render(<StrictMode><CaptionEditor onClose={vi.fn()} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Review shift' }))
    act(() => useDocumentStore.getState().setDoc(seededDoc(3)))
    expect(screen.queryByRole('button', { name: 'Apply caption edit' })).not.toBeInTheDocument()
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
    fireEvent.click(screen.getByRole('button', { name: 'Review shift' }))
    expect(Object.keys(useDocumentStore.getState().retainedCaptionOwners)).toHaveLength(1)
    view.unmount()
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('shows mixed styles, keeps unrelated values, and requires acceptance to remove opaque overrides', () => {
    const doc = seededDoc()
    const [first, second] = doc.captionTracks[0]!.items
    Object.assign(first!, { style: { version: 1, params: { color: '#ff0000ff', bold: false } } })
    Object.assign(second!, { style: { version: 1, params: { color: '#0000ffff', italic: false } } })
    useDocumentStore.getState().setDoc(doc)
    render(<CaptionEditor onClose={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'a', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Review style change' }))
    expect(screen.getByText(/Text color: #ff0000ff; Bold: Off; Italic: On/)).toBeInTheDocument()
    expect(screen.getByText(/Text color: #0000ffff; Italic: On/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply caption edit' }))
    expect(useDocumentStore.getState().doc.captionTracks![0]!.items[0]!.style?.params).toEqual({ color: '#ff0000ff', bold: false, italic: true })
    act(() => {
      const replacement = structuredClone(useDocumentStore.getState().doc)
      replacement.captionTracks![0]!.items[0]!.style = { version: 2, params: { future: 'secret-opaque-value' } }
      useDocumentStore.getState().setDoc(replacement)
    })
    fireEvent.click(screen.getByRole('option', { name: /0–10/u }))
    const before = useDocumentStore.getState().project
    fireEvent.click(screen.getByRole('button', { name: 'Review removal of overrides' }))
    expect(screen.getByRole('button', { name: 'Apply caption edit' })).toBeDisabled()
    expect(screen.getByText(/1 unavailable style override/)).toBeInTheDocument()
    expect(screen.queryByText(/secret-opaque-value/)).not.toBeInTheDocument()
    expect(useDocumentStore.getState().project).toBe(before)
    fireEvent.click(screen.getByLabelText('I accept the disclosed caption losses'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply caption edit' }))
    expect(useDocumentStore.getState().doc.captionTracks![0]!.items[0]!.style).toBeUndefined()
    act(() => useDocumentStore.getState().undo())
    expect(useDocumentStore.getState().project).toBe(before)
  })

  it('keeps selection with the newly split cue and supports sparse selection by toggling', () => {
    render(<CaptionEditor onClose={vi.fn()} />)
    act(() => useTransportStore.getState().setPlayheadFrame(5))
    fireEvent.click(screen.getByRole('button', { name: 'Split at playhead' }))
    const list = screen.getByRole('listbox')
    expect(within(list).getByRole('option', { selected: true })).toHaveTextContent('5–10')
    fireEvent.click(within(list).getByRole('option', { name: /10–20/u }), { ctrlKey: true })
    expect(list).toHaveFocus()
    expect(within(list).getAllByRole('option', { selected: true })).toHaveLength(2)
    fireEvent.keyDown(list, { key: ' ' })
    expect(within(list).getAllByRole('option', { selected: true })).toHaveLength(1)
  })
})
