/**
 * ui/MediaPool.tsx — Import + asset list. Phase 3.4.
 *
 * Importing only calls mediaStore.addAsset(file); the preview controller
 * watches the store and does the demux/preview side effects. Real metadata
 * (dimensions, duration) appears on each row once demuxing fills it in.
 */

import { useMediaStore } from '../state/mediaStore'
import { formatTimecode } from '../domain/time'

export default function MediaPool() {
  const assets = useMediaStore((s) => s.assets)
  const addAsset = useMediaStore((s) => s.addAsset)
  const removeAsset = useMediaStore((s) => s.removeAsset)

  return (
    <div className="media-pool">
      <label className="media-import">
        <input
          type="file"
          accept="video/*,.mp4,.mov,.mkv,.webm"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) addAsset(file)
            e.target.value = '' // allow re-importing the same file
          }}
        />
      </label>

      {assets.size === 0 ? (
        <p className="media-empty">no media yet — import a video file</p>
      ) : (
        <ul className="media-list">
          {[...assets.values()].map((asset) => (
            <li key={asset.id} className="media-item" title={asset.fileName}>
              <span className="media-name">{asset.fileName}</span>
              <span className="media-meta">
                {asset.frameRate
                  ? `${asset.width}×${asset.height} · ${formatTimecode(
                      asset.durationFrames,
                      asset.frameRate,
                    )}`
                  : 'analyzing…'}
              </span>
              <button
                className="media-remove"
                aria-label={`remove ${asset.fileName}`}
                onClick={() => removeAsset(asset.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
