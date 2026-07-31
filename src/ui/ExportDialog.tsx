/**
 * ui/ExportDialog.tsx — Phase 5.2b export settings/progress/download flow.
 *
 * The UI shows the one profile the pipeline really supports today: current
 * timeline dimensions, MP4/AVC, and the MVP bitrate. All codec/media work goes
 * through app/exportController; this component owns only short-lived view
 * state, rAF-coalesced progress, and its finished download object URL.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { DEFAULT_EXPORT_PROFILE } from '../domain/exportProfile'
import { docDurationFrames, outputMediaAssetIds } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'

type ExportControllerModule = typeof import('../app/exportController')
type ExportSettings = Parameters<ExportControllerModule['startExport']>[0]

const MVP_EXPORT_SETTINGS: ExportSettings = DEFAULT_EXPORT_PROFILE

let controllerPromise: Promise<ExportControllerModule> | null = null

/** Export codecs/adapters stay out of the initial editor bundle. */
function loadExportController(): Promise<ExportControllerModule> {
  controllerPromise ??= import('../app/exportController').catch((cause) => {
    controllerPromise = null
    throw cause
  })
  return controllerPromise
}

type ExportPhase =
  | 'configure'
  | 'running'
  | 'cancelling'
  | 'download'
  | 'cancelled'

interface DownloadReady {
  url: string
  fileName: string
}

interface ExportDialogProps {
  onClose(): void
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') {
    return cause.message
  }
  return 'Export failed. Please try again.'
}

function exportFileName(projectName: string): string {
  let base = projectName.trim().replace(/[. ]+$/g, '').replace(/\.mp4$/i, '')
  base = base.replace(/[<>:"/\\|?*]/g, '-')
  base = Array.from(base, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('')
  base = Array.from(base).slice(0, 80).join('').replace(/[. ]+$/g, '')
  if (
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i
      .test(base)
  ) {
    base = `webcut-${base}`
  }
  return `${base || 'webcut-export'}.mp4`
}

export default function ExportDialog({ onClose }: ExportDialogProps) {
  const doc = useDocumentStore((state) => state.doc)
  const hasContent = docDurationFrames(doc) > 0
  const offlineExportMessage = useMediaStore((state) => {
    const offline = [...outputMediaAssetIds(doc)].filter(
      (assetId) => !state.assets.has(assetId),
    )
    if (offline.length === 0) return null
    const names = offline.map(
      (assetId) => state.descriptors.get(assetId)?.fileName ?? assetId,
    )
    return `Reconnect ${offline.length} offline source${offline.length === 1 ? '' : 's'} before exporting: ${names.join(', ')}.`
  })
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const startButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const phaseStatusRef = useRef<HTMLSpanElement | null>(null)
  const downloadLinkRef = useRef<HTMLAnchorElement | null>(null)
  const backButtonRef = useRef<HTMLButtonElement | null>(null)
  const mountedRef = useRef(false)
  const runningRef = useRef(false)
  const controllerRunStartedRef = useRef(false)
  const cancelRequestedRef = useRef(false)
  const runTokenRef = useRef(0)
  const progressFrameRef = useRef<number | null>(null)
  const latestProgressRef = useRef(0)
  const downloadUrlRef = useRef<string | null>(null)
  const [phase, setPhase] = useState<ExportPhase>('configure')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadReady | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const progressId = useId()

  const cancelProgressFrame = useCallback((): void => {
    if (progressFrameRef.current === null) return
    cancelAnimationFrame(progressFrameRef.current)
    progressFrameRef.current = null
  }, [])

  const revokeDownload = useCallback((): void => {
    const url = downloadUrlRef.current
    if (!url) return
    downloadUrlRef.current = null
    URL.revokeObjectURL(url)
  }, [])

  const publishProgress = useCallback(
    (token: number, value: number): void => {
      if (token !== runTokenRef.current || !Number.isFinite(value)) return
      const next = Math.min(1, Math.max(0, value))
      latestProgressRef.current = next
      if (next === 1) {
        cancelProgressFrame()
        if (mountedRef.current) setProgress(1)
        return
      }
      if (progressFrameRef.current !== null) return
      progressFrameRef.current = requestAnimationFrame(() => {
        progressFrameRef.current = null
        if (mountedRef.current && token === runTokenRef.current) {
          setProgress(latestProgressRef.current)
        }
      })
    },
    [cancelProgressFrame],
  )

  const invalidateRun = useCallback((): void => {
    runTokenRef.current++
  }, [])

  const cancelActiveControllerRun = useCallback((): void => {
    if (!runningRef.current || !controllerRunStartedRef.current) return
    void loadExportController()
      .then((controller) => controller.cancelExport())
      .catch(() => undefined)
  }, [])

  const resetToConfigure = (): void => {
    invalidateRun()
    cancelProgressFrame()
    revokeDownload()
    setDownload(null)
    setProgress(0)
    latestProgressRef.current = 0
    setError(null)
    setPhase('configure')
  }

  const closeDialog = (): void => {
    if (runningRef.current) return
    invalidateRun()
    cancelProgressFrame()
    revokeDownload()
    onClose()
  }

  const requestCancel = (): void => {
    if (!runningRef.current || cancelRequestedRef.current) return
    cancelRequestedRef.current = true
    // If the export-only controller chunk has not started a run yet, there is
    // no external resource to clean up. Cancel locally and invalidate the
    // pending import continuation instead of waiting on the network.
    if (!controllerRunStartedRef.current) {
      runningRef.current = false
      cancelRequestedRef.current = false
      invalidateRun()
      cancelProgressFrame()
      setPhase('cancelled')
      return
    }
    setPhase('cancelling')
    // startExport's original promise is the terminal-state owner and surfaces
    // the shared cleanup error. Swallow this duplicate observer promise.
    cancelActiveControllerRun()
  }

  const beginExport = async (): Promise<void> => {
    if (runningRef.current || !hasContent || offlineExportMessage) return
    runningRef.current = true
    cancelRequestedRef.current = false
    const token = ++runTokenRef.current
    const fileName = exportFileName(doc.name)
    cancelProgressFrame()
    revokeDownload()
    setDownload(null)
    setProgress(0)
    latestProgressRef.current = 0
    setError(null)
    setPhase('running')

    try {
      const controller = await loadExportController()
      if (!mountedRef.current || token !== runTokenRef.current) {
        return
      }
      // Cancel may win while the export-only chunk is loading. In that case
      // no controller run exists yet, so finish locally without starting one.
      if (cancelRequestedRef.current) {
        runningRef.current = false
        cancelRequestedRef.current = false
        setPhase('cancelled')
        return
      }

      controllerRunStartedRef.current = true
      const result = await controller.startExport(MVP_EXPORT_SETTINGS, {
        onProgress: (value) => publishProgress(token, value),
      })
      controllerRunStartedRef.current = false
      runningRef.current = false
      cancelRequestedRef.current = false
      if (!mountedRef.current || token !== runTokenRef.current) return
      cancelProgressFrame()

      if (result === undefined) {
        setPhase('cancelled')
        return
      }

      setProgress(1)
      latestProgressRef.current = 1
      const url = URL.createObjectURL(
        new Blob([result.buffer], { type: result.mimeType }),
      )
      downloadUrlRef.current = url
      setDownload({ url, fileName })
      setPhase('download')
    } catch (cause) {
      if (!mountedRef.current || token !== runTokenRef.current) return
      controllerRunStartedRef.current = false
      runningRef.current = false
      cancelRequestedRef.current = false
      cancelProgressFrame()
      setProgress(0)
      latestProgressRef.current = 0
      setError(errorMessage(cause))
      setPhase('configure')
    }
  }

  // Open the native modal safely under StrictMode. jsdom lacks showModal(),
  // so the attribute fallback keeps focused RTL tests faithful to the UI.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    return () => {
      if (typeof dialog.close === 'function') {
        if (dialog.open) dialog.close()
      } else {
        dialog.removeAttribute('open')
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invalidateRun()
      cancelProgressFrame()
      revokeDownload()
      cancelActiveControllerRun()
    }
  }, [
    cancelActiveControllerRun,
    cancelProgressFrame,
    invalidateRun,
    revokeDownload,
  ])

  useEffect(() => {
    const focusFrame = requestAnimationFrame(() => {
      switch (phase) {
        case 'configure':
          if (hasContent) startButtonRef.current?.focus()
          else closeButtonRef.current?.focus()
          break
        case 'running':
          cancelButtonRef.current?.focus()
          break
        case 'cancelling':
          phaseStatusRef.current?.focus()
          break
        case 'download':
          downloadLinkRef.current?.focus()
          break
        case 'cancelled':
          backButtonRef.current?.focus()
          break
      }
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [hasContent, phase])

  const busy = phase === 'running' || phase === 'cancelling'
  const percent = Math.round(progress * 100)

  return (
    <dialog
      ref={dialogRef}
      className="export-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (busy) requestCancel()
        else closeDialog()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        if (!busy) closeDialog()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="export-dialog-card">
        <header className="export-dialog-header">
          <div>
            <span className="export-eyebrow">Deliver</span>
            <h2 id={titleId}>Export video</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="export-close"
            aria-label="Close export dialog"
            disabled={busy}
            onClick={closeDialog}
          >
            ×
          </button>
        </header>

        <div className="export-dialog-body">
          <p id={descriptionId} className="export-description">
            Export the full timeline using its current project settings.
          </p>

          <dl className="export-profile">
            <div className="export-profile-row">
              <dt>Resolution</dt>
              <dd>
                <strong>{doc.width} × {doc.height}</strong>
                <span>Timeline resolution (fixed)</span>
              </dd>
            </div>
            <div className="export-profile-row">
              <dt>Format</dt>
              <dd>
                <strong>MP4 · H.264/AVC</strong>
                <span>Format (fixed)</span>
              </dd>
            </div>
            <div className="export-profile-row">
              <dt>Video bitrate</dt>
              <dd>
                <strong>8 Mbps</strong>
                <span>MVP quality profile</span>
              </dd>
            </div>
          </dl>

          {!hasContent && phase === 'configure' && (
            <p className="export-empty">Add a clip to the timeline before exporting.</p>
          )}

          {offlineExportMessage && phase === 'configure' && (
            <p className="export-error" role="alert">
              {offlineExportMessage}
            </p>
          )}

          {error && (
            <p className="export-error" role="alert">
              {error}
            </p>
          )}

          {busy && (
            <section className="export-progress-panel" aria-labelledby={progressId}>
              <div className="export-progress-heading">
                <span
                  ref={phaseStatusRef}
                  id={progressId}
                  role="status"
                  aria-live="polite"
                  tabIndex={-1}
                >
                  {phase === 'cancelling' ? 'Cancelling…' : 'Encoding timeline…'}
                </span>
                <strong>{percent}%</strong>
              </div>
              <progress aria-label="Export progress" max={1} value={progress} />
              <p>Keep this tab open until encoding and cleanup finish.</p>
            </section>
          )}

          {phase === 'download' && download && (
            <section className="export-result" role="status" aria-live="polite">
              <span className="export-result-mark" aria-hidden="true">✓</span>
              <div>
                <strong>Export ready</strong>
                <span>Your MP4 is ready to download.</span>
              </div>
            </section>
          )}

          {phase === 'cancelled' && (
            <section className="export-cancelled" role="status" aria-live="polite">
              <strong>Export cancelled</strong>
              <span>No download file was created.</span>
            </section>
          )}
        </div>

        <footer className="export-dialog-actions">
          {phase === 'configure' && (
            <>
              <button type="button" className="export-secondary" onClick={closeDialog}>
                Close
              </button>
              <button
                ref={startButtonRef}
                type="button"
                className="export-primary"
                disabled={!hasContent || offlineExportMessage !== null}
                onClick={() => void beginExport()}
              >
                {offlineExportMessage
                  ? 'Reconnect media to export'
                  : error ? 'Retry export' : 'Start export'}
              </button>
            </>
          )}

          {phase === 'running' && (
            <button
              ref={cancelButtonRef}
              type="button"
              className="export-danger"
              onClick={requestCancel}
            >
              Cancel export
            </button>
          )}

          {phase === 'cancelling' && (
            <button type="button" className="export-danger" disabled>
              Cancelling…
            </button>
          )}

          {phase === 'download' && download && (
            <>
              <button type="button" className="export-secondary" onClick={closeDialog}>
                Close
              </button>
              <button type="button" className="export-secondary" onClick={resetToConfigure}>
                Export another
              </button>
              <a
                ref={downloadLinkRef}
                className="export-primary export-download"
                href={download.url}
                download={download.fileName}
              >
                Download MP4
              </a>
            </>
          )}

          {phase === 'cancelled' && (
            <>
              <button type="button" className="export-secondary" onClick={closeDialog}>
                Close
              </button>
              <button
                ref={backButtonRef}
                type="button"
                className="export-primary"
                onClick={resetToConfigure}
              >
                Back to settings
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  )
}
