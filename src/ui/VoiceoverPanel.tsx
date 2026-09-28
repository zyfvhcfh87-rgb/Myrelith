/**
 * ui/VoiceoverPanel.tsx — non-modal microphone voiceover controls.
 *
 * Reads serializable capture/draft/setup state only. Every action goes through
 * app/voiceoverController; streams, worklets, and files never reach React.
 * The panel never subscribes to the playhead (render-isolation invariant):
 * the take starts at the playhead read inside the Record click.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Microphone, Stop, X } from '@phosphor-icons/react'
import { formatTimecode } from '../domain/time'
import { voiceoverLaneOptions } from '../domain/voiceoverDestination'
import type { VoiceoverDraftClassification } from '../domain/voiceoverDrafts'
import type { VoiceoverFailure, VoiceoverInterruption, VoiceoverSession } from '../domain/voiceoverSession'
import {
  cancelVoiceover,
  discardVoiceoverDraft,
  keepVoiceover,
  listVoiceoverInputDevices,
  recoverVoiceoverDraft,
  refreshVoiceoverDrafts,
  removeVoiceoverOriginal,
  retryVoiceoverCleanup,
  startVoiceover,
  stopVoiceover,
  VOICEOVER_COMPENSATION_MS_LIMIT,
  VOICEOVER_COUNT_IN_SECONDS,
} from '../app/voiceoverController'
import { useDocumentStore } from '../state/documentStore'
import {
  useVoiceoverCaptureStore,
  useVoiceoverDraftStore,
  useVoiceoverSetupStore,
  type VoiceoverDraftActionResult,
  type VoiceoverInputDevice,
} from '../state/voiceoverCaptureStore'
import { VOICEOVER_DISPLAY_SAMPLE_RATE, voiceoverElapsedLabel, voiceoverSessionActive } from './voiceoverFormat'

const SAMPLE_RATE = VOICEOVER_DISPLAY_SAMPLE_RATE

const INTERRUPTION_TEXT: Record<VoiceoverInterruption, string> = {
  'source-ended': 'The microphone stopped (unplugged, or access was revoked).',
  hidden: 'The editor was hidden or frozen, so recording stopped.',
  'transport-changed': 'Playback was moved or paused, so recording stopped.',
  'destination-changed': 'The timeline changed during the take, so it can only be kept in the Media Pool.',
  overrun: 'Storage could not keep up, so recording stopped early.',
}

const FAILURE_TEXT: Record<VoiceoverFailure, string> = {
  'permission-denied': 'Microphone access was blocked. Allow it in the browser’s site settings, then try again.',
  'permission-dismissed': 'The microphone prompt was dismissed. Press Record to ask again.',
  unsupported: 'This browser cannot record voiceover here.',
  'device-unavailable': 'No usable microphone was found. Check that one is connected and not in use.',
  'writer-failed': 'The recording could not be written to browser storage.',
  'finalization-failed': 'The recording could not be finished.',
  'project-replaced': 'The project was closed, so the take was set aside as a draft.',
  'cleanup-failed': 'The recording could not be closed cleanly.',
}

function phaseText(session: VoiceoverSession | null): string {
  if (!session) return 'Ready'
  switch (session.phase) {
    case 'requesting': return 'Waiting for microphone permission…'
    case 'preparing': return 'Preparing the microphone…'
    case 'counting-in': return 'Count-in…'
    case 'recording': return 'Recording'
    case 'closing': return session.after === 'review' ? 'Finishing the take…' : 'Stopping…'
    case 'review': return 'Take ready to review'
    case 'keeping': return 'Saving the take…'
    case 'kept': return session.location === 'timeline' ? 'Take placed on the timeline' : 'Take saved to the Media Pool'
    case 'cancelled': return 'Take discarded'
    case 'failed': return 'Recording failed'
    case 'cleanup-failed': return 'Cleanup needs a retry'
  }
}

function sizeText(bytes: number | null): string {
  if (bytes === null) return 'size unknown'
  // 44-byte WAV header, mono 16-bit at 48 kHz.
  const samples = Math.max(0, bytes - 44) / 2
  return `${voiceoverElapsedLabel(samples)} · ${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function actionText(action: VoiceoverDraftActionResult | null): string | null {
  if (!action) return null
  switch (action.status) {
    case 'recovered': return 'Draft recovered into the Media Pool.'
    case 'discarded': return 'Draft deleted.'
    case 'removed': return action.note ? `Recording file removed. ${action.note}` : 'Recording file removed.'
    case 'cancelled': return 'Stopped because the project changed.'
    case 'rejected': return action.reason
    case 'failed': return action.message
  }
}

function InputLevel({ peak }: { peak: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, peak)) * 100)
  return (
    <div
      className="voiceover-level"
      role="meter"
      aria-label="Microphone input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={percent === 0 ? 'no signal' : `${percent} percent`}
    >
      <span className="voiceover-level-fill" style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  )
}

function DraftRow({ draft, busy }: { draft: VoiceoverDraftClassification; busy: boolean }) {
  if (draft.state === 'live') return null
  const label = draft.state === 'orphaned' ? 'Unsaved draft' : 'Kept recording'
  return (
    <li className="voiceover-draft" data-state={draft.state}>
      <span className="voiceover-draft-name">
        <strong>{label}</strong>
        <span>{sizeText(draft.sizeBytes)}</span>
      </span>
      {draft.state === 'orphaned' ? (
        <span className="voiceover-draft-actions">
          <button type="button" className="voiceover-button" disabled={busy}
            onClick={() => void recoverVoiceoverDraft(draft.id)}>Recover</button>
          <button type="button" className="voiceover-button voiceover-danger" disabled={busy}
            onClick={() => {
              if (window.confirm('Delete this unsaved recording draft? This cannot be undone.')) {
                void discardVoiceoverDraft(draft.id)
              }
            }}>Delete</button>
        </span>
      ) : draft.assetIds.length === 1 ? (
        <span className="voiceover-draft-actions">
          <button type="button" className="voiceover-button voiceover-danger" disabled={busy}
            title="Only allowed when no clip, undo step, or other project still uses it"
            onClick={() => {
              if (window.confirm('Delete this recording file from browser storage? Its media will go offline in this project.')) {
                void removeVoiceoverOriginal(draft.assetIds[0]!)
              }
            }}>Delete file</button>
        </span>
      ) : null}
    </li>
  )
}

function DraftSection() {
  const drafts = useVoiceoverDraftStore((s) => s.drafts)
  const busy = useVoiceoverDraftStore((s) => s.busy)
  const error = useVoiceoverDraftStore((s) => s.error)
  const lastAction = useVoiceoverDraftStore((s) => s.lastAction)
  const visible = drafts?.filter((draft) => draft.state !== 'live') ?? []
  const orphaned = visible.filter((draft) => draft.state === 'orphaned').length
  const message = error ?? actionText(lastAction)
  // Opens itself when drafts need attention, then stays open until the user closes it.
  const [open, setOpen] = useState(orphaned > 0)
  useEffect(() => { if (orphaned > 0) setOpen(true) }, [orphaned])
  return (
    <details className="voiceover-drafts" open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Recordings in browser storage{drafts ? ` (${visible.length})` : ''}
        {orphaned > 0 && <span className="voiceover-badge">{orphaned} to recover</span>}
      </summary>
      <p className="voiceover-hint">
        Unsaved drafts are left behind by a crash or a closed tab. Nothing is imported or deleted
        until you choose.
      </p>
      {drafts === null ? <p className="voiceover-hint">{busy ? 'Checking…' : 'Not checked yet.'}</p>
        : visible.length === 0 ? <p className="voiceover-hint">No recordings stored.</p>
          : <ul className="voiceover-draft-list">{visible.map((draft) =>
            <DraftRow key={draft.id} draft={draft} busy={busy} />)}</ul>}
      {message && <p className="voiceover-hint" role="status">{message}</p>}
      <button type="button" className="voiceover-button" disabled={busy}
        onClick={() => void refreshVoiceoverDrafts()}>Check again</button>
    </details>
  )
}

export default function VoiceoverPanel({ onClose }: { onClose(): void }) {
  const titleId = useId()
  const laneId = useId()
  const deviceId = useId()
  const countInId = useId()
  const offsetId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const doc = useDocumentStore((s) => s.doc)
  const session = useVoiceoverCaptureStore((s) => s.session)
  const capturedSamples = useVoiceoverCaptureStore((s) => s.capturedSamples)
  const inputPeak = useVoiceoverCaptureStore((s) => s.inputPeak)
  const sourceLabel = useVoiceoverCaptureStore((s) => s.sourceLabel)
  const diagnostic = useVoiceoverCaptureStore((s) => s.diagnostic)
  const timing = useVoiceoverCaptureStore((s) => s.timing)
  const setup = useVoiceoverSetupStore()
  const [devices, setDevices] = useState<readonly VoiceoverInputDevice[]>([])
  const [rejection, setRejection] = useState<string | null>(null)
  const [offsetText, setOffsetText] = useState(String(setup.compensationMs))

  const lanes = voiceoverLaneOptions(doc)
  const usableLanes = lanes.filter((lane) => !lane.locked)
  const trackId = setup.trackId && usableLanes.some((lane) => lane.id === setup.trackId)
    ? setup.trackId : usableLanes[0]?.id ?? null
  const active = voiceoverSessionActive(session)
  const phase = session?.phase ?? null
  const reviewing = phase === 'review'
  const busySession = active || phase === 'keeping'

  useEffect(() => { headingRef.current?.focus() }, [])
  useEffect(() => { void refreshVoiceoverDrafts() }, [])
  useEffect(() => {
    let cancelled = false
    const load = () => void listVoiceoverInputDevices().then((next) => { if (!cancelled) setDevices(next) }, () => {})
    load()
    // Labels become available after the first permission grant.
    if (phase === 'recording' || phase === 'review') load()
    navigator.mediaDevices?.addEventListener?.('devicechange', load)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', load)
    }
  }, [phase])

  const record = () => {
    setRejection(null)
    if (!trackId) return
    const offset = Number(offsetText)
    if (offsetText.trim() === '' || !Number.isInteger(offset) || Math.abs(offset) > VOICEOVER_COMPENSATION_MS_LIMIT) {
      setRejection(`Latency offset must be a whole number of milliseconds within ±${VOICEOVER_COMPENSATION_MS_LIMIT}.`)
      return
    }
    useVoiceoverSetupStore.setState({ trackId, compensationMs: offset })
    const result = startVoiceover({ trackId, countInSeconds: setup.countInSeconds,
      compensationMs: offset, mutePlayback: setup.mutePlayback, deviceId: setup.deviceId })
    if (result.status === 'rejected') setRejection(result.reason)
  }

  const interruption = session?.interruption ?? null
  const failure = session?.failure ?? null
  const statusDetail = failure ? FAILURE_TEXT[failure]
    : interruption ? INTERRUPTION_TEXT[interruption] : null
  const noSignal = phase === 'recording' && capturedSamples >= SAMPLE_RATE * 2 && inputPeak === 0

  return (
    <section
      className="voiceover-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-phase={phase ?? 'idle'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busySession) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="voiceover-header">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          <Microphone aria-hidden="true" size={16} weight="fill" /> Voiceover
        </h2>
        <button type="button" className="voiceover-close" aria-label="Close voiceover panel" onClick={onClose}>
          <X aria-hidden="true" size={14} weight="bold" />
        </button>
      </header>

      <div className="voiceover-status" role="status" aria-live="polite" aria-atomic="true">
        <strong>{phaseText(session)}</strong>
        {(active || reviewing || phase === 'keeping') && (
          <span className="voiceover-elapsed">{voiceoverElapsedLabel(capturedSamples)}</span>
        )}
      </div>
      {statusDetail && <p className="voiceover-notice" data-tone={failure ? 'error' : 'warning'}>{statusDetail}</p>}
      {diagnostic && <p className="voiceover-diagnostic">{diagnostic}</p>}
      {rejection && <p className="voiceover-notice" data-tone="error" role="alert">{rejection}</p>}
      {noSignal && (
        <p className="voiceover-notice" data-tone="warning" role="alert">
          No microphone signal yet. Check the input device and its mute switch.
        </p>
      )}

      {(active || reviewing) && (
        <dl className="voiceover-facts">
          {sourceLabel && <><dt>Source</dt><dd>{sourceLabel}</dd></>}
          {session && <><dt>Starts at</dt><dd>{formatTimecode(session.destination.startFrame, doc.frameRate)}</dd></>}
          {timing && timing.compensationSamples !== 0 && (
            <><dt>Offset</dt><dd>{Math.round(timing.compensationSamples / (SAMPLE_RATE / 1000))} ms</dd></>
          )}
        </dl>
      )}

      {active && (
        <>
          <InputLevel peak={inputPeak} />
          <div className="voiceover-actions">
            <button type="button" className="voiceover-button voiceover-stop"
              disabled={phase === 'closing' || phase === 'requesting'}
              onClick={() => void stopVoiceover()}>
              <Stop aria-hidden="true" size={13} weight="fill" /> Stop
            </button>
            <button type="button" className="voiceover-button" disabled={phase === 'closing'}
              onClick={() => void cancelVoiceover()}>Cancel</button>
          </div>
        </>
      )}

      {(reviewing || phase === 'keeping') && (
        <div className="voiceover-actions">
          <button type="button" className="voiceover-button voiceover-primary"
            disabled={phase === 'keeping' || interruption !== null}
            title={interruption === null ? undefined : 'Interrupted takes can only be kept in the Media Pool'}
            onClick={() => void keepVoiceover(true)}>Keep on timeline</button>
          <button type="button" className="voiceover-button" disabled={phase === 'keeping'}
            onClick={() => void keepVoiceover(false)}>Keep in Media Pool</button>
          <button type="button" className="voiceover-button voiceover-danger" disabled={phase === 'keeping'}
            onClick={() => void cancelVoiceover()}>Discard</button>
        </div>
      )}

      {phase === 'cleanup-failed' && (
        <div className="voiceover-actions">
          <button type="button" className="voiceover-button" onClick={() => void retryVoiceoverCleanup()}>
            Retry cleanup
          </button>
        </div>
      )}

      {!busySession && !reviewing && phase !== 'cleanup-failed' && (
        <form className="voiceover-setup" noValidate onSubmit={(event) => { event.preventDefault(); record() }}>
          <label htmlFor={laneId}>Audio track</label>
          <select id={laneId} value={trackId ?? ''} disabled={usableLanes.length === 0}
            onChange={(event) => useVoiceoverSetupStore.setState({ trackId: event.target.value })}>
            {lanes.length === 0 && <option value="">No audio tracks</option>}
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id} disabled={lane.locked}>
                {lane.name}{lane.locked ? ' (locked)' : ''}
              </option>
            ))}
          </select>

          <label htmlFor={deviceId}>Microphone</label>
          <select id={deviceId} value={setup.deviceId ?? ''}
            onChange={(event) => useVoiceoverSetupStore.setState({ deviceId: event.target.value || null })}>
            <option value="">Browser default</option>
            {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>

          <label htmlFor={countInId}>Count-in</label>
          <select id={countInId} value={setup.countInSeconds}
            onChange={(event) => useVoiceoverSetupStore.setState({ countInSeconds: Number(event.target.value) })}>
            {VOICEOVER_COUNT_IN_SECONDS.map((seconds) => (
              <option key={seconds} value={seconds}>{seconds === 0 ? 'Off' : `${seconds} s`}</option>
            ))}
          </select>

          <label htmlFor={offsetId}>Latency offset (ms)</label>
          <input id={offsetId} type="number" inputMode="numeric" step={1}
            min={-VOICEOVER_COMPENSATION_MS_LIMIT} max={VOICEOVER_COMPENSATION_MS_LIMIT}
            value={offsetText} aria-describedby={`${offsetId}-hint`}
            onChange={(event) => setOffsetText(event.target.value)} />
          <p id={`${offsetId}-hint`} className="voiceover-hint voiceover-span">
            Uncalibrated: 0 ms places audio exactly as the browser delivers it. A positive value
            moves the take earlier to cancel microphone delay.
          </p>

          <label className="voiceover-check voiceover-span">
            <input type="checkbox" checked={setup.mutePlayback}
              onChange={(event) => useVoiceoverSetupStore.setState({ mutePlayback: event.target.checked })} />
            Mute timeline audio while recording
          </label>

          <p className="voiceover-hint voiceover-span">
            Use headphones: timeline audio and the count-in can leak from speakers into the
            microphone. Your microphone is never played back.
          </p>

          <button type="submit" className="voiceover-button voiceover-record voiceover-span"
            disabled={!trackId}>
            <span className="voiceover-record-dot" aria-hidden="true" />
            Record at playhead
          </button>
          {!trackId && (
            <p className="voiceover-hint voiceover-span">
              {lanes.length === 0 ? 'Add an audio track to record onto.' : 'Unlock an audio track to record onto.'}
            </p>
          )}
        </form>
      )}

      <DraftSection />
    </section>
  )
}
