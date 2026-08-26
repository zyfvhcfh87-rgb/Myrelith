/**
 * ui/Preview.tsx — Program monitor. Phase 3.4.
 *
 * A dumb canvas: pixels are painted by the decode worker (the canvas is
 * transferred on first mount), scrubbing is driven by app/previewController
 * reacting to transportStore. This component hands the canvas and measured
 * monitor viewport to the controller, exposes the session-only quality mode,
 * and shows a hint until visual content is available. It never imports
 * engine/pipeline/workers (the controller is the facade).
 */

import { useEffect, useRef } from 'react'
import {
  initPreview,
  setPreviewViewport,
  setVideoScopesEnabled,
} from '../app/previewController'
import type { PresentationQualityMode } from '../domain/presentationProfile'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { usePreviewQualityStore } from '../state/previewQualityStore'
import { useProxyStore } from '../state/proxyStore'
import { useVideoScopesStore } from '../state/videoScopesStore'
import TextOverlayControls from './TextOverlayControls'
import VideoScopesPanel from './VideoScopesPanel'
import VisualOverlayControls from './VisualOverlayControls'
import MotionTrackingOverlay from './MotionTrackingOverlay'
import { focusProgramMonitor } from '../app/sequenceEditController'

export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const docWidth = useDocumentStore((state) => state.doc.width)
  const docHeight = useDocumentStore((state) => state.doc.height)
  const qualityMode = usePreviewQualityStore((state) => state.qualityMode)
  const setQualityMode = usePreviewQualityStore((state) => state.setQualityMode)
  const scopesEnabled = useVideoScopesStore((state) => state.enabled)
  const scopesSupported = useVideoScopesStore((state) => state.rendererSupported)
  const hasTextOverlay = useDocumentStore((state) =>
    state.doc.tracks.some((track) => track.clips.some((clip) => clip.text !== undefined)),
  )
  const hasVisibleCaption = useDocumentStore((state) =>
    (state.doc.captionTracks ?? []).some(
      (track) => !track.hidden && track.items.length > 0,
    ),
  )
  const hasLoadedVisual = useMediaStore((s) => {
    for (const asset of s.assets.values()) {
      if (asset.kind === 'video' && asset.frameRate) return true
      if (asset.kind === 'image') return true
    }
    return false
  })
  const mediaDescriptors = useMediaStore((state) => state.descriptors)
  const hasVisualDescriptor = [...mediaDescriptors.values()].some(
    (descriptor) => descriptor.kind === 'video' || descriptor.kind === 'image',
  )
  const hasLoadedProxy = useProxyStore((state) => {
    for (const item of state.assets.values()) {
      if (
        item.phase === 'ready'
        && item.entry !== null
        && mediaDescriptors.get(item.assetId)?.kind === 'video'
      ) return true
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

  useEffect(() => {
    const canvas = canvasRef.current
    const panel = panelRef.current
    if (!canvas || !panel) return

    const publish = () => {
      const styles = getComputedStyle(panel)
      const availableWidth = panel.clientWidth
        - Number.parseFloat(styles.paddingLeft || '0')
        - Number.parseFloat(styles.paddingRight || '0')
      const availableHeight = panel.clientHeight
        - Number.parseFloat(styles.paddingTop || '0')
        - Number.parseFloat(styles.paddingBottom || '0')
      if (availableWidth <= 0 || availableHeight <= 0) {
        setPreviewViewport(null)
        return
      }
      const displayScale = Math.min(
        availableWidth / docWidth,
        availableHeight / docHeight,
      )
      const widthCssPx = Math.max(1, Math.floor(docWidth * displayScale))
      const heightCssPx = Math.max(1, Math.floor(docHeight * displayScale))
      canvas.style.width = `${widthCssPx}px`
      canvas.style.height = `${heightCssPx}px`
      setPreviewViewport({
        widthCssPx,
        heightCssPx,
        devicePixelRatio: window.devicePixelRatio || 1,
      })
    }

    publish()
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(publish)
      : null
    observer?.observe(panel)
    window.addEventListener('resize', publish)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', publish)
    }
  }, [docHeight, docWidth])

  return (
    <div
      className="preview-panel"
      ref={panelRef}
      onPointerDown={focusProgramMonitor}
    >
      <button
        type="button"
        className="preview-scopes-toggle"
        aria-pressed={scopesEnabled}
        disabled={!scopesEnabled && scopesSupported === false}
        onClick={() => setVideoScopesEnabled(!scopesEnabled)}
      >
        {scopesSupported === false ? 'Scopes unavailable' : 'Scopes'}
      </button>
      <label className="preview-quality-control">
        <span>Quality</span>
        <select
          aria-label="Preview quality"
          value={qualityMode}
          onChange={(event) => {
            setQualityMode(event.currentTarget.value as PresentationQualityMode)
          }}
        >
          <option value="auto">Auto</option>
          <option value="full">Full</option>
          <option value="half">Half</option>
          <option value="quarter">Quarter</option>
        </select>
      </label>
      <canvas
        ref={canvasRef}
        className="preview-canvas"
        data-testid="preview-canvas"
      />
      <VisualOverlayControls canvasRef={canvasRef} panelRef={panelRef} />
      <MotionTrackingOverlay canvasRef={canvasRef} panelRef={panelRef} />
      <TextOverlayControls canvasRef={canvasRef} panelRef={panelRef} />
      {scopesEnabled ? <VideoScopesPanel /> : null}
      {offlineVisualAssetIds.length > 0 ? (
        <div className="preview-hint preview-hint-offline" role="status">
          <strong>Source offline</strong>
          <span>
            Reconnect {offlineFileNames || 'this source'} in the Media panel.
          </span>
        </div>
      ) : !hasVisualDescriptor && !hasTextOverlay && !hasVisibleCaption ? (
        <div className="preview-hint">
          import a video or still image in the Media Pool to preview it here
        </div>
      ) : hasVisualDescriptor && !hasLoadedVisual && !hasLoadedProxy ? (
        <div className="preview-hint preview-hint-offline" role="status">
          Visual sources are offline. Reconnect them in the Media panel.
        </div>
      ) : null}
    </div>
  )
}
