/**
 * ui/CollectMediaDialog.tsx — explicit local collect-media/archive flow.
 * Destination handles and file bytes stay in the app controller.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import type {
  CollectMediaInclusionPolicy,
  CollectMediaPreflight,
} from '../domain/collectMedia'
import {
  cancelCollectMedia,
  collectActiveProject,
  DEFAULT_COLLECT_MEDIA_POLICY,
  preflightCollectMedia,
  type CollectMediaProgress,
  type CollectMediaResult,
} from '../app/collectMediaController'
import {
  getCollectMediaPickerAvailability,
  isCollectMediaAbort,
  pickCollectMediaDestination,
} from '../app/collectMediaArchive'

interface CollectMediaDialogProps {
  onClose(): void
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  return 'Could not collect media.'
}

export default function CollectMediaDialog({ onClose }: CollectMediaDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [policy, setPolicy] = useState<CollectMediaInclusionPolicy>(
    DEFAULT_COLLECT_MEDIA_POLICY,
  )
  const [preflight, setPreflight] = useState<CollectMediaPreflight | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [progress, setProgress] = useState<CollectMediaProgress | null>(null)
  const [result, setResult] = useState<CollectMediaResult | null>(null)
  const [busy, setBusy] = useState(false)
  const collectRunRef = useRef<Promise<unknown> | null>(null)
  const picker = getCollectMediaPickerAvailability()
  const working = busy && result === null

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void preflightCollectMedia(policy).then((next) => {
      if (!cancelled) {
        setPreflight(next)
        setPreflightError(null)
      }
    }, (cause: unknown) => {
      if (!cancelled) setPreflightError(errorMessage(cause))
    })
    return () => {
      cancelled = true
    }
  }, [policy])

  const close = useCallback((): void => {
    if (busy) cancelCollectMedia()
    const running = collectRunRef.current
    if (running) {
      void running.finally(() => onClose())
      return
    }
    onClose()
  }, [busy, onClose])

  const startCollect = async (): Promise<void> => {
    if (busy || !picker.available) return
    setBusy(true)
    setResult(null)
    try {
      const destination = await pickCollectMediaDestination()
      const running = collectActiveProject(destination, policy, setProgress)
      collectRunRef.current = running
      try {
        setResult(await running)
      } finally {
        collectRunRef.current = null
      }
    } catch (cause) {
      if (isCollectMediaAbort(cause)) {
        setResult({ status: 'cancelled' })
      } else {
        setResult({ status: 'failed', message: errorMessage(cause) })
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="collect-media-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        if (!working) close()
        else cancelCollectMedia()
      }}
    >
      <div className="collect-media-card">
        <header className="collect-media-header">
          <div>
            <span className="collect-media-eyebrow">Archive</span>
            <h2 id={titleId}>Collect media</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="collect-media-close"
            aria-label="Close collect media dialog"
            onClick={close}
          >
            ×
          </button>
        </header>
        <p id={descriptionId} className="collect-media-lead">
          Copy referenced sources into a chosen local folder. Save and Save As stay unchanged.
        </p>
        {!picker.available && (
          <p className="collect-media-error" role="alert">{picker.reason}</p>
        )}
        {preflightError && (
          <p className="collect-media-error" role="alert">{preflightError}</p>
        )}
        <fieldset className="collect-media-policy" disabled={busy}>
          <legend>Inclusion policy</legend>
          <label>
            <input
              type="checkbox"
              checked={policy.includeProxies}
              onChange={(event) => setPolicy((current) => ({
                ...current,
                includeProxies: event.target.checked,
              }))}
            />
            Include editing proxies
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy.includeTitleTemplates}
              onChange={(event) => setPolicy((current) => ({
                ...current,
                includeTitleTemplates: event.target.checked,
              }))}
            />
            Include origin-local title templates
          </label>
        </fieldset>
        {preflight && (
          <section aria-label="Collect-media preflight">
            <p className="collect-media-counts">
              Included {preflight.includedCount} · Excluded {preflight.excludedCount} · Offline {preflight.offlineCount} · Unresolved {preflight.unresolvedCount}
            </p>
            <ul className="collect-media-list">
              {preflight.items.map((item) => (
                <li key={item.id} data-disposition={item.disposition}>
                  <strong>{item.originalFileName ?? item.id}</strong>
                  <span>{item.disposition}</span>
                  <span>{item.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {progress && (
          <p role="status" aria-live="polite">
            {progress.phase === 'copying'
              ? `Copying ${progress.currentName ?? 'media'} (${progress.completedFiles}/${progress.totalFiles})`
              : progress.phase === 'writing-project'
                ? 'Writing the project copy…'
                : progress.phase === 'writing-manifest'
                  ? 'Writing the collect-media manifest…'
                  : progress.phase}
          </p>
        )}
        {result?.status === 'complete' && (
          <p role="status">
            Complete archive in {result.destinationName}: {result.projectFileName}
          </p>
        )}
        {result?.status === 'partial' && (
          <p className="collect-media-error" role="alert">
            Incomplete archive. {result.message} It is marked incomplete and is not a finished package.
          </p>
        )}
        {result?.status === 'failed' && (
          <p className="collect-media-error" role="alert">{result.message}</p>
        )}
        {result?.status === 'cancelled' && (
          <p role="status">Collect media was cancelled.</p>
        )}
        <div className="collect-media-actions">
          {working ? (
            <button type="button" onClick={() => cancelCollectMedia()}>
              Cancel copy
            </button>
          ) : (
            <button
              type="button"
              className="collect-media-start"
              disabled={busy || !picker.available || !preflight}
              onClick={() => void startCollect()}
            >
              Choose folder and collect
            </button>
          )}
          <button type="button" onClick={close}>Close</button>
        </div>
      </div>
    </dialog>
  )
}
