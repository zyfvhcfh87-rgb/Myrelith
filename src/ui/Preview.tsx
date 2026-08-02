/**
 * ui/Preview.tsx — Program monitor. Phase 3.4.
 *
 * A dumb canvas: pixels are painted by the decode worker (the canvas is
 * transferred on first mount), scrubbing is driven by app/previewController
 * reacting to transportStore. This component only (1) hands the canvas to
 * the controller once and (2) shows a hint until a visual asset is loaded.
 * It never imports engine/pipeline/workers (the controller is the facade).
 */

import { useEffect, useRef } from 'react'
import { initPreview } from '../app/previewController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import TextOverlayControls from './TextOverlayControls'

export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const hasTextOverlay = useDocumentStore((state) =>
    state.doc.tracks.some((track) => track.clips.some((clip) => clip.text !== undefined)),
  )
  const hasLoadedVisual = useMediaStore((s) => {
    for (const asset of s.assets.values()) {
      if (asset.kind === 'video' && asset.frameRate) return true
      if (asset.kind === 'image') return true
    }
    return false
  })
  const hasVisualDescriptor = useMediaStore((s) => {
    for (const descriptor of s.descriptors.values()) {
      if (descriptor.kind === 'video' || descriptor.kind === 'image') return true
    }
    return false
  })
  const offlineVisualAssetIds = usePreviewStatusStore(
    (state) => state.offlineVisualAssetIds,
  )
  const offlineFileNames = useMediaStore((state) => (
    offlineVisualAssetIds
      .map((id) => state.descriptors.get(id)?.fileName)
      .filter((name): name is string => name !== undefined)
      .join(', ')
  ))

  // initPreview is idempotent per canvas — StrictMode double-mount safe.
  useEffect(() => {
    if (canvasRef.current) initPreview(canvasRef.current)
  }, [])

  return (
    <div className="preview-panel" ref={panelRef}>
      <canvas
        ref={canvasRef}
        className="preview-canvas"
        data-testid="preview-canvas"
      />
      <TextOverlayControls canvasRef={canvasRef} panelRef={panelRef} />
      {offlineVisualAssetIds.length > 0 ? (
        <div className="preview-hint preview-hint-offline" role="status">
          <strong>Source offline</strong>
          <span>
            Reconnect {offlineFileNames || 'this source'} in the Media panel.
          </span>
        </div>
      ) : !hasVisualDescriptor && !hasTextOverlay ? (
        <div className="preview-hint">
          import a video or still image in the Media Pool to preview it here
        </div>
      ) : hasVisualDescriptor && !hasLoadedVisual ? (
        <div className="preview-hint preview-hint-offline" role="status">
          Visual sources are offline. Reconnect them in the Media panel.
        </div>
      ) : null}
    </div>
  )
}
