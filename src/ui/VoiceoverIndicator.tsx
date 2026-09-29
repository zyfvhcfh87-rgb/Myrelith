/**
 * ui/VoiceoverIndicator.tsx — always-visible toolbar Record entry.
 *
 * While any capture (voiceover, camera, screen) holds a device, it shows a
 * recording badge with elapsed time and a Stop control, even when the panel
 * is closed. It also badges drafts left behind by a crash or reload.
 */
import { useEffect, type Ref } from 'react'
import { Record, Stop } from '@phosphor-icons/react'
import { stopAvCapture } from '../app/avCaptureController'
import { useAvCaptureStore } from '../state/avCaptureStore'
import { refreshVoiceoverDrafts, stopVoiceover, voiceoverStorageAvailable } from '../app/voiceoverController'
import { useDocumentStore } from '../state/documentStore'
import { useVoiceoverCaptureStore, useVoiceoverDraftStore } from '../state/voiceoverCaptureStore'
import { voiceoverElapsedLabel, voiceoverSessionActive } from './voiceoverFormat'

export default function VoiceoverIndicator({ buttonRef, open, disabled, onOpen }: {
  buttonRef?: Ref<HTMLButtonElement>
  open: boolean
  disabled: boolean
  onOpen(): void
}) {
  const session = useVoiceoverCaptureStore((s) => s.session)
  const capturedSamples = useVoiceoverCaptureStore((s) => s.capturedSamples)
  const orphaned = useVoiceoverDraftStore((s) => s.drafts?.filter((draft) => draft.state === 'orphaned').length ?? 0)
  const projectGeneration = useDocumentStore((s) => s.projectGeneration)
  const capture = useAvCaptureStore((s) => s.session)
  const captureUs = useAvCaptureStore((s) => s.progress?.durationUs ?? 0)
  const phase = session?.phase ?? null
  const capturePhase = capture?.phase ?? null
  const captureActive = capturePhase === 'requesting' || capturePhase === 'preparing' ||
    capturePhase === 'recording' || capturePhase === 'closing'
  const voiceoverActive = voiceoverSessionActive(session)
  const active = voiceoverActive || captureActive

  // Metadata-only survey: after a crash or reload, left-behind drafts are
  // offered for explicit recovery. Never opens a device or imports anything.
  useEffect(() => {
    if (!voiceoverStorageAvailable()) return
    const settled = (value: string | null) => value === null || value === 'kept' || value === 'cancelled' || value === 'failed'
    if (settled(phase) && settled(capturePhase)) void refreshVoiceoverDrafts()
  }, [projectGeneration, phase, capturePhase])
  const recording = phase === 'recording' || capturePhase === 'recording'
  const countingIn = phase === 'counting-in'
  const elapsed = voiceoverActive ? voiceoverElapsedLabel(capturedSamples) : voiceoverElapsedLabel(Math.floor(captureUs * 48 / 1000))
  const label = recording ? `REC ${elapsed}`
    : countingIn ? 'Count-in' : active ? (captureActive && capture?.mode === 'screen' ? 'Sharing' : 'Device on') : 'Record'

  return (
    <span className="voiceover-indicator" data-active={active || undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="toolbar-button voiceover-toolbar-button"
        aria-label={!active && orphaned > 0 ? `${label}, ${orphaned} recording drafts to recover` : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={active ? 'Recording device in use — open recording controls' : 'Record voiceover, camera or screen'}
        onClick={onOpen}
      >
        {active
          ? <span className="voiceover-live-dot" aria-hidden="true" />
          : <Record aria-hidden="true" size={14} weight="bold" />}
        <span className="voiceover-toolbar-label">{label}</span>
        {!active && orphaned > 0 && <span className="voiceover-badge" aria-hidden="true">{orphaned}</span>}
      </button>
      {(recording || countingIn) && (
        <button
          type="button"
          className="toolbar-button voiceover-toolbar-stop"
          aria-label="Stop recording"
          title="Stop recording"
          onClick={() => void (voiceoverActive ? stopVoiceover() : stopAvCapture())}
        >
          <Stop aria-hidden="true" size={12} weight="fill" />
        </button>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {voiceoverActive ? 'Microphone is in use for voiceover recording.'
          : captureActive ? `Recording ${capture?.mode === 'screen' ? 'the shared screen' : 'the camera'}.` : ''}
      </span>
    </span>
  )
}
