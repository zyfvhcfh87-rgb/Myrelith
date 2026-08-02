/**
 * Durable media catalog plus connected/offline source controls.
 *
 * Rows come from portable descriptors so a missing local file remains visible
 * and actionable. Files, handles, and analysis work stay behind app-layer
 * controller facades; the component reads serializable store projections only.
 */

import { useEffect, useRef, useState } from 'react'
import {
  acceptPartialMediaImport,
  canRememberImportedMedia,
  chooseMediaForImport,
  forgetImportedMediaHandle,
  importMediaFiles,
  removeMediaCompatibility,
  retryMediaCompatibility,
} from '../app/mediaImportController'
import { MEDIA_FILE_INPUT_ACCEPT } from '../app/localMediaHandles'
import {
  canChooseActiveMediaFolder,
  chooseActiveAssetMedia,
  chooseActiveMediaFolder,
  connectActiveAssetMedia,
} from '../app/projectController'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import {
  isValidStillImageDurationMicroseconds,
  STILL_IMAGE_DURATION_PREFERENCE_LIMITS,
} from '../domain/staticImage'
import {
  compatibilityAllowsTimelineUse,
  mediaRuntimeSurfaceLabel,
  omittedPartialImportTracks,
  partialTrackImportOption,
  type MediaCompatibilityItem,
  type MediaCompatibilityStatus,
  type MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
import type {
  FrameRate,
  PartialTrackImportSelection,
} from '../domain/schema'
import {
  formatTimecode,
  microsecondsDurationToFrames,
} from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaImportStore } from '../state/mediaImportStore'
import { useMediaStore } from '../state/mediaStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { usePreferencesStore } from '../state/preferencesStore'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'
import MediaImportDialog from './MediaImportDialog'
import MediaRelinkDialog from './MediaRelinkDialog'

function formatPreferenceSeconds(durationMicroseconds: number): string {
  return String(durationMicroseconds / 1_000_000)
}

function StillImageDurationPreference() {
  const durationMicroseconds = usePreferencesStore(
    (state) => state.defaultStillImageDurationMicroseconds,
  )
  const setDurationMicroseconds = usePreferencesStore(
    (state) => state.setDefaultStillImageDurationMicroseconds,
  )
  const [draft, setDraft] = useState(
    () => formatPreferenceSeconds(durationMicroseconds),
  )

  useEffect(() => {
    setDraft(formatPreferenceSeconds(durationMicroseconds))
  }, [durationMicroseconds])

  const restore = (): void => {
    setDraft(formatPreferenceSeconds(durationMicroseconds))
  }
  const commit = (): void => {
    const seconds = Number(draft)
    const nextMicroseconds = Math.round(seconds * 1_000_000)
    if (!isValidStillImageDurationMicroseconds(nextMicroseconds)) {
      restore()
      return
    }
    setDurationMicroseconds(nextMicroseconds)
    setDraft(formatPreferenceSeconds(nextMicroseconds))
  }

  return (
    <label className="media-still-duration">
      <span className="media-still-duration-label">
        Default still-image duration
      </span>
      <span className="media-still-duration-input">
        <input
          aria-label="Default still-image duration"
          aria-describedby="media-still-duration-help"
          type="number"
          min={STILL_IMAGE_DURATION_PREFERENCE_LIMITS.minMicroseconds / 1_000_000}
          max={STILL_IMAGE_DURATION_PREFERENCE_LIMITS.maxMicroseconds / 1_000_000}
          step="0.1"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              restore()
            }
          }}
        />
        <span aria-hidden="true">s</span>
      </span>
      <span id="media-still-duration-help" className="media-still-duration-help">
        Future imports only
      </span>
    </label>
  )
}

function formatAssetMetadata(
  descriptor: PortableAssetDescriptor,
  projectRate: FrameRate,
  compatibilityItem?: MediaCompatibilityItem,
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
    const projection = descriptor.partialTrackSelection === 'video-only'
      ? ' · Video only'
      : ''
    return `${dimensions} · ${duration}${projection}`
  }
  if (descriptor.kind === 'audio') {
    const quality = descriptor.audioSampleRate
      ? `${descriptor.audioSampleRate / 1_000} kHz`
      : 'Audio'
    const projection = descriptor.partialTrackSelection === 'audio-only'
      ? ' · Audio only'
      : ''
    return `${quality} · ${duration}${projection}`
  }
  const dimensions = descriptor.width && descriptor.height
    ? `${descriptor.width}×${descriptor.height}`
    : 'Still image'
  const animation = compatibilityItem?.report?.image?.firstFrameOnly
    ? ' · First frame only'
    : ''
  return `${dimensions} · ${duration}${animation}`
}

function assetIsUsedOnTimeline(assetId: string): boolean {
  return useDocumentStore.getState().doc.tracks.some((track) => (
    track.clips.some(
      (clip) => clip.text === undefined && clip.assetId === assetId,
    )
  ))
}

const COMPATIBILITY_LABELS: Record<MediaCompatibilityStatus, string> = {
  checking: 'Checking',
  ready: 'Ready',
  limited: 'Limited',
  unsupported: 'Unsupported',
  error: 'Error',
}

const DECODER_PATH_LABELS: Record<
  NonNullable<MediaTrackCompatibility['decoderPath']>,
  string
> = {
  native: 'Native browser decoder',
  'local-prores': 'Local fallback (ProRes)',
  'local-ac3': 'Local fallback (AC-3/E-AC-3)',
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
  if (track.decoderPath) parts.push(DECODER_PATH_LABELS[track.decoderPath])
  return parts.join(' · ')
}

function CompatibilityDiagnostics({
  item,
  busy,
  onReviewPartial,
  onRetry,
}: {
  item: MediaCompatibilityItem
  busy: boolean
  onReviewPartial?: (
    selection: PartialTrackImportSelection,
    trigger: HTMLButtonElement,
  ) => void
  onRetry?: () => void
}) {
  const report = item.report
  const partialOption = partialTrackImportOption(report)
  const acceptedOmissions = report ? omittedPartialImportTracks(report) : []
  const retryable = item.status === 'limited'
    || item.status === 'unsupported'
    || item.status === 'error'
  const runtimeFailures = report?.runtimeFailures ?? []
  const failedTracks = report?.tracks.filter((track) => (
    !track.decodable
    && !acceptedOmissions.includes(track)
    && !runtimeFailures.some((failure) =>
      failure.trackKind === track.kind
      && failure.reason === track.reason
      && failure.detail === track.detail,
    )
  )) ?? []

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
          {item.status === 'ready' && report?.partialImport
            ? ` — ${report.partialImport.selection === 'video-only' ? 'video only' : 'audio only'}`
            : ''}
        </p>
        {retryable && onRetry ? (
          <button
            className="media-compatibility-retry"
            type="button"
            aria-label={`Retry compatibility check for ${item.fileName}`}
            disabled={busy}
            onClick={onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>

      {!report ? (
        <p className="media-compatibility-note">
          Reading file bytes and media metadata…
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
            {report.image ? (
              <div>
                <dt>Still image</dt>
                <dd>
                  {report.image.format.toUpperCase()}
                  {' · '}
                  {report.image.width}×{report.image.height}
                  {' · '}
                  {report.image.decodePath === 'image-decoder'
                    ? 'ImageDecoder'
                    : 'ImageBitmap'}
                  {report.image.firstFrameOnly ? ' · First frame only' : ''}
                </dd>
              </div>
            ) : null}
          </dl>
          {report.detail && runtimeFailures.length === 0 ? (
            <p
              className="media-compatibility-summary"
              data-partial-import={report.partialImport ? 'accepted' : undefined}
            >
              {report.detail}
            </p>
          ) : null}
          {acceptedOmissions.length > 0 ? (
            <ul className="media-partial-import-omissions">
              {acceptedOmissions.map((track) => (
                <li key={`${track.kind}-${track.number}`}>
                  <strong>{trackLabel(track)} omitted:</strong>{' '}
                  {track.detail ?? 'Omitted by the explicit partial-import choice.'}
                </li>
              ))}
            </ul>
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
          {runtimeFailures.length > 0 ? (
            <ul className="media-compatibility-failures">
              {runtimeFailures.map((failure, index) => (
                <li key={`${failure.surface}-${failure.trackKind}-${index}`}>
                  <strong>{mediaRuntimeSurfaceLabel(failure.surface)}:</strong>{' '}
                  {failure.detail}
                </li>
              ))}
            </ul>
          ) : null}
          {partialOption && onReviewPartial ? (
            <div className="media-partial-import-action">
              <p>
                Importing {partialOption === 'video-only' ? 'video only' : 'audio only'} will
                omit{' '}
                {report.tracks
                  .filter((track) => track.kind !== (
                    partialOption === 'video-only' ? 'video' : 'audio'
                  ))
                  .map(trackLabel)
                  .join(', ')}.
                {' '}The omitted track content will not appear on the timeline or in exports.
              </p>
              <button
                className="media-partial-import-button"
                type="button"
                aria-label={`Review ${partialOption} import for ${item.fileName}`}
                aria-haspopup="dialog"
                disabled={busy}
                onClick={(event) => onReviewPartial(
                  partialOption,
                  event.currentTarget,
                )}
              >
                Review {partialOption === 'video-only' ? 'video only' : 'audio only'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

interface PartialTrackImportReview {
  itemId: string
  selection: PartialTrackImportSelection
}

function PartialTrackImportDialog({
  item,
  selection,
  busy,
  onCancel,
  onConfirm,
}: {
  item: MediaCompatibilityItem
  selection: PartialTrackImportSelection
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const keptKind = selection === 'video-only' ? 'video' : 'audio'
  const omittedKind = keptKind === 'video' ? 'audio' : 'video'
  const keptTracks = item.report?.tracks.filter(
    (track) => track.kind === keptKind,
  ) ?? []
  const omittedTracks = item.report?.tracks.filter(
    (track) => track.kind === omittedKind,
  ) ?? []
  const keptLabels = keptTracks.map(trackLabel).join(', ')
  const omittedLabels = omittedTracks.map(trackLabel).join(', ')
  const titleId = 'media-partial-import-title'
  const descriptionId = 'media-partial-import-description'

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

  return (
    <dialog
      ref={dialogRef}
      className="media-partial-import-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="media-partial-import-card">
        <header className="media-partial-import-header">
          <span className="media-import-eyebrow">Track choice</span>
          <h2 id={titleId}>
            Import “{item.fileName}” without {omittedKind}?
          </h2>
        </header>
        <div className="media-partial-import-body">
          <p id={descriptionId}>
            The original file stays unchanged. WebCut will use {keptLabels} and
            {' '}omit {omittedLabels}. Omitted {omittedKind} will not appear on
            {' '}the timeline or in exports.
          </p>
          <dl className="media-partial-import-facts">
            {keptTracks.map((track) => (
              <div key={`keep-${track.kind}-${track.number}`}>
                <dt>Keep</dt>
                <dd>
                  <strong>{trackLabel(track)}</strong>
                  <span>{formatTrack(track)}</span>
                </dd>
              </div>
            ))}
            {omittedTracks.map((track) => (
              <div key={`omit-${track.kind}-${track.number}`} data-action="omit">
                <dt>Omit</dt>
                <dd>
                  <strong>{trackLabel(track)}</strong>
                  <span>{formatTrack(track)}</span>
                  <span>{track.detail ?? 'This track is not usable in this browser.'}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="media-partial-import-dialog-actions">
          <button
            type="button"
            className="media-import-secondary"
            autoFocus
            disabled={busy}
            onClick={onCancel}
          >
            Keep as Limited
          </button>
          <button
            type="button"
            className="media-import-primary"
            disabled={busy}
            onClick={onConfirm}
          >
            Import {selection === 'video-only' ? 'video only' : 'audio only'}
          </button>
        </div>
      </div>
    </dialog>
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
  const [partialReview, setPartialReview] =
    useState<PartialTrackImportReview | null>(null)
  const partialReviewTriggerRef = useRef<HTMLButtonElement | null>(null)
  let offlineCount = 0
  for (const descriptor of descriptors.values()) {
    if (!assets.has(descriptor.id)) offlineCount++
  }
  const itemIds = [
    ...descriptors.keys(),
    ...[...compatibility.keys()].filter((id) => !descriptors.has(id)),
  ]
  const partialReviewItem = partialReview
    ? compatibility.get(partialReview.itemId)
    : undefined
  const partialReviewIsValid = Boolean(partialReview
    && partialReviewItem?.status === 'limited'
    && partialTrackImportOption(partialReviewItem.report) === partialReview.selection
    && !descriptors.has(partialReview.itemId))
  const validPartialReview = partialReviewIsValid
    && partialReview
    && partialReviewItem
      ? { review: partialReview, item: partialReviewItem }
      : null

  const closePartialReview = (restoreFocus: boolean): void => {
    const trigger = partialReviewTriggerRef.current
    partialReviewTriggerRef.current = null
    setPartialReview(null)
    if (restoreFocus && trigger) {
      requestAnimationFrame(() => {
        if (trigger.isConnected) trigger.focus()
      })
    }
  }

  useEffect(() => {
    if (partialReview && !partialReviewIsValid) closePartialReview(true)
  }, [partialReview, partialReviewIsValid])

  return (
    <div className="media-pool">
      <div className="media-pool-header">
        <div className="media-pool-header-main">
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
                  accept={MEDIA_FILE_INPUT_ACCEPT}
                  multiple
                  disabled={importBusy || relinkBusy}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])]
                    event.target.value = ''
                    if (files.length > 0) void importMediaFiles(files)
                  }}
                />
              </label>
            )}
          </div>
        </div>
        <StillImageDurationPreference />
      </div>

      <MediaRelinkStatus />

      {itemIds.length === 0 ? (
        <p className="media-empty">
          no media yet — import video, audio, or a still image
        </p>
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
                  ...(asset?.kind === 'image'
                    ? {
                        backgroundSize: 'contain',
                        backgroundPosition: 'center',
                        backgroundRepeat: 'no-repeat',
                      }
                    : {
                        // Scale the strip so its first tile fills the thumbnail.
                        backgroundSize: `${filmstrip.tiles * 100}% auto`,
                      }),
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
                      {descriptor?.kind === 'image' ? (
                        <>
                          <rect x="3" y="4" width="18" height="16" rx="2" />
                          <circle cx="9" cy="9" r="2" />
                          <path d="m5 17 4-4 3 3 2-2 5 5" />
                        </>
                      ) : (
                        <>
                          <rect x="3" y="5" width="13" height="14" rx="2" />
                          <path d="m16 10 5-3v10l-5-3" />
                        </>
                      )}
                    </svg>
                  ) : null}
                </div>

                <div className="media-details">
                  <span className="media-name">{fileName}</span>
                  <span className="media-meta">
                    {descriptor
                      ? formatAssetMetadata(
                          descriptor,
                          documentFrameRate,
                          compatibilityItem,
                        )
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
                            accept={MEDIA_FILE_INPUT_ACCEPT}
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
                    onReviewPartial={descriptor
                      ? undefined
                      : (selection, trigger) => {
                          partialReviewTriggerRef.current = trigger
                          setPartialReview({ itemId: id, selection })
                        }}
                    onRetry={descriptor
                      ? undefined
                      : () => void retryMediaCompatibility(id)}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <MediaImportDialog />
      <MediaRelinkDialog />
      {validPartialReview ? (
        <PartialTrackImportDialog
          item={validPartialReview.item}
          selection={validPartialReview.review.selection}
          busy={importBusy || relinkBusy}
          onCancel={() => closePartialReview(true)}
          onConfirm={() => {
            const { itemId, selection } = validPartialReview.review
            closePartialReview(false)
            void acceptPartialMediaImport(itemId, selection)
          }}
        />
      ) : null}
    </div>
  )
}
