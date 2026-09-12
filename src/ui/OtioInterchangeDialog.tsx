/**
 * ui/OtioInterchangeDialog.tsx — preview/loss review for OTIO JSON files.
 * Reads interchange state through the app controller facade only.
 */

import { useEffect, useId, useRef, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from 'react'
import {
  cancelOtioInterchange,
  commitOtioImport,
  downloadStagedOtioExport,
  getOtioInterchangeSnapshot,
  stageOtioExport,
  stageOtioImport,
  subscribeOtioInterchange,
} from '../app/otioInterchangeController'
import type { OtioImportPreview, OtioLossEntry } from '../domain/otioInterchange'

interface OtioInterchangeDialogProps {
  onClose: () => void
}

function closeInterchange(onClose: () => void): void {
  cancelOtioInterchange()
  onClose()
}

function lossList(preview: OtioImportPreview): OtioLossEntry[] {
  return [...preview.losses]
}

export default function OtioInterchangeDialog({ onClose }: OtioInterchangeDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const snapshot = useSyncExternalStore(
    subscribeOtioInterchange,
    getOtioInterchangeSnapshot,
    getOtioInterchangeSnapshot,
  )
  const busy = snapshot.phase === 'committing' || snapshot.phase === 'exporting'

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      closeInterchange(onClose)
    }
  }

  const chooseFile = (): void => {
    fileInputRef.current?.click()
  }

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void stageOtioImport(file)
  }

  return (
    <div
      className="otio-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) closeInterchange(onClose)
      }}
    >
      <div
        ref={dialogRef}
        className="otio-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <header className="otio-dialog-header">
          <div>
            <p className="otio-dialog-kicker">OpenTimelineIO 0.17.0 JSON</p>
            <h2 id={titleId}>OTIO interchange</h2>
          </div>
          <button
            type="button"
            className="otio-dialog-close"
            aria-label="Close OTIO interchange"
            disabled={busy}
            onClick={() => closeInterchange(onClose)}
          >
            ×
          </button>
        </header>

        <p id={descriptionId} className="otio-dialog-lede">
          Import and export the pinned OTIO JSON family in this browser. Sequences
          conform to the open project. Missing media stays offline for relink.
          Adapters, packages, and remote URLs are never executed.
        </p>

        {snapshot.error && (
          <p className="otio-dialog-error" role="alert">{snapshot.error}</p>
        )}

        {snapshot.importPreview && (
          <ImportPreview preview={snapshot.importPreview} />
        )}

        {snapshot.exportPreview && (
          <ExportPreview preview={snapshot.exportPreview} />
        )}

        <footer className="otio-dialog-actions">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            accept=".otio,application/json,application/vnd.pixar.opentimelineio+json"
            onChange={onFile}
          />
          <button type="button" disabled={busy} onClick={chooseFile}>
            Choose OTIO file
          </button>
          {snapshot.phase === 'preview' && (
            <button
              type="button"
              className="otio-dialog-primary"
              disabled={busy}
              onClick={() => commitOtioImport()}
            >
              Import into project
            </button>
          )}
          {snapshot.phase !== 'export-preview' && (
            <button type="button" disabled={busy} onClick={() => stageOtioExport()}>
              Review OTIO export
            </button>
          )}
          {snapshot.phase === 'export-preview' && (
            <button
              type="button"
              className="otio-dialog-primary"
              disabled={busy}
              onClick={() => downloadStagedOtioExport()}
            >
              Download .otio
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => closeInterchange(onClose)}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  )
}

function ImportPreview({ preview }: { preview: OtioImportPreview }) {
  const sequence = preview.sequences[0]
  return (
    <section className="otio-dialog-preview" aria-label="OTIO import preview">
      <p>
        {preview.sequences.length} sequence{preview.sequences.length === 1 ? '' : 's'}
        {sequence ? ` · ${sequence.clips} clips · ${sequence.transitions} dissolves` : ''}
        {` · ${preview.media.length} offline media references`}
      </p>
      {preview.media.length > 0 && (
        <ul className="otio-dialog-media" aria-label="Offline media">
          {preview.media.map((item) => (
            <li key={item.id}>{item.fileName} ({item.kind})</li>
          ))}
        </ul>
      )}
      <LossReport preview={preview} />
    </section>
  )
}

function ExportPreview({ preview }: { preview: OtioImportPreview }) {
  return (
    <section className="otio-dialog-preview" aria-label="OTIO export preview">
      <p>
        {preview.sequences.length} sequence{preview.sequences.length === 1 ? '' : 's'}
        {` · ${preview.media.length} media references`}
      </p>
      <LossReport preview={preview} />
    </section>
  )
}

function LossReport({ preview }: { preview: OtioImportPreview }) {
  const losses = lossList(preview)
  if (losses.length === 0 && preview.omittedLosses === 0) {
    return <p className="otio-dialog-ok">No disclosed losses for the supported subset.</p>
  }
  return (
    <>
      <ul className="otio-dialog-losses" aria-label="OTIO conversion losses">
        {losses.map((loss, index) => (
          <li key={`${loss.code}-${loss.path}-${index}`}>
            {loss.detail}
          </li>
        ))}
      </ul>
      {preview.omittedLosses > 0 && (
        <p>{preview.omittedLosses} additional conversion details omitted from this bounded report.</p>
      )}
    </>
  )
}
