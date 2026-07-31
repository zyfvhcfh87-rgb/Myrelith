/**
 * ui/ExportDialog.tsx — Phase 5.2b export settings/progress/download flow.
 *
 * Preset hints and custom-profile checks stay behind the app capability
 * facade. The pre-start export controller remains authoritative; this
 * component owns only view state, progress, and download URL lifetime.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import {
  DEFAULT_EXPORT_PROFILE,
  EXPORT_PRESETS,
  type ExportProfile,
  type ExportSelectionId,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames, outputMediaAssetIds } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreferencesStore } from '../state/preferencesStore'
import ExportProfilePicker, {
  type ExportPresetAvailability,
} from './ExportProfilePicker'
import {
  estimateExportBytes,
  exportFileName,
  exportProfileSummary,
  formatEstimatedFileSize,
  profileForSelectionFallback,
  type ExportUiSelectionId,
} from './exportProfileUi'

type ExportControllerModule = typeof import('../app/exportController')
type ExportSettings = Parameters<ExportControllerModule['startExport']>[0]
type ExportCapabilitiesModule =
  typeof import('../app/exportCapabilitiesController')
type ExportCapabilitySnapshot = Awaited<ReturnType<
  ExportCapabilitiesModule['getExportPresetCapabilities']
>>
type ExportCapabilityResult = Awaited<ReturnType<
  ExportCapabilitiesModule['checkCurrentExportProfile']
>>

type PresetCapabilityState =
  | {
      readonly status: 'loading'
      readonly doc: TimelineDoc
    }
  | {
      readonly status: 'ready'
      readonly doc: TimelineDoc
      readonly snapshot: Readonly<ExportCapabilitySnapshot>
    }
  | {
      readonly status: 'error'
      readonly doc: TimelineDoc
      readonly error: string
    }

type CustomCapabilityState =
  | {
      readonly status: 'loading'
      readonly doc: TimelineDoc
      readonly profile: Readonly<ExportProfile>
    }
  | {
      readonly status: 'ready'
      readonly doc: TimelineDoc
      readonly profile: Readonly<ExportProfile>
      readonly result: Readonly<ExportCapabilityResult>
    }

let controllerPromise: Promise<ExportControllerModule> | null = null
let capabilitiesPromise: Promise<ExportCapabilitiesModule> | null = null

/** Export codecs/adapters stay out of the initial editor bundle. */
function loadExportController(): Promise<ExportControllerModule> {
  controllerPromise ??= import('../app/exportController').catch((cause) => {
    controllerPromise = null
    throw cause
  })
  return controllerPromise
}

/** Capability code is also excluded from the initial editor bundle. */
function loadExportCapabilities(): Promise<ExportCapabilitiesModule> {
  capabilitiesPromise ??= import('../app/exportCapabilitiesController')
    .catch((cause) => {
      capabilitiesPromise = null
      throw cause
    })
  return capabilitiesPromise
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
  formatLabel: string
  linkLabel: string
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

export default function ExportDialog({ onClose }: ExportDialogProps) {
  const doc = useDocumentStore((state) => state.doc)
  const hasContent = docDurationFrames(doc) > 0
  const mediaAssets = useMediaStore((state) => state.assets)
  const mediaDescriptors = useMediaStore((state) => state.descriptors)
  const setExportSelectionPreference = usePreferencesStore(
    (state) => state.setExportSelection,
  )
  const [initialPreference] = useState(
    () => usePreferencesStore.getState().exportSelection,
  )
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const selectedProfileRef = useRef<HTMLInputElement | null>(null)
  const startButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const phaseStatusRef = useRef<HTMLSpanElement | null>(null)
  const capabilityStatusRef = useRef<HTMLDivElement | null>(null)
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
  const capabilityTokenRef = useRef(0)
  const customCapabilityTokenRef = useRef(0)
  const previousSelectedSupportedRef = useRef<boolean | null>(null)
  const [phase, setPhase] = useState<ExportPhase>('configure')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadReady | null>(null)
  const [selectionId, setSelectionId] = useState<ExportUiSelectionId>(
    initialPreference.selectionId,
  )
  const [customProfile, setCustomProfile] = useState<Readonly<ExportProfile>>(
    initialPreference.profile ?? DEFAULT_EXPORT_PROFILE,
  )
  const [presetCapabilityState, setPresetCapabilityState] =
    useState<Readonly<PresetCapabilityState>>(() => ({
      status: 'loading',
      doc,
    }))
  const [customCapabilityState, setCustomCapabilityState] =
    useState<Readonly<CustomCapabilityState> | null>(null)
  const [advancedDraftsValid, setAdvancedDraftsValid] = useState(true)
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

  const refreshCapabilities = useCallback((requestDoc: TimelineDoc): void => {
    const token = ++capabilityTokenRef.current
    setPresetCapabilityState({ status: 'loading', doc: requestDoc })
    void loadExportCapabilities()
      .then(async (controller) => {
        return controller.getExportPresetCapabilities()
      })
      .then((snapshot) => {
        if (!mountedRef.current || token !== capabilityTokenRef.current) return
        setPresetCapabilityState({
          status: 'ready',
          doc: requestDoc,
          snapshot,
        })
      })
      .catch((cause) => {
        if (!mountedRef.current || token !== capabilityTokenRef.current) return
        setPresetCapabilityState({
          status: 'error',
          doc: requestDoc,
          error: errorMessage(cause),
        })
      })
  }, [])

  const selectRecommendedProfile = useCallback((
    nextSelectionId: ExportSelectionId,
  ): void => {
    setSelectionId(nextSelectionId)
    setAdvancedDraftsValid(true)
    setError(null)
  }, [])

  const selectCustomProfile = useCallback((
    profile: Readonly<ExportProfile>,
  ): void => {
    setCustomCapabilityState(null)
    setCustomProfile(profile)
    setSelectionId('custom')
    setError(null)
  }, [])

  const currentPresetCapability = presetCapabilityState.doc === doc
    ? presetCapabilityState
    : null
  const capabilitySnapshot = currentPresetCapability?.status === 'ready'
    ? currentPresetCapability.snapshot
    : null
  const capabilityError = currentPresetCapability?.status === 'error'
    ? currentPresetCapability.error
    : null
  const capabilityLoading = currentPresetCapability === null
    || currentPresetCapability.status === 'loading'
  const customCapability = customCapabilityState?.status === 'ready'
    && customCapabilityState.doc === doc
    && customCapabilityState.profile === customProfile
    ? customCapabilityState.result
    : null

  let displayProfile = profileForSelectionFallback(selectionId, customProfile)
  let activeProfile: Readonly<ExportProfile> | null = null
  let selectedSupported: boolean | null = capabilityLoading ? null : false
  let selectedReason: string | null = capabilityError

  if (selectionId === 'custom') {
    displayProfile = customProfile
    if (customCapability) {
      selectedSupported = customCapability.supported
      selectedReason = customCapability.reason
      activeProfile = customCapability.supported ? customCapability.profile : null
    } else {
      selectedSupported = null
      selectedReason = null
    }
  } else if (capabilitySnapshot) {
    const presetId = selectionId === 'auto'
      ? capabilitySnapshot.autoPresetId
      : selectionId
    if (presetId === null) {
      selectedSupported = false
      selectedReason = 'No export profile supports this project in this browser.'
    } else {
      const result = capabilitySnapshot.presets.find(
        (candidate) => candidate.presetId === presetId,
      )
      if (!result) {
        selectedSupported = false
        selectedReason = `Capability results are missing ${presetId}.`
      } else {
        displayProfile = result.profile
        selectedSupported = result.supported
        selectedReason = result.reason
        activeProfile = result.supported ? result.profile : null
      }
    }
  }

  const presetAvailability: readonly Readonly<ExportPresetAvailability>[] = [
    {
      selectionId: 'auto',
      supported: capabilitySnapshot
        ? capabilitySnapshot.autoPresetId !== null
        : capabilityError ? false : null,
      reason: capabilitySnapshot?.autoPresetId === null
        ? 'No documented profile is supported on this browser.'
        : capabilityError,
      autoPresetId: capabilitySnapshot?.autoPresetId,
    },
    ...EXPORT_PRESETS.map((preset) => {
      const result = capabilitySnapshot?.presets.find(
        (candidate) => candidate.presetId === preset.id,
      )
      return {
        selectionId: preset.id,
        supported: result?.supported ?? (capabilityError ? false : null),
        reason: result?.reason ?? capabilityError,
      }
    }),
  ]

  const offline = [...outputMediaAssetIds(
    doc,
    displayProfile.audioChannelLayout !== 'off',
  )].filter((assetId) => !mediaAssets.has(assetId))
  const offlineExportMessage = offline.length === 0
    ? null
    : `Reconnect ${offline.length} offline source${
        offline.length === 1 ? '' : 's'
      } before exporting: ${offline.map(
        (assetId) => mediaDescriptors.get(assetId)?.fileName ?? assetId,
      ).join(', ')}.`

  const canStart = hasContent
    && offlineExportMessage === null
    && selectedSupported === true
    && activeProfile !== null
    && advancedDraftsValid
  const estimatedSize = formatEstimatedFileSize(
    estimateExportBytes(doc, displayProfile),
  )

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
    const exportSettings: ExportSettings | null = activeProfile
    if (runningRef.current || !canStart || exportSettings === null) return
    runningRef.current = true
    cancelRequestedRef.current = false
    const token = ++runTokenRef.current
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
      const result = await controller.startExport(exportSettings, {
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
      const formatLabel = result.profile.container === 'webm' ? 'WebM' : 'MP4'
      setDownload({
        url,
        fileName: exportFileName(doc.name, result.fileExtension),
        formatLabel,
        linkLabel: `Download ${formatLabel}`,
      })
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
    const capabilityToken = capabilityTokenRef
    const customCapabilityToken = customCapabilityTokenRef
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      capabilityToken.current++
      customCapabilityToken.current++
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
    refreshCapabilities(doc)
  }, [doc, refreshCapabilities])

  useEffect(() => {
    if (selectionId !== 'custom') {
      customCapabilityTokenRef.current++
      setCustomCapabilityState(null)
      return
    }
    const token = ++customCapabilityTokenRef.current
    const requestDoc = doc
    const requestProfile = customProfile
    setCustomCapabilityState({
      status: 'loading',
      doc: requestDoc,
      profile: requestProfile,
    })
    void loadExportCapabilities()
      .then(async (controller) => {
        return controller.checkCurrentExportProfile(requestProfile)
      })
      .then((result) => {
        if (
          !mountedRef.current
          || token !== customCapabilityTokenRef.current
        ) return
        setCustomCapabilityState({
          status: 'ready',
          doc: requestDoc,
          profile: requestProfile,
          result,
        })
      })
      .catch((cause) => {
        if (
          !mountedRef.current
          || token !== customCapabilityTokenRef.current
        ) return
        setCustomCapabilityState({
          status: 'ready',
          doc: requestDoc,
          profile: requestProfile,
          result: {
            profile: requestProfile,
            supported: false,
            reason: errorMessage(cause),
          },
        })
      })
  }, [customProfile, doc, selectionId])

  useEffect(() => {
    if (selectedSupported !== true || activeProfile === null) return
    setExportSelectionPreference({
      selectionId,
      profile: selectionId === 'custom' ? activeProfile : null,
    })
  }, [
    activeProfile,
    selectedSupported,
    selectionId,
    setExportSelectionPreference,
  ])

  useEffect(() => {
    const focusFrame = requestAnimationFrame(() => {
      switch (phase) {
        case 'configure':
          selectedProfileRef.current?.focus()
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
  }, [phase])

  useEffect(() => {
    const previous = previousSelectedSupportedRef.current
    previousSelectedSupportedRef.current = selectedSupported
    if (
      phase !== 'configure'
      || selectedSupported !== false
      || previous === false
    ) return
    const focusFrame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === selectedProfileRef.current || active === document.body) {
        capabilityStatusRef.current?.focus()
      }
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [phase, selectedSupported])

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
              <dt>Selected output</dt>
              <dd>
                <strong>{exportProfileSummary(displayProfile)}</strong>
                <span>
                  {displayProfile.mimeType} · .{displayProfile.fileExtension}
                </span>
              </dd>
            </div>
            <div className="export-profile-row">
              <dt>Estimated size</dt>
              <dd>
                <strong>About {estimatedSize}</strong>
                <span>
                  Bitrate-based estimate; variable bitrate and container
                  overhead can change the final size.
                </span>
              </dd>
            </div>
          </dl>

          <ExportProfilePicker
            selectionId={selectionId}
            profile={displayProfile}
            availability={presetAvailability}
            selectedSupported={selectedSupported}
            selectedReason={selectedReason}
            disabled={phase !== 'configure'}
            selectedInputRef={selectedProfileRef}
            onSelect={selectRecommendedProfile}
            onChangeProfile={selectCustomProfile}
            onDraftValidityChange={setAdvancedDraftsValid}
          />

          <div
            ref={capabilityStatusRef}
            className={`export-capability-status${
              selectedSupported === false ? ' is-unavailable' : ''
            }`}
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            {capabilityLoading && selectionId !== 'custom' ? (
              <span>Checking export support for this project…</span>
            ) : selectionId !== 'custom'
              && capabilityError
              && capabilitySnapshot === null ? (
              <>
                <span>Could not check export support: {capabilityError}</span>
                <button
                  type="button"
                  className="export-inline-retry"
                  onClick={() => refreshCapabilities(doc)}
                >
                  Retry capability check
                </button>
              </>
            ) : !advancedDraftsValid ? (
              <span>Fix the invalid advanced value before exporting.</span>
            ) : selectedSupported === null ? (
              <span>Checking this exact custom profile…</span>
            ) : selectedSupported ? (
              <span>
                Ready to export exactly {exportProfileSummary(displayProfile)}.
                {selectionId === 'auto' && capabilitySnapshot?.autoPresetId
                  ? ` Auto selected ${EXPORT_PRESETS.find(
                      (preset) => preset.id === capabilitySnapshot.autoPresetId,
                    )?.label ?? capabilitySnapshot.autoPresetId}.`
                  : ''}
              </span>
            ) : (
              <span>
                {selectedReason ?? 'The selected profile is unavailable.'}
                {' '}No codec will be substituted.
              </span>
            )}
          </div>

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
                <span>Your {download.formatLabel} is ready to download.</span>
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
                disabled={!canStart}
                onClick={() => void beginExport()}
              >
                {offlineExportMessage
                  ? 'Reconnect media to export'
                  : capabilityLoading || selectedSupported === null
                    ? 'Checking export support…'
                    : selectedSupported === false || !advancedDraftsValid
                      ? 'Profile unavailable'
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
                {download.linkLabel}
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
