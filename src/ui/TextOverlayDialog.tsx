import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createTextClip } from '../domain/operations'
import { findClip } from '../domain/selectors'
import { TEXT_OVERLAY_LIMITS } from '../domain/textOverlay'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

interface TextOverlayDialogProps {
  onClose(): void
}

function integerDraft(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export default function TextOverlayDialog({ onClose }: TextOverlayDialogProps) {
  const initialDoc = useDocumentStore((state) => state.doc)
  const initialPlayhead = useTransportStore((state) => state.playheadFrame)
  const videoTracks = initialDoc.tracks.filter((track) => track.kind === 'video')
  const [trackId, setTrackId] = useState(
    videoTracks.find((track) => !track.locked)?.id ?? videoTracks[0]?.id ?? '',
  )
  const [content, setContent] = useState('Your text')
  const [startFrame, setStartFrame] = useState(String(initialPlayhead))
  const [durationFrames, setDurationFrames] = useState(String(Math.max(
    1,
    Math.round((initialDoc.frameRate.num / initialDoc.frameRate.den) * 5),
  )))
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const contentRef = useRef<HTMLTextAreaElement | null>(null)
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
      contentRef.current?.focus()
      contentRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const start = integerDraft(startFrame)
    const duration = integerDraft(durationFrames)
    if (start === null || start < 0) {
      setError('Start frame must be a whole number at or after 0.')
      return
    }
    if (duration === null || duration < 1) {
      setError('Duration must be a positive whole number of frames.')
      return
    }
    if (content.length > TEXT_OVERLAY_LIMITS.maxCharacters) {
      setError(`Text must be ${TEXT_OVERLAY_LIMITS.maxCharacters.toLocaleString()} characters or fewer.`)
      return
    }

    const documentState = useDocumentStore.getState()
    const track = documentState.doc.tracks.find((candidate) => candidate.id === trackId)
    if (!track || track.kind !== 'video') {
      setError('Choose an available video track.')
      return
    }
    if (track.locked) {
      setError(`Unlock ${track.name} before adding text to it.`)
      return
    }

    const clip = createTextClip(documentState.doc, start, duration, content)
    documentState.insertClip(track.id, clip)
    const after = useDocumentStore.getState().doc
    if (!findClip(after, clip.id)) {
      setError(`That range overlaps another clip on ${track.name}. Choose a different start, duration, or video track.`)
      return
    }

    const transport = useTransportStore.getState()
    transport.setSelectedClip(clip.id)
    transport.setPlayheadFrame(start)
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="text-overlay-dialog"
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
            <h2 id={titleId}>Add text overlay</h2>
            <p id={descriptionId}>Choose exactly where this title or callout lives on the timeline.</p>
          </div>
          <button type="button" className="text-overlay-dialog-close" onClick={onClose} aria-label="Close add text dialog">×</button>
        </header>

        <label className="text-overlay-dialog-field text-overlay-dialog-content">
          <span>Text</span>
          <textarea
            ref={contentRef}
            value={content}
            maxLength={TEXT_OVERLAY_LIMITS.maxCharacters}
            rows={4}
            onChange={(event) => {
              setContent(event.target.value)
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
          {error ?? 'You can move, resize, and style it after adding it.'}
        </div>
        <footer>
          <button type="button" className="text-overlay-dialog-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="text-overlay-dialog-submit" disabled={videoTracks.length === 0}>Add text</button>
        </footer>
      </form>
    </dialog>
  )
}
