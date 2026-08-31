import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useDocumentStore } from '../state/documentStore'
import {
  createAdjustmentItem,
  findAdjustment,
  MAX_PROJECT_NAME_CHARACTERS,
  secondsToFrames,
} from '../state/editorUi'
import { useTransportStore } from '../state/transportStore'

interface AdjustmentDialogProps {
  onClose(): void
}

function integerDraft(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export default function AdjustmentDialog({ onClose }: AdjustmentDialogProps) {
  const initialDoc = useDocumentStore((state) => state.doc)
  const initialPlayhead = useTransportStore((state) => state.playheadFrame)
  const videoTracks = initialDoc.tracks.filter((track) => track.kind === 'video')
  const [trackId, setTrackId] = useState(
    videoTracks.find((track) => !track.locked)?.id ?? videoTracks[0]?.id ?? '',
  )
  const [name, setName] = useState('Adjustment')
  const [startFrame, setStartFrame] = useState(String(initialPlayhead))
  const [durationFrames, setDurationFrames] = useState(String(Math.max(
    1,
    secondsToFrames(5, initialDoc.frameRate),
  )))
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    const frame = requestAnimationFrame(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const start = integerDraft(startFrame)
    const duration = integerDraft(durationFrames)
    const trimmedName = name.trim()
    if (trimmedName.length < 1 || trimmedName.length > MAX_PROJECT_NAME_CHARACTERS) {
      setError(`Name must be 1–${MAX_PROJECT_NAME_CHARACTERS} characters.`)
      return
    }
    if (start === null || start < 0) {
      setError('Start frame must be a whole number at or after 0.')
      return
    }
    if (duration === null || duration < 1) {
      setError('Duration must be a positive whole number of frames.')
      return
    }

    const documentState = useDocumentStore.getState()
    const track = documentState.doc.tracks.find((candidate) => candidate.id === trackId)
    if (!track || track.kind !== 'video') {
      setError('Choose an available video track.')
      return
    }
    if (track.locked) {
      setError(`Unlock ${track.name} before adding an adjustment.`)
      return
    }

    const adjustment = createAdjustmentItem(start, duration, trimmedName)
    documentState.insertAdjustment(track.id, adjustment)
    if (!findAdjustment(useDocumentStore.getState().doc, adjustment.id)) {
      setError(`That range overlaps another item on ${track.name}. Choose a different range or track.`)
      return
    }

    const transport = useTransportStore.getState()
    transport.setSelectedAdjustment(adjustment.id)
    transport.setPlayheadFrame(start)
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="text-overlay-dialog adjustment-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form method="dialog" className="text-overlay-dialog-card" onSubmit={submit}>
        <header>
          <div>
            <h2 id={titleId}>Add adjustment layer</h2>
            <p id={descriptionId}>Effects apply to the completed video tracks below this lane.</p>
          </div>
          <button type="button" className="text-overlay-dialog-close" onClick={onClose} aria-label="Close add adjustment dialog">×</button>
        </header>

        <label className="text-overlay-dialog-field">
          <span>Name</span>
          <input
            ref={nameRef}
            value={name}
            maxLength={MAX_PROJECT_NAME_CHARACTERS}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
          />
        </label>

        <div className="text-overlay-dialog-grid">
          <label className="text-overlay-dialog-field">
            <span>Video track</span>
            <select value={trackId} onChange={(event) => setTrackId(event.target.value)}>
              {videoTracks.map((track) => (
                <option key={track.id} value={track.id} disabled={track.locked}>
                  {track.name}{track.locked ? ' (locked)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-overlay-dialog-field">
            <span>Start frame</span>
            <input
              type="number"
              min={0}
              step={1}
              value={startFrame}
              onChange={(event) => {
                setStartFrame(event.target.value)
                setError(null)
              }}
            />
          </label>
          <label className="text-overlay-dialog-field">
            <span>Duration (frames)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={durationFrames}
              onChange={(event) => {
                setDurationFrames(event.target.value)
                setError(null)
              }}
            />
          </label>
        </div>

        <div className="text-overlay-dialog-status" role={error ? 'alert' : 'status'} aria-live="polite">
          {error ?? 'Add color effects in the Inspector after placing it.'}
        </div>
        <footer>
          <button type="button" className="text-overlay-dialog-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="text-overlay-dialog-submit" disabled={videoTracks.length === 0}>Add adjustment</button>
        </footer>
      </form>
    </dialog>
  )
}
