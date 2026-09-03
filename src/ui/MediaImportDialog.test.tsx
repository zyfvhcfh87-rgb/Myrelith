import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useEditShortcuts } from '../app/useEditShortcuts'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import {
  cancelMediaImport,
  dismissMediaImportError,
  resolveMediaImportDecision,
} from '../app/mediaImportController'
import {
  INITIAL_MEDIA_IMPORT_STATE,
  useMediaImportStore,
} from '../state/mediaImportStore'
import MediaImportDialog from './MediaImportDialog'

vi.mock('../app/mediaImportController', () => ({
  importMedia: vi.fn(),
  cancelMediaImport: vi.fn(),
  dismissMediaImportError: vi.fn(),
  resolveMediaImportDecision: vi.fn(),
}))

beforeEach(() => {
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
  vi.clearAllMocks()
})

describe('MediaImportDialog', () => {
  test('shows analysis status and makes cancellation explicit', () => {
    useMediaImportStore.setState({
      phase: 'analyzing',
      fileName: 'camera.mp4',
      prompt: null,
      error: null,
    })
    render(<MediaImportDialog />)

    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Checking media compatibility…',
    )
    expect(screen.getByRole('status')).toHaveTextContent('camera.mp4')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
    expect(cancelMediaImport).toHaveBeenCalledOnce()
  })

  test('presents exact project/source rates and all three decisions', () => {
    useMediaImportStore.setState({
      phase: 'awaiting-decision',
      fileName: 'cinema.mp4',
      prompt: {
        fileName: 'cinema.mp4',
        projectRate: { num: 30_000, den: 1_001 },
        sourceRate: { num: 60_000, den: 1_001 },
        canMatchSource: true,
        matchUnavailableReason: null,
      },
      error: null,
    })
    render(<MediaImportDialog />)

    expect(screen.getByText('29.97 fps')).toBeInTheDocument()
    expect(screen.getByText('59.94 fps')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep 29.97 fps' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Use 59.94 fps' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep 29.97 fps' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
    expect(resolveMediaImportDecision).toHaveBeenNthCalledWith(
      1,
      'match-source-rate',
    )
    expect(resolveMediaImportDecision).toHaveBeenNthCalledWith(
      2,
      'keep-project-rate',
    )
    expect(resolveMediaImportDecision).toHaveBeenNthCalledWith(3, 'cancel')
  })

  test('keeps Match visible but disabled with a useful reason', () => {
    const reason = 'Matching is unavailable after clips have been added to the timeline.'
    useMediaImportStore.setState({
      phase: 'awaiting-decision',
      fileName: 'fast.mp4',
      prompt: {
        fileName: 'fast.mp4',
        projectRate: { num: 30, den: 1 },
        sourceRate: { num: 60, den: 1 },
        canMatchSource: false,
        matchUnavailableReason: reason,
      },
      error: null,
    })
    render(<MediaImportDialog />)

    const match = screen.getByRole('button', { name: 'Use 60 fps' })
    expect(match).toBeDisabled()
    expect(match).toHaveAttribute('title', reason)
    expect(screen.getByText(new RegExp(reason))).toBeInTheDocument()
  })

  test('Escape dismisses a visible import error', () => {
    useMediaImportStore.setState({
      phase: 'error',
      fileName: 'broken.mp4',
      prompt: null,
      error: 'Could not import "broken.mp4": unsupported container',
    })
    render(<MediaImportDialog />)

    const dialog = screen.getByRole('dialog')
    const leakedShortcut = vi.fn()
    window.addEventListener('keydown', leakedShortcut)
    expect(screen.getByRole('alert')).toHaveTextContent('unsupported container')
    fireEvent.keyDown(dialog, { key: 's' })
    expect(leakedShortcut).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(dismissMediaImportError).toHaveBeenCalledOnce()
    window.removeEventListener('keydown', leakedShortcut)
  })

  test('traps Tab and Shift+Tab inside the dialog', () => {
    useMediaImportStore.setState({
      phase: 'awaiting-decision',
      fileName: 'cinema.mp4',
      prompt: {
        fileName: 'cinema.mp4',
        projectRate: { num: 30, den: 1 },
        sourceRate: { num: 60, den: 1 },
        canMatchSource: true,
        matchUnavailableReason: null,
      },
      error: null,
    })
    render(
      <>
        <button type="button">Outside</button>
        <MediaImportDialog />
      </>,
    )

    const cancel = screen.getByRole('button', { name: 'Cancel import' })
    const keep = screen.getByRole('button', { name: 'Keep 30 fps' })
    keep.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(cancel).toHaveFocus()

    cancel.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(keep).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Outside' })).not.toHaveFocus()
  })

  test('restores focus to the opener when the dialog closes', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Import media'
    document.body.appendChild(opener)
    opener.focus()
    expect(opener).toHaveFocus()

    useMediaImportStore.setState({
      phase: 'error',
      fileName: 'broken.mp4',
      prompt: null,
      error: 'Could not import "broken.mp4": unsupported container',
    })
    const { rerender } = render(<MediaImportDialog />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
    rerender(<MediaImportDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  test('blocks global edit shortcuts while the import dialog is open', () => {
    function Host() {
      useEditShortcuts()
      return <MediaImportDialog />
    }
    const clip = (id: string): Clip => ({
      id,
      assetId: 'asset-1',
      name: id,
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 50 },
      timelineRange: { startFrame: 100, durationFrames: 50 },
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1,
      volume: 1,
      effects: [],
    })
    const track = (id: string, clips: Clip[]): Track => ({
      id,
      kind: 'video',
      name: id,
      clips,
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    })
    const document: TimelineDoc = {
      schemaVersion: 19,
      id: 'doc-import-a11y',
      name: 'import a11y',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks: [track('V1', [clip('clipA')])],
    }
    useDocumentStore.getState().setDoc(document)
    useTransportStore.setState({
      playheadFrame: 120,
      isPlaying: false,
      isScrubbing: false,
      zoom: 1,
      inOut: null,
      dragPreview: null,
      tool: 'select',
      selectedClipId: 'clipA',
      selectedClipIds: ['clipA'],
      selectedMarkerId: null,
      editingMarkerId: null,
      editPreview: null,
    })
    useProjectSessionStore.setState({
      ...INITIAL_PROJECT_SESSION_STATE,
      screen: 'editor',
    })
    useMediaImportStore.setState({
      phase: 'awaiting-decision',
      fileName: 'cinema.mp4',
      prompt: {
        fileName: 'cinema.mp4',
        projectRate: { num: 30, den: 1 },
        sourceRate: { num: 60, den: 1 },
        canMatchSource: true,
        matchUnavailableReason: null,
      },
      error: null,
    })
    render(<Host />)

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 't',
      bubbles: true,
      cancelable: true,
    }))
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 's',
      bubbles: true,
      cancelable: true,
    }))
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    }))

    expect(useTransportStore.getState().tool).toBe('select')
    expect(useDocumentStore.getState().doc.tracks[0]?.clips).toHaveLength(1)
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })
})
