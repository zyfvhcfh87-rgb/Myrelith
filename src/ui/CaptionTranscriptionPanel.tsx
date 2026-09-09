import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { captionTranscription as controller, SPEECH_MODEL } from '../app/captionTranscriptionController'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
const PAGE_SIZE = 40
export default function CaptionTranscriptionPanel({ onClose }: { onClose(): void }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const assets = useMediaStore(state => state.assets)
  const sources = [...assets.values()].filter(asset => asset.hasAudio && (asset.kind === 'audio' || asset.kind === 'video'))
  const playhead = useTransportStore(state => state.playheadFrame)
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [start, setStart] = useState('0'), [end, setEnd] = useState('')
  const [target, setTarget] = useState(String(playhead)), [language, setLanguage] = useState<'en' | 'fr'>('en')
  const [page, setPage] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const source = assets.get(sourceId)
  const busy = ['installing', 'preparing', 'running', 'stopping'].includes(snapshot.phase)
  const reviewing = snapshot.phase === 'review'
  useEffect(() => { heading.current?.focus(); void controller.refresh() }, [])
  useEffect(() => {
    setStart('0'); setEnd(source ? String(Math.min(300, Math.floor(source.durationMicroseconds / 1000) / 1000)) : '')
  }, [source])
  const pageCount = Math.max(1, Math.ceil(snapshot.rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const included = snapshot.rows.filter(row => row.included)
  const needTiming = included.some(row => row.startFrame === null || row.endFrame === null || row.endFrame <= row.startFrame)
  return <section className="caption-import-panel caption-speech-panel" data-caption-review>
    <h3 id="caption-speech-heading" tabIndex={-1} ref={heading}>Transcribe local audio</h3>
    <p>English or French · one connected source · 1–300 seconds. Processing stays on this device. Review every caption before applying it.</p>
    <p>Audio: continuous mono/stereo at 8–96 kHz with a supported decoder. Offline use also needs cached speech app/runtime files. Installing the model alone does not make the tools offline-ready. Reopening the app or loading missing app files requires an app connection.</p>
    <details><summary>Model, storage and licenses</summary>
      <p>Whisper tiny Q8 · {(SPEECH_MODEL.bytes / 1_000_000).toFixed(2)} MB · {SPEECH_MODEL.id} at {SPEECH_MODEL.revision}. Local cache budget: 96 MiB including an install in progress.</p>
      <p>Model SHA-256: <code>{SPEECH_MODEL.sha256}</code>. The exact upstream conversion/quantizer revision is unknown. Model and upstream Whisper notices are MIT; runtime dependency notices are included.</p>
      <a href={`${import.meta.env.BASE_URL}speech-runtime/runtime-notices.zip`} download>Download runtime and model license notices</a>
      <p>Download contacts Hugging Face only for this exact model. Selected local model files are checked against the same hash. Audio and transcripts are never uploaded.</p>
    </details>
    <fieldset disabled={busy || reviewing} className="caption-track-settings">
      <legend>Local speech model</legend>
      <p>{snapshot.installed ? 'Installed on this browser origin.' : 'No verified model installation is available.'}</p>
      <button type="button" onClick={() => controller.install(null)}>Download and install model</button>
      <label>Install selected model file<input type="file" accept=".bin" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) controller.install(file)
      }} /></label>
      <button type="button" onClick={() => { void controller.remove() }}>Remove local model</button>
    </fieldset>
    <fieldset disabled={busy || reviewing} className="caption-track-settings">
      <legend>Source and destination</legend>
      <label>Connected audio source<select value={sourceId} onChange={event => setSourceId(event.target.value)}>
        {!sources.length && <option value="">No connected sources</option>}
        {sources.map(asset => <option value={asset.id} key={asset.id}>{asset.fileName}</option>)}
      </select></label>
      <label>Language<select value={language} onChange={event => setLanguage(event.target.value === 'fr' ? 'fr' : 'en')}><option value="en">English</option><option value="fr">French</option></select></label>
      <label>Source start (seconds)<input type="number" min="0" step="0.001" value={start} onChange={event => setStart(event.target.value)} /></label>
      <label>Source end (seconds)<input type="number" min="1" step="0.001" value={end} onChange={event => setEnd(event.target.value)} /></label>
      <label>Insert at timeline frame<input type="number" min="0" step="1" value={target} onChange={event => setTarget(event.target.value)} /></label>
      <button type="button" disabled={!source || !snapshot.installed || !start || !end || !target} onClick={() => {
        setPage(0); controller.start({ assetId: sourceId, language, startMicroseconds: Math.round(Number(start) * 1_000_000),
          endMicroseconds: Math.round(Number(end) * 1_000_000), targetFrame: Number(target) })
      }}>Transcribe selected window</button>
    </fieldset>
    <p role="status" aria-live="polite">{snapshot.message}</p>
    {busy && <><progress max={1} value={snapshot.progress} aria-label="Speech progress" />
      <p>Cancel, playback and export wait for the current native window to finish, typically a few seconds and at most its 120 second deadline.</p>
      <button type="button" disabled={snapshot.phase === 'stopping'} onClick={() => { void controller.cancel().catch(() => undefined) }}>Cancel speech</button></>}
    {snapshot.error && <p role="alert">{snapshot.error}</p>}
    {reviewing && <>
      <p>{snapshot.rows.length} review rows · {included.length} included. Rows with missing timing cannot be applied. Splitting a row clears both halves’ timing for manual review.</p>
      <div className="caption-speech-rows" aria-label="Transcript review">{snapshot.rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((row, index) => {
        const number = currentPage * PAGE_SIZE + index + 1
        return <fieldset key={row.id} className="caption-track-settings"><legend>Caption {number} · {row.timing === 'manual' ? 'Manual timing required' : 'Model timing — review required'}</legend>
          <p>Source audio: {(row.sourceStartSample / snapshot.sourceSampleRate).toFixed(3)}–{((row.sourceStartSample + row.sourceSampleCount) / snapshot.sourceSampleRate).toFixed(3)} seconds. This is source coverage, not authored cue timing.</p>
          <label><input type="checkbox" checked={row.included} onChange={event => controller.updateRow(row.id, { included: event.target.checked })} />Include caption {number}</label>
          <label>Text {number}<textarea maxLength={20_000} value={row.text} onChange={event => controller.updateRow(row.id, { text: event.target.value })} /></label>
          <label>Start frame {number}<input type="number" min="0" step="1" value={row.startFrame ?? ''} onChange={event => controller.updateRow(row.id, { startFrame: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <label>End frame {number}<input type="number" min="1" step="1" value={row.endFrame ?? ''} onChange={event => controller.updateRow(row.id, { endFrame: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <button type="button" onClick={() => controller.splitRow(row.id)}>Split text for manual timing</button>
        </fieldset>
      })}</div>
      <div><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous captions</button>
        <span> Page {currentPage + 1} of {pageCount} </span><button type="button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>Next captions</button></div>
      {needTiming && <p>Enter valid start/end frames for all included text, or uncheck those rows.</p>}
      <button type="button" disabled={!included.length || needTiming} onClick={() => { if (controller.apply()) onClose() }}>Apply transcription as one edit</button>
      <button type="button" onClick={() => { void controller.cancel('Transcript review discarded') }}>Discard review</button>
    </>}
    <button type="button" onClick={onClose}>Close transcription</button>
  </section>
}
