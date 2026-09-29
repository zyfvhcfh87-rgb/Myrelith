/**
 * ui/AvCaptureControls.tsx — camera and screen recording controls.
 * Reads serializable capture state only; streams, the worker and files stay
 * with app/avCaptureOwner behind app/avCaptureController.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Stop } from '@phosphor-icons/react'
import type { AvCaptureFailure, AvCaptureInterruption, AvCaptureMode, AvCaptureSession } from '../domain/avCaptureSession'
import {
  attachAvPreview,
  cancelAvCapture,
  keepAvCapture,
  listVideoInputDevices,
  retryAvCaptureCleanup,
  startAvCapture,
  stopAvCapture,
} from '../app/avCaptureController'
import { listVoiceoverInputDevices } from '../app/voiceoverController'
import { useAvCaptureSetupStore, useAvCaptureStore, type ScreenAudioChoice } from '../state/avCaptureStore'
import { avElapsedLabel } from './voiceoverFormat'

const FAILURE_TEXT: Record<AvCaptureFailure, string> = {
  'permission-denied': 'Access was blocked. Allow the camera, microphone or screen in the browser’s site settings, then try again.',
  'permission-dismissed': 'The browser prompt was closed. Press Record to choose again.',
  unsupported: 'This browser cannot record camera or screen video here.',
  'device-unavailable': 'The camera or microphone could not be opened. Check that it is connected and not used by another app.',
  'screen-permission': 'Your system blocked screen recording for this browser. On macOS, open System Settings → Privacy & Security → Screen & System Audio Recording, allow the browser, then restart it. Sharing a single browser tab does not need this.',
  'writer-failed': 'The recording could not be written to browser storage.',
  'project-replaced': 'The project was closed, so the take was set aside as a draft.',
}

const INTERRUPTION_TEXT: Record<AvCaptureInterruption, string> = {
  'source-ended': 'Sharing or the camera stopped, so the recording ended there. Everything up to that point was kept.',
  'page-frozen': 'The browser paused this page, so recording stopped. Everything written so far was kept.',
  limit: 'The take reached its size or length limit (60 minutes, 4 GiB) and stopped there.',
}

function phaseText(session: AvCaptureSession | null, mode: AvCaptureMode): string {
  if (!session) return 'Ready'
  switch (session.phase) {
    case 'requesting': return mode === 'screen' ? 'Choose what to share in the browser prompt…' : 'Waiting for camera permission…'
    case 'preparing': return 'Syncing video and audio clocks…'
    case 'recording': return 'Recording'
    case 'closing': return session.after === 'review' ? 'Finishing the recording…' : 'Stopping…'
    case 'review': return 'Recording ready to review'
    case 'keeping': return 'Saving to the Media Pool…'
    case 'kept': return 'Saved to the Media Pool'
    case 'cancelled': return 'Recording discarded'
    case 'failed': return 'Recording failed'
    case 'cleanup-failed': return 'Cleanup needs a retry'
  }
}

function Preview({ live }: { live: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => (live ? attachAvPreview(ref.current) : undefined), [live])
  return <video ref={ref} className="av-preview" muted playsInline aria-label="Live preview of the recording" />
}

export function AvCaptureControls({ mode }: { mode: AvCaptureMode }) {
  const cameraFieldId = useId()
  const microphoneFieldId = useId()
  const session = useAvCaptureStore((s) => s.session)
  const progress = useAvCaptureStore((s) => s.progress)
  const videoLabel = useAvCaptureStore((s) => s.videoLabel)
  const audioLabel = useAvCaptureStore((s) => s.audioLabel)
  const audioNote = useAvCaptureStore((s) => s.audioNote)
  const clockMethod = useAvCaptureStore((s) => s.clockMethod)
  const clockNote = useAvCaptureStore((s) => s.clockNote)
  const diagnostic = useAvCaptureStore((s) => s.diagnostic)
  const setup = useAvCaptureSetupStore()
  const [cameras, setCameras] = useState<ReadonlyArray<{ deviceId: string; label: string }>>([])
  const [microphones, setMicrophones] = useState<ReadonlyArray<{ deviceId: string; label: string }>>([])
  const [rejection, setRejection] = useState<string | null>(null)

  // A take in another mode keeps its own status; show this mode's controls only.
  const own = session && session.mode === mode ? session : null
  const otherActive = session !== null && session.mode !== mode && !['kept', 'cancelled', 'failed'].includes(session.phase)
  const phase = own?.phase ?? null
  const active = phase === 'requesting' || phase === 'preparing' || phase === 'recording' || phase === 'closing'
  const reviewing = phase === 'review' || phase === 'keeping'

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void listVideoInputDevices().then((next) => { if (!cancelled) setCameras(next) }, () => {})
      void listVoiceoverInputDevices().then((next) => { if (!cancelled) setMicrophones(next) }, () => {})
    }
    load()
    navigator.mediaDevices?.addEventListener?.('devicechange', load)
    return () => { cancelled = true; navigator.mediaDevices?.removeEventListener?.('devicechange', load) }
  }, [phase])

  const record = () => {
    setRejection(null)
    const result = startAvCapture(mode === 'camera'
      ? { mode, cameraId: setup.cameraId, cameraMicrophoneId: setup.cameraMicrophoneId }
      : { mode, screenAudio: setup.screenAudio, screenMicrophoneId: setup.screenMicrophoneId })
    if (result.status === 'rejected') setRejection(result.reason)
  }

  const failure = own?.failure ?? null
  const interruption = own?.interruption ?? null
  const statusDetail = failure ? FAILURE_TEXT[failure] : interruption ? INTERRUPTION_TEXT[interruption] : null
  const showProgress = (active || reviewing) && progress

  return (
    <div className="record-mode-body" data-phase={phase ?? 'idle'}>
      <div className="voiceover-status" role="status" aria-live="polite" aria-atomic="true">
        <strong>{phaseText(own, mode)}</strong>
        {showProgress && <span className="voiceover-elapsed">{avElapsedLabel(progress.durationUs)}</span>}
      </div>
      {statusDetail && <p className="voiceover-notice" data-tone={failure ? 'error' : 'warning'}>{statusDetail}</p>}
      {own && audioNote && <p className="voiceover-notice" data-tone="warning">{audioNote}</p>}
      {own && clockMethod === 'delivery-estimate' && (active || reviewing) && (
        <p className="voiceover-notice" data-tone="warning">
          The browser did not report exact frame capture times for this source, so picture and sound were
          lined up from arrival times. Check lip sync before relying on this take.
        </p>
      )}
      {own && clockNote && reviewing && <p className="voiceover-notice" data-tone="warning">{clockNote}</p>}
      {own && diagnostic && <p className="voiceover-diagnostic">{diagnostic}</p>}
      {rejection && <p className="voiceover-notice" data-tone="error" role="alert">{rejection}</p>}

      {phase === 'recording' && <Preview live />}

      {own && (active || reviewing) && (
        <dl className="voiceover-facts">
          {videoLabel && <><dt>{mode === 'camera' ? 'Camera' : 'Sharing'}</dt><dd>{videoLabel}</dd></>}
          <dt>Audio</dt><dd>{audioLabel ?? 'None'}</dd>
          {progress && <><dt>Size</dt><dd>{(progress.bytes / 1_048_576).toFixed(1)} MiB</dd></>}
          {progress?.width && <><dt>Frame</dt><dd>{progress.width}×{progress.height}</dd></>}
        </dl>
      )}

      {active && (
        <div className="voiceover-actions">
          <button type="button" className="voiceover-button voiceover-stop"
            disabled={phase !== 'recording'} onClick={() => void stopAvCapture()}>
            <Stop aria-hidden="true" size={13} weight="fill" /> Stop
          </button>
          <button type="button" className="voiceover-button" disabled={phase === 'closing'}
            onClick={() => void cancelAvCapture()}>Cancel</button>
        </div>
      )}

      {reviewing && (
        <div className="voiceover-actions">
          <button type="button" className="voiceover-button voiceover-primary" disabled={phase === 'keeping'}
            onClick={() => void keepAvCapture()}>Keep in Media Pool</button>
          <button type="button" className="voiceover-button voiceover-danger" disabled={phase === 'keeping'}
            onClick={() => void cancelAvCapture()}>Discard</button>
        </div>
      )}

      {phase === 'cleanup-failed' && (
        <div className="voiceover-actions">
          <button type="button" className="voiceover-button" onClick={() => void retryAvCaptureCleanup()}>Retry cleanup</button>
        </div>
      )}

      {!active && !reviewing && phase !== 'cleanup-failed' && (
        <form className="voiceover-setup" noValidate onSubmit={(event) => { event.preventDefault(); record() }}>
          {mode === 'camera' ? (
            <>
              <label htmlFor={cameraFieldId}>Camera</label>
              <select id={cameraFieldId} value={setup.cameraId ?? ''}
                onChange={(event) => useAvCaptureSetupStore.setState({ cameraId: event.target.value || null })}>
                <option value="">Browser default</option>
                {cameras.map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
              </select>
              <label htmlFor={microphoneFieldId}>Microphone</label>
              <select id={microphoneFieldId} value={setup.cameraMicrophoneId ?? ''}
                onChange={(event) => useAvCaptureSetupStore.setState({
                  cameraMicrophoneId: event.target.value === '' ? null : event.target.value })}>
                <option value="">Browser default</option>
                <option value="none">No microphone</option>
                {microphones.map((mic) => <option key={mic.deviceId} value={mic.deviceId}>{mic.label}</option>)}
              </select>
            </>
          ) : (
            <>
              <fieldset className="voiceover-span av-audio-choice">
                <legend>Audio</legend>
                {([['none', 'No audio'], ['display', 'Tab or system audio (when the browser offers it)'],
                  ['microphone', 'Microphone']] as Array<[ScreenAudioChoice, string]>).map(([value, label]) => (
                  <label key={value} className="voiceover-check">
                    <input type="radio" name="screen-audio" value={value} checked={setup.screenAudio === value}
                      onChange={() => useAvCaptureSetupStore.setState({ screenAudio: value })} />
                    {label}
                  </label>
                ))}
              </fieldset>
              {setup.screenAudio === 'microphone' && (
                <>
                  <label htmlFor={microphoneFieldId}>Microphone</label>
                  <select id={microphoneFieldId} value={setup.screenMicrophoneId ?? ''}
                    onChange={(event) => useAvCaptureSetupStore.setState({ screenMicrophoneId: event.target.value || null })}>
                    <option value="">Browser default</option>
                    {microphones.map((mic) => <option key={mic.deviceId} value={mic.deviceId}>{mic.label}</option>)}
                  </select>
                </>
              )}
              <p className="voiceover-hint voiceover-span">
                The browser asks which screen, window or tab to share, and shows its own sharing controls.
                Only one audio source is recorded; tabs can share their own audio.
              </p>
            </>
          )}
          <p className="voiceover-hint voiceover-span">
            Recordings stay on this device and are saved to the Media Pool when you keep them.
          </p>
          <button type="submit" className="voiceover-button voiceover-record voiceover-span" disabled={otherActive}>
            <span className="voiceover-record-dot" aria-hidden="true" />
            {mode === 'camera' ? 'Record camera' : 'Choose screen and record'}
          </button>
          {otherActive && <p className="voiceover-hint voiceover-span">Finish the current recording first.</p>}
        </form>
      )}
    </div>
  )
}
