/**
 * Capability-aware export-flow integration at Toolbar.
 *
 * Codec discovery and export execution stay behind lazy app controllers. The
 * mocks below keep this suite deterministic while exercising the rendered
 * preset/custom UI, exact-profile handoff, lifecycle, and Blob URL ownership.
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
  checkCurrentExportProfile,
  getExportPresetCapabilities,
  type ExportCapabilitySnapshot,
} from '../app/exportCapabilitiesController'
import {
  cancelExport,
  startExport,
  type ExportCallbacks,
  type ExportResult,
} from '../app/exportController'
import {
  getExportFilePickerAvailability,
  requestExportFileDestination,
  type ExportFileDestinationCapability,
} from '../app/exportFilePicker'
import {
  DEFAULT_EXPORT_PROFILE,
  EXPORT_PRESETS,
  exportPresetById,
  updateExportProfile,
  type ExportPresetId,
  type ExportProfile,
} from '../domain/exportProfile'
import type { Clip, MediaAsset, TimelineDoc, Track } from '../domain/schema'
import { DirectFileAbortError } from '../pipeline/export-file-target'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_PREFERENCES_STATE,
  usePreferencesStore,
} from '../state/preferencesStore'
import Toolbar from './Toolbar'

vi.mock('../app/exportController', () => ({
  startExport: vi.fn(),
  cancelExport: vi.fn(),
}))

vi.mock('../app/exportCapabilitiesController', () => ({
  getExportPresetCapabilities: vi.fn(),
  checkCurrentExportProfile: vi.fn(),
}))

vi.mock('../app/exportFilePicker', () => ({
  getExportFilePickerAvailability: vi.fn(),
  requestExportFileDestination: vi.fn(),
}))

function capabilitySnapshot({
  autoPresetId = 'modern',
  unsupported = {},
}: {
  autoPresetId?: ExportPresetId | null
  unsupported?: Partial<Record<ExportPresetId, string>>
} = {}): Readonly<ExportCapabilitySnapshot> {
  return {
    autoPresetId,
    presets: EXPORT_PRESETS.map((preset) => {
      const reason = unsupported[preset.id]
      return {
        presetId: preset.id,
        profile: preset.profile,
        supported: reason === undefined,
        reason: reason ?? null,
      }
    }),
  }
}

const SUPPORTED_CAPABILITIES = capabilitySnapshot()

function exportResult(
  profile: Readonly<ExportProfile>,
): ExportResult {
  return {
    destination: 'download',
    buffer: new Uint8Array([1, 2, 3, 4]).buffer,
    mimeType: profile.mimeType,
    fileExtension: profile.fileExtension,
    profile,
  }
}

function directFileResult(
  profile: Readonly<ExportProfile>,
  fileName = `chosen.${profile.fileExtension}`,
): ExportResult {
  return {
    destination: 'file',
    fileName,
    byteLength: 4,
    mimeType: profile.mimeType,
    fileExtension: profile.fileExtension,
    profile,
  }
}

function clip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'source.mp4',
    sourceMode: 'timed',
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

function audioTrack(clips: Clip[]): Track {
  return {
    ...track(clips),
    id: 'A1',
    kind: 'audio',
    name: 'A1',
  }
}

function doc(withContent = true): TimelineDoc {
  return {
    schemaVersion: 11,
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
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 3_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 3_000_000 },
    },
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
const presetCapabilitiesMock = vi.mocked(getExportPresetCapabilities)
const customCapabilityMock = vi.mocked(checkCurrentExportProfile)
const pickerAvailabilityMock = vi.mocked(getExportFilePickerAvailability)
const requestFileDestinationMock = vi.mocked(requestExportFileDestination)

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
  startMock.mockResolvedValue(undefined)
  cancelMock.mockReset()
  cancelMock.mockResolvedValue(undefined)
  presetCapabilitiesMock.mockReset()
  presetCapabilitiesMock.mockResolvedValue(SUPPORTED_CAPABILITIES)
  customCapabilityMock.mockReset()
  customCapabilityMock.mockImplementation(async (profile) => ({
    profile,
    supported: true,
    reason: null,
  }))
  pickerAvailabilityMock.mockReset()
  pickerAvailabilityMock.mockReturnValue({ available: true, reason: null })
  requestFileDestinationMock.mockReset()

  usePreferencesStore.setState({ ...INITIAL_PREFERENCES_STATE })
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
  return await screen.findByRole('dialog', {
    name: 'Export video',
  }) as HTMLDialogElement
}

async function readyStartButton(): Promise<HTMLButtonElement> {
  return await screen.findByRole('button', {
    name: 'Start export',
  }) as HTMLButtonElement
}

function profileRadio(label: string): HTMLInputElement {
  return screen.getByRole('radio', {
    name: new RegExp(`^${label}`),
  }) as HTMLInputElement
}

describe('Export dialog configuration', () => {
  test('keeps a stored file destination selected when this browser cannot write it', async () => {
    const fileProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    const reason = 'Direct files require a secure supported browser.'
    usePreferencesStore.setState({
      exportSelection: { selectionId: 'custom', profile: fileProfile },
    })
    pickerAvailabilityMock.mockReturnValue({ available: false, reason })

    render(<Toolbar />)
    await openDialog()

    const destination = screen.getByRole('combobox', {
      name: 'Export destination',
    })
    expect(destination).toHaveValue('file')
    expect(screen.getByRole('option', { name: 'Choose a file' })).toBeDisabled()
    expect(await screen.findByText(`${reason} No codec will be substituted.`))
      .toBeInTheDocument()
    expect(screen.getByText(
      `${reason} Choose Browser download explicitly to use it here.`,
    )).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Profile unavailable' }))
      .toBeDisabled()
    expect(usePreferencesStore.getState().exportSelection).toEqual({
      selectionId: 'custom',
      profile: fileProfile,
    })
  })

  test('defaults to Compatibility, shows Auto resolution, isolates shortcuts, and restores focus', async () => {
    render(<Toolbar />)
    const trigger = screen.getByRole('button', { name: 'Export' })
    const dialog = await openDialog()
    const start = await readyStartButton()

    expect(screen.getByText('Horizontal 16:9 · 1280 × 720')).toBeInTheDocument()
    expect(screen.getByText('Timeline resolution (fixed)')).toBeInTheDocument()
    expect(screen.getByText('MP4 · H.264/AVC · AAC · stereo')).toBeInTheDocument()
    expect(profileRadio('Compatibility')).toBeChecked()
    expect(profileRadio('Auto')).not.toBeChecked()
    expect(screen.getByText('Available — selects Modern')).toBeInTheDocument()

    flushAnimationFrame()
    expect(profileRadio('Compatibility')).toHaveFocus()

    const escapedKey = vi.fn()
    window.addEventListener('keydown', escapedKey)
    fireEvent.keyDown(start, { key: 's' })
    expect(escapedKey).not.toHaveBeenCalled()
    window.removeEventListener('keydown', escapedKey)

    const cancelEvent = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancelEvent)
    expect(cancelEvent.defaultPrevented).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    flushAnimationFrame()
    expect(trigger).toHaveFocus()
  })

  test('derives a portrait ratio label from the fixed timeline dimensions', async () => {
    useDocumentStore.setState({
      doc: { ...doc(), width: 1080, height: 1920 },
      past: [],
      future: [],
    })
    render(<Toolbar />)
    await openDialog()

    expect(screen.getByText('Vertical 9:16 · 1080 × 1920'))
      .toBeInTheDocument()
    expect(screen.getByText('Timeline resolution (fixed)')).toBeInTheDocument()
  })

  test('shows an explicit unsupported reason without silently falling back', async () => {
    const reason = 'AVC is disabled by this browser policy.'
    presetCapabilitiesMock.mockResolvedValue(capabilitySnapshot({
      autoPresetId: 'modern',
      unsupported: { compatibility: reason },
    }))
    render(<Toolbar />)
    await openDialog()

    await screen.findByText(`${reason} No codec will be substituted.`)
    expect(profileRadio('Compatibility')).toBeChecked()
    expect(profileRadio('Compatibility')).toBeDisabled()
    expect(profileRadio('Modern')).not.toBeChecked()
    expect(screen.getByText('MP4 · H.264/AVC · AAC · stereo')).toBeInTheDocument()
    expect(screen.queryByText('WebM · AV1 · Opus · stereo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Profile unavailable' })).toBeDisabled()
    flushAnimationFrame()
    expect(screen.getByText(
      `${reason} No codec will be substituted.`,
    ).closest('[role="status"]')).toHaveFocus()
    expect(startMock).not.toHaveBeenCalled()
  })

  test('visibly resolves Auto and passes that exact profile to export', async () => {
    const modernProfile = exportPresetById('modern').profile
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()

    fireEvent.click(profileRadio('Auto'))

    expect(await screen.findByText(/Auto selected Modern\.$/)).toBeInTheDocument()
    expect(profileRadio('Auto')).toBeChecked()
    expect(screen.getByText('WEBM · AV1 · OPUS · stereo')).toBeInTheDocument()
    fireEvent.click(await readyStartButton())

    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())
    expect(startMock).toHaveBeenCalledWith(
      modernProfile,
      { onProgress: expect.any(Function) },
    )
  })

  test('checks an advanced edit as one exact custom profile before starting', async () => {
    const expectedProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      videoBitrate: 12_000_000,
    })
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()

    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'Export video bitrate in megabits per second',
    }), { target: { value: '12' } })

    await waitFor(() => {
      expect(customCapabilityMock).toHaveBeenCalledWith(expectedProfile)
    })
    expect(profileRadio('Custom')).toBeChecked()
    expect(await screen.findByText(
      'Ready to export exactly MP4 · H.264/AVC · AAC · stereo.',
    )).toBeInTheDocument()

    fireEvent.click(await readyStartButton())
    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())
    expect(startMock).toHaveBeenCalledWith(
      expectedProfile,
      { onProgress: expect.any(Function) },
    )
  })

  test('checks and exports the exact audio-off custom profile', async () => {
    const expectedProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()

    fireEvent.change(screen.getByRole('combobox', {
      name: 'Export audio channel layout',
    }), { target: { value: 'off' } })

    await waitFor(() => {
      expect(customCapabilityMock).toHaveBeenCalledWith(expectedProfile)
    })
    expect(screen.getByRole('combobox', {
      name: 'Export audio codec',
    })).toBeDisabled()
    expect(screen.getByRole('spinbutton', {
      name: 'Export audio bitrate in kilobits per second',
    })).toBeDisabled()
    expect(await screen.findByText(
      'Ready to export exactly MP4 · H.264/AVC · No audio.',
    )).toBeInTheDocument()

    fireEvent.click(await readyStartButton())
    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())
    expect(startMock).toHaveBeenCalledWith(
      expectedProfile,
      { onProgress: expect.any(Function) },
    )
  })

  test('keeps an invalid numeric draft accessible and disables Start', async () => {
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()
    const bitrate = screen.getByRole('spinbutton', {
      name: 'Export video bitrate in megabits per second',
    })

    fireEvent.change(bitrate, { target: { value: '0.05' } })

    expect(bitrate).toHaveAttribute('aria-invalid', 'true')
    expect(bitrate).toHaveAccessibleDescription('Enter 0.1–200 Mbps.')
    expect(screen.getByText(
      'Fix the invalid advanced value before exporting.',
    )).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Profile unavailable' })).toBeDisabled()
    expect(customCapabilityMock).not.toHaveBeenCalled()
    expect(startMock).not.toHaveBeenCalled()
  })

  test('shows a capability load error and retries the check', async () => {
    presetCapabilitiesMock
      .mockRejectedValueOnce(new Error('Capability worker failed'))
      .mockResolvedValueOnce(SUPPORTED_CAPABILITIES)
    render(<Toolbar />)
    await openDialog()

    expect(await screen.findByText(
      'Could not check export support: Capability worker failed',
    )).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Profile unavailable' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', {
      name: 'Retry capability check',
    }))

    expect(await readyStartButton()).toBeEnabled()
    expect(presetCapabilitiesMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Could not check export support/)).not.toBeInTheDocument()
  })

  test('ignores a stale custom result after a newer edit resolves', async () => {
    const first = deferred<{
      profile: Readonly<ExportProfile>
      supported: boolean
      reason: string | null
    }>()
    const second = deferred<{
      profile: Readonly<ExportProfile>
      supported: boolean
      reason: string | null
    }>()
    customCapabilityMock.mockImplementation((profile) => {
      if (profile.videoBitrate === 10_000_000) return first.promise
      if (profile.videoBitrate === 12_000_000) return second.promise
      throw new Error(`Unexpected bitrate ${profile.videoBitrate}`)
    })
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()
    const bitrate = screen.getByRole('spinbutton', {
      name: 'Export video bitrate in megabits per second',
    })

    fireEvent.change(bitrate, { target: { value: '10' } })
    await waitFor(() => expect(customCapabilityMock).toHaveBeenCalledTimes(1))
    fireEvent.change(bitrate, { target: { value: '12' } })
    await waitFor(() => expect(customCapabilityMock).toHaveBeenCalledTimes(2))
    const oldProfile = customCapabilityMock.mock.calls[0][0]
    const currentProfile = customCapabilityMock.mock.calls[1][0]

    await act(async () => {
      second.resolve({
        profile: currentProfile,
        supported: true,
        reason: null,
      })
      await second.promise
    })
    expect(await readyStartButton()).toBeEnabled()

    await act(async () => {
      first.resolve({
        profile: oldProfile,
        supported: false,
        reason: 'Stale encoder rejection',
      })
      await first.promise
    })
    expect(screen.queryByText(/Stale encoder rejection/)).not.toBeInTheDocument()
    expect(screen.getByText(
      'Ready to export exactly MP4 · H.264/AVC · AAC · stereo.',
    )).toBeInTheDocument()
    expect(await readyStartButton()).toBeEnabled()
  })

  test('explains an empty timeline and never starts the controller', async () => {
    useDocumentStore.setState({ doc: doc(false), past: [], future: [] })
    render(<Toolbar />)
    await openDialog()

    expect(screen.getByText(/add a clip to the timeline/i)).toBeInTheDocument()
    expect(await readyStartButton()).toBeDisabled()
    fireEvent.click(await readyStartButton())
    expect(startMock).not.toHaveBeenCalled()
  })

  test('lists referenced offline media and disables export until relinked', async () => {
    useMediaStore.getState().disconnectAsset('asset-1')
    render(<Toolbar />)
    await openDialog()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Reconnect 1 offline source before exporting: source.mp4.',
    )
    expect(screen.getByRole('button', {
      name: 'Reconnect media to export',
    })).toBeDisabled()
    expect(startMock).not.toHaveBeenCalled()
  })

  test('audio off does not require an offline audio-only source', async () => {
    const voiceClip: Clip = {
      ...clip(),
      id: 'clip-audio',
      assetId: 'asset-audio',
      name: 'voice.wav',
    }
    const voiceAsset: MediaAsset = {
      ...asset(),
      id: 'asset-audio',
      fileName: 'voice.wav',
      mimeType: 'audio/wav',
      objectUrl: 'blob:voice',
      kind: 'audio',
      frameRate: null,
      width: null,
      height: null,
      decoderConfigB64: null,
    }
    useDocumentStore.setState({
      doc: { ...doc(), tracks: [track([clip()]), audioTrack([voiceClip])] },
      past: [],
      future: [],
    })
    useMediaStore.getState().addAsset(voiceAsset)
    useMediaStore.getState().disconnectAsset('asset-audio')
    render(<Toolbar />)
    await openDialog()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Reconnect 1 offline source before exporting: voice.wav.',
    )
    fireEvent.change(screen.getByRole('combobox', {
      name: 'Export audio channel layout',
    }), { target: { value: 'off' } })

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
    expect(await readyStartButton()).toBeEnabled()
  })
})

describe('Export dialog lifecycle', () => {
  test('picks before loading the controller and reports a committed direct file', async () => {
    const fileProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    const capability: ExportFileDestinationCapability = {
      fileName: 'final-cut.mp4',
      takeFileHandle: vi.fn(() => {
        throw new Error('The UI must not consume the native file handle')
      }),
    }
    const picker = deferred<Awaited<ReturnType<
      typeof requestExportFileDestination
    >>>()
    const order: string[] = []
    requestFileDestinationMock.mockImplementation(() => {
      order.push('picker')
      return picker.promise
    })
    startMock.mockImplementation(async () => {
      order.push('start')
      return directFileResult(fileProfile, 'final-cut.mp4')
    })
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()

    fireEvent.change(screen.getByRole('combobox', {
      name: 'Export destination',
    }), { target: { value: 'file' } })
    await waitFor(() => expect(customCapabilityMock).toHaveBeenCalledWith(
      fileProfile,
    ))
    const start = await screen.findByRole('button', {
      name: 'Choose file and export',
    })
    fireEvent.click(start)

    expect(requestFileDestinationMock).toHaveBeenCalledWith(
      fileProfile,
      'My - Rough- Cut.mp4',
    )
    expect(order).toEqual(['picker'])
    expect(startMock).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', {
      name: 'Waiting for file selection…',
    })).toBeDisabled()

    await act(async () => {
      picker.resolve({ status: 'selected', destination: capability })
      await picker.promise
    })

    await screen.findByText('Export saved')
    expect(order).toEqual(['picker', 'start'])
    expect(startMock).toHaveBeenCalledWith(fileProfile, {
      onProgress: expect.any(Function),
      fileDestination: capability,
    })
    expect(screen.getByText(
      'Your MP4 was written directly to final-cut.mp4.',
    )).toBeInTheDocument()
    await waitFor(() => expect(rafCallbacks.size).toBeGreaterThan(0))
    flushAnimationFrame()
    expect(screen.getByRole('button', { name: 'Export another' })).toHaveFocus()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test('reuses the file profile after picker cancellation and starts from a fresh selection', async () => {
    const fileProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    const capability: ExportFileDestinationCapability = {
      fileName: 'retry.mp4',
      takeFileHandle: vi.fn(() => {
        throw new Error('The UI must not consume the native file handle')
      }),
    }
    requestFileDestinationMock
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'selected', destination: capability })
    startMock.mockResolvedValue(directFileResult(fileProfile, 'retry.mp4'))
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()
    fireEvent.change(screen.getByRole('combobox', {
      name: 'Export destination',
    }), { target: { value: 'file' } })
    await waitFor(() => expect(customCapabilityMock).toHaveBeenCalledWith(
      fileProfile,
    ))

    fireEvent.click(await screen.findByRole('button', {
      name: 'Choose file and export',
    }))

    expect(await screen.findByText('No file selected.')).toBeInTheDocument()
    expect(startMock).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Export destination' }))
      .toHaveValue('file')
    expect(screen.getByRole('button', { name: 'Choose file and export' }))
      .toBeEnabled()

    fireEvent.click(screen.getByRole('button', {
      name: 'Choose file and export',
    }))

    expect(await screen.findByText('Export saved')).toBeInTheDocument()
    expect(requestFileDestinationMock).toHaveBeenCalledTimes(2)
    expect(requestFileDestinationMock).toHaveBeenNthCalledWith(
      2,
      fileProfile,
      'My - Rough- Cut.mp4',
    )
    expect(startMock).toHaveBeenCalledOnce()
    expect(startMock).toHaveBeenCalledWith(fileProfile, {
      onProgress: expect.any(Function),
      fileDestination: capability,
    })
    expect(screen.getByText(
      'Your MP4 was written directly to retry.mp4.',
    )).toBeInTheDocument()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test.each([
    {
      label: 'a discarded ordinary failure',
      failure: new Error('disk full'),
      expected:
        'disk full No partial video was kept; the selected file may remain empty.',
      forbidden: 'selected file may be incomplete',
    },
    {
      label: 'a failed abort',
      failure: new DirectFileAbortError(
        new Error('disk full'),
        new Error('abort failed'),
      ),
      expected:
        'Could not discard the selected export file; the selected file may be incomplete.',
      forbidden: 'No partial video was kept',
    },
  ])('keeps direct-file failure copy honest for $label', async ({
    failure,
    expected,
    forbidden,
  }) => {
    const fileProfile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    const capability: ExportFileDestinationCapability = {
      fileName: 'failed.mp4',
      takeFileHandle: vi.fn(() => {
        throw new Error('The UI must not consume the native file handle')
      }),
    }
    requestFileDestinationMock.mockResolvedValue({
      status: 'selected',
      destination: capability,
    })
    startMock.mockRejectedValue(failure)
    render(<Toolbar />)
    await openDialog()
    await readyStartButton()
    fireEvent.change(screen.getByRole('combobox', {
      name: 'Export destination',
    }), { target: { value: 'file' } })
    await waitFor(() => expect(customCapabilityMock).toHaveBeenCalledWith(
      fileProfile,
    ))

    fireEvent.click(await screen.findByRole('button', {
      name: 'Choose file and export',
    }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(expected)
    expect(alert).not.toHaveTextContent(forbidden)
    expect(startMock).toHaveBeenCalledWith(fileProfile, {
      onProgress: expect.any(Function),
      fileDestination: capability,
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test('starts once, coalesces progress bursts, and waits for the real result', async () => {
    const completion = deferred<ExportResult | undefined>()
    let callbacks: ExportCallbacks | undefined
    startMock.mockImplementation((_settings, nextCallbacks) => {
      callbacks = nextCallbacks
      return completion.promise
    })
    render(<Toolbar />)
    await openDialog()
    const start = await readyStartButton()
    flushAnimationFrame()

    act(() => {
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())
    flushAnimationFrame()
    expect(screen.getByRole('button', { name: 'Cancel export' })).toHaveFocus()
    expect(startMock).toHaveBeenCalledWith(
      DEFAULT_EXPORT_PROFILE,
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
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument()
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    await act(async () => {
      completion.resolve(undefined)
      await completion.promise
    })
    expect(screen.getByText('Export cancelled')).toBeInTheDocument()
  })

  test('creates a typed WebM download with a dynamic filename and revokes it on close', async () => {
    const webProfile = exportPresetById('web').profile
    useDocumentStore.setState({
      doc: { ...doc(), name: 'CON.txt' },
      past: [],
      future: [],
    })
    startMock.mockResolvedValue(exportResult(webProfile))
    render(<Toolbar />)
    const trigger = screen.getByRole('button', { name: 'Export' })
    await openDialog()
    await readyStartButton()
    fireEvent.click(profileRadio('Web'))
    fireEvent.click(await readyStartButton())

    const download = await screen.findByRole('link', { name: 'Download WebM' })
    await waitFor(() => expect(rafCallbacks.size).toBeGreaterThan(0))
    flushAnimationFrame()
    expect(download).toHaveFocus()
    expect(screen.getByText('Your WebM is ready to download.')).toBeInTheDocument()
    expect(startMock).toHaveBeenCalledWith(
      webProfile,
      { onProgress: expect.any(Function) },
    )
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob).toMatchObject({ size: 4, type: 'video/webm' })
    expect(download).toHaveAttribute('href', 'blob:finished-export')
    expect(download).toHaveAttribute('download', 'myrelith-CON.txt.webm')

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
    fireEvent.click(await readyStartButton())
    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())

    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog)
    expect(cancelMock).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledOnce())
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
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument()
  })

  test('shows the pipeline error and a retry clears it', async () => {
    startMock
      .mockRejectedValueOnce(new Error('AVC encoding is not supported'))
      .mockResolvedValueOnce(undefined)
    render(<Toolbar />)
    await openDialog()
    fireEvent.click(await readyStartButton())

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
    fireEvent.click(await readyStartButton())
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

    fireEvent.click(await readyStartButton())
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

    fireEvent.click(await readyStartButton())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))

    await waitFor(() => expect(startMock).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()

    await act(async () => {
      completion.resolve(undefined)
      await completion.promise
    })
    expect(screen.getByText('Export cancelled')).toBeInTheDocument()
  })
})
