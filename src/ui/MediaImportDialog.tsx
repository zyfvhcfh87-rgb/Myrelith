import type { KeyboardEvent } from 'react'
import {
  cancelMediaImport,
  dismissMediaImportError,
  resolveMediaImportDecision,
} from '../app/mediaImportController'
import type { FrameRate } from '../domain/schema'
import { useMediaImportStore } from '../state/mediaImportStore'

function formatRate(rate: FrameRate): string {
  const fps = rate.num / rate.den
  if (Number.isInteger(fps)) return String(fps)
  return fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

export default function MediaImportDialog() {
  const phase = useMediaImportStore((state) => state.phase)
  const fileName = useMediaImportStore((state) => state.fileName)
  const prompt = useMediaImportStore((state) => state.prompt)
  const error = useMediaImportStore((state) => state.error)

  if (phase === 'idle') return null

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // A modal choice must not leak editor shortcuts (S/Delete/A/B/etc.) to
    // the timeline behind it.
    event.stopPropagation()
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (phase === 'error') dismissMediaImportError()
    else cancelMediaImport()
  }

  return (
    <div className="media-import-backdrop">
      <section
        className="media-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-import-title"
        aria-describedby="media-import-description"
        onKeyDown={handleKeyDown}
      >
        {phase === 'awaiting-decision' && prompt ? (
          <>
            <div className="media-import-dialog-header">
              <span className="media-import-eyebrow">Timing check</span>
              <h2 id="media-import-title">Frame rate mismatch</h2>
            </div>
            <div className="media-import-dialog-body">
              <p id="media-import-description">
                <strong>{prompt.fileName}</strong> uses a different frame rate
                from this project. Choose how WebCut should time the import.
              </p>
              <dl className="media-import-rates">
                <div>
                  <dt>Project</dt>
                  <dd>{formatRate(prompt.projectRate)} fps</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{formatRate(prompt.sourceRate)} fps</dd>
                </div>
              </dl>
              {prompt.matchUnavailableReason ? (
                <p className="media-import-note">
                  {prompt.matchUnavailableReason} Keep the project rate or
                  cancel this import.
                </p>
              ) : (
                <p className="media-import-note">
                  Matching changes the project FPS and re-conforms media that
                  is not yet on the timeline.
                </p>
              )}
            </div>
            <div className="media-import-dialog-actions">
              <button
                type="button"
                className="media-import-secondary"
                onClick={() => resolveMediaImportDecision('cancel')}
              >
                Cancel import
              </button>
              <button
                type="button"
                className="media-import-secondary"
                disabled={!prompt.canMatchSource}
                title={prompt.matchUnavailableReason ?? undefined}
                onClick={() => resolveMediaImportDecision('match-source-rate')}
              >
                Use {formatRate(prompt.sourceRate)} fps
              </button>
              <button
                type="button"
                className="media-import-primary"
                autoFocus
                onClick={() => resolveMediaImportDecision('keep-project-rate')}
              >
                Keep {formatRate(prompt.projectRate)} fps
              </button>
            </div>
          </>
        ) : phase === 'error' ? (
          <>
            <div className="media-import-dialog-header">
              <span className="media-import-eyebrow">Import stopped</span>
              <h2 id="media-import-title">Could not import media</h2>
            </div>
            <div className="media-import-dialog-body">
              <p id="media-import-description" className="media-import-error" role="alert">
                {error}
              </p>
            </div>
            <div className="media-import-dialog-actions">
              <button
                type="button"
                className="media-import-primary"
                autoFocus
                onClick={dismissMediaImportError}
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="media-import-dialog-header">
              <span className="media-import-eyebrow">Media import</span>
              <h2 id="media-import-title">
                {phase === 'cancelling'
                  ? 'Cancelling…'
                  : 'Checking media compatibility…'}
              </h2>
            </div>
            <div className="media-import-dialog-body">
              <p id="media-import-description" role="status">
                {phase === 'cancelling'
                  ? 'Finishing cleanup safely.'
                  : `Reading container and track metadata for ${fileName ?? 'the selected file'}.`}
              </p>
            </div>
            <div className="media-import-dialog-actions">
              <button
                type="button"
                className="media-import-secondary"
                autoFocus
                disabled={phase === 'cancelling'}
                onClick={cancelMediaImport}
              >
                {phase === 'cancelling' ? 'Cancelling…' : 'Cancel import'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
