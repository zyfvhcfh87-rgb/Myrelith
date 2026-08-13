/** Program Monitor point/box picker; selection is ephemeral and never history. */

import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import { clipVisualSettings } from '../domain/clipInspector'
import { findClip } from '../domain/selectors'
import type { Clip, TimelineDoc } from '../domain/schema'
import { rangeEnd } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { useTransportStore } from '../state/transportStore'

interface Viewport {
  left: number
  top: number
  width: number
  height: number
  clientLeft: number
  clientTop: number
}

interface SourceFacts {
  clip: Clip
  width: number
  height: number
}

function measureViewport(canvas: HTMLCanvasElement, panel: HTMLDivElement): Viewport | null {
  const canvasRect = canvas.getBoundingClientRect()
  const panelRect = panel.getBoundingClientRect()
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return null
  return {
    left: canvasRect.left - panelRect.left,
    top: canvasRect.top - panelRect.top,
    width: canvasRect.width,
    height: canvasRect.height,
    clientLeft: canvasRect.left,
    clientTop: canvasRect.top,
  }
}

function sourceFacts(
  doc: TimelineDoc,
  sourceClipId: string | null,
  playheadFrame: number,
  descriptors: ReturnType<typeof useMediaStore.getState>['descriptors'],
): SourceFacts | null {
  if (!sourceClipId) return null
  const clip = findClip(doc, sourceClipId)
  const descriptor = clip ? descriptors.get(clip.assetId) : null
  if (
    !clip
    || clip.text
    || playheadFrame < clip.timelineRange.startFrame
    || playheadFrame >= rangeEnd(clip.timelineRange)
    || !descriptor
    || descriptor.kind !== 'video'
    || !descriptor.width
    || !descriptor.height
  ) return null
  return {
    clip: resolveClipAnimationAtFrame(clip, playheadFrame),
    width: descriptor.width,
    height: descriptor.height,
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function sourcePoint(
  event: PointerEvent<HTMLButtonElement>,
  viewport: Viewport,
  doc: TimelineDoc,
  source: SourceFacts,
): { x: number; y: number } {
  const documentX = (event.clientX - viewport.clientLeft) * doc.width / viewport.width
  const documentY = (event.clientY - viewport.clientTop) * doc.height / viewport.height
  const transform = source.clip.transform
  const visual = clipVisualSettings(source.clip)
  const anchorX = transform.anchorX * source.width
  const anchorY = transform.anchorY * source.height
  const canvasAnchorX = (doc.width - source.width) / 2 + anchorX + transform.x
  const canvasAnchorY = (doc.height - source.height) / 2 + anchorY + transform.y
  const deltaX = documentX - canvasAnchorX
  const deltaY = documentY - canvasAnchorY
  const angle = transform.rotation * Math.PI / 180
  const rotatedX = Math.cos(angle) * deltaX + Math.sin(angle) * deltaY
  const rotatedY = -Math.sin(angle) * deltaX + Math.cos(angle) * deltaY
  const fullX = anchorX + rotatedX / transform.scaleX * (visual.flipHorizontal ? -1 : 1)
  const fullY = anchorY + rotatedY / transform.scaleY * (visual.flipVertical ? -1 : 1)
  return {
    x: clamp(fullX / source.width, visual.crop.left, 1 - visual.crop.right),
    y: clamp(fullY / source.height, visual.crop.top, 1 - visual.crop.bottom),
  }
}

function documentPoint(
  normalized: { x: number; y: number },
  doc: TimelineDoc,
  source: SourceFacts,
): { x: number; y: number } {
  const transform = source.clip.transform
  const visual = clipVisualSettings(source.clip)
  const anchorX = transform.anchorX * source.width
  const anchorY = transform.anchorY * source.height
  const localX = (normalized.x * source.width - anchorX)
    * transform.scaleX * (visual.flipHorizontal ? -1 : 1)
  const localY = (normalized.y * source.height - anchorY)
    * transform.scaleY * (visual.flipVertical ? -1 : 1)
  const angle = transform.rotation * Math.PI / 180
  return {
    x: (doc.width - source.width) / 2 + anchorX + transform.x
      + Math.cos(angle) * localX - Math.sin(angle) * localY,
    y: (doc.height - source.height) / 2 + anchorY + transform.y
      + Math.sin(angle) * localX + Math.cos(angle) * localY,
  }
}

export default function MotionTrackingOverlay({
  canvasRef,
  panelRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  panelRef: RefObject<HTMLDivElement | null>
}) {
  const doc = useDocumentStore((state) => state.doc)
  const descriptors = useMediaStore((state) => state.descriptors)
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const sourceClipId = useMotionTrackingSelectionStore((state) => state.sourceClipId)
  const pickingKind = useMotionTrackingSelectionStore((state) => state.pickingKind)
  const selection = useMotionTrackingSelectionStore((state) => state.selection)
  const selectionGlobalFrame = useMotionTrackingSelectionStore((state) => state.selectionGlobalFrame)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const dragStart = useRef<{ x: number; y: number; frame: number } | null>(null)
  const selectionOnDisplayedFrame = !selection
    || selectionGlobalFrame === playheadFrame
  const source = useMemo(
    () => sourceFacts(doc, sourceClipId, playheadFrame, descriptors),
    [descriptors, doc, playheadFrame, sourceClipId],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const panel = panelRef.current
    if (!canvas || !panel) return
    const measure = () => setViewport(measureViewport(canvas, panel))
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(canvas)
    observer?.observe(panel)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [canvasRef, panelRef])

  if (
    !viewport
    || !source
    || !selectionOnDisplayedFrame
    || (!pickingKind && !selection)
  ) return null
  const scaleX = viewport.width / doc.width
  const scaleY = viewport.height / doc.height
  const marker = selection?.kind === 'point'
    ? (() => {
        const point = documentPoint(selection.point, doc, source)
        return {
          left: viewport.left + point.x * scaleX,
          top: viewport.top + point.y * scaleY,
        }
      })()
    : null
  const boxPolygon = selection?.kind === 'box'
    ? (() => {
        return [
          { x: selection.box.x, y: selection.box.y },
          { x: selection.box.x + selection.box.width, y: selection.box.y },
          { x: selection.box.x + selection.box.width, y: selection.box.y + selection.box.height },
          { x: selection.box.x, y: selection.box.y + selection.box.height },
        ].map((point) => documentPoint(point, doc, source))
          .map((point) => `${point.x * scaleX},${point.y * scaleY}`)
          .join(' ')
      })()
    : null

  const finishBox = (event: PointerEvent<HTMLButtonElement>): void => {
    const start = dragStart.current
    dragStart.current = null
    if (!start || !sourceClipId || start.frame !== playheadFrame) return
    const end = sourcePoint(event, viewport, doc, source)
    const box = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    }
    if (box.width > 0 && box.height > 0) {
      useMotionTrackingSelectionStore.getState().setSelection(
        sourceClipId,
        { kind: 'box', box },
        playheadFrame,
      )
    }
  }

  return (
    <div className="motion-tracking-overlay" aria-label="Motion tracking selection overlay">
      {marker ? <div className="motion-tracking-point" style={marker} aria-hidden="true" /> : null}
      {boxPolygon ? (
        <svg
          className="motion-tracking-box"
          style={{
            left: viewport.left,
            top: viewport.top,
            width: viewport.width,
            height: viewport.height,
          }}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          aria-hidden="true"
        >
          <polygon points={boxPolygon} />
        </svg>
      ) : null}
      {pickingKind ? (
        <button
          type="button"
          className="motion-tracking-pick-surface"
          aria-label={pickingKind === 'point'
            ? 'Choose a point to track in the source clip'
            : 'Drag a box to track in the source clip'}
          style={{ left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height }}
          onPointerDown={(event) => {
            const point = sourcePoint(event, viewport, doc, source)
            if (pickingKind === 'point' && sourceClipId) {
              useMotionTrackingSelectionStore.getState().setSelection(
                sourceClipId,
                { kind: 'point', point },
                playheadFrame,
              )
            } else {
              dragStart.current = { ...point, frame: playheadFrame }
              event.currentTarget.setPointerCapture(event.pointerId)
            }
          }}
          onPointerUp={finishBox}
          onPointerCancel={() => { dragStart.current = null }}
        />
      ) : null}
    </div>
  )
}
