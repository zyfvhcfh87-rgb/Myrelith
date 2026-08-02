/** Stateless presentation sections for the export dialog. */

import type { RefObject } from 'react'
import {
  EXPORT_PRESETS,
  type ExportPresetId,
  type ExportProfile,
  type ExportSelectionId,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import { formatProjectCanvas } from '../domain/projectSettings'
import type { ExportFilePickerAvailability } from '../app/exportFilePicker'
import ExportProfilePicker, {
  type ExportPresetAvailability,
} from './ExportProfilePicker'
import {
  exportProfileSummary,
  type ExportUiSelectionId,
} from './exportProfileUi'

export type ExportPhase =
  | 'configure'
  | 'choosing-file'
  | 'running'
  | 'cancelling'
  | 'download'
  | 'saved'
  | 'cancelled'

export interface DownloadReady {
  url: string
  fileName: string
  formatLabel: string
  linkLabel: string
}

export interface SavedFileReady {
  fileName: string
  formatLabel: string
}

interface ExportDialogHeaderProps {
  titleId: string
  busy: boolean
  closeButtonRef: RefObject<HTMLButtonElement | null>
  onClose(): void
}

export function ExportDialogHeader({
  titleId,
  busy,
  closeButtonRef,
  onClose,
}: ExportDialogHeaderProps) {
  return (
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
        onClick={onClose}
      >
        ×
      </button>
    </header>
  )
}

interface ExportConfigurationProps {
  descriptionId: string
  doc: TimelineDoc
  displayProfile: Readonly<ExportProfile>
  estimatedSize: string
  selectionId: ExportUiSelectionId
  presetAvailability: readonly Readonly<ExportPresetAvailability>[]
  selectedSupported: boolean | null
  selectedReason: string | null
  filePickerAvailability: ExportFilePickerAvailability
  phase: ExportPhase
  selectedProfileRef: RefObject<HTMLInputElement | null>
  capabilityStatusRef: RefObject<HTMLDivElement | null>
  capabilityLoading: boolean
  capabilityError: string | null
  autoPresetId: ExportPresetId | null | undefined
  advancedDraftsValid: boolean
  hasContent: boolean
  offlineExportMessage: string | null
  filePickerMessage: string | null
  error: string | null
  onSelect(selectionId: ExportSelectionId): void
  onChangeProfile(profile: Readonly<ExportProfile>): void
  onDraftValidityChange(valid: boolean): void
  onRetryCapabilities(): void
}

export function ExportConfiguration({
  descriptionId,
  doc,
  displayProfile,
  estimatedSize,
  selectionId,
  presetAvailability,
  selectedSupported,
  selectedReason,
  filePickerAvailability,
  phase,
  selectedProfileRef,
  capabilityStatusRef,
  capabilityLoading,
  capabilityError,
  autoPresetId,
  advancedDraftsValid,
  hasContent,
  offlineExportMessage,
  filePickerMessage,
  error,
  onSelect,
  onChangeProfile,
  onDraftValidityChange,
  onRetryCapabilities,
}: ExportConfigurationProps) {
  return (
    <>
      <p id={descriptionId} className="export-description">
        Export the full timeline using its current project settings.
      </p>

      <dl className="export-profile">
        <div className="export-profile-row">
          <dt>Resolution</dt>
          <dd>
            <strong>{formatProjectCanvas(doc.width, doc.height)}</strong>
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
              Bitrate-based estimate; variable bitrate and container overhead
              can change the final size.
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
        fileDestinationAvailability={filePickerAvailability}
        disabled={phase !== 'configure'}
        selectedInputRef={selectedProfileRef}
        onSelect={onSelect}
        onChangeProfile={onChangeProfile}
        onDraftValidityChange={onDraftValidityChange}
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
          && capabilityError ? (
          <>
            <span>Could not check export support: {capabilityError}</span>
            <button
              type="button"
              className="export-inline-retry"
              onClick={onRetryCapabilities}
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
            {selectionId === 'auto' && autoPresetId
              ? ` Auto selected ${EXPORT_PRESETS.find(
                  (preset) => preset.id === autoPresetId,
                )?.label ?? autoPresetId}.`
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

      {filePickerMessage && phase === 'configure' && (
        <p className="export-file-message" role="status">
          {filePickerMessage}
        </p>
      )}

      {error && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

interface ExportPhaseContentProps {
  phase: ExportPhase
  phaseStatusRef: RefObject<HTMLSpanElement | null>
  progressId: string
  progress: number
  percent: number
  download: DownloadReady | null
  savedFile: SavedFileReady | null
  runDestination: 'download' | 'file'
}

export function ExportPhaseContent({
  phase,
  phaseStatusRef,
  progressId,
  progress,
  percent,
  download,
  savedFile,
  runDestination,
}: ExportPhaseContentProps) {
  return (
    <>
      {phase === 'choosing-file' && (
        <section className="export-progress-panel">
          <span
            ref={phaseStatusRef}
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            Choose the export file in your browser…
          </span>
          <p>WebCut will begin encoding after you approve the destination.</p>
        </section>
      )}

      {(phase === 'running' || phase === 'cancelling') && (
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

      {phase === 'saved' && savedFile && (
        <section className="export-result" role="status" aria-live="polite">
          <span className="export-result-mark" aria-hidden="true">✓</span>
          <div>
            <strong>Export saved</strong>
            <span>
              Your {savedFile.formatLabel} was written directly to{' '}
              {savedFile.fileName}.
            </span>
          </div>
        </section>
      )}

      {phase === 'cancelled' && (
        <section className="export-cancelled" role="status" aria-live="polite">
          <strong>Export cancelled</strong>
          <span>
            {runDestination === 'file'
              ? 'No video was completed; the selected file may remain empty.'
              : 'No download file was created.'}
          </span>
        </section>
      )}
    </>
  )
}

interface ExportDialogActionsProps {
  phase: ExportPhase
  startButtonRef: RefObject<HTMLButtonElement | null>
  cancelButtonRef: RefObject<HTMLButtonElement | null>
  downloadLinkRef: RefObject<HTMLAnchorElement | null>
  backButtonRef: RefObject<HTMLButtonElement | null>
  canStart: boolean
  offlineExportMessage: string | null
  capabilityLoading: boolean
  selectedSupported: boolean | null
  advancedDraftsValid: boolean
  error: string | null
  displayProfile: Readonly<ExportProfile>
  download: DownloadReady | null
  savedFile: SavedFileReady | null
  onClose(): void
  onStart(): void
  onCancel(): void
  onReset(): void
}

export function ExportDialogActions({
  phase,
  startButtonRef,
  cancelButtonRef,
  downloadLinkRef,
  backButtonRef,
  canStart,
  offlineExportMessage,
  capabilityLoading,
  selectedSupported,
  advancedDraftsValid,
  error,
  displayProfile,
  download,
  savedFile,
  onClose,
  onStart,
  onCancel,
  onReset,
}: ExportDialogActionsProps) {
  return (
    <footer className="export-dialog-actions">
      {phase === 'configure' && (
        <>
          <button type="button" className="export-secondary" onClick={onClose}>
            Close
          </button>
          <button
            ref={startButtonRef}
            type="button"
            className="export-primary"
            disabled={!canStart}
            onClick={onStart}
          >
            {offlineExportMessage
              ? 'Reconnect media to export'
              : capabilityLoading || selectedSupported === null
                ? 'Checking export support…'
                : selectedSupported === false || !advancedDraftsValid
                  ? 'Profile unavailable'
                  : error ? 'Retry export'
                    : displayProfile.destination === 'file'
                      ? 'Choose file and export'
                      : 'Start export'}
          </button>
        </>
      )}

      {phase === 'running' && (
        <button
          ref={cancelButtonRef}
          type="button"
          className="export-danger"
          onClick={onCancel}
        >
          Cancel export
        </button>
      )}

      {phase === 'choosing-file' && (
        <button type="button" className="export-primary" disabled>
          Waiting for file selection…
        </button>
      )}

      {phase === 'cancelling' && (
        <button type="button" className="export-danger" disabled>
          Cancelling…
        </button>
      )}

      {phase === 'download' && download && (
        <>
          <button type="button" className="export-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="export-secondary" onClick={onReset}>
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

      {phase === 'saved' && savedFile && (
        <>
          <button type="button" className="export-secondary" onClick={onClose}>
            Close
          </button>
          <button
            ref={backButtonRef}
            type="button"
            className="export-primary"
            onClick={onReset}
          >
            Export another
          </button>
        </>
      )}

      {phase === 'cancelled' && (
        <>
          <button type="button" className="export-secondary" onClick={onClose}>
            Close
          </button>
          <button
            ref={backButtonRef}
            type="button"
            className="export-primary"
            onClick={onReset}
          >
            Back to settings
          </button>
        </>
      )}
    </footer>
  )
}
