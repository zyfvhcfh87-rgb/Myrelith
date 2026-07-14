/**
 * ui/ExportDialog.test.tsx — Phase 5.2b export-flow integration at Toolbar.
 *
 * The real codecs stay behind the app export controller. These tests prove
 * the rendered fixed profile, progress/cancel lifecycle, Blob download URL
 * ownership, retry behavior, focus restoration, and shortcut isolation.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  cancelExport,
  startExport,
  type ExportCallbacks,
  type ExportResult,
} from '../app/exportController'
import type { Clip, MediaAsset, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import Toolbar from './Toolbar'

vi.mock('../app/exportController', () => ({
  startExport: vi.fn(),
  cancelExport: vi.fn(),
}))

const RESULT: ExportResult = {
  buffer: new Uint8Array([1, 2, 3, 4]).buffer,
  mimeType: 'video/mp4',
}

function clip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'source.mp4',
    sourceRange: { startFrame: 0, durationFrames: 90 },
    timelineRange: { startFrame: 0, durationFrames: 90 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function track(clips: Clip[]): Track {
  return {
    id: 'V1',
    kind: 'video',
    name: 'V1',
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function doc(withContent = true): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'export-ui-doc',
    name: 'My / Rough: Cut.mp4',
    frameRate: { num: 30, den: 1 },
    width: 1280,
    height: 720,
    audioSampleRate: 48_000,
    tracks: [track(withContent ? [clip()] : [])],
  }
}

function asset(): MediaAsset {
  return {
    id: 'asset-1',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 90,
    durationMicroseconds: 3_000_000,
    frameRate: { num: 30, den: 1 },
    width: 1280,
    height: 720,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

let rafId = 0
let rafCallbacks: Map<number, FrameRequestCallback>

function flushAnimationFrame(): void {
  act(() => {
    const callbacks = [...rafCallbacks.values()]
    rafCallbacks.clear()
    for (const callback of callbacks) callback(performance.now())
  })
}

const startMock = vi.mocked(startExport)
const cancelMock = vi.mocked(cancelExport)

beforeEach(() => {
  rafId = 0
  rafCallbacks = new Map()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++rafId
      rafCallbacks.set(id, callback)
      return id
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      rafCallbacks.delete(id)
    }),
  )
  URL.createObjectURL = vi.fn(() => 'blob:finished-export') as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  startMock.mockReset()
  cancelMock.mockReset()
  cancelMock.mockResolvedValue(undefined)
  useDocumentStore.setState({ doc: doc(), past: [], future: [] })
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
  })
  useMediaStore.getState().addAsset(asset())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openDialog(): Promise<HTMLDialogElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Export' }))
  return await screen.findByRole('dialog', { name: 'Export video' }) as HTMLDialogElement
}

describe('Export dialog configuration', () => {
  test('shows the honest fixed profile, isolates shortcuts, and restores focus', async () => {
    render(<Toolbar />)
    const trigger = screen.getByRole('button', { name: 'Export' })
    const dialog = await openDialog()

    expect(screen.getByText('1280 × 720')).toBeInTheDocument()
    expect(screen.getByText('Timeline resolution (fixed)')).toBeInTheDocument()
    expect(screen.getByText('MP4 · H.264/AVC')).toBeInTheDocument()
    expect(screen.getByText('Format (fixed)')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    flushAnimationFrame()
    expect(screen.getByRole('button', { name: 'Start export' })).toHaveFocus()

    const escapedKey = vi.fn()
    window.addEventListener('keydown', escapedKey)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Start export' }), {
      key: 's',
    })
    expect(escapedKey).not.toHaveBeenCalled()
    window.removeEventListener('keydown', escapedKey)

    const cancelEvent = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancelEvent)
    expect(cancelEvent.defaultPrevented).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    flushAnimationFrame()
    expect(trigger).toHaveFocus()
  })

  test('explains an empty timeline and never starts the controller', async () => {
    useDocumentStore.setState({ doc: doc(false), past: [], future: [] })
    render(<Toolbar />)
    await openDialog()

    expect(screen.getByText(/add a clip to the timeline/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start export' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    expect(startMock).not.toHaveBeenCalled()
  })

  test('lists referenced offline media and disables export until relinked', async () => {
    useMediaStore.getState().disconnectAsset('asset-1')
    render(<Toolbar />)
    await openDialog()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Reconnect 1 offline source before exporting: source.mp4.',
    )
    expect(
      screen.getByRole('button', { name: 'Reconnect media to export' }),
    ).toBeDisabled()
    expect(startMock).not.toHaveBeenCalled()
  })
})

describe('Export dialog lifecycle', () => {
  test('starts once, coalesces progress bursts, and waits for the real result', async () => {
    const completion = deferred<ExportResult | undefined>()
    let callbacks: ExportCallbacks | undefined
    startMock.mockImplementation((_settings, nextCallbacks) => {
      callbacks = nextCallbacks
      return completion.promise
    })
    render(<Toolbar />)
    await openDialog()
    flushAnimationFrame()

    const start = screen.getByRole('button', { name: 'Start export' })
    act(() => {
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())
    flushAnimationFrame()
    expect(screen.getByRole('button', { name: 'Cancel export' })).toHaveFocus()
    expect(startMock).toHaveBeenCalledWith(
      {
        format: 'mp4',
        videoCodec: 'avc',
        videoBitrate: 8_000_000,
      },
      { onProgress: expect.any(Function) },
    )
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('progressbar')).toHaveValue(0)

    act(() => {
      callbacks?.onProgress?.(0.1)
      callbacks?.onProgress?.(0.2)
      callbacks?.onProgress?.(0.3)
    })
    expect(rafCallbacks.size).toBe(1)
    expect(screen.getByRole('progressbar')).toHaveValue(0)
    flushAnimationFrame()
    expect(screen.getByRole('progressbar')).toHaveValue(0.3)
    expect(screen.getByText('30%')).toBeInTheDocument()

    act(() => callbacks?.onProgress?.(1))
    expect(screen.getByRole('progressbar')).toHaveValue(1)
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Download MP4' })).not.toBeInTheDocument()
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    await act(async () => {
      completion.resolve(undefined)
      await completion.promise
    })
    expect(screen.getByText('Export cancelled')).toBeInTheDocument()
  })

  test('creates one typed Blob URL, keeps it through download, and revokes on close', async () => {
    useDocumentStore.setState({
      doc: { ...doc(), name: 'CON.txt' },
      past: [],
      future: [],
    })
    startMock.mockResolvedValue(RESULT)
    render(<Toolbar />)
    const trigger = screen.getByRole('button', { name: 'Export' })
    await openDialog()
    flushAnimationFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))

    const download = await screen.findByRole('link', { name: 'Download MP4' })
    await waitFor(() => expect(rafCallbacks.size).toBeGreaterThan(0))
    flushAnimationFrame()
    expect(download).toHaveFocus()
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob).toMatchObject({ size: 4, type: 'video/mp4' })
    expect(download).toHaveAttribute('href', 'blob:finished-export')
    expect(download).toHaveAttribute('download', 'webcut-CON.txt.mp4')

    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:finished-export')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    flushAnimationFrame()
    expect(trigger).toHaveFocus()
  })

  test('cancels once, stays visible through cleanup, and creates no download', async () => {
    const completion = deferred<ExportResult | undefined>()
    startMock.mockReturnValue(completion.promise)
    render(<Toolbar />)
    await openDialog()
    flushAnimationFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())

    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog)
    expect(cancelMock).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledOnce())
    expect(screen.getByRole('status')).toHaveTextContent('Cancelling…')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()

    await act(async () => {
      completion.resolve(undefined)
      await completion.promise
    })
    expect(screen.getByText('Export cancelled')).toBeInTheDocument()
    flushAnimationFrame()
    expect(screen.getByRole('button', { name: 'Back to settings' })).toHaveFocus()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Download MP4' })).not.toBeInTheDocument()
  })

  test('shows the pipeline error and a retry clears it', async () => {
    startMock
      .mockRejectedValueOnce(new Error('AVC encoding is not supported'))
      .mockResolvedValueOnce(undefined)
    render(<Toolbar />)
    await openDialog()
    flushAnimationFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'AVC encoding is not supported',
    )
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry export' }))
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(await screen.findByText('Export cancelled')).toBeInTheDocument()
  })

  test('unmounting an active export requests controller cleanup', async () => {
    const completion = deferred<ExportResult | undefined>()
    startMock.mockReturnValue(completion.promise)
    const { unmount } = render(<Toolbar />)
    await openDialog()
    flushAnimationFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())

    unmount()
    await waitFor(() => expect(cancelMock).toHaveBeenCalledOnce())
    await act(async () => {
      completion.resolve(undefined)
      await completion.promise
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test('cancels locally before the lazy controller has started a run', async () => {
    const completion = deferred<ExportResult | undefined>()
    startMock.mockReturnValue(completion.promise)
    render(<Toolbar />)
    await openDialog()
    flushAnimationFrame()

    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))

    expect(screen.getByText('Export cancelled')).toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()
    expect(cancelMock).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(startMock).not.toHaveBeenCalled()
  })

  test('a stale pre-controller cancellation cannot disable a same-tick retry', async () => {
    const completion = deferred<ExportResult | undefined>()
    startMock.mockReturnValue(completion.promise)
    render(<Toolbar />)
    await openDialog()
    flushAnimationFrame()

    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))

    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledOnce())
    expect(screen.getByRole('status')).toHaveTextContent('Cancelling…')

    await act(async () => {
      completion.resolve(undefined)
      await completion.promise
    })
    expect(screen.getByText('Export cancelled')).toBeInTheDocument()
  })
})
