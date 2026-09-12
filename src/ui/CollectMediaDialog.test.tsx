import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import CollectMediaDialog from './CollectMediaDialog'

const collect = vi.hoisted(() => ({
  preflightCollectMedia: vi.fn(),
  collectActiveProject: vi.fn(),
  cancelCollectMedia: vi.fn(),
  pickCollectMediaDestination: vi.fn(),
  getCollectMediaPickerAvailability: vi.fn(),
  isCollectMediaAbort: vi.fn(() => false),
}))

vi.mock('../app/collectMediaController', async () => {
  const actual = await vi.importActual<typeof import('../app/collectMediaController')>(
    '../app/collectMediaController',
  )
  return {
    ...actual,
    preflightCollectMedia: collect.preflightCollectMedia,
    collectActiveProject: collect.collectActiveProject,
    cancelCollectMedia: collect.cancelCollectMedia,
  }
})

vi.mock('../app/collectMediaArchive', async () => {
  const actual = await vi.importActual<typeof import('../app/collectMediaArchive')>(
    '../app/collectMediaArchive',
  )
  return {
    ...actual,
    pickCollectMediaDestination: collect.pickCollectMediaDestination,
    getCollectMediaPickerAvailability: collect.getCollectMediaPickerAvailability,
    isCollectMediaAbort: collect.isCollectMediaAbort,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  collect.getCollectMediaPickerAvailability.mockReturnValue({
    available: true,
    reason: null,
  })
  collect.preflightCollectMedia.mockResolvedValue({
    inclusionPolicy: { includeProxies: false, includeTitleTemplates: false },
    includedCount: 1,
    excludedCount: 1,
    offlineCount: 1,
    unresolvedCount: 1,
    items: [
      {
        id: 'asset-1',
        kind: 'asset',
        disposition: 'included',
        reason: 'Original source will be copied into the archive.',
        originalFileName: 'clip.mp4',
        plannedRelativePath: 'media/clip.mp4',
        size: 8,
        lastModified: 1,
        mimeType: 'video/mp4',
      },
      {
        id: 'offline',
        kind: 'asset',
        disposition: 'offline',
        reason: 'offline',
        originalFileName: 'gone.mp4',
        plannedRelativePath: null,
        size: 8,
        lastModified: 1,
        mimeType: 'video/mp4',
      },
    ],
  })
  collect.pickCollectMediaDestination.mockResolvedValue({ name: 'Archive' })
  collect.collectActiveProject.mockResolvedValue({
    status: 'complete',
    projectFileName: 'Collect.myrelith',
    destinationName: 'Archive',
    manifest: { status: 'complete' },
  })
})

describe('CollectMediaDialog', () => {
  test('shows preflight counts before copying', async () => {
    render(<CollectMediaDialog onClose={() => undefined} />)
    expect(await screen.findByText(/Included 1/)).toBeInTheDocument()
    expect(screen.getByText('clip.mp4')).toBeInTheDocument()
    expect(screen.getByText('gone.mp4')).toBeInTheDocument()
    expect(screen.getByText('gone.mp4').closest('li'))
      .toHaveAttribute('data-disposition', 'offline')
  })

  test('collects into a chosen folder without claiming a partial archive is complete', async () => {
    collect.collectActiveProject.mockResolvedValue({
      status: 'partial',
      projectFileName: 'Collect.myrelith',
      destinationName: 'Archive',
      message: 'The collect-media copy was cancelled.',
      manifest: { status: 'partial' },
    })
    render(<CollectMediaDialog onClose={() => undefined} />)
    await screen.findByText(/Included 1/)
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder and collect' }))
    await waitFor(() => expect(collect.pickCollectMediaDestination).toHaveBeenCalledOnce())
    expect(await screen.findByRole('alert')).toHaveTextContent(/Incomplete archive/)
    expect(screen.getByRole('alert')).toHaveTextContent(/not a finished package/)
  })

  test('cancels an in-flight copy from the dialog', async () => {
    let finish!: (value: { status: 'partial'; message: string; projectFileName: string; destinationName: string; manifest: { status: 'partial' } }) => void
    collect.collectActiveProject.mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve
      }),
    )
    render(<CollectMediaDialog onClose={() => undefined} />)
    await screen.findByText(/Included 1/)
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder and collect' }))
    await waitFor(() => expect(collect.collectActiveProject).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel copy' }))
    expect(collect.cancelCollectMedia).toHaveBeenCalled()
    act(() => {
      finish({
        status: 'partial',
        message: 'The collect-media copy was cancelled.',
        projectFileName: 'Collect.myrelith',
        destinationName: 'Archive',
        manifest: { status: 'partial' },
      })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Incomplete archive/)
  })

  test('Close during a copy waits for cancel before dismissing', async () => {
    const onClose = vi.fn()
    let finish!: (value: { status: 'cancelled' }) => void
    collect.collectActiveProject.mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve
      }),
    )
    render(<CollectMediaDialog onClose={onClose} />)
    await screen.findByText(/Included 1/)
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder and collect' }))
    await waitFor(() => expect(collect.collectActiveProject).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(collect.cancelCollectMedia).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      finish({ status: 'cancelled' })
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
