import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { VoiceoverSession } from '../domain/voiceoverSession'
import { resetDocumentStoreForTest } from '../test/storeFixtures'
import {
  useVoiceoverCaptureStore,
  useVoiceoverDraftStore,
  useVoiceoverSetupStore,
} from '../state/voiceoverCaptureStore'
import VoiceoverPanel from './VoiceoverPanel'
import VoiceoverIndicator from './VoiceoverIndicator'

const controller = vi.hoisted(() => ({
  startVoiceover: vi.fn(() => ({ status: 'started' as const, sessionId: 'voiceover_1' })),
  stopVoiceover: vi.fn(async () => {}),
  cancelVoiceover: vi.fn(async () => {}),
  keepVoiceover: vi.fn(async () => {}),
  retryVoiceoverCleanup: vi.fn(async () => {}),
  refreshVoiceoverDrafts: vi.fn(async () => {}),
  recoverVoiceoverDraft: vi.fn(async () => ({ status: 'recovered' as const, assetId: 'a', sizeBytes: 0 })),
  discardVoiceoverDraft: vi.fn(async () => ({ status: 'discarded' as const, sizeBytes: 0 })),
  removeVoiceoverOriginal: vi.fn(async () => ({ status: 'removed' as const, sizeBytes: 0 })),
  listVoiceoverInputDevices: vi.fn(async () => [{ deviceId: 'usb', label: 'USB mic' }]),
  voiceoverStorageAvailable: vi.fn(() => false),
}))

vi.mock('../app/voiceoverController', () => ({
  ...controller,
  VOICEOVER_COUNT_IN_SECONDS: [0, 1, 2, 3, 4],
  VOICEOVER_COMPENSATION_MS_LIMIT: 500,
}))

function session(phase: VoiceoverSession['phase'], extra: Partial<VoiceoverSession> = {}): VoiceoverSession {
  return {
    sessionId: 'voiceover_1', operation: 1, interruption: null, failure: null,
    destination: { projectId: 'p', projectGeneration: 1, editRevision: 1, sequenceId: 's',
      trackId: 'A1', startFrame: 30, frameRate: { num: 30, den: 1 }, audioSampleRate: 48_000 },
    phase, ...extra,
  } as VoiceoverSession
}

function setCapture(phase: VoiceoverSession['phase'] | null, extra: Record<string, unknown> = {}) {
  act(() => {
    useVoiceoverCaptureStore.setState({
      session: phase ? session(phase, (extra.session ?? {}) as Partial<VoiceoverSession>) : null,
      capturedSamples: (extra.capturedSamples as number) ?? 0,
      inputPeak: (extra.inputPeak as number) ?? 0,
      sourceLabel: 'USB mic', diagnostic: null, timing: null, playbackMuted: false,
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDocumentStoreForTest(createTimelineDoc('Voiceover UI', DEFAULT_PROJECT_SETTINGS, 'seq'))
  useVoiceoverSetupStore.setState({ trackId: null, countInSeconds: 1, compensationMs: 0,
    mutePlayback: false, deviceId: null, panelOpen: true })
  useVoiceoverDraftStore.setState({ drafts: [], busy: false, error: null, lastAction: null })
  setCapture(null)
})

describe('VoiceoverPanel', () => {
  test('records at the playhead with the chosen lane, count-in, offset, and mute', async () => {
    render(<VoiceoverPanel onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: /voiceover/i })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Count-in'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Latency offset (ms)'), { target: { value: '-40' } })
    fireEvent.click(screen.getByLabelText('Mute timeline audio while recording'))
    await act(async () => {})
    fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'usb' } })
    fireEvent.click(screen.getByRole('button', { name: /record at playhead/i }))
    expect(controller.startVoiceover).toHaveBeenCalledWith({ trackId: 'A1', countInSeconds: 3,
      compensationMs: -40, mutePlayback: true, deviceId: 'usb' })
  })

  test('explains a rejected start and an invalid offset without starting', () => {
    controller.startVoiceover.mockReturnValueOnce({ status: 'rejected', reason: 'Pause playback first.' } as never)
    render(<VoiceoverPanel onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /record at playhead/i }))
    expect(screen.getByRole('alert').textContent).toBe('Pause playback first.')
    fireEvent.change(screen.getByLabelText('Latency offset (ms)'), { target: { value: '900' } })
    fireEvent.click(screen.getByRole('button', { name: /record at playhead/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/within ±500/)
    expect(controller.startVoiceover).toHaveBeenCalledTimes(1)
  })

  test('disables recording when every audio lane is locked', () => {
    const doc = createTimelineDoc('Locked', DEFAULT_PROJECT_SETTINGS, 'seq')
    resetDocumentStoreForTest({ ...doc, tracks: doc.tracks.map((track) =>
      track.kind === 'audio' ? { ...track, locked: true } : track) })
    render(<VoiceoverPanel onClose={() => {}} />)
    expect((screen.getByRole('button', { name: /record at playhead/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Unlock an audio track to record onto.')).toBeTruthy()
  })

  test('recording shows elapsed time, level, and Stop/Cancel; Escape does not close', () => {
    const onClose = vi.fn()
    setCapture('recording', { capturedSamples: 48_000 * 12 + 24_000, inputPeak: 0.5 })
    render(<VoiceoverPanel onClose={onClose} />)
    expect(screen.getByRole('status').textContent).toContain('0:12.5')
    expect(screen.getByRole('meter', { name: 'Microphone input level' }).getAttribute('aria-valuenow')).toBe('50')
    expect(screen.queryByRole('button', { name: /record at playhead/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(controller.stopVoiceover).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  test('warns when the microphone delivers silence', () => {
    setCapture('recording', { capturedSamples: 48_000 * 3, inputPeak: 0 })
    render(<VoiceoverPanel onClose={() => {}} />)
    expect(screen.getByText(/No microphone signal yet/)).toBeTruthy()
  })

  test('review offers keep choices; an interrupted take can only go to the Media Pool', () => {
    setCapture('review', { session: { interruption: 'transport-changed' } })
    render(<VoiceoverPanel onClose={() => {}} />)
    expect(screen.getByText(/Playback was moved or paused/)).toBeTruthy()
    const onTimeline = screen.getByRole('button', { name: 'Keep on timeline' }) as HTMLButtonElement
    expect(onTimeline.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Keep in Media Pool' }))
    expect(controller.keepVoiceover).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(controller.cancelVoiceover).toHaveBeenCalledOnce()
  })

  test('permission denial is explained and recording can be retried', () => {
    setCapture('failed', { session: { failure: 'permission-denied' } })
    render(<VoiceoverPanel onClose={() => {}} />)
    expect(screen.getByText(/Microphone access was blocked/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /record at playhead/i })).toBeTruthy()
  })

  test('lists unsaved drafts for explicit recovery, never live ones', () => {
    act(() => {
      useVoiceoverDraftStore.setState({ drafts: [
        { id: 'voiceover_crash', sizeBytes: 44 + 96_000, hasJournal: true, state: 'orphaned', assetIds: [], references: [] },
        { id: 'voiceover_live', sizeBytes: null, hasJournal: true, state: 'live', assetIds: [], references: [] },
      ] })
    })
    render(<VoiceoverPanel onClose={() => {}} />)
    expect(screen.getByText('1 to recover')).toBeTruthy()
    expect(screen.getAllByText('Unsaved draft')).toHaveLength(1)
    expect(screen.getByText(/0:01\.0/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    expect(controller.recoverVoiceoverDraft).toHaveBeenCalledWith('voiceover_crash')
  })

  test('Escape closes the idle panel', () => {
    const onClose = vi.fn()
    render(<VoiceoverPanel onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('VoiceoverIndicator', () => {
  test('shows an idle entry, then a recording badge with Stop while the mic is live', () => {
    const onOpen = vi.fn()
    render(<VoiceoverIndicator open={false} disabled={false} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /voiceover/i }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull()
    setCapture('recording', { capturedSamples: 48_000 * 65 })
    expect(screen.getByRole('button', { name: /REC 1:05\.0/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(controller.stopVoiceover).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toMatch(/Microphone is in use/)
  })

  test('badges drafts waiting for recovery', () => {
    act(() => {
      useVoiceoverDraftStore.setState({ drafts: [
        { id: 'voiceover_crash', sizeBytes: 100, hasJournal: true, state: 'orphaned', assetIds: [], references: [] },
      ] })
    })
    render(<VoiceoverIndicator open={false} disabled={false} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: 'Voiceover, 1 recording drafts to recover' })).toBeTruthy()
  })
})
