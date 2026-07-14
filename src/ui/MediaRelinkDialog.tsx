import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  cancelActiveMediaRelink,
  resolveActiveMediaAmbiguity,
  skipActiveMediaAmbiguity,
} from '../app/projectController'
import {
  useProjectSessionStore,
  type MediaRelinkAmbiguitySummary,
} from '../state/projectSessionStore'

interface MediaRelinkChoiceProps {
  ambiguity: MediaRelinkAmbiguitySummary
}

function MediaRelinkChoice({ ambiguity }: MediaRelinkChoiceProps) {
  const [selectedToken, setSelectedToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const dialogRef = useRef<HTMLElement | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedToken || submitting) return
    setSubmitting(true)
    try {
      await resolveActiveMediaAmbiguity(ambiguity.token, selectedToken)
    } finally {
      setSubmitting(false)
    }
  }

  const handleSkip = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await skipActiveMediaAmbiguity(ambiguity.token)
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape' && !submitting) {
      event.preventDefault()
      cancelActiveMediaRelink()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button, input',
    )].filter((element) => !element.hasAttribute('disabled'))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement
    if (event.shiftKey && (current === first || !dialog.contains(current))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="media-import-backdrop media-relink-backdrop">
      <section
        ref={dialogRef}
        className="media-import-dialog media-relink-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-relink-title"
        aria-describedby="media-relink-description"
        onKeyDown={handleKeyDown}
      >
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="media-import-dialog-header">
            <span className="media-import-eyebrow">Folder match</span>
            <h2 id="media-relink-title">Choose the correct source</h2>
          </div>

          <div className="media-import-dialog-body">
            <p id="media-relink-description">
              More than one file could reconnect{' '}
              <strong>{ambiguity.assetFileName}</strong>. Nothing is selected
              automatically—choose a file only if you recognize it.
            </p>

            <fieldset className="media-relink-candidates" disabled={submitting}>
              <legend>Possible files</legend>
              {ambiguity.candidates.map((candidate) => (
                <label key={candidate.token} className="media-relink-candidate">
                  <input
                    type="radio"
                    name={`media-relink-${ambiguity.token}`}
                    value={candidate.token}
                    checked={selectedToken === candidate.token}
                    onChange={(event) => setSelectedToken(event.target.value)}
                  />
                  <span>
                    <strong>{candidate.fileName}</strong>
                    <small>{candidate.relativePath}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>

          <div className="media-import-dialog-actions media-relink-dialog-actions">
            <button
              autoFocus
              type="button"
              className="media-import-secondary"
              disabled={submitting}
              onClick={() => cancelActiveMediaRelink()}
            >
              Cancel remaining
            </button>
            <button
              type="button"
              className="media-import-secondary"
              disabled={submitting}
              onClick={() => void handleSkip()}
            >
              Leave source offline
            </button>
            <button
              type="submit"
              className="media-import-primary"
              disabled={!selectedToken || submitting}
            >
              {submitting ? 'Connecting…' : 'Connect selected file'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

export default function MediaRelinkDialog() {
  const ambiguity = useProjectSessionStore(
    (state) => state.activeMediaRelink.ambiguity,
  )
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)

  if (ambiguity && !wasOpenRef.current) {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    wasOpenRef.current = true
  }

  useEffect(() => {
    if (ambiguity || !wasOpenRef.current) return
    const target = restoreFocusRef.current
    restoreFocusRef.current = null
    wasOpenRef.current = false
    target?.focus()
  }, [ambiguity])

  useEffect(() => () => {
    restoreFocusRef.current?.focus()
  }, [])

  if (!ambiguity) return null

  // A new ambiguity remounts the choice body so selection always starts empty
  // without mirroring store state through an effect.
  return <MediaRelinkChoice key={ambiguity.token} ambiguity={ambiguity} />
}
