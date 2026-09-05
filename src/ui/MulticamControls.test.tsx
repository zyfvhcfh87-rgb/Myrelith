import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMulticamSelectionStore } from '../state/multicamSelectionStore'
import { useTransportStore } from '../state/transportStore'
import MulticamControls from './MulticamControls'

function descriptor(id: string, fileName: string): PortableAssetDescriptor {
  return {
    id,
    fileName,
    mimeType: 'video/mp4',
    size: 1_000,
    lastModified: 1,
    kind: 'video',
    durationMicroseconds: 4_000_000,
    sourceBounds: {
      video: { status: 'unknown' },
      audio: { status: 'unknown' },
    },
    nativeFrameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }
}

describe('MulticamControls', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(createTimelineDoc(
      'Main edit',
      DEFAULT_PROJECT_SETTINGS,
      'multicam-ui-root',
    ))
    useMediaStore.getState().replaceAssets([
      descriptor('wide', 'Wide.mp4'),
      descriptor('close', 'Close.mp4'),
      descriptor('roam', 'Roam.mp4'),
    ], [])
    useMulticamSelectionStore.getState().setSelectedInstanceId(null)
    useTransportStore.getState().resetTransport()
  })

  test('creates a bounded manual-sync group and authors cuts by button and shortcut', () => {
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))
    fireEvent.change(screen.getByLabelText('Multicam name'), {
      target: { value: 'Concert' },
    })
    fireEvent.change(screen.getByLabelText('Sync frame for Wide.mp4'), {
      target: { value: '5' },
    })
    fireEvent.change(screen.getByLabelText('Sync frame for Close.mp4'), {
      target: { value: '10' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create multicam' }))

    const state = useDocumentStore.getState()
    expect(state.project.multicams).toHaveLength(1)
    expect(state.doc.tracks.find((track) => track.id === 'V1')?.multicamInstances)
      .toHaveLength(1)
    expect(state.doc.tracks.find((track) => track.id === 'A1')?.multicamInstances)
      .toHaveLength(1)
    const definition = state.project.multicams![0]

    act(() => useTransportStore.getState().setPlayheadFrame(20))
    fireEvent.click(screen.getByRole('button', { name: 'Cut to Close.mp4' }))
    expect(useDocumentStore.getState().project.multicams![0].switches).toEqual([
      { frame: 0, videoAngleId: definition.angles[0].id },
      { frame: 20, videoAngleId: definition.angles[1].id },
    ])

    act(() => useTransportStore.getState().setPlayheadFrame(30))
    fireEvent.keyDown(window, { key: '1', altKey: true })
    expect(useDocumentStore.getState().project.multicams![0].switches.at(-1))
      .toEqual({ frame: 30, videoAngleId: definition.angles[0].id })
    expect(screen.getByRole('button', { name: 'Cut to Wide.mp4' }))
      .toHaveAttribute('aria-keyshortcuts', 'Alt+1')
  })

  test('cancels setup without changing project history', () => {
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel multicam setup' }))
    expect(useDocumentStore.getState().project.multicams).toEqual([])
    expect(useDocumentStore.getState().past).toEqual([])
  })

  test('keeps a fixed audio source attached to its angle when earlier choices change', () => {
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Roam.mp4' }))
    const fixedRoam = screen.getByRole('option', { name: 'Fixed: Roam.mp4' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Initial audio policy' }), {
      target: { value: fixedRoam.getAttribute('value') },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wide.mp4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create multicam' }))

    const definition = useDocumentStore.getState().project.multicams?.[0]
    expect(definition?.angles.map((angle) => angle.name)).toEqual([
      'Close.mp4',
      'Roam.mp4',
    ])
    expect(definition?.audioPolicy).toEqual({
      kind: 'fixed',
      angleId: definition?.angles[1].id,
    })
  })

  test('rejects setup deterministically when a selected source disappears', () => {
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))

    act(() => useMediaStore.getState().replaceAssets([
      descriptor('wide', 'Wide.mp4'),
      descriptor('roam', 'Roam.mp4'),
    ], []))
    fireEvent.click(screen.getByRole('button', { name: 'Create multicam' }))

    expect(screen.getByRole('status', { name: 'Multicam edit status' })).toHaveTextContent(
      'A selected angle is no longer available. Choose available video sources again.',
    )
    expect(useDocumentStore.getState().project.multicams).toEqual([])
  })

  test('closes an in-progress setup when the project is replaced', () => {
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))

    act(() => useDocumentStore.getState().setDoc(createTimelineDoc(
      'Replacement',
      DEFAULT_PROJECT_SETTINGS,
      'multicam-ui-replacement',
    )))

    expect(screen.queryByLabelText('Multicam name')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Multicam edit status' })).toHaveTextContent(
      'Multicam setup closed because the active project changed.',
    )
  })

  test('guards and keyboard-rolls the preceding cut at the playhead', () => {
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create multicam' }))

    act(() => useTransportStore.getState().setPlayheadFrame(20))
    fireEvent.click(screen.getByRole('button', { name: 'Cut to Close.mp4' }))
    const definitionBefore = useDocumentStore.getState().project.multicams![0]

    act(() => useTransportStore.getState().setPlayheadFrame(500))
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(useDocumentStore.getState().project.multicams![0]).toBe(definitionBefore)
    expect(screen.getByRole('status', { name: 'Multicam edit status' })).toHaveTextContent(
      'Place the playhead inside the multicam item before rolling a cut.',
    )

    act(() => useTransportStore.getState().setPlayheadFrame(20))
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(useDocumentStore.getState().project.multicams![0].switches).toEqual([
      expect.objectContaining({ frame: 0 }),
      expect.objectContaining({ frame: 19 }),
    ])
    expect(screen.getByRole('button', { name: 'Roll preceding cut earlier' }))
      .toHaveAttribute('aria-keyshortcuts', 'Alt+Shift+ArrowLeft')
  })

  test('makes shared definition controls read-only while any owning lane is locked', () => {
    render(<MulticamControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New multicam' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create multicam' }))
    const project = useDocumentStore.getState().project

    act(() => useDocumentStore.getState().setProject({
      ...project,
      sequences: project.sequences.map((sequence) => ({
        ...sequence,
        tracks: sequence.tracks.map((track) => (
          track.id === 'A1' ? { ...track, locked: true } : track
        )),
      })),
    }))

    expect(screen.getByRole('note')).toHaveTextContent(
      'Unlock every lane that uses this multicam',
    )
    expect(screen.getByRole('button', { name: 'Cut to Wide.mp4' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Multicam audio policy' })).toBeDisabled()
  })
})
