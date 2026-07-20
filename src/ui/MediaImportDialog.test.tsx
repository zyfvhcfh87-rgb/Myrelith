import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
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
})
