import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import {
  MAX_CLIP_SCALE,
  MAX_CROP_SUM,
  clipVisualSettings,
} from '../domain/clipInspector'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import type { ClipVisualPatch } from '../domain/operations'
import { findClip, trackOfClip } from '../domain/selectors'
import type {
  Clip,
  ClipVisualSettings,
  CropInsets,
  TimelineDoc,
  Transform,
} from '../domain/schema'
import { rangeEnd } from '../domain/time'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  useTransportStore,
  type ClipVisualPreview,
} from '../state/transportStore'

interface Viewport {
  left: number
  top: number
  width: number
  height: number
  clientLeft: number
  clientTop: number
}

type CropEdge = keyof CropInsets
type ScaleCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
type GestureKind =
  | 'move'
  | 'rotate'
  | 'anchor'
  | `scale-${ScaleCorner}`
  | `crop-${CropEdge}`

interface Gesture {
  clipId: string
  document: TimelineDoc
  timelineFrame: number
  kind: GestureKind
  startClientX: number
  startClientY: number
  startPointerAngle: number
  viewport: Viewport
  sourceWidth: number
  sourceHeight: number
  scaleVector: { x: number; y: number }
  transform: Transform
  visual: ClipVisualSettings
  latest: ClipVisualPreview
}

interface ActiveVisualClip {
  clip: Clip
  descriptor: PortableAssetDescriptor
  locked: boolean
  sourceWidth: number
  sourceHeight: number
}

const MIN_EDITABLE_SCALE = 0.01
const SCALE_CORNERS: readonly ScaleCorner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function measureViewport(
  canvas: HTMLCanvasElement | null,
  panel: HTMLDivElement | null,
): Viewport | null {
  if (!canvas || !panel) return null
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

function activeVisualClips(
  doc: TimelineDoc,
  descriptors: ReadonlyMap<string, PortableAssetDescriptor>,
  frame: number,
): ActiveVisualClip[] {
  const clips: ActiveVisualClip[] = []
  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      if (
        clip.text
        || frame < clip.timelineRange.startFrame
        || frame >= rangeEnd(clip.timelineRange)
      ) continue
      const descriptor = descriptors.get(clip.assetId)
      if (
        !descriptor
        || (descriptor.kind !== 'video' && descriptor.kind !== 'image')
        || descriptor.width === null
        || descriptor.height === null
        || descriptor.width <= 0
        || descriptor.height <= 0
      ) continue
      const resolvedClip = resolveClipAnimationAtFrame(clip, frame)
      if (resolvedClip.opacity <= 0) continue
      clips.push({
        clip: resolvedClip,
        descriptor,
        locked: track.locked,
        sourceWidth: descriptor.width,
        sourceHeight: descriptor.height,
      })
    }
  }
  return clips
}

function previewFromClip(clip: Clip): ClipVisualPreview {
  const visual = clipVisualSettings(clip)
  return {
    clipId: clip.id,
    transform: { ...clip.transform },
    visual: { ...visual, crop: { ...visual.crop } },
  }
}

function scaleVectorForCorner(
  transform: Transform,
  visual: ClipVisualSettings,
  width: number,
  height: number,
  corner: ScaleCorner,
): { x: number; y: number } {
  const left = visual.crop.left * width
  const right = (1 - visual.crop.right) * width
  const top = visual.crop.top * height
  const bottom = (1 - visual.crop.bottom) * height
  const anchorX = transform.anchorX * width
  const anchorY = transform.anchorY * height
  return {
    x: (corner.endsWith('left') ? left : right) - anchorX,
    y: (corner.startsWith('top') ? top : bottom) - anchorY,
  }
}

function pointerAngle(
  event: PointerEvent<HTMLButtonElement>,
  viewport: Viewport,
  doc: TimelineDoc,
  transform: Transform,
): number {
  const x = (event.clientX - viewport.clientLeft) * doc.width / viewport.width
    - doc.width / 2
  const y = (event.clientY - viewport.clientTop) * doc.height / viewport.height
    - doc.height / 2
  return Math.atan2(y - transform.y, x - transform.x)
}

function normalizedAngleDelta(angle: number): number {
  let delta = angle
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

function documentDelta(
  gesture: Gesture,
  event: PointerEvent<HTMLButtonElement>,
): { x: number; y: number } {
  return {
    x: (event.clientX - gesture.startClientX)
      * gesture.document.width / gesture.viewport.width,
    y: (event.clientY - gesture.startClientY)
      * gesture.document.height / gesture.viewport.height,
  }
}

function localDelta(
  gesture: Gesture,
  event: PointerEvent<HTMLButtonElement>,
  divideByScale: boolean,
): { x: number; y: number } {
  const delta = documentDelta(gesture, event)
  const angle = gesture.transform.rotation * Math.PI / 180
  const rotatedX = Math.cos(angle) * delta.x + Math.sin(angle) * delta.y
  const rotatedY = -Math.sin(angle) * delta.x + Math.cos(angle) * delta.y
  const flipX = gesture.visual.flipHorizontal ? -1 : 1
  const flipY = gesture.visual.flipVertical ? -1 : 1
  return {
    x: rotatedX * flipX / (divideByScale
      ? Math.max(gesture.transform.scaleX, 0.0001)
      : 1),
    y: rotatedY * flipY / (divideByScale
      ? Math.max(gesture.transform.scaleY, 0.0001)
      : 1),
  }
}

function sourceVectorToDocument(
  x: number,
  y: number,
  transform: Transform,
  visual: ClipVisualSettings,
): { x: number; y: number } {
  const scaledX = x * transform.scaleX * (visual.flipHorizontal ? -1 : 1)
  const scaledY = y * transform.scaleY * (visual.flipVertical ? -1 : 1)
  const angle = transform.rotation * Math.PI / 180
  return {
    x: Math.cos(angle) * scaledX - Math.sin(angle) * scaledY,
    y: Math.sin(angle) * scaledX + Math.cos(angle) * scaledY,
  }
}

function cropWithEdge(
  crop: CropInsets,
  edge: CropEdge,
  delta: number,
): CropInsets {
  const opposite: Record<CropEdge, CropEdge> = {
    left: 'right',
    right: 'left',
    top: 'bottom',
    bottom: 'top',
  }
  return {
    ...crop,
    [edge]: clamp(crop[edge] + delta, 0, MAX_CROP_SUM - crop[opposite[edge]]),
  }
}

function previewForGesture(
  gesture: Gesture,
  event: PointerEvent<HTMLButtonElement>,
): ClipVisualPreview {
  let transform = { ...gesture.transform }
  let visual = { ...gesture.visual, crop: { ...gesture.visual.crop } }

  if (gesture.kind === 'move') {
    const delta = documentDelta(gesture, event)
    transform.x += delta.x
    transform.y += delta.y
  } else if (gesture.kind.startsWith('scale-')) {
    const delta = localDelta(gesture, event, false)
    if (visual.scaleLocked) {
      const vector = gesture.scaleVector
      const denominator = vector.x * vector.x + vector.y * vector.y
      const scaleDelta = denominator > 0
        ? (delta.x * vector.x + delta.y * vector.y) / denominator
        : 0
      const scale = clamp(transform.scaleX + scaleDelta, MIN_EDITABLE_SCALE, MAX_CLIP_SCALE)
      transform.scaleX = scale
      transform.scaleY = scale
    } else {
      transform.scaleX = clamp(
        transform.scaleX + (gesture.scaleVector.x === 0
          ? 0
          : delta.x / gesture.scaleVector.x),
        MIN_EDITABLE_SCALE,
        MAX_CLIP_SCALE,
      )
      transform.scaleY = clamp(
        transform.scaleY + (gesture.scaleVector.y === 0
          ? 0
          : delta.y / gesture.scaleVector.y),
        MIN_EDITABLE_SCALE,
        MAX_CLIP_SCALE,
      )
    }
  } else if (gesture.kind === 'rotate') {
    const nextAngle = pointerAngle(event, gesture.viewport, gesture.document, gesture.transform)
    const deltaDegrees = normalizedAngleDelta(nextAngle - gesture.startPointerAngle) * 180 / Math.PI
    const rotation = gesture.transform.rotation + deltaDegrees
    transform.rotation = event.shiftKey ? Math.round(rotation / 15) * 15 : rotation
  } else if (gesture.kind === 'anchor') {
    const delta = localDelta(gesture, event, true)
    const anchorX = clamp(
      gesture.transform.anchorX + delta.x / gesture.sourceWidth,
      0,
      1,
    )
    const anchorY = clamp(
      gesture.transform.anchorY + delta.y / gesture.sourceHeight,
      0,
      1,
    )
    const sourceDeltaX = (anchorX - gesture.transform.anchorX) * gesture.sourceWidth
    const sourceDeltaY = (anchorY - gesture.transform.anchorY) * gesture.sourceHeight
    const compensation = sourceVectorToDocument(
      sourceDeltaX,
      sourceDeltaY,
      gesture.transform,
      gesture.visual,
    )
    transform.anchorX = anchorX
    transform.anchorY = anchorY
    transform.x += compensation.x
    transform.y += compensation.y
  } else {
    const edge = gesture.kind.slice(5) as CropEdge
    const delta = localDelta(gesture, event, true)
    const sourceDelta = edge === 'left' || edge === 'right'
      ? delta.x / gesture.sourceWidth
      : delta.y / gesture.sourceHeight
    visual.crop = cropWithEdge(
      visual.crop,
      edge,
      edge === 'right' || edge === 'bottom' ? -sourceDelta : sourceDelta,
    )
  }

  return { clipId: gesture.clipId, transform, visual }
}

function currentEditableClip(clipId: string): Clip | null {
  const doc = useDocumentStore.getState().doc
  const track = trackOfClip(doc, clipId)
  if (!track || track.locked) return null
  const clip = findClip(doc, clipId)
  return clip
    ? resolveClipAnimationAtFrame(
        clip,
        useTransportStore.getState().playheadFrame,
      )
    : null
}

function updateVisualAtPlayhead(clipId: string, patch: ClipVisualPatch): void {
  const frame = useTransportStore.getState().playheadFrame
  useDocumentStore.getState().updateClipVisualAtFrame(clipId, frame, patch)
}

function gestureCommitPatch(gesture: Gesture): ClipVisualPatch {
  const { transform, visual } = gesture.latest
  if (gesture.kind === 'move') {
    return { transform: { x: transform.x, y: transform.y } }
  }
  if (gesture.kind.startsWith('scale-')) {
    return {
      transform: {
        scaleX: transform.scaleX,
        scaleY: transform.scaleY,
      },
    }
  }
  if (gesture.kind === 'rotate') {
    return { transform: { rotation: transform.rotation } }
  }
  if (gesture.kind === 'anchor') {
    return {
      transform: {
        x: transform.x,
        y: transform.y,
        anchorX: transform.anchorX,
        anchorY: transform.anchorY,
      },
    }
  }
  return { visual: { crop: { ...visual.crop } } }
}

export default function VisualOverlayControls({
  canvasRef,
  panelRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  panelRef: RefObject<HTMLDivElement | null>
}) {
  const doc = useDocumentStore((state) => state.doc)
  const descriptors = useMediaStore((state) => state.descriptors)
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const selectedClipId = useTransportStore((state) => state.selectedClipId)
  const draft = useTransportStore((state) => state.clipVisualPreview)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const previewFrameRef = useRef<number | null>(null)
  const pendingPreviewRef = useRef<ClipVisualPreview | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const panel = panelRef.current
    if (!canvas || !panel) return
    const measure = (): void => {
      setViewport(measureViewport(canvas, panel))
    }
    measure()
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure)
      : null
    observer?.observe(canvas)
    observer?.observe(panel)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [canvasRef, panelRef, doc.width, doc.height])

  useEffect(() => () => {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current)
    useTransportStore.getState().setOwnedClipVisualPreview('visual-gesture', null)
  }, [])

  const publishPreview = (preview: ClipVisualPreview): void => {
    pendingPreviewRef.current = preview
    if (previewFrameRef.current !== null) return
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null
      const pending = pendingPreviewRef.current
      if (pending) {
        useTransportStore.getState().setOwnedClipVisualPreview('visual-gesture', pending)
      }
    })
  }

  const flushPreview = (): void => {
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current)
      previewFrameRef.current = null
    }
    const pending = pendingPreviewRef.current
    if (pending) {
      useTransportStore.getState().setOwnedClipVisualPreview('visual-gesture', pending)
    }
  }

  const startGesture = (
    event: PointerEvent<HTMLButtonElement>,
    clipId: string,
    kind: GestureKind,
  ): void => {
    useTransportStore.getState().setSelectedClip(clipId)
    const latestDoc = useDocumentStore.getState().doc
    const durableClip = findClip(latestDoc, clipId)
    const timelineFrame = useTransportStore.getState().playheadFrame
    const clip = durableClip
      ? resolveClipAnimationAtFrame(durableClip, timelineFrame)
      : null
    const track = trackOfClip(latestDoc, clipId)
    const descriptor = clip ? useMediaStore.getState().descriptors.get(clip.assetId) : null
    const measured = measureViewport(canvasRef.current, panelRef.current)
    if (
      !clip
      || clip.text
      || !track
      || track.locked
      || !descriptor
      || descriptor.width === null
      || descriptor.height === null
      || descriptor.width <= 0
      || descriptor.height <= 0
      || !measured
    ) return
    setViewport(measured)
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const visual = clipVisualSettings(clip)
    const latest = previewFromClip(clip)
    const scaleCorner = kind.startsWith('scale-')
      ? kind.slice(6) as ScaleCorner
      : null
    gestureRef.current = {
      clipId,
      document: latestDoc,
      timelineFrame,
      kind,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPointerAngle: pointerAngle(event, measured, latestDoc, clip.transform),
      viewport: measured,
      sourceWidth: descriptor.width,
      sourceHeight: descriptor.height,
      scaleVector: scaleCorner
        ? scaleVectorForCorner(
            clip.transform,
            visual,
            descriptor.width,
            descriptor.height,
            scaleCorner,
          )
        : { x: 0, y: 0 },
      transform: { ...clip.transform },
      visual: { ...visual, crop: { ...visual.crop } },
      latest,
    }
    pendingPreviewRef.current = latest
  }

  const moveGesture = (event: PointerEvent<HTMLButtonElement>): void => {
    const gesture = gestureRef.current
    if (!gesture) return
    const preview = previewForGesture(gesture, event)
    gesture.latest = preview
    publishPreview(preview)
  }

  const finishGesture = (
    event: PointerEvent<HTMLButtonElement>,
    commit: boolean,
  ): void => {
    const gesture = gestureRef.current
    if (!gesture) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    flushPreview()
    gestureRef.current = null
    pendingPreviewRef.current = null
    if (commit && useDocumentStore.getState().doc === gesture.document) {
      useDocumentStore.getState().updateClipVisualAtFrame(
        gesture.clipId,
        gesture.timelineFrame,
        gestureCommitPatch(gesture),
      )
    }
    useTransportStore.getState().setOwnedClipVisualPreview('visual-gesture', null)
  }

  const keyboardMove = (
    event: KeyboardEvent<HTMLButtonElement>,
    clipId: string,
  ): void => {
    if (!event.key.startsWith('Arrow')) return
    const clip = currentEditableClip(clipId)
    if (!clip) return
    const amount = event.shiftKey ? 10 : 1
    const x = clip.transform.x
      + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0)
    const y = clip.transform.y
      + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0)
    if (x === clip.transform.x && y === clip.transform.y) return
    event.preventDefault()
    updateVisualAtPlayhead(clipId, { transform: { x, y } })
  }

  const keyboardScale = (
    event: KeyboardEvent<HTMLButtonElement>,
    clipId: string,
  ): void => {
    if (!event.key.startsWith('Arrow')) return
    const clip = currentEditableClip(clipId)
    if (!clip) return
    const visual = clipVisualSettings(clip)
    const amount = event.shiftKey ? 0.1 : 0.01
    const horizontal = event.key === 'ArrowLeft' ? -amount
      : event.key === 'ArrowRight' ? amount : 0
    const vertical = event.key === 'ArrowDown' ? -amount
      : event.key === 'ArrowUp' ? amount : 0
    if (horizontal === 0 && vertical === 0) return
    event.preventDefault()
    if (visual.scaleLocked) {
      const scale = clamp(
        clip.transform.scaleX + horizontal + vertical,
        MIN_EDITABLE_SCALE,
        MAX_CLIP_SCALE,
      )
      updateVisualAtPlayhead(clipId, {
        transform: { scaleX: scale, scaleY: scale },
      })
    } else {
      updateVisualAtPlayhead(clipId, {
        transform: {
          scaleX: clamp(clip.transform.scaleX + horizontal, MIN_EDITABLE_SCALE, MAX_CLIP_SCALE),
          scaleY: clamp(clip.transform.scaleY + vertical, MIN_EDITABLE_SCALE, MAX_CLIP_SCALE),
        },
      })
    }
  }

  const keyboardRotate = (
    event: KeyboardEvent<HTMLButtonElement>,
    clipId: string,
  ): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const clip = currentEditableClip(clipId)
    if (!clip) return
    event.preventDefault()
    const amount = event.shiftKey ? 15 : 1
    updateVisualAtPlayhead(clipId, {
      transform: {
        rotation: clip.transform.rotation
          + (event.key === 'ArrowLeft' ? -amount : amount),
      },
    })
  }

  const keyboardAnchor = (
    event: KeyboardEvent<HTMLButtonElement>,
    item: ActiveVisualClip,
  ): void => {
    if (!event.key.startsWith('Arrow')) return
    const clip = currentEditableClip(item.clip.id)
    if (!clip) return
    const visual = clipVisualSettings(clip)
    const amount = event.shiftKey ? 0.05 : 0.01
    const anchorX = clamp(
      clip.transform.anchorX
        + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0),
      0,
      1,
    )
    const anchorY = clamp(
      clip.transform.anchorY
        + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0),
      0,
      1,
    )
    if (anchorX === clip.transform.anchorX && anchorY === clip.transform.anchorY) return
    event.preventDefault()
    const compensation = sourceVectorToDocument(
      (anchorX - clip.transform.anchorX) * item.sourceWidth,
      (anchorY - clip.transform.anchorY) * item.sourceHeight,
      clip.transform,
      visual,
    )
    updateVisualAtPlayhead(clip.id, {
      transform: {
        anchorX,
        anchorY,
        x: clip.transform.x + compensation.x,
        y: clip.transform.y + compensation.y,
      },
    })
  }

  const keyboardCrop = (
    event: KeyboardEvent<HTMLButtonElement>,
    clipId: string,
    edge: CropEdge,
  ): void => {
    if (!event.key.startsWith('Arrow')) return
    const clip = currentEditableClip(clipId)
    if (!clip) return
    const visual = clipVisualSettings(clip)
    const amount = event.shiftKey ? 0.05 : 0.01
    let delta = 0
    if (edge === 'left') delta = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0
    if (edge === 'right') delta = event.key === 'ArrowLeft' ? amount : event.key === 'ArrowRight' ? -amount : 0
    if (edge === 'top') delta = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0
    if (edge === 'bottom') delta = event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0
    if (delta === 0) return
    event.preventDefault()
    updateVisualAtPlayhead(clipId, {
      visual: { crop: cropWithEdge(visual.crop, edge, delta) },
    })
  }

  const toggleFlip = (clipId: string, axis: 'horizontal' | 'vertical'): void => {
    const clip = currentEditableClip(clipId)
    if (!clip) return
    const visual = clipVisualSettings(clip)
    updateVisualAtPlayhead(clipId, {
      visual: axis === 'horizontal'
        ? { flipHorizontal: !visual.flipHorizontal }
        : { flipVertical: !visual.flipVertical },
    })
  }

  if (!viewport) return null
  const items = activeVisualClips(doc, descriptors, playheadFrame)
  const scaleX = viewport.width / doc.width
  const scaleY = viewport.height / doc.height
  const selectedItem = items.find((item) => item.clip.id === selectedClipId) ?? null

  return (
    <div className="visual-overlay-controls" aria-label="Visual clip canvas controls">
      <span id="visual-overlay-control-help" className="visually-hidden">
        Arrow keys adjust the focused control. Hold Shift for larger steps. Drag to preview; releasing commits one edit.
      </span>
      {selectedItem && (
        <div
          className="visual-overlay-toolbar"
          style={{ left: viewport.left + 8, top: viewport.top + 8 }}
          aria-label={`Flip controls for ${selectedItem.clip.name}`}
        >
          <button
            type="button"
            aria-label={`Flip ${selectedItem.clip.name} horizontally`}
            aria-pressed={clipVisualSettings(selectedItem.clip).flipHorizontal}
            aria-disabled={selectedItem.locked}
            title="Flip horizontally"
            onClick={() => toggleFlip(selectedItem.clip.id, 'horizontal')}
          >H</button>
          <button
            type="button"
            aria-label={`Flip ${selectedItem.clip.name} vertically`}
            aria-pressed={clipVisualSettings(selectedItem.clip).flipVertical}
            aria-disabled={selectedItem.locked}
            title="Flip vertically"
            onClick={() => toggleFlip(selectedItem.clip.id, 'vertical')}
          >V</button>
        </div>
      )}
      {items.map((item) => {
        const committedClip = item.clip
        const preview = draft?.clipId === committedClip.id ? draft : null
        const transform = preview?.transform ?? committedClip.transform
        const visual = preview?.visual ?? clipVisualSettings(committedClip)
        const selected = selectedClipId === committedClip.id
        const sourceLeft = visual.crop.left * item.sourceWidth
        const sourceTop = visual.crop.top * item.sourceHeight
        const visibleWidth = (1 - visual.crop.left - visual.crop.right) * item.sourceWidth
        const visibleHeight = (1 - visual.crop.top - visual.crop.bottom) * item.sourceHeight
        const localLeft = sourceLeft - transform.anchorX * item.sourceWidth
        const localTop = sourceTop - transform.anchorY * item.sourceHeight
        const transformOriginX = -localLeft / visibleWidth
        const transformOriginY = -localTop / visibleHeight
        const style = {
          left: viewport.left + (doc.width / 2 + transform.x + localLeft) * scaleX,
          top: viewport.top + (doc.height / 2 + transform.y + localTop) * scaleY,
          width: visibleWidth * scaleX,
          height: visibleHeight * scaleY,
          transform: `rotate(${transform.rotation}deg) scale(${visual.flipHorizontal ? -transform.scaleX : transform.scaleX}, ${visual.flipVertical ? -transform.scaleY : transform.scaleY})`,
          transformOrigin: `${transformOriginX * 100}% ${transformOriginY * 100}%`,
          '--visual-counter-scale-x': String(
            (visual.flipHorizontal ? -1 : 1)
              / Math.max(transform.scaleX, 0.0001),
          ),
          '--visual-counter-scale-y': String(
            (visual.flipVertical ? -1 : 1)
              / Math.max(transform.scaleY, 0.0001),
          ),
          '--visual-rotate-offset': `${-32 / Math.max(transform.scaleY, 0.0001)}px`,
          '--visual-border-width': `${1 / Math.max(
            transform.scaleX,
            transform.scaleY,
            0.0001,
          )}px`,
          '--visual-shadow-width': `${2 / Math.max(
            transform.scaleX,
            transform.scaleY,
            0.0001,
          )}px`,
          '--visual-focus-width': `${3 / Math.max(
            transform.scaleX,
            transform.scaleY,
            0.0001,
          )}px`,
        } as CSSProperties
        const pointerHandlers = (kind: GestureKind) => ({
          onPointerDown: (event: PointerEvent<HTMLButtonElement>) => startGesture(event, committedClip.id, kind),
          onPointerMove: moveGesture,
          onPointerUp: (event: PointerEvent<HTMLButtonElement>) => finishGesture(event, true),
          onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finishGesture(event, false),
        })

        return (
          <div
            key={committedClip.id}
            className="visual-overlay-control"
            data-selected={selected ? 'true' : 'false'}
            data-locked={item.locked ? 'true' : 'false'}
            style={style}
          >
            <button
              type="button"
              className="visual-overlay-control-body"
              aria-label={`${selected ? 'Selected ' : ''}visual clip: ${committedClip.name}`}
              aria-pressed={selected}
              aria-disabled={item.locked}
              aria-describedby="visual-overlay-control-help"
              onClick={() => useTransportStore.getState().setSelectedClip(committedClip.id)}
              onKeyDown={(event) => keyboardMove(event, committedClip.id)}
              {...pointerHandlers('move')}
            />
            {selected && (
              <>
                {SCALE_CORNERS.map((corner) => (
                  <button
                    key={corner}
                    type="button"
                    className={`visual-overlay-handle visual-overlay-scale-handle visual-overlay-scale-${corner}`}
                    aria-label={`Scale visual clip from ${corner.replace('-', ' ')} corner: ${committedClip.name}`}
                    aria-disabled={item.locked}
                    aria-describedby="visual-overlay-control-help"
                    onKeyDown={(event) => keyboardScale(event, committedClip.id)}
                    {...pointerHandlers(`scale-${corner}`)}
                  />
                ))}
                <button
                  type="button"
                  className="visual-overlay-handle visual-overlay-rotate-handle"
                  aria-label={`Rotate visual clip: ${committedClip.name}`}
                  aria-disabled={item.locked}
                  aria-describedby="visual-overlay-control-help"
                  onKeyDown={(event) => keyboardRotate(event, committedClip.id)}
                  {...pointerHandlers('rotate')}
                />
                <button
                  type="button"
                  className="visual-overlay-handle visual-overlay-anchor-handle"
                  style={{ left: `${transformOriginX * 100}%`, top: `${transformOriginY * 100}%` }}
                  aria-label={`Move anchor for visual clip: ${committedClip.name}`}
                  aria-disabled={item.locked}
                  aria-describedby="visual-overlay-control-help"
                  onKeyDown={(event) => keyboardAnchor(event, item)}
                  {...pointerHandlers('anchor')}
                />
                {(['left', 'right', 'top', 'bottom'] as const).map((edge) => (
                  <button
                    key={edge}
                    type="button"
                    className={`visual-overlay-crop-handle visual-overlay-crop-${edge}`}
                    aria-label={`Crop ${edge} edge of visual clip: ${committedClip.name}`}
                    aria-disabled={item.locked}
                    aria-describedby="visual-overlay-control-help"
                    onKeyDown={(event) => keyboardCrop(event, committedClip.id, edge)}
                    {...pointerHandlers(`crop-${edge}`)}
                  />
                ))}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
