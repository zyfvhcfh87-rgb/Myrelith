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

export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasLoadedVideo = useMediaStore((s) => {
    for (const asset of s.assets.values()) {
      if (asset.kind === 'video' && asset.frameRate) return true
    }
    return false
  })

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
      {!hasLoadedVideo && (
        <div className="preview-hint">
          import a video in the Media Pool to preview it here
        </div>
      )}
    </div>
  )
}
