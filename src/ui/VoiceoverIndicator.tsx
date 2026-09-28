/**
 * ui/VoiceoverIndicator.tsx — always-visible toolbar entry for voiceover.
 *
 * While any capture phase holds the microphone, it shows a recording badge
 * with elapsed time and a Stop control, even when the panel is closed.
 */
import { useEffect, type Ref } from 'react'
import { Microphone, Stop } from '@phosphor-icons/react'
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
  const phase = session?.phase ?? null
  const active = voiceoverSessionActive(session)

  // Metadata-only survey: after a crash or reload, left-behind drafts are
  // offered for explicit recovery. Never opens a device or imports anything.
  useEffect(() => {
    if (!voiceoverStorageAvailable()) return
    if (phase === null || phase === 'kept' || phase === 'cancelled' || phase === 'failed') {
      void refreshVoiceoverDrafts()
    }
  }, [projectGeneration, phase])
  const recording = session?.phase === 'recording'
  const countingIn = session?.phase === 'counting-in'
  const label = recording ? `REC ${voiceoverElapsedLabel(capturedSamples)}`
    : countingIn ? 'Count-in' : active ? 'Mic on' : 'Voiceover'

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
        title={active ? 'Microphone in use — open voiceover controls' : 'Record a voiceover'}
        onClick={onOpen}
      >
        {active
          ? <span className="voiceover-live-dot" aria-hidden="true" />
          : <Microphone aria-hidden="true" size={14} weight="bold" />}
        <span className="voiceover-toolbar-label">{label}</span>
        {!active && orphaned > 0 && <span className="voiceover-badge" aria-hidden="true">{orphaned}</span>}
      </button>
      {(recording || countingIn) && (
        <button
          type="button"
          className="toolbar-button voiceover-toolbar-stop"
          aria-label="Stop recording"
          title="Stop recording"
          onClick={() => void stopVoiceover()}
        >
          <Stop aria-hidden="true" size={12} weight="fill" />
        </button>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {active ? 'Microphone is in use for voiceover recording.' : ''}
      </span>
    </span>
  )
}
