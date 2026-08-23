/**
 * Durable media catalog plus connected/offline source controls.
 *
 * Rows come from portable descriptors so a missing local file remains visible
 * and actionable. Files, handles, and analysis work stay behind app-layer
 * controller facades; the component reads serializable store projections only.
 */

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  FileVideo,
  ImageSquare,
  List,
  Rows,
  SortAscending,
  SortDescending,
  SquaresFour,
  UploadSimple,
  Waveform,
  X,
} from '@phosphor-icons/react'
import {
  acceptPartialMediaImport,
  canRememberImportedMedia,
  chooseMediaForImport,
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
  connectActiveMediaFolderFiles,
} from '../app/projectController'
import { setMediaVisualPoolViewport } from '../app/mediaVisualsController'
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
import {
  usePreferencesStore,
  type MediaPoolSortField,
  type MediaPoolThumbnailSize,
  type MediaPoolViewPreference,
} from '../state/preferencesStore'
import { importDroppedMediaFiles, clearMediaPlacementPreview } from '../app/mediaPlacementController'
import {
  ASSET_DRAG_TYPE,
  assetKindDragType,
  beginAssetDrag,
  endAssetDrag,
} from './dnd'
import { extractDroppedFiles, isFileDrag } from './fileDrag'
import {
  buildMediaPoolItems,
  filterMediaPoolItems,
  mediaPoolShowsThumbnails,
  sortMediaPoolItems,
  type MediaPoolKind,
  type MediaPoolKindFilter,
  type MediaPoolRowLayout,
  type MediaPoolStatusFilter,
} from './mediaPoolModel'
import MediaImportDialog from './MediaImportDialog'
import MediaCollectionsPanel, {
  MediaCollectionMembership,
} from './MediaCollectionsPanel'
import MediaRelinkDialog from './MediaRelinkDialog'
import { ProxyControls, ProxyStorageSummary } from './ProxyControls'
import { useMediaPoolVirtualizer } from './useMediaPoolVirtualizer'
import {
  localAccessChoiceDescription,
  localAccessChoiceLabel,
} from './localAccessCopy'
import {
  mediaAssetRemovalDisabledReason,
  removeMediaAssetFromProject,
} from '../app/mediaAssetActions'
import {
  editorContextMenuIdentity,
  type EditorContextMenuUiActions,
} from '../app/editorContextMenuCommands'
import {
  openEditorContextMenuFromEvent,
  useEditorContextMenu,
} from './editorContextMenuController'

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
    <label
      className="media-still-duration"
      title="Default still-image duration. Future imports only."
    >
      <span className="media-still-duration-label">Stills</span>
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
      <span id="media-still-duration-help" className="media-pool-sr-only">
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
      role="gridcell"
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
            The original file stays unchanged. Myrelith will use {keptLabels} and
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
  const processedFileCount = useProjectSessionStore(
    (state) => state.activeMediaRelink.processedFileCount,
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
    ? `Checking ${processedFileCount} of ${scannedFileCount} source ${scannedFileCount === 1 ? 'file' : 'files'}…`
    : phase === 'awaiting-choice'
      ? `Checked ${processedFileCount} of ${scannedFileCount} · waiting for a source choice · ${connectedCount} connected so far`
      : `Relink finished · ${processedFileCount} of ${scannedFileCount} checked · ${connectedCount} connected · ${skippedCount} skipped`

  return (
    <section className="media-relink-status" aria-label="Media relink status">
      <p role="status" data-phase={phase}>{message}</p>
      {scannedFileCount > 0 ? (
        <progress
          aria-label="Folder relink progress"
          max={scannedFileCount}
          value={Math.min(processedFileCount, scannedFileCount)}
        />
      ) : null}
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

function mediaPoolItemContextActions(
  row: HTMLElement,
): EditorContextMenuUiActions {
  return {
    openAssetCollections: () => {
      const trigger = row.querySelector<HTMLButtonElement>(
        '.media-membership > button',
      )
      if (!trigger?.isConnected || trigger.disabled) return false
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
      requestAnimationFrame(() => trigger.focus({ preventScroll: true }))
      return true
    },
    openRelinkOnce: () => {
      const input = row.querySelector<HTMLInputElement>(
        '.media-offline-actions input[type="file"]',
      )
      if (!input?.isConnected || input.disabled) return false
      // Deliberately synchronous: the picker needs transient user activation.
      input.click()
      return true
    },
  }
}

const MEDIA_POOL_VIEW_OPTIONS = [
  { viewMode: 'thumbnail', label: 'Thumbnail grid', Icon: SquaresFour },
  { viewMode: 'details', label: 'Details', Icon: Rows },
  { viewMode: 'compact-list', label: 'Compact list', Icon: List },
] as const

const MEDIA_POOL_SIZE_OPTIONS: readonly {
  readonly value: MediaPoolThumbnailSize
  readonly label: string
}[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

const MEDIA_POOL_SORT_OPTIONS: readonly {
  readonly value: MediaPoolSortField
  readonly label: string
}[] = [
  { value: 'project-order', label: 'Project order' },
  { value: 'name', label: 'Name' },
  { value: 'kind', label: 'Kind' },
  { value: 'duration', label: 'Duration' },
  { value: 'last-modified', label: 'Last modified' },
  { value: 'size', label: 'Size' },
]

function MediaPoolViewToolbar({
  preference,
  onChange,
}: {
  readonly preference: MediaPoolViewPreference
  readonly onChange: (next: MediaPoolViewPreference) => void
}) {
  const compact = preference.viewMode === 'compact-list'
  const ascending = preference.sortDirection === 'ascending'
  return (
    <div className="media-pool-view-toolbar" role="group" aria-label="View and sort">
      <div
        className="media-pool-view-modes"
        role="radiogroup"
        aria-label="Media Pool view"
      >
        {MEDIA_POOL_VIEW_OPTIONS.map(({ viewMode, label, Icon }) => {
          const selected = preference.viewMode === viewMode
          return (
            <button
              key={viewMode}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              className="media-pool-view-button"
              data-selected={selected ? 'true' : undefined}
              onClick={() => {
                if (!selected) onChange({ ...preference, viewMode })
              }}
            >
              <Icon aria-hidden="true" size={14} weight={selected ? 'bold' : 'regular'} />
            </button>
          )
        })}
      </div>
      <label className="media-pool-view-select">
        <span className="media-pool-sr-only">Thumbnail size</span>
        <select
          value={preference.thumbnailSize}
          disabled={compact}
          aria-disabled={compact}
          aria-label="Thumbnail size"
          onChange={(event) => onChange({
            ...preference,
            thumbnailSize: event.target.value as MediaPoolThumbnailSize,
          })}
        >
          {MEDIA_POOL_SIZE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="media-pool-view-select">
        <span className="media-pool-sr-only">Sort</span>
        <select
          value={preference.sortField}
          aria-label="Sort media"
          onChange={(event) => onChange({
            ...preference,
            sortField: event.target.value as MediaPoolSortField,
          })}
        >
          {MEDIA_POOL_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="media-pool-view-button"
        aria-label={ascending ? 'Sort ascending' : 'Sort descending'}
        aria-pressed={!ascending}
        title={ascending ? 'Ascending' : 'Descending'}
        onClick={() => onChange({
          ...preference,
          sortDirection: ascending ? 'descending' : 'ascending',
        })}
      >
        {ascending
          ? <SortAscending aria-hidden="true" size={14} weight="bold" />
          : <SortDescending aria-hidden="true" size={14} weight="bold" />}
      </button>
    </div>
  )
}

interface MediaPoolItemCardProps {
  readonly id: string
  readonly kind: MediaPoolKind
  readonly rowId: string
  readonly rowKey: string
  readonly position: number
  readonly itemCount: number
  readonly selected: boolean
  readonly projectRate: FrameRate
  readonly busy: boolean
  readonly handlePickerAvailable: boolean
  readonly showThumbnail: boolean
  readonly attention: boolean
  readonly detailsOpen: boolean
  readonly onSelect: (id: string) => void
  readonly onContextSelect: (id: string) => void
  readonly onToggleDetails: (id: string) => void
  readonly onReviewPartial: (
    id: string,
    selection: PartialTrackImportSelection,
    trigger: HTMLButtonElement,
  ) => void
}

const MediaPoolItemCard = memo(function MediaPoolItemCard({
  id,
  kind,
  rowId,
  rowKey,
  position,
  itemCount,
  selected,
  projectRate,
  busy,
  handlePickerAvailable,
  showThumbnail,
  attention,
  detailsOpen,
  onSelect,
  onContextSelect,
  onToggleDetails,
  onReviewPartial,
}: MediaPoolItemCardProps) {
  const contextMenu = useEditorContextMenu()
  const descriptor = useMediaStore((state) => state.descriptors.get(id))
  const asset = useMediaStore((state) => state.assets.get(id))
  const visual = useMediaStore((state) => state.visuals.get(id))
  const compatibilityItem = useMediaStore(
    (state) => state.compatibility.get(id),
  )
  const fileName = descriptor?.fileName ?? compatibilityItem?.fileName
  if (!fileName) return null

  const connected = asset !== undefined
  const filmstrip = connected ? visual?.filmstrip ?? null : null
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
  const metadata = descriptor
    ? formatAssetMetadata(descriptor, projectRate, compatibilityItem)
    : compatibilityItem
      ? formatSelectedFile(compatibilityItem)
      : ''

  return (
    <li
      id={rowId}
      role="row"
      aria-selected={selected}
      aria-posinset={position}
      aria-setsize={itemCount}
      aria-label={`${fileName}, ${connection}, ${metadata}`}
      key={id}
      className="media-item"
      data-media-id={id}
      data-kind={kind}
      data-media-virtual-row={rowKey}
      data-connection={connection}
      data-compatibility={compatibilityItem?.status}
      data-expanded={detailsOpen || attention ? 'true' : undefined}
      title={fileName}
      draggable={draggable}
      onClick={(event) => {
        const target = event.target
        if (
          target instanceof Element
          && target.closest('button, input, label, select, textarea, a')
        ) return
        onSelect(id)
      }}
      onContextMenu={(event) => {
        const row = event.currentTarget
        if (openEditorContextMenuFromEvent(contextMenu, event, {
          target: {
            ...editorContextMenuIdentity(),
            kind: 'asset',
            assetId: id,
          },
          anchorElement: row,
          restoreFocusTo: row.closest<HTMLElement>('[role="grid"]'),
          uiActions: mediaPoolItemContextActions(row),
        })) onContextSelect(id)
      }}
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
        beginAssetDrag({
          assetId: liveAsset.id,
          kind: liveAsset.kind,
          durationFrames: liveAsset.durationFrames,
        })
      }}
      onDragEnd={() => {
        endAssetDrag()
        clearMediaPlacementPreview()
      }}
    >
      {showThumbnail ? (
        <div
          role="gridcell"
          className="media-thumbnail"
          data-testid={`media-thumbnail-${id}`}
          data-state={connected
            ? filmstrip ? 'ready' : 'placeholder'
            : descriptor ? 'offline' : compatibilityItem?.status}
          style={thumbnailStyle}
          aria-hidden="true"
        >
          {!filmstrip
            ? descriptor?.kind === 'image'
              ? <ImageSquare className="media-thumbnail-icon" aria-hidden="true" size={28} weight="regular" />
              : descriptor?.kind === 'audio'
                ? <Waveform className="media-thumbnail-icon" aria-hidden="true" size={28} weight="regular" />
                : <FileVideo className="media-thumbnail-icon" aria-hidden="true" size={28} weight="regular" />
            : null}
        </div>
      ) : null}

      <div role="gridcell" className="media-details">
        <span className="media-name">{fileName}</span>
        <span className="media-meta">{metadata}</span>
        {descriptor && connected ? (
          <span className="media-connection-badge" data-status="connected">
            Connected
          </span>
        ) : null}
        {descriptor && !connected ? (
          <div className="media-offline-actions">
            <span className="media-connection-badge" data-status="offline">
              Offline · relink needed
            </span>
            {handlePickerAvailable ? (
              <button
                className="media-source-relink"
                type="button"
                aria-label={`Relink & remember ${fileName}`}
                title="Reconnect this source and remember access for future sessions"
                disabled={busy}
                onClick={() => void chooseActiveAssetMedia(id)}
              >
                {localAccessChoiceLabel('Relink', 'remember')}
              </button>
            ) : null}
            <label
              className={handlePickerAvailable
                ? 'media-source-relink media-source-relink-quick'
                : 'media-source-relink'}
              title={handlePickerAvailable
                ? 'Reconnect this source for this session without remembering access'
                : undefined}
            >
              {handlePickerAvailable
                ? localAccessChoiceLabel('Relink', 'once')
                : 'Relink'}
              <input
                className="media-import-input"
                aria-label={handlePickerAvailable
                  ? `Relink ${fileName} once`
                  : `Relink ${fileName}`}
                type="file"
                accept={MEDIA_FILE_INPUT_ACCEPT}
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void connectActiveAssetMedia(id, file)
                }}
              />
            </label>
          </div>
        ) : null}
        <button
          type="button"
          className="media-item-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls={`media-pool-item-actions-${id}`}
          aria-label={`Details and actions for ${fileName}`}
          onClick={() => onToggleDetails(id)}
        >
          Details and actions
        </button>
        {detailsOpen ? (
          <div
            id={`media-pool-item-actions-${id}`}
            className="media-item-actions"
          >
            {descriptor ? (
              <MediaCollectionMembership
                assetId={descriptor.id}
                fileName={descriptor.fileName}
              />
            ) : null}
            {descriptor?.kind === 'video' ? (
              <ProxyControls assetId={descriptor.id} fileName={descriptor.fileName} />
            ) : null}
          </div>
        ) : null}
      </div>

      <div role="gridcell" className="media-remove-cell">
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
            const document = useDocumentStore.getState().doc
            const reason = mediaAssetRemovalDisabledReason(document, id)
            if (reason) {
              window.alert(reason)
              return
            }
            removeMediaAssetFromProject(document, id)
          }}
        >
          <X aria-hidden="true" size={14} weight="bold" />
        </button>
      </div>
      {compatibilityItem && (detailsOpen || attention) ? (
        <CompatibilityDiagnostics
          item={compatibilityItem}
          busy={busy}
          onReviewPartial={descriptor
            ? undefined
            : (selection, trigger) => onReviewPartial(
                id,
                selection,
                trigger,
              )}
          onRetry={descriptor
            ? undefined
            : () => void retryMediaCompatibility(id)}
        />
      ) : null}
    </li>
  )
})

export default function MediaPool() {
  const contextMenu = useEditorContextMenu()
  const documentFrameRate = useDocumentStore((state) => state.doc.frameRate)
  const descriptors = useMediaStore((state) => state.descriptors)
  const assets = useMediaStore((state) => state.assets)
  const compatibility = useMediaStore((state) => state.compatibility)
  const collections = useMediaStore((state) => state.collections)
  const canUndoCollection = useMediaStore(
    (state) => state.collectionPast.length > 0,
  )
  const canRedoCollection = useMediaStore(
    (state) => state.collectionFuture.length > 0,
  )
  const undoCollectionEdit = useMediaStore(
    (state) => state.undoCollectionEdit,
  )
  const redoCollectionEdit = useMediaStore(
    (state) => state.redoCollectionEdit,
  )
  const importBusy = useMediaImportStore((state) => state.phase !== 'idle')
  const relinkPhase = useProjectSessionStore(
    (state) => state.activeMediaRelink.phase,
  )
  const relinkBusy = relinkPhase === 'scanning'
    || relinkPhase === 'awaiting-choice'
  const busy = importBusy || relinkBusy
  const handlePickerAvailable = canRememberImportedMedia()
  const folderPickerAvailable = canChooseActiveMediaFolder()
  const [searchQuery, setSearchQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<MediaPoolKindFilter>('all')
  const [statusFilter, setStatusFilter] =
    useState<MediaPoolStatusFilter>('all')
  const [selectedCollectionId, setSelectedCollectionId] =
    useState<string | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [partialReview, setPartialReview] =
    useState<PartialTrackImportReview | null>(null)
  const [dropReady, setDropReady] = useState(false)
  const partialReviewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const mediaPoolView = usePreferencesStore((state) => state.mediaPoolView)
  const setMediaPoolView = usePreferencesStore((state) => state.setMediaPoolView)
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const itemModels = useMemo(
    () => buildMediaPoolItems(descriptors, assets, compatibility),
    [assets, compatibility, descriptors],
  )
  const selectedCollection = useMemo(
    () => collections.find(
      (collection) => collection.id === selectedCollectionId,
    ) ?? null,
    [collections, selectedCollectionId],
  )
  const selectedCollectionMissing = selectedCollectionId !== null
    && selectedCollection === null
  const collectionAssetIds = useMemo(
    () => selectedCollection
      ? new Set(selectedCollection.assetIds)
      : null,
    [selectedCollection],
  )
  const collectionItemCount = useMemo(
    () => collectionAssetIds === null
      ? itemModels.length
      : itemModels.reduce(
          (count, item) => count + Number(collectionAssetIds.has(item.id)),
          0,
        ),
    [collectionAssetIds, itemModels],
  )
  const filteredItems = useMemo(
    () => filterMediaPoolItems(itemModels, {
      query: deferredSearchQuery,
      kind: kindFilter,
      status: statusFilter,
    }, collectionAssetIds),
    [
      collectionAssetIds,
      deferredSearchQuery,
      itemModels,
      kindFilter,
      statusFilter,
    ],
  )
  const sortedItems = useMemo(
    () => sortMediaPoolItems(
      filteredItems,
      mediaPoolView.sortField,
      mediaPoolView.sortDirection,
    ),
    [
      filteredItems,
      mediaPoolView.sortDirection,
      mediaPoolView.sortField,
    ],
  )
  const showThumbnails = mediaPoolShowsThumbnails(mediaPoolView.viewMode)
  const rowLayout = useMemo((): MediaPoolRowLayout => ({
    viewMode: mediaPoolView.viewMode,
    thumbnailSize: mediaPoolView.thumbnailSize,
    expandedItemId,
  }), [
    expandedItemId,
    mediaPoolView.thumbnailSize,
    mediaPoolView.viewMode,
  ])
  const virtualizer = useMediaPoolVirtualizer(sortedItems, rowLayout)
  const { scrollToStart, visibleItemIds } = virtualizer
  const filteredIndexById = useMemo(() => new Map(
    sortedItems.map((item, index) => [item.id, index] as const),
  ), [sortedItems])
  const rowKeyByItemId = useMemo(() => {
    const result = new Map<string, string>()
    for (const row of virtualizer.rows) {
      for (const id of row.itemIds) result.set(id, row.key)
    }
    return result
  }, [virtualizer.rows])
  const renderedItemIds = useMemo(
    () => new Set(virtualizer.renderedItemIds),
    [virtualizer.renderedItemIds],
  )
  const effectiveSelectedAssetId = selectedAssetId
    && filteredIndexById.has(selectedAssetId)
      ? selectedAssetId
      : sortedItems[0]?.id ?? null
  const activeRowId = effectiveSelectedAssetId
    && renderedItemIds.has(effectiveSelectedAssetId)
      ? `media-pool-row-${filteredIndexById.get(effectiveSelectedAssetId)}`
      : undefined
  const offlineCount = useMemo(() => {
    let count = 0
    for (const descriptor of descriptors.values()) {
      if (!assets.has(descriptor.id)) count++
    }
    return count
  }, [assets, descriptors])
  const filtersActive = searchQuery.length > 0
    || kindFilter !== 'all'
    || statusFilter !== 'all'
  const filterPending = searchQuery !== deferredSearchQuery
  useEffect(() => {
    setMediaVisualPoolViewport(showThumbnails ? visibleItemIds : [])
  }, [showThumbnails, visibleItemIds])

  useEffect(() => () => setMediaVisualPoolViewport([]), [])

  useEffect(() => {
    scrollToStart()
  }, [
    deferredSearchQuery,
    kindFilter,
    scrollToStart,
    selectedCollectionId,
    statusFilter,
  ])

  useEffect(() => {
    if (selectedCollectionMissing) setSelectedCollectionId(null)
  }, [selectedCollectionMissing])

  useEffect(() => {
    if (expandedItemId && !filteredIndexById.has(expandedItemId)) {
      setExpandedItemId(null)
    }
  }, [expandedItemId, filteredIndexById])

  useEffect(() => {
    if (!effectiveSelectedAssetId) return
    const rowIndex = virtualizer.rowIndexByItemId.get(effectiveSelectedAssetId)
    if (rowIndex !== undefined) virtualizer.ensureRowVisible(rowIndex)
  }, [
    effectiveSelectedAssetId,
    mediaPoolView.sortDirection,
    mediaPoolView.sortField,
    mediaPoolView.thumbnailSize,
    mediaPoolView.viewMode,
    virtualizer,
  ])

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

  const selectItem = useCallback((id: string): void => {
    setSelectedAssetId(id)
    requestAnimationFrame(() => {
      virtualizer.listRef.current?.focus({ preventScroll: true })
    })
  }, [virtualizer.listRef])

  const toggleItemDetails = useCallback((id: string): void => {
    setExpandedItemId((current) => current === id ? null : id)
    setSelectedAssetId(id)
  }, [])

  const openPartialReview = useCallback((
    id: string,
    selection: PartialTrackImportSelection,
    trigger: HTMLButtonElement,
  ): void => {
    partialReviewTriggerRef.current = trigger
    setPartialReview({ itemId: id, selection })
  }, [])

  const closePartialReview = useCallback((restoreFocus: boolean): void => {
    const trigger = partialReviewTriggerRef.current
    const reviewId = partialReview?.itemId ?? null
    partialReviewTriggerRef.current = null
    setPartialReview(null)
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (trigger?.isConnected) {
          trigger.focus()
          return
        }
        if (reviewId) {
          const rowIndex = virtualizer.rowIndexByItemId.get(reviewId)
          if (rowIndex !== undefined) virtualizer.ensureRowVisible(rowIndex)
          setSelectedAssetId(reviewId)
        }
        virtualizer.listRef.current?.focus({ preventScroll: true })
      })
    }
  }, [partialReview?.itemId, virtualizer])

  useEffect(() => {
    if (partialReview && !partialReviewIsValid) closePartialReview(true)
  }, [closePartialReview, partialReview, partialReviewIsValid])

  const handleListKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLUListElement>,
  ): void => {
    if (event.currentTarget !== event.target || sortedItems.length === 0) {
      return
    }
    const currentIndex = effectiveSelectedAssetId
      ? filteredIndexById.get(effectiveSelectedAssetId) ?? 0
      : 0
    if (
      event.key === 'ContextMenu'
      || (event.key === 'F10' && event.shiftKey)
    ) {
      const assetId = sortedItems[currentIndex]?.id
      const row = assetId
        ? [...event.currentTarget.querySelectorAll<HTMLElement>('[data-media-id]')]
          .find((candidate) => candidate.dataset.mediaId === assetId)
        : null
      if (!assetId || !row) return
      const rect = row.getBoundingClientRect()
      const opened = contextMenu.open({
        target: {
          ...editorContextMenuIdentity(),
          kind: 'asset',
          assetId,
        },
        anchor: {
          kind: 'rect',
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
        restoreFocusTo: event.currentTarget,
        uiActions: mediaPoolItemContextActions(row),
      })
      if (!opened) return
      event.preventDefault()
      event.stopPropagation()
      setSelectedAssetId(assetId)
      return
    }
    let nextIndex: number | null = null
    const columnCount = Math.max(1, virtualizer.columnCount)
    if (event.key === 'ArrowRight') {
      nextIndex = currentIndex + 1
    } else if (event.key === 'ArrowLeft') {
      nextIndex = currentIndex - 1
    } else if (event.key === 'ArrowDown') {
      nextIndex = currentIndex + columnCount
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex - columnCount
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = sortedItems.length - 1
    } else if (event.key === 'PageDown') {
      nextIndex = currentIndex + columnCount * 4
    } else if (event.key === 'PageUp') {
      nextIndex = currentIndex - columnCount * 4
    }
    if (nextIndex === null) return
    event.preventDefault()
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && (nextIndex < 0 || nextIndex >= sortedItems.length)
    ) {
      return
    }
    const boundedIndex = Math.max(
      0,
      Math.min(sortedItems.length - 1, nextIndex),
    )
    const nextId = sortedItems[boundedIndex]?.id
    if (!nextId) return
    const rowIndex = virtualizer.rowIndexByItemId.get(nextId)
    if (rowIndex !== undefined) virtualizer.ensureRowVisible(rowIndex)
    setSelectedAssetId(nextId)
  }, [
    effectiveSelectedAssetId,
    filteredIndexById,
    sortedItems,
    contextMenu,
    virtualizer,
  ])

  const handleCollectionHistoryKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    const target = event.target
    if (
      target instanceof HTMLElement
      && (target.isContentEditable
        || target.closest('input, textarea, select, [contenteditable="true"]'))
    ) return
    const key = event.key.toLowerCase()
    const redoRequested = (key === 'z' && event.shiftKey) || key === 'y'
    const undoRequested = key === 'z' && !event.shiftKey
    if (
      (undoRequested && !canUndoCollection)
      || (redoRequested && !canRedoCollection)
      || (!undoRequested && !redoRequested)
    ) return
    event.preventDefault()
    event.stopPropagation()
    if (redoRequested) redoCollectionEdit()
    else undoCollectionEdit()
  }, [
    canRedoCollection,
    canUndoCollection,
    redoCollectionEdit,
    undoCollectionEdit,
  ])

  const handleFileDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDropReady(true)
  }

  const handleFileDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    const related = event.relatedTarget
    if (related instanceof Node && event.currentTarget.contains(related)) return
    setDropReady(false)
  }

  const handleFileDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setDropReady(false)
    const files = extractDroppedFiles(event.dataTransfer)
    if (files.length === 0) return
    void importDroppedMediaFiles(files)
  }

  return (
    <div
      className={`media-pool${dropReady ? ' drop-target' : ''}`}
      data-drop-target={dropReady ? 'true' : undefined}
      onKeyDown={handleCollectionHistoryKeyDown}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
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
                {localAccessChoiceLabel('Relink folder', 'remember')}
              </button>
            ) : null}
            {offlineCount > 0 ? (
              <label
                className={folderPickerAvailable
                  ? 'media-folder-relink media-folder-relink-once'
                  : 'media-folder-relink'}
                title={folderPickerAvailable
                  ? localAccessChoiceDescription('once')
                  : undefined}
              >
                {folderPickerAvailable
                  ? localAccessChoiceLabel('Relink folder', 'once')
                  : 'Relink folder'}
                <input
                  className="media-import-input"
                  aria-label={folderPickerAvailable
                    ? 'Relink a media folder once'
                    : 'Relink a media folder'}
                  type="file"
                  accept={MEDIA_FILE_INPUT_ACCEPT}
                  multiple
                  disabled={importBusy || relinkBusy}
                  ref={(input) => input?.setAttribute('webkitdirectory', '')}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])]
                    event.target.value = ''
                    if (files.length > 0) void connectActiveMediaFolderFiles(files)
                  }}
                />
              </label>
            ) : null}
            {handlePickerAvailable ? (
              <button
                className="media-import"
                type="button"
                aria-describedby="media-access-explanation"
                title="Choose media and keep access for later sessions"
                disabled={importBusy || relinkBusy}
                onClick={() => void chooseMediaForImport()}
              >
                <UploadSimple aria-hidden="true" size={14} weight="bold" />
                <span>Import</span>
              </button>
            ) : (
              <label className="media-import">
                <UploadSimple aria-hidden="true" size={14} weight="bold" />
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
        {handlePickerAvailable ? (
          <p id="media-access-explanation" className="media-pool-sr-only">
            Import stores a browser-only file permission and its label.
            Myrelith never copies or uploads the file.
          </p>
        ) : null}
        <div className="media-pool-filters" role="search" aria-label="Filter media">
          <label className="media-pool-search">
            <span className="media-pool-sr-only">Search</span>
            <input
              type="search"
              value={searchQuery}
              placeholder="Search"
              aria-controls="media-pool-list"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <label className="media-pool-filter">
            <span className="media-pool-sr-only">Type</span>
            <select
              value={kindFilter}
              aria-controls="media-pool-list"
              onChange={(event) => setKindFilter(
                event.target.value as MediaPoolKindFilter,
              )}
            >
              <option value="all">All types</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="image">Still images</option>
            </select>
          </label>
          <label className="media-pool-filter">
            <span className="media-pool-sr-only">Status</span>
            <select
              value={statusFilter}
              aria-controls="media-pool-list"
              onChange={(event) => setStatusFilter(
                event.target.value as MediaPoolStatusFilter,
              )}
            >
              <option value="all">All statuses</option>
              <option value="ready">Ready media</option>
              <option value="offline">Offline media</option>
              <option value="checking">Checking media</option>
              <option value="limited">Limited media</option>
              <option value="unsupported">Unsupported media</option>
              <option value="error">Media errors</option>
            </select>
          </label>
          {filtersActive ? (
            <button
              className="media-pool-clear-filters"
              type="button"
              onClick={() => {
                setSearchQuery('')
                setKindFilter('all')
                setStatusFilter('all')
              }}
            >
              Clear
            </button>
          ) : null}
          <span
            className="media-pool-filter-status"
            aria-live="polite"
          >
            {filterPending
              ? 'Filtering…'
              : `${filteredItems.length} of ${collectionItemCount}`}
          </span>
        </div>
        <div className="media-pool-header-tools">
          <MediaPoolViewToolbar
            preference={mediaPoolView}
            onChange={setMediaPoolView}
          />
        </div>
        <div className="media-pool-header-meta">
          <ProxyStorageSummary />
          <StillImageDurationPreference />
        </div>
      </div>

      <MediaCollectionsPanel
        selectedCollectionId={selectedCollectionId}
        onSelectCollection={setSelectedCollectionId}
      />

      <MediaRelinkStatus />

      <ul
        ref={virtualizer.listRef}
        id="media-pool-list"
        className="media-list"
        role="grid"
        aria-label="Media assets"
        aria-busy={filterPending}
        aria-activedescendant={activeRowId}
        aria-describedby="media-pool-keyboard-help"
        data-view={mediaPoolView.viewMode}
        data-size={mediaPoolView.thumbnailSize}
        tabIndex={0}
        style={{
          '--media-pool-columns': virtualizer.columnCount,
        } as CSSProperties}
        onFocus={() => {
          if (!effectiveSelectedAssetId) return
          const rowIndex = virtualizer.rowIndexByItemId.get(
            effectiveSelectedAssetId,
          )
          if (rowIndex !== undefined) virtualizer.ensureRowVisible(rowIndex)
        }}
        onKeyDown={handleListKeyDown}
      >
        {virtualizer.virtualWindow.topSpacerHeight > 0 ? (
          <li
            className="media-list-spacer"
            aria-hidden="true"
            style={{ height: virtualizer.virtualWindow.topSpacerHeight }}
          />
        ) : null}
        {virtualizer.renderedItemIds.map((id) => {
          const position = filteredIndexById.get(id)
          const rowKey = rowKeyByItemId.get(id)
          const item = position === undefined ? undefined : sortedItems[position]
          if (position === undefined || !rowKey || !item) return null
          return (
            <MediaPoolItemCard
              key={id}
              id={id}
              kind={item.kind}
              rowId={`media-pool-row-${position}`}
              rowKey={rowKey}
              position={position + 1}
              itemCount={sortedItems.length}
              selected={effectiveSelectedAssetId === id}
              projectRate={documentFrameRate}
              busy={busy}
              handlePickerAvailable={handlePickerAvailable}
              showThumbnail={showThumbnails}
              attention={item.expanded}
              detailsOpen={expandedItemId === id}
              onSelect={selectItem}
              onContextSelect={setSelectedAssetId}
              onToggleDetails={toggleItemDetails}
              onReviewPartial={openPartialReview}
            />
          )
        })}
        {virtualizer.virtualWindow.bottomSpacerHeight > 0 ? (
          <li
            className="media-list-spacer"
            aria-hidden="true"
            style={{ height: virtualizer.virtualWindow.bottomSpacerHeight }}
          />
        ) : null}
      </ul>
      {itemModels.length === 0 ? (
        <p className="media-empty">
          no media yet — import video, audio, or a still image
        </p>
      ) : selectedCollection && collectionItemCount === 0 ? (
        <p className="media-empty" role="status">
          This collection is empty. Drag media to its tab or use Organize.
        </p>
      ) : filteredItems.length === 0 && !filterPending ? (
        <div className="media-empty" role="status">
          <p>No media matches these filters.</p>
          <button
            type="button"
            className="media-pool-clear-empty"
            onClick={() => {
              setSearchQuery('')
              setKindFilter('all')
              setStatusFilter('all')
            }}
          >
            Clear filters
          </button>
        </div>
      ) : null}
      <span id="media-pool-keyboard-help" className="media-pool-sr-only">
        Use arrow keys, Home, End, Page Up, and Page Down to move the Media Pool selection. Tab moves into that row's relink, collection, proxy, and remove actions.
      </span>
      <span className="media-pool-sr-only" aria-live="polite">
        {effectiveSelectedAssetId
          ? `Selected ${filteredItems[filteredIndexById.get(effectiveSelectedAssetId) ?? -1]?.fileName ?? 'media'}`
          : 'No media selected'}
      </span>
      {itemModels.length > 0 && (
        <div className="media-count">
          {selectedCollection ? `${selectedCollection.name}: ` : ''}
          {filteredItems.length === collectionItemCount
            ? `${collectionItemCount} ${collectionItemCount === 1 ? 'item' : 'items'}`
            : `${filteredItems.length} of ${collectionItemCount} items`}
        </div>
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
