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
  removeMediaCompatibility,
  retryMediaCompatibility,
} from '../app/mediaImportController'
import {
  canChooseActiveMediaFolder,
  chooseActiveAssetMedia,
  chooseActiveMediaFolder,
  connectActiveAssetMedia,
} from '../app/projectController'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import {
  compatibilityAllowsTimelineUse,
  type MediaCompatibilityItem,
  type MediaCompatibilityStatus,
  type MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
import type { FrameRate } from '../domain/schema'
import {
  formatTimecode,
  microsecondsDurationToFrames,
} from '../domain/time'
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
    microsecondsDurationToFrames(
      descriptor.durationMicroseconds,
      projectRate,
    ),
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

const COMPATIBILITY_LABELS: Record<MediaCompatibilityStatus, string> = {
  checking: 'Checking',
  ready: 'Ready',
  limited: 'Limited',
  unsupported: 'Unsupported',
  error: 'Error',
}

function formatRate(rate: FrameRate): string {
  const framesPerSecond = rate.num / rate.den
  if (Number.isInteger(framesPerSecond)) return String(framesPerSecond)
  return framesPerSecond.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function formatSelectedFile(item: MediaCompatibilityItem): string {
  const size = item.size >= 1024 * 1024
    ? `${(item.size / (1024 * 1024)).toFixed(1)} MiB`
    : item.size >= 1024
      ? `${(item.size / 1024).toFixed(1)} KiB`
      : `${item.size} B`
  return `${item.declaredMimeType || 'Unknown file type'} · ${size}`
}

function trackLabel(track: MediaTrackCompatibility): string {
  const kind = track.kind === 'video' ? 'Video' : 'Audio'
  return `${kind} track ${track.number}${track.primary ? ' (primary)' : ''}`
}

function formatTrack(track: MediaTrackCompatibility): string {
  const parts: string[] = []
  if (track.kind === 'video') {
    if (track.width && track.height) parts.push(`${track.width}×${track.height}`)
    if (track.frameRate) parts.push(`${formatRate(track.frameRate)} fps`)
  } else {
    if (track.sampleRate) parts.push(`${track.sampleRate / 1_000} kHz`)
    if (track.channels) {
      parts.push(`${track.channels} ${track.channels === 1 ? 'channel' : 'channels'}`)
    }
  }
  parts.push(
    track.codecParameter
      ?? track.decoderConfig?.codec
      ?? track.codec
      ?? track.internalCodecId
      ?? 'Unknown codec',
  )
  return parts.join(' · ')
}

function CompatibilityDiagnostics({
  item,
  busy,
}: {
  item: MediaCompatibilityItem
  busy: boolean
}) {
  const report = item.report
  const retryable = item.status === 'limited'
    || item.status === 'unsupported'
    || item.status === 'error'
  const failedTracks = report?.tracks.filter((track) => !track.decodable) ?? []

  return (
    <section
      className="media-compatibility"
      data-status={item.status}
      aria-label={`${item.fileName} compatibility`}
    >
      <div className="media-compatibility-heading">
        <p
          className="media-compatibility-status"
          role="status"
          aria-label={`${item.fileName} compatibility status`}
          aria-live="polite"
          aria-atomic="true"
        >
          Compatibility: {COMPATIBILITY_LABELS[item.status]}
        </p>
        {retryable ? (
          <button
            className="media-compatibility-retry"
            type="button"
            aria-label={`Retry compatibility check for ${item.fileName}`}
            disabled={busy}
            onClick={() => void retryMediaCompatibility(item.id)}
          >
            Retry
          </button>
        ) : null}
      </div>

      {!report ? (
        <p className="media-compatibility-note">
          Reading container and track metadata…
        </p>
      ) : (
        <>
          <dl className="media-compatibility-grid">
            <div>
              <dt>Container</dt>
              <dd>
                {report.container
                  ? `${report.container.name} · ${report.container.fullMimeType}`
                  : 'Not detected'}
              </dd>
            </div>
            {report.tracks.map((track) => (
              <div key={`${track.kind}-${track.number}`}>
                <dt>{trackLabel(track)}</dt>
                <dd>{formatTrack(track)}</dd>
              </div>
            ))}
          </dl>
          {report.detail ? (
            <p className="media-compatibility-summary">{report.detail}</p>
          ) : null}
          {failedTracks.length > 0 ? (
            <ul className="media-compatibility-failures">
              {failedTracks.map((track) => (
                <li key={`${track.kind}-${track.number}`}>
                  <strong>{trackLabel(track)}:</strong>{' '}
                  {track.detail ?? 'This track is not usable in this browser.'}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  )
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
  const compatibility = useMediaStore((state) => state.compatibility)
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
  const itemIds = [
    ...descriptors.keys(),
    ...[...compatibility.keys()].filter((id) => !descriptors.has(id)),
  ]

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

      {itemIds.length === 0 ? (
        <p className="media-empty">no media yet — import a video or audio file</p>
      ) : (
        <ul className="media-list">
          {itemIds.map((id) => {
            const descriptor = descriptors.get(id)
            const compatibilityItem = compatibility.get(id)
            const fileName = descriptor?.fileName ?? compatibilityItem?.fileName
            if (!fileName) return null
            const asset = assets.get(id)
            const connected = asset !== undefined
            const filmstrip = connected
              ? visuals.get(id)?.filmstrip ?? null
              : null
            const thumbnailStyle = filmstrip
              ? {
                  backgroundImage: `url("${filmstrip.url}")`,
                  // Scale the strip so its first tile fills the thumbnail.
                  backgroundSize: `${filmstrip.tiles * 100}% auto`,
                }
              : undefined
            const draggable = Boolean(
              asset
              && asset.durationFrames > 0
              && compatibilityAllowsTimelineUse(compatibilityItem),
            )
            const connection = connected
              ? 'online'
              : descriptor ? 'offline' : 'provisional'

            return (
              <li
                key={id}
                className="media-item"
                data-connection={connection}
                data-compatibility={compatibilityItem?.status}
                title={fileName}
                draggable={draggable}
                onDragStart={(event) => {
                  const liveMedia = useMediaStore.getState()
                  const liveAsset = liveMedia.assets.get(id)
                  if (
                    !liveAsset
                    || liveAsset.durationFrames <= 0
                    || !compatibilityAllowsTimelineUse(
                      liveMedia.compatibility.get(id),
                    )
                  ) {
                    event.preventDefault()
                    return
                  }
                  event.dataTransfer.setData(ASSET_DRAG_TYPE, liveAsset.id)
                  event.dataTransfer.setData(
                    assetKindDragType(liveAsset.kind),
                    liveAsset.kind,
                  )
                  event.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <div
                  className="media-thumbnail"
                  data-testid={`media-thumbnail-${id}`}
                  data-state={connected
                    ? filmstrip ? 'ready' : 'placeholder'
                    : descriptor ? 'offline' : compatibilityItem?.status}
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
                  <span className="media-name">{fileName}</span>
                  <span className="media-meta">
                    {descriptor
                      ? formatAssetMetadata(descriptor, documentFrameRate)
                      : compatibilityItem
                        ? formatSelectedFile(compatibilityItem)
                        : null}
                  </span>
                  {descriptor && !connected ? (
                    <div className="media-offline-actions">
                      <span className="media-offline-badge">Offline</span>
                      {handlePickerAvailable ? (
                        <button
                          className="media-source-relink"
                          type="button"
                          aria-label={`Relink ${fileName}`}
                          disabled={importBusy || relinkBusy}
                          onClick={() => void chooseActiveAssetMedia(id)}
                        >
                          Relink
                        </button>
                      ) : (
                        <label className="media-source-relink">
                          Relink
                          <input
                            className="media-import-input"
                            aria-label={`Relink ${fileName}`}
                            type="file"
                            accept="video/*,audio/*,.mp4,.mov,.mkv,.webm"
                            disabled={importBusy || relinkBusy}
                            onChange={(event) => {
                              const file = event.target.files?.[0]
                              event.target.value = ''
                              if (file) {
                                void connectActiveAssetMedia(id, file)
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
                  aria-label={`Remove ${fileName}`}
                  onDragStart={(event) => event.stopPropagation()}
                  onClick={() => {
                    if (!descriptor) {
                      removeMediaCompatibility(id)
                      return
                    }
                    if (assetIsUsedOnTimeline(id)) {
                      window.alert(
                        'Remove this media\'s clips from the timeline before removing its source.',
                      )
                      return
                    }
                    forgetImportedMediaHandle(id)
                    removeAsset(id)
                  }}
                >
                  ×
                </button>
                {compatibilityItem ? (
                  <CompatibilityDiagnostics
                    item={compatibilityItem}
                    busy={importBusy || relinkBusy}
                  />
                ) : null}
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
