import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TimelineDoc, TimelineMarker } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../../state/transportStore'
import Ruler from './Ruler'

function doc(markers: TimelineMarker[]): TimelineDoc {
  return {
    schemaVersion: 19,
    id: 'doc-marker-ui',
    name: 'Marker UI',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [],
    markers,
  }
}

const intro: TimelineMarker = {
  id: 'intro',
  frame: 30,
  label: 'Intro',
  color: 'blue',
  note: 'Opening beat',
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useDocumentStore.getState().setDoc(doc([intro]))
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE, zoom: 2, customZoom: 2 })
})

describe('timeline marker ruler UI', () => {
  test('selects, seeks, explicitly edits, and undo-restores a marker', async () => {
    const user = userEvent.setup()
    render(<Ruler />)
    const button = screen.getByRole('button', { name: /Intro, 00:00:01:00/ })

    await user.click(button)
    expect(useTransportStore.getState()).toMatchObject({
      selectedMarkerId: 'intro',
      playheadFrame: 30,
    })

    button.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('form', { name: 'Edit marker Intro' })).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Label'))
    await user.type(screen.getByLabelText('Label'), 'Chorus')
    await user.clear(screen.getByLabelText('Frame'))
    await user.type(screen.getByLabelText('Frame'), '120')
    await user.selectOptions(screen.getByLabelText('Color'), 'purple')
    await user.clear(screen.getByLabelText('Note'))
    await user.type(screen.getByLabelText('Note'), 'Cut on beat')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(useDocumentStore.getState().doc.markers).toEqual([{
      id: 'intro',
      frame: 120,
      label: 'Chorus',
      color: 'purple',
      note: 'Cut on beat',
    }])
    expect(screen.getByRole('button', { name: /Chorus, 00:00:04:00/ }))
      .toHaveAttribute('aria-pressed', 'true')

    act(() => useDocumentStore.getState().undo())
    expect(useDocumentStore.getState().doc.markers).toEqual([intro])
  })

  test('keeps marker controls keyboard-operable without scrubbing the ruler', () => {
    render(<Ruler />)
    const button = screen.getByRole('button', { name: /Intro/ })
    fireEvent.keyDown(button, { key: 'Delete' })
    expect(useDocumentStore.getState().doc.markers).toEqual([])
    expect(useTransportStore.getState().isScrubbing).toBe(false)
  })

  test('renders one clustered control for 20k equal-frame markers', () => {
    const markers: TimelineMarker[] = Array.from({ length: 20_000 }, (_, index) => ({
      id: `marker-${String(index).padStart(5, '0')}`,
      frame: 100,
      label: `Marker ${index}`,
      color: 'yellow',
    }))
    useDocumentStore.getState().setDoc(doc(markers))
    const { container } = render(<Ruler />)

    expect(container.querySelectorAll('.timeline-marker')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /20000 markers at this position/ }))
      .toBeInTheDocument()
  })
})
