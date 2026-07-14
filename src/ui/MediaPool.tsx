/**
 * Durable media catalog plus connected/offline source controls.
 *
 * Rows come from portable descriptors so a missing local file remains visible
 * and actionable. Files, handles, and analysis work stay behind app-layer
 * controller facades; the component reads serializable store projections only.
 */

import {
  canRememberImportedMedia,
  chooseMediaForImport,
  forgetImportedMediaHandle,
  importMedia,
} from '../app/mediaImportController'
import {
  canChooseActiveMediaFolder,
  chooseActiveAssetMedia,
  chooseActiveMediaFolder,
  connectActiveAssetMedia,
} from '../app/projectController'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { FrameRate } from '../domain/schema'
import { formatTimecode, microsecondsToFrames } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaImportStore } from '../state/mediaImportStore'
import { useMediaStore } from '../state/mediaStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'
import MediaImportDialog from './MediaImportDialog'
import MediaRelinkDialog from './MediaRelinkDialog'

function formatAssetMetadata(
  descriptor: PortableAssetDescriptor,
  projectRate: FrameRate,
): string {
  const duration = formatTimecode(
    microsecondsToFrames(descriptor.durationMicroseconds, projectRate),
    projectRate,
  )
  if (descriptor.kind === 'video') {
    const dimensions = descriptor.width && descriptor.height
      ? `${descriptor.width}×${descriptor.height}`
      : 'Video'
    return `${dimensions} · ${duration}`
  }
  if (descriptor.kind === 'audio') {
    const quality = descriptor.audioSampleRate
      ? `${descriptor.audioSampleRate / 1_000} kHz`
      : 'Audio'
    return `${quality} · ${duration}`
  }
  return `Image · ${duration}`
}

function assetIsUsedOnTimeline(assetId: string): boolean {
  return useDocumentStore.getState().doc.tracks.some((track) => (
    track.clips.some((clip) => clip.assetId === assetId)
  ))
}

function MediaRelinkStatus() {
  const phase = useProjectSessionStore(
    (state) => state.activeMediaRelink.phase,
  )
  const scannedFileCount = useProjectSessionStore(
    (state) => state.activeMediaRelink.scannedFileCount,
  )
  const connectedCount = useProjectSessionStore(
    (state) => state.activeMediaRelink.connectedCount,
  )
  const skippedCount = useProjectSessionStore(
    (state) => state.activeMediaRelink.skippedCount,
  )
  const errors = useProjectSessionStore(
    (state) => state.activeMediaRelink.errors,
  )

  if (phase === 'idle') return null

  const message = phase === 'scanning'
    ? `Scanning ${scannedFileCount} source ${scannedFileCount === 1 ? 'file' : 'files'}…`
    : phase === 'awaiting-choice'
      ? `Waiting for a file choice · ${connectedCount} connected so far`
      : `Relink finished · ${connectedCount} connected · ${skippedCount} skipped`

  return (
    <section className="media-relink-status" aria-label="Media relink status">
      <p role="status" data-phase={phase}>{message}</p>
      {errors.length > 0 ? (
        <ul className="media-relink-errors" role="alert">
          {errors.map((error, index) => (
            <li key={`${index}-${error}`}>{error}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export default function MediaPool() {
  const documentFrameRate = useDocumentStore((state) => state.doc.frameRate)
  const descriptors = useMediaStore((state) => state.descriptors)
  const assets = useMediaStore((state) => state.assets)
  const visuals = useMediaStore((state) => state.visuals)
  const removeAsset = useMediaStore((state) => state.removeAsset)
  const importBusy = useMediaImportStore((state) => state.phase !== 'idle')
  const relinkPhase = useProjectSessionStore(
    (state) => state.activeMediaRelink.phase,
  )
  const relinkBusy = relinkPhase === 'scanning'
    || relinkPhase === 'awaiting-choice'
  const handlePickerAvailable = canRememberImportedMedia()
  const folderPickerAvailable = canChooseActiveMediaFolder()
  let offlineCount = 0
  for (const descriptor of descriptors.values()) {
    if (!assets.has(descriptor.id)) offlineCount++
  }

  return (
    <div className="media-pool">
      <div className="media-pool-header">
        <h2 className="media-pool-title">Media</h2>
        <div className="media-pool-actions">
          {folderPickerAvailable && offlineCount > 0 ? (
            <button
              className="media-folder-relink"
              type="button"
              disabled={importBusy || relinkBusy}
              onClick={() => void chooseActiveMediaFolder()}
            >
              Scan folder
            </button>
          ) : null}
          {handlePickerAvailable ? (
            <button
              className="media-import"
              type="button"
              disabled={importBusy || relinkBusy}
              onClick={() => void chooseMediaForImport()}
            >
              <span aria-hidden="true">+</span>
              <span>Import</span>
            </button>
          ) : (
            <label className="media-import">
              <span aria-hidden="true">+</span>
              <span>Import</span>
              <input
                className="media-import-input"
                aria-label="Import media"
                type="file"
                accept="video/*,audio/*,.mp4,.mov,.mkv,.webm"
                disabled={importBusy || relinkBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void importMedia(file)
                }}
              />
            </label>
          )}
        </div>
      </div>

      <MediaRelinkStatus />

      {descriptors.size === 0 ? (
        <p className="media-empty">no media yet — import a video or audio file</p>
      ) : (
        <ul className="media-list">
          {[...descriptors.values()].map((descriptor) => {
            const asset = assets.get(descriptor.id)
            const connected = asset !== undefined
            const filmstrip = connected
              ? visuals.get(descriptor.id)?.filmstrip ?? null
              : null
            const thumbnailStyle = filmstrip
              ? {
                  backgroundImage: `url("${filmstrip.url}")`,
                  // Scale the strip so its first tile fills the thumbnail.
                  backgroundSize: `${filmstrip.tiles * 100}% auto`,
                }
              : undefined
            const draggable = Boolean(asset && asset.durationFrames > 0)

            return (
              <li
                key={descriptor.id}
                className="media-item"
                data-connection={connected ? 'online' : 'offline'}
                title={descriptor.fileName}
                draggable={draggable}
                onDragStart={(event) => {
                  if (!asset || asset.durationFrames <= 0) {
                    event.preventDefault()
                    return
                  }
                  event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id)
                  event.dataTransfer.setData(
                    assetKindDragType(asset.kind),
                    asset.kind,
                  )
                  event.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <div
                  className="media-thumbnail"
                  data-testid={`media-thumbnail-${descriptor.id}`}
                  data-state={connected
                    ? filmstrip ? 'ready' : 'placeholder'
                    : 'offline'}
                  style={thumbnailStyle}
                  aria-hidden="true"
                >
                  {!filmstrip ? (
                    <svg
                      className="media-thumbnail-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <rect x="3" y="5" width="13" height="14" rx="2" />
                      <path d="m16 10 5-3v10l-5-3" />
                    </svg>
                  ) : null}
                </div>

                <div className="media-details">
                  <span className="media-name">{descriptor.fileName}</span>
                  <span className="media-meta">
                    {formatAssetMetadata(descriptor, documentFrameRate)}
                  </span>
                  {!connected ? (
                    <div className="media-offline-actions">
                      <span className="media-offline-badge">Offline</span>
                      {handlePickerAvailable ? (
                        <button
                          className="media-source-relink"
                          type="button"
                          aria-label={`Relink ${descriptor.fileName}`}
                          disabled={importBusy || relinkBusy}
                          onClick={() => void chooseActiveAssetMedia(descriptor.id)}
                        >
                          Relink
                        </button>
                      ) : (
                        <label className="media-source-relink">
                          Relink
                          <input
                            className="media-import-input"
                            aria-label={`Relink ${descriptor.fileName}`}
                            type="file"
                            accept="video/*,audio/*,.mp4,.mov,.mkv,.webm"
                            disabled={importBusy || relinkBusy}
                            onChange={(event) => {
                              const file = event.target.files?.[0]
                              event.target.value = ''
                              if (file) {
                                void connectActiveAssetMedia(descriptor.id, file)
                              }
                            }}
                          />
                        </label>
                      )}
                    </div>
                  ) : null}
                </div>

                <button
                  className="media-remove"
                  type="button"
                  draggable={false}
                  aria-label={`remove ${descriptor.fileName}`}
                  onDragStart={(event) => event.stopPropagation()}
                  onClick={() => {
                    if (assetIsUsedOnTimeline(descriptor.id)) {
                      window.alert(
                        'Remove this media\'s clips from the timeline before removing its source.',
                      )
                      return
                    }
                    forgetImportedMediaHandle(descriptor.id)
                    removeAsset(descriptor.id)
                  }}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <MediaImportDialog />
      <MediaRelinkDialog />
    </div>
  )
}
