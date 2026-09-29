import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AvCaptureSession } from '../domain/avCaptureSession'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { useAvCaptureSetupStore, useAvCaptureStore, type AvCaptureStatus } from '../state/avCaptureStore'
import { useVoiceoverDraftStore } from '../state/voiceoverCaptureStore'
import { resetDocumentStoreForTest } from '../test/storeFixtures'
import RecordPanel from './RecordPanel'

const av = vi.hoisted(() => ({
  startAvCapture: vi.fn(() => ({ status: 'started' as const, sessionId: 'capture_1' })),
  stopAvCapture: vi.fn(async () => {}),
  cancelAvCapture: vi.fn(async () => {}),
  keepAvCapture: vi.fn(async () => {}),
  retryAvCaptureCleanup: vi.fn(async () => {}),
  attachAvPreview: vi.fn(() => () => {}),
  listVideoInputDevices: vi.fn(async () => [{ deviceId: 'cam-1', label: 'FaceTime HD Camera' }]),
}))

vi.mock('../app/avCaptureController', () => av)
vi.mock('../app/voiceoverController', () => ({
  refreshVoiceoverDrafts: vi.fn(async () => {}),
  listVoiceoverInputDevices: vi.fn(async () => [{ deviceId: 'usb', label: 'USB mic' }]),
  startVoiceover: vi.fn(), stopVoiceover: vi.fn(), cancelVoiceover: vi.fn(), keepVoiceover: vi.fn(),
  retryVoiceoverCleanup: vi.fn(), recoverVoiceoverDraft: vi.fn(), discardVoiceoverDraft: vi.fn(),
  removeVoiceoverOriginal: vi.fn(), voiceoverStorageAvailable: () => false,
  VOICEOVER_COUNT_IN_SECONDS: [0, 1, 2, 3, 4], VOICEOVER_COMPENSATION_MS_LIMIT: 500,
}))

function session(mode: 'camera' | 'screen', phase: AvCaptureSession['phase'], extra: Partial<AvCaptureSession> = {}) {
  return { sessionId: 'capture_1', mode, operation: 1, interruption: null, failure: null,
    projectId: 'p', projectGeneration: 1, phase, ...extra } as AvCaptureSession
}

function capture(state: Partial<AvCaptureStatus>) {
  act(() => { useAvCaptureStore.setState(state) })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDocumentStoreForTest(createTimelineDoc('Capture UI', DEFAULT_PROJECT_SETTINGS, 'seq'))
  useVoiceoverDraftStore.setState({ drafts: [], busy: false, error: null, lastAction: null })
  useAvCaptureSetupStore.setState({ mode: 'camera', cameraId: null, cameraMicrophoneId: null,
    screenAudio: 'none', screenMicrophoneId: null })
  capture({ session: null, progress: null, videoLabel: null, audioLabel: null, audioNote: null,
    clockMethod: null, clockNote: null, diagnostic: null })
})

describe('Record panel camera and screen tabs', () => {
  test('camera: choose devices and record from the click', async () => {
    render(<RecordPanel onClose={() => {}} />)
    await act(async () => {})
    fireEvent.change(screen.getByLabelText('Camera', { selector: 'select' }), { target: { value: 'cam-1' } })
    fireEvent.change(screen.getByLabelText('Microphone', { selector: 'select' }), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: /record camera/i }))
    expect(av.startAvCapture).toHaveBeenCalledWith({ mode: 'camera', cameraId: 'cam-1', cameraMicrophoneId: 'none' })
  })

  test('screen: the microphone option reveals its device choice', async () => {
    act(() => useAvCaptureSetupStore.setState({ mode: 'screen' }))
    render(<RecordPanel onClose={() => {}} />)
    await act(async () => {})
    expect(screen.queryByLabelText('Microphone', { selector: 'select' })).toBeNull()
    fireEvent.click(screen.getByLabelText('Microphone', { selector: 'input' }))
    fireEvent.change(screen.getByLabelText('Microphone', { selector: 'select' }), { target: { value: 'usb' } })
    fireEvent.click(screen.getByRole('button', { name: /choose screen and record/i }))
    expect(av.startAvCapture).toHaveBeenCalledWith({ mode: 'screen', screenAudio: 'microphone', screenMicrophoneId: 'usb' })
  })

  test('a rejected start is announced', () => {
    av.startAvCapture.mockReturnValueOnce({ status: 'rejected', reason: 'Finish the voiceover take first.' } as never)
    render(<RecordPanel onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /record camera/i }))
    expect(screen.getByRole('alert').textContent).toBe('Finish the voiceover take first.')
  })

  test('recording shows time, size, preview, and Stop; Escape does not close', () => {
    const onClose = vi.fn()
    capture({ session: session('camera', 'recording'), videoLabel: 'FaceTime HD Camera', audioLabel: 'USB mic',
      clockMethod: 'capture-time', progress: { bytes: 3 * 1_048_576, durationUs: 75_300_000, videoFrames: 1, droppedVideoFrames: 0,
        audioSamples: 0, audioSampleRate: 48_000, width: 1280, height: 720 } })
    render(<RecordPanel onClose={onClose} />)
    expect(screen.getByRole('tab', { name: 'Camera', selected: true })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('1:15.3')
    expect(screen.getByText('3.0 MiB')).toBeTruthy()
    expect(screen.getByLabelText('Live preview of the recording')).toBeTruthy()
    expect(av.attachAvPreview).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(av.stopAvCapture).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  test('review after sharing stopped keeps the take and explains why it ended', () => {
    act(() => useAvCaptureSetupStore.setState({ mode: 'screen' }))
    capture({ session: session('screen', 'review', { interruption: 'source-ended' }), clockNote: 'Audio input paused 1 time(s).' })
    render(<RecordPanel onClose={() => {}} />)
    expect(screen.getByText(/Sharing or the camera stopped/)).toBeTruthy()
    expect(screen.getByText('Audio input paused 1 time(s).')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep in Media Pool' }))
    expect(av.keepAvCapture).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(av.cancelAvCapture).toHaveBeenCalledOnce()
  })

  test('a missing macOS screen permission gets concrete guidance', () => {
    act(() => useAvCaptureSetupStore.setState({ mode: 'screen' }))
    capture({ session: session('screen', 'failed', { failure: 'screen-permission' }) })
    render(<RecordPanel onClose={() => {}} />)
    expect(screen.getByText(/Screen & System Audio Recording/)).toBeTruthy()
  })

  test('an estimated A/V alignment is never presented as exact', () => {
    capture({ session: session('camera', 'recording'), clockMethod: 'delivery-estimate' })
    render(<RecordPanel onClose={() => {}} />)
    expect(screen.getByText(/Check lip sync/)).toBeTruthy()
  })

  test('arrow keys move between recording types', () => {
    act(() => useAvCaptureSetupStore.setState({ mode: 'voiceover' }))
    render(<RecordPanel onClose={() => {}} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Voiceover' }), { key: 'ArrowRight' })
    expect(useAvCaptureSetupStore.getState().mode).toBe('camera')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Camera' }), { key: 'End' })
    expect(useAvCaptureSetupStore.getState().mode).toBe('screen')
  })
})
