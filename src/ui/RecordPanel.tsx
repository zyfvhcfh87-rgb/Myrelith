/**
 * ui/RecordPanel.tsx — non-modal local recording panel: Voiceover, Camera and
 * Screen tabs plus the shared list of recordings in browser storage.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { Record, X } from '@phosphor-icons/react'
import { refreshVoiceoverDrafts } from '../app/voiceoverController'
import { useAvCaptureSetupStore, useAvCaptureStore, type AvCaptureSetup } from '../state/avCaptureStore'
import { useVoiceoverCaptureStore } from '../state/voiceoverCaptureStore'
import { AvCaptureControls } from './AvCaptureControls'
import { DraftSection, VoiceoverControls } from './VoiceoverPanel'
import { voiceoverSessionActive } from './voiceoverFormat'

const MODES: ReadonlyArray<{ id: AvCaptureSetup['mode']; label: string }> = [
  { id: 'voiceover', label: 'Voiceover' },
  { id: 'camera', label: 'Camera' },
  { id: 'screen', label: 'Screen' },
]

const BUSY = new Set(['requesting', 'preparing', 'counting-in', 'recording', 'closing', 'keeping'])

export default function RecordPanel({ onClose }: { onClose(): void }) {
  const titleId = useId()
  const tabsId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const mode = useAvCaptureSetupStore((s) => s.mode)
  const voiceover = useVoiceoverCaptureStore((s) => s.session)
  const capture = useAvCaptureStore((s) => s.session)
  const busy = (voiceover !== null && BUSY.has(voiceover.phase)) || (capture !== null && BUSY.has(capture.phase))

  useEffect(() => {
    // Open on the tab of a take in progress.
    if (voiceoverSessionActive(voiceover)) useAvCaptureSetupStore.setState({ mode: 'voiceover' })
    else if (capture && BUSY.has(capture.phase)) useAvCaptureSetupStore.setState({ mode: capture.mode })
    headingRef.current?.focus()
    void refreshVoiceoverDrafts()
    // Runs once when the panel opens; later store changes must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!offset && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? MODES.length - 1
      : (index + offset + MODES.length) % MODES.length
    useAvCaptureSetupStore.setState({ mode: MODES[next]!.id })
    tabRefs.current[next]?.focus()
  }

  return (
    <section
      className="voiceover-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="voiceover-header">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          <Record aria-hidden="true" size={16} weight="fill" /> Record
        </h2>
        <button type="button" className="voiceover-close" aria-label="Close record panel" onClick={onClose}>
          <X aria-hidden="true" size={14} weight="bold" />
        </button>
      </header>
      <div className="record-tabs" role="tablist" aria-label="Recording type">
        {MODES.map((entry, index) => (
          <button key={entry.id} ref={(node) => { tabRefs.current[index] = node }} type="button" role="tab"
            id={`${tabsId}-${entry.id}`} aria-selected={mode === entry.id} aria-controls={`${tabsId}-panel`}
            tabIndex={mode === entry.id ? 0 : -1} className="record-tab"
            onClick={() => useAvCaptureSetupStore.setState({ mode: entry.id })}
            onKeyDown={(event) => onTabKey(event, index)}>
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${mode}`}>
        {mode === 'voiceover' ? <VoiceoverControls /> : <AvCaptureControls mode={mode} />}
      </div>
      <DraftSection />
    </section>
  )
}
