/**
 * ui/Preview.tsx — Program monitor. Phase 3.4.
 *
 * A dumb canvas: pixels are painted by the decode worker (the canvas is
 * transferred on first mount), scrubbing is driven by app/previewController
 * reacting to transportStore. This component only (1) hands the canvas to
 * the controller once and (2) shows a hint until a video asset is loaded.
 * It never imports engine/pipeline/workers (the controller is the facade).
 */

import { useEffect, useRef } from 'react'
import { initPreview } from '../app/previewController'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'

export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasLoadedVideo = useMediaStore((s) => {
    for (const asset of s.assets.values()) {
      if (asset.kind === 'video' && asset.frameRate) return true
    }
    return false
  })
  const hasVideoDescriptor = useMediaStore((s) => {
    for (const descriptor of s.descriptors.values()) {
      if (descriptor.kind === 'video') return true
    }
    return false
  })
  const offlineVideoAssetIds = usePreviewStatusStore(
    (state) => state.offlineVideoAssetIds,
  )
  const offlineFileNames = useMediaStore((state) => (
    offlineVideoAssetIds
      .map((id) => state.descriptors.get(id)?.fileName)
      .filter((name): name is string => name !== undefined)
      .join(', ')
  ))

  // initPreview is idempotent per canvas — StrictMode double-mount safe.
  useEffect(() => {
    if (canvasRef.current) initPreview(canvasRef.current)
  }, [])

  return (
    <div className="preview-panel">
      <canvas
        ref={canvasRef}
        className="preview-canvas"
        data-testid="preview-canvas"
      />
      {offlineVideoAssetIds.length > 0 ? (
        <div className="preview-hint preview-hint-offline" role="status">
          <strong>Source offline</strong>
          <span>
            Reconnect {offlineFileNames || 'this video'} in the Media panel.
          </span>
        </div>
      ) : !hasVideoDescriptor ? (
        <div className="preview-hint">
          import a video in the Media Pool to preview it here
        </div>
      ) : !hasLoadedVideo ? (
        <div className="preview-hint preview-hint-offline" role="status">
          Video sources are offline. Reconnect them in the Media panel.
        </div>
      ) : null}
    </div>
  )
}
