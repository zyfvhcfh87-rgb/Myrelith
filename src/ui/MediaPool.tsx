/**
 * ui/MediaPool.tsx — Import + thumbnail asset cards.
 *
 * Importing only calls mediaStore.addAsset(file); the existing controllers
 * fill metadata and generate the full-source filmstrip in the background.
 * This UI crops the filmstrip's first tile as a representative thumbnail.
 * Rows become draggable only after demuxing supplies a real duration.
 */

import { formatTimecode } from '../domain/time'
import { useMediaStore } from '../state/mediaStore'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'

export default function MediaPool() {
  const assets = useMediaStore((state) => state.assets)
  const visuals = useMediaStore((state) => state.visuals)
  const addAsset = useMediaStore((state) => state.addAsset)
  const removeAsset = useMediaStore((state) => state.removeAsset)

  return (
    <div className="media-pool">
      <div className="media-pool-header">
        <h2 className="media-pool-title">Media</h2>
        <label className="media-import">
          <span aria-hidden="true">+</span>
          <span>Import</span>
          <input
            className="media-import-input"
            aria-label="Import media"
            type="file"
            accept="video/*,.mp4,.mov,.mkv,.webm"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) addAsset(file)
              event.target.value = ''
            }}
          />
        </label>
      </div>

      {assets.size === 0 ? (
        <p className="media-empty">no media yet — import a video file</p>
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
                    {asset.frameRate
                      ? `${asset.width}×${asset.height} · ${formatTimecode(
                          asset.durationFrames,
                          asset.frameRate,
                        )}`
                      : 'analyzing…'}
                  </span>
                </div>

                <button
                  className="media-remove"
                  type="button"
                  draggable={false}
                  aria-label={`remove ${asset.fileName}`}
                  onDragStart={(event) => event.stopPropagation()}
                  onClick={() => removeAsset(asset.id)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
