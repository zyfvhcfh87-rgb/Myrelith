import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  cancelActiveMediaRelink,
  resolveActiveMediaAmbiguity,
  skipActiveMediaAmbiguity,
} from '../app/projectController'
import {
  INITIAL_ACTIVE_MEDIA_RELINK,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import MediaRelinkDialog from './MediaRelinkDialog'

vi.mock('../app/projectController', () => ({
  cancelActiveMediaRelink: vi.fn(),
  resolveActiveMediaAmbiguity: vi.fn(async () => ({ status: 'ready' })),
  skipActiveMediaAmbiguity: vi.fn(async () => ({ status: 'ready' })),
}))

const ambiguity = {
  token: 'ambiguity-1',
  assetId: 'asset-1',
  assetFileName: 'camera.mp4',
  candidates: [
    {
      token: 'source-a',
      fileName: 'camera.mp4',
      relativePath: 'day-one/camera.mp4',
    },
    {
      token: 'source-b',
      fileName: 'camera.mp4',
      relativePath: 'day-two/camera.mp4',
    },
  ],
} as const

beforeEach(() => {
  vi.mocked(cancelActiveMediaRelink).mockClear()
  vi.mocked(resolveActiveMediaAmbiguity).mockClear()
  vi.mocked(skipActiveMediaAmbiguity).mockClear()
  useProjectSessionStore.setState({
    activeMediaRelink: {
      ...INITIAL_ACTIVE_MEDIA_RELINK,
      phase: 'awaiting-choice',
      scannedFileCount: 2,
      ambiguity,
    },
  })
})

describe('MediaRelinkDialog', () => {
  test('starts with no implicit file and requires an explicit radio choice', async () => {
    render(<MediaRelinkDialog />)

    const connect = screen.getByRole('button', {
      name: 'Connect selected file',
    })
    const candidates = screen.getAllByRole('radio')
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) expect(candidate).not.toBeChecked()
    expect(connect).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: /day-two\/camera\.mp4/ }))
    expect(connect).toBeEnabled()
    fireEvent.click(connect)

    await waitFor(() => {
      expect(resolveActiveMediaAmbiguity).toHaveBeenCalledWith(
        'ambiguity-1',
        'source-b',
      )
    })
  })

  test('can leave only the current source offline', async () => {
    render(<MediaRelinkDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Leave source offline' }))

    await waitFor(() => {
      expect(skipActiveMediaAmbiguity).toHaveBeenCalledWith('ambiguity-1')
    })
    expect(cancelActiveMediaRelink).not.toHaveBeenCalled()
  })

  test('can cancel all remaining choices without selecting a file', () => {
    render(<MediaRelinkDialog />)

    const cancel = screen.getByRole('button', { name: 'Cancel remaining' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Escape' })

    expect(cancelActiveMediaRelink).toHaveBeenCalledOnce()
    expect(resolveActiveMediaAmbiguity).not.toHaveBeenCalled()
  })

  test('traps focus and restores the control that opened the dialog', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    render(<MediaRelinkDialog />)

    const leaveOffline = screen.getByRole('button', {
      name: 'Leave source offline',
    })
    leaveOffline.focus()
    fireEvent.keyDown(leaveOffline, { key: 'Tab' })
    expect(screen.getAllByRole('radio')[0]).toHaveFocus()

    act(() => {
      useProjectSessionStore.setState({
        activeMediaRelink: INITIAL_ACTIVE_MEDIA_RELINK,
      })
    })
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
