/**
 * ui/MediaPool.tsx — Import + thumbnail asset cards.
 *
 * Importing delegates to app/mediaImportController, which analyzes the File,
 * handles any FPS decision, and commits one complete asset. Existing
 * controllers then open its preview source and generate visuals.
 * This UI crops the filmstrip's first tile as a representative thumbnail.
 * Every visible row is already analyzed; a positive duration makes it
 * draggable onto the timeline.
 */

import {
  canRememberImportedMedia,
  chooseMediaForImport,
  forgetImportedMediaHandle,
  importMedia,
} from '../app/mediaImportController'
import type { FrameRate, MediaAsset } from '../domain/schema'
import { formatTimecode } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaImportStore } from '../state/mediaImportStore'
import { useMediaStore } from '../state/mediaStore'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'
import MediaImportDialog from './MediaImportDialog'

function formatAssetMetadata(
  asset: MediaAsset,
  projectRate: FrameRate,
): string {
  const duration = formatTimecode(asset.durationFrames, projectRate)
  if (asset.kind === 'video') {
    const dimensions = asset.width && asset.height
      ? `${asset.width}×${asset.height}`
      : 'Video'
    return `${dimensions} · ${duration}`
  }
  if (asset.kind === 'audio') {
    const quality = asset.audioSampleRate
      ? `${asset.audioSampleRate / 1_000} kHz`
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

export default function MediaPool() {
  const documentFrameRate = useDocumentStore((state) => state.doc.frameRate)
  const assets = useMediaStore((state) => state.assets)
  const visuals = useMediaStore((state) => state.visuals)
  const removeAsset = useMediaStore((state) => state.removeAsset)
  const importBusy = useMediaImportStore((state) => state.phase !== 'idle')
  const handlePickerAvailable = canRememberImportedMedia()

  return (
    <div className="media-pool">
      <div className="media-pool-header">
        <h2 className="media-pool-title">Media</h2>
        {handlePickerAvailable ? (
          <button
            className="media-import"
            type="button"
            disabled={importBusy}
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
              disabled={importBusy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void importMedia(file)
              }}
            />
          </label>
        )}
      </div>

      {assets.size === 0 ? (
        <p className="media-empty">no media yet — import a video or audio file</p>
      ) : (
        <ul className="media-list">
          {[...assets.values()].map((asset) => {
            const filmstrip = visuals.get(asset.id)?.filmstrip ?? null
            const thumbnailStyle = filmstrip
              ? {
                  backgroundImage: `url("${filmstrip.url}")`,
                  // The strip is N tiles wide. Scaling its total width to
                  // N × the thumbnail width makes exactly tile 1 fill the box.
                  backgroundSize: `${filmstrip.tiles * 100}% auto`,
                }
              : undefined

            return (
              <li
                key={asset.id}
                className="media-item"
                title={asset.fileName}
                draggable={asset.durationFrames > 0}
                onDragStart={(event) => {
                  if (asset.durationFrames <= 0) return
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
                  data-testid={`media-thumbnail-${asset.id}`}
                  data-state={filmstrip ? 'ready' : 'placeholder'}
                  style={thumbnailStyle}
                  aria-hidden="true"
                >
                  {!filmstrip && (
                    <svg
                      className="media-thumbnail-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <rect x="3" y="5" width="13" height="14" rx="2" />
                      <path d="m16 10 5-3v10l-5-3" />
                    </svg>
                  )}
                </div>

                <div className="media-details">
                  <span className="media-name">{asset.fileName}</span>
                  <span className="media-meta">
                    {formatAssetMetadata(asset, documentFrameRate)}
                  </span>
                </div>

                <button
                  className="media-remove"
                  type="button"
                  draggable={false}
                  aria-label={`remove ${asset.fileName}`}
                  onDragStart={(event) => event.stopPropagation()}
                  onClick={() => {
                    if (assetIsUsedOnTimeline(asset.id)) {
                      window.alert(
                        'Remove this media\'s clips from the timeline before removing its source.',
                      )
                      return
                    }
                    forgetImportedMediaHandle(asset.id)
                    removeAsset(asset.id)
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
    </div>
  )
}
