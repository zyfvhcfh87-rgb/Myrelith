/** Program Monitor point/box picker; selection is ephemeral and never history. */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import { clipVisualSettings } from '../domain/clipInspector'
import { findClip } from '../domain/selectors'
import type { Clip, TimelineDoc } from '../domain/schema'
import { rangeEnd } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import type { MotionTrackingSelection } from '../domain/motionTracking'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { useTransportStore } from '../state/transportStore'

const KEYBOARD_STEP = 0.02
const KEYBOARD_LARGE_STEP = 0.1

function defaultDraft(kind: 'point' | 'box'): MotionTrackingSelection {
  return kind === 'point'
    ? { kind: 'point', point: { x: 0.5, y: 0.5 } }
    : { kind: 'box', box: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }
}

function clampDraft(
  draft: MotionTrackingSelection,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): MotionTrackingSelection {
  if (draft.kind === 'point') {
    return {
      kind: 'point',
      point: {
        x: clamp(draft.point.x, minX, maxX),
        y: clamp(draft.point.y, minY, maxY),
      },
    }
  }
  const width = Math.min(draft.box.width, maxX - minX)
  const height = Math.min(draft.box.height, maxY - minY)
  return {
    kind: 'box',
    box: {
      x: clamp(draft.box.x, minX, maxX - width),
      y: clamp(draft.box.y, minY, maxY - height),
      width,
      height,
    },
  }
}

function moveDraft(
  draft: MotionTrackingSelection,
  deltaX: number,
  deltaY: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): MotionTrackingSelection {
  if (draft.kind === 'point') {
    return clampDraft({
      kind: 'point',
      point: { x: draft.point.x + deltaX, y: draft.point.y + deltaY },
    }, minX, maxX, minY, maxY)
  }
  return clampDraft({
    kind: 'box',
    box: {
      ...draft.box,
      x: draft.box.x + deltaX,
      y: draft.box.y + deltaY,
    },
  }, minX, maxX, minY, maxY)
}

function resizeDraft(
  draft: MotionTrackingSelection,
  deltaX: number,
  deltaY: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): MotionTrackingSelection {
  if (draft.kind !== 'box') return draft
  const width = Math.max(0.02, draft.box.width + deltaX)
  const height = Math.max(0.02, draft.box.height + deltaY)
  return clampDraft({
    kind: 'box',
    box: { ...draft.box, width, height },
  }, minX, maxX, minY, maxY)
}

function describeDraft(draft: MotionTrackingSelection): string {
  if (draft.kind === 'point') {
    return `Point at ${Math.round(draft.point.x * 100)}% x, ${Math.round(draft.point.y * 100)}% y`
  }
  return `Box at ${Math.round(draft.box.x * 100)}% x, ${Math.round(draft.box.y * 100)}% y, ${Math.round(draft.box.width * 100)}% by ${Math.round(draft.box.height * 100)}%`
}

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
    || (clip.lensCorrection ?? null) !== null
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
  const [keyboardDraft, setKeyboardDraft] = useState<MotionTrackingSelection | null>(null)
  const dragStart = useRef<{ x: number; y: number; frame: number } | null>(null)
  const selectionOnDisplayedFrame = !selection
    || selectionGlobalFrame === playheadFrame
  const source = useMemo(
    () => sourceFacts(doc, sourceClipId, playheadFrame, descriptors),
    [descriptors, doc, playheadFrame, sourceClipId],
  )

  useEffect(() => {
    setKeyboardDraft(pickingKind ? defaultDraft(pickingKind) : null)
  }, [pickingKind])

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
  const displayedSelection = selection ?? keyboardDraft
  const marker = displayedSelection?.kind === 'point'
    ? (() => {
        const point = documentPoint(displayedSelection.point, doc, source)
        return {
          left: viewport.left + point.x * scaleX,
          top: viewport.top + point.y * scaleY,
        }
      })()
    : null
  const boxPolygon = displayedSelection?.kind === 'box'
    ? (() => {
        return [
          { x: displayedSelection.box.x, y: displayedSelection.box.y },
          { x: displayedSelection.box.x + displayedSelection.box.width, y: displayedSelection.box.y },
          { x: displayedSelection.box.x + displayedSelection.box.width, y: displayedSelection.box.y + displayedSelection.box.height },
          { x: displayedSelection.box.x, y: displayedSelection.box.y + displayedSelection.box.height },
        ].map((point) => documentPoint(point, doc, source))
          .map((point) => `${point.x * scaleX},${point.y * scaleY}`)
          .join(' ')
      })()
    : null
  const visual = clipVisualSettings(source.clip)
  const cropMinX = visual.crop.left
  const cropMaxX = 1 - visual.crop.right
  const cropMinY = visual.crop.top
  const cropMaxY = 1 - visual.crop.bottom

  const confirmDraft = (draft: MotionTrackingSelection | null): void => {
    if (!draft || !sourceClipId) return
    if (draft.kind === 'box' && (draft.box.width <= 0 || draft.box.height <= 0)) return
    useMotionTrackingSelectionStore.getState().setSelection(
      sourceClipId,
      draft,
      playheadFrame,
    )
  }

  const handlePickKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      useMotionTrackingSelectionStore.getState().cancelPicking()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      confirmDraft(keyboardDraft)
      return
    }
    if (!keyboardDraft) return
    const step = event.shiftKey && keyboardDraft.kind === 'point'
      ? KEYBOARD_LARGE_STEP
      : KEYBOARD_STEP
    let next: MotionTrackingSelection | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      next = event.shiftKey && keyboardDraft.kind === 'box'
        ? resizeDraft(keyboardDraft, deltaX, deltaY, cropMinX, cropMaxX, cropMinY, cropMaxY)
        : moveDraft(keyboardDraft, deltaX, deltaY, cropMinX, cropMaxX, cropMinY, cropMaxY)
    }
    if (next) setKeyboardDraft(next)
  }

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
          aria-describedby="motion-tracking-pick-help"
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Escape"
          style={{ left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height }}
          onClick={(event) => {
            if (event.detail !== 0) return
            confirmDraft(keyboardDraft)
          }}
          onKeyDown={handlePickKeyDown}
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
      {pickingKind ? (
        <>
          <span id="motion-tracking-pick-help" className="visually-hidden">
            {pickingKind === 'point'
              ? 'Arrow keys move the point. Shift+arrow moves farther. Enter or Space confirms. Escape cancels.'
              : 'Arrow keys move the box. Shift+arrow resizes. Enter or Space confirms. Escape cancels.'}
          </span>
          <span className="visually-hidden" aria-live="polite">
            {keyboardDraft ? describeDraft(keyboardDraft) : ''}
          </span>
        </>
      ) : null}
    </div>
  )
}
