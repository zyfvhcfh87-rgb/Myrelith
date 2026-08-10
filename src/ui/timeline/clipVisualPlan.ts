/**
 * Pure presentation planning for ClipView.
 *
 * Live preview geometry is intersected with the bounded timeline window, then
 * mapped into source time without touching the pointer session. Filmstrips use
 * integer-frame buckets and waveforms use normalized source-time view boxes,
 * so trim, slip, razor, zoom, and origin rebasing remain exactly aligned.
 */

import type { Clip, SourceTimeMap, SourceTimeRate, TrackKind } from '../../domain/schema'
import {
  clipSourceTimeMap,
  sourceTicksAtTimelineOffset,
  sourceTimeMapAtOffset,
  SOURCE_TIME_TICKS_PER_FRAME,
} from '../../domain/sourceTimeMap'
import type { AssetVisuals } from '../../state/mediaStore'
import type {
  EditPreview,
  TimelineTool,
} from '../../state/transportStore'
import { frameToTimelineLocalPx } from './timelineViewport'

export interface FilmstripBucket {
  index: number
  spriteIndex: number
  startFrame: number
  endFrame: number
}

export function visibleFilmstripBuckets(
  assetDurationFrames: number,
  tileCount: number,
  tileWidth: number,
  zoom: number,
  sourceStartFrame: number,
  sourceDurationFrames: number,
  rate: SourceTimeRate = { numerator: 1, denominator: 1 },
): FilmstripBucket[] {
  if (
    !Number.isSafeInteger(assetDurationFrames) ||
    assetDurationFrames <= 0 ||
    !Number.isSafeInteger(tileCount) ||
    tileCount <= 0 ||
    !Number.isSafeInteger(tileWidth) ||
    tileWidth <= 0 ||
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    !Number.isSafeInteger(sourceStartFrame) ||
    !Number.isSafeInteger(sourceDurationFrames) ||
    sourceDurationFrames <= 0
    || !Number.isSafeInteger(rate.numerator)
    || !Number.isSafeInteger(rate.denominator)
    || rate.numerator <= 0
    || rate.denominator <= 0
  ) {
    return []
  }

  const sourceEndFrame = sourceStartFrame + sourceDurationFrames
  if (!Number.isSafeInteger(sourceEndFrame)) return []

  const sourcePixelsPerFrame = zoom * rate.denominator / rate.numerator
  const assetWidth = assetDurationFrames * sourcePixelsPerFrame
  if (!Number.isFinite(assetWidth)) return []
  const displayCount = Math.min(
    tileCount,
    Math.max(1, Math.floor(assetWidth / tileWidth)),
  )

  const buckets: FilmstripBucket[] = []
  const duration = BigInt(assetDurationFrames)
  const divisor = BigInt(displayCount)
  for (let index = 0; index < displayCount; index++) {
    const startFrame = Number((BigInt(index) * duration) / divisor)
    const endFrame = Number((BigInt(index + 1) * duration) / divisor)
    const spriteIndex = Number(
      (BigInt(index * 2 + 1) * BigInt(tileCount)) / (divisor * 2n),
    )
    if (
      startFrame < endFrame &&
      endFrame > sourceStartFrame &&
      startFrame < sourceEndFrame
    ) {
      buckets.push({ index, spriteIndex, startFrame, endFrame })
    }
  }
  return buckets
}

type FilmstripVisual = NonNullable<AssetVisuals['filmstrip']>
type WaveformVisual = NonNullable<AssetVisuals['waveform']>

export interface FilmstripTilePresentation {
  index: number
  leftPx: number
  widthPx: number
  patternX: number
  spriteX: number
}

export interface FilmstripPresentation {
  kind: 'filmstrip'
  source: FilmstripVisual
  tiles: FilmstripTilePresentation[]
}

export interface WaveformPresentation {
  kind: 'waveform'
  source: WaveformVisual
  viewBox: string
}

export type ClipGeneratedVisualPresentation =
  | FilmstripPresentation
  | WaveformPresentation
  | null

export interface ClipPresentationPlan {
  isStillSource: boolean
  dragging: boolean
  badge: string | null
  hasVisibleSlice: boolean
  displayedStartFrame: number
  displayedEndFrame: number
  displayedDurationFrames: number
  localStartPx: number
  showStartEdge: boolean
  showEndEdge: boolean
  accessibleKind: string
  interactionTitle: string
  visual: ClipGeneratedVisualPresentation
}

export interface ClipPresentationPlanInput {
  clip: Clip
  trackKind: TrackKind
  zoom: number
  tool: TimelineTool
  movePreviewDelta: number | null
  editPreview: EditPreview | null
  ownsLiveGesture: boolean
  timelineOriginFrame: number
  timelineWindowEndFrame: number
  assetDurationFrames: number
  visuals: AssetVisuals | undefined
}

interface GeneratedVisualPlanInput {
  trackKind: TrackKind
  zoom: number
  isStillSource: boolean
  assetDurationFrames: number
  visuals: AssetVisuals | undefined
  hasVisibleSlice: boolean
  displayedStartFrame: number
  displayedDurationFrames: number
  clipStartFrame: number
  clipDurationFrames: number
  sourceTimeMap: SourceTimeMap
}

function planGeneratedVisual({
  trackKind,
  zoom,
  isStillSource,
  assetDurationFrames,
  visuals,
  hasVisibleSlice,
  displayedStartFrame,
  displayedDurationFrames,
  clipStartFrame,
  clipDurationFrames,
  sourceTimeMap,
}: GeneratedVisualPlanInput): ClipGeneratedVisualPresentation {
  if (!hasVisibleSlice) return null

  const displayedSourceStartTicks = sourceTicksAtTimelineOffset(
    sourceTimeMap,
    displayedStartFrame - clipStartFrame,
  )
  const displayedSourceEndTicks = sourceTicksAtTimelineOffset(
    sourceTimeMap,
    displayedStartFrame - clipStartFrame + displayedDurationFrames,
  )
  const displayedSourceStartFrame = Math.floor(
    displayedSourceStartTicks / SOURCE_TIME_TICKS_PER_FRAME,
  )
  const displayedSourceEndFrame = Math.ceil(
    displayedSourceEndTicks / SOURCE_TIME_TICKS_PER_FRAME,
  )
  const displayedSourceDurationFrames = Math.max(
    1,
    displayedSourceEndFrame - displayedSourceStartFrame,
  )
  const visualDurationFrames = isStillSource
    ? clipDurationFrames
    : assetDurationFrames
  const displayedVisualStartFrame = isStillSource
    ? displayedStartFrame - clipStartFrame
    : displayedSourceStartFrame
  const displayedVisualDurationFrames = isStillSource
    ? displayedDurationFrames
    : displayedSourceDurationFrames

  const filmstrip = trackKind === 'video' ? visuals?.filmstrip : null
  if (filmstrip && visualDurationFrames > 0) {
    const buckets = visibleFilmstripBuckets(
      visualDurationFrames,
      filmstrip.tiles,
      filmstrip.tileWidth,
      zoom,
      displayedVisualStartFrame,
      isStillSource ? displayedDurationFrames : displayedSourceDurationFrames,
      sourceTimeMap.rate,
    )
    if (buckets.length > 0) {
      return {
        kind: 'filmstrip',
        source: filmstrip,
        tiles: buckets.map((bucket) => {
          const visibleBucketStart = Math.max(
            bucket.startFrame,
            displayedVisualStartFrame,
          )
          const visibleBucketEnd = Math.min(
            bucket.endFrame,
            displayedVisualStartFrame + displayedVisualDurationFrames,
          )
          const croppedHeadPx =
            (visibleBucketStart - bucket.startFrame)
            * zoom * sourceTimeMap.rate.denominator / sourceTimeMap.rate.numerator
          const sourcePixelsPerFrame = isStillSource
            ? zoom
            : zoom * sourceTimeMap.rate.denominator / sourceTimeMap.rate.numerator
          return {
            index: bucket.index,
            leftPx:
              (visibleBucketStart - displayedVisualStartFrame) * sourcePixelsPerFrame,
            widthPx: (visibleBucketEnd - visibleBucketStart) * sourcePixelsPerFrame,
            patternX: -(croppedHeadPx % filmstrip.tileWidth),
            spriteX: -bucket.spriteIndex * filmstrip.tileWidth,
          }
        }),
      }
    }
  }

  const waveform = trackKind === 'audio' ? visuals?.waveform : null
  if (waveform && assetDurationFrames > 0) {
    return {
      kind: 'waveform',
      source: waveform,
      viewBox:
        `${(displayedSourceStartTicks / SOURCE_TIME_TICKS_PER_FRAME) / assetDurationFrames} 0 `
        + `${((displayedSourceEndTicks - displayedSourceStartTicks) / SOURCE_TIME_TICKS_PER_FRAME) / assetDurationFrames} 1`,
    }
  }

  return null
}

/**
 * Derive the complete render-only projection for one ClipView. Pointer
 * sessions remain in ClipView; this function owns only live display geometry,
 * bounded-window intersection, source-time mapping, and visual visibility.
 */
export function planClipPresentation({
  clip,
  trackKind,
  zoom,
  tool,
  movePreviewDelta,
  editPreview,
  ownsLiveGesture,
  timelineOriginFrame,
  timelineWindowEndFrame,
  assetDurationFrames,
  visuals,
}: ClipPresentationPlanInput): ClipPresentationPlan | null {
  const isStillSource = clip.sourceMode === 'still'
  const timelineRange = clip.timelineRange
  let startFrame = timelineRange.startFrame + (movePreviewDelta ?? 0)
  let durationFrames = timelineRange.durationFrames
  let badge: string | null = null

  if (editPreview) {
    const deltaFrames = editPreview.deltaFrames
    badge =
      `${editPreview.kind} ${deltaFrames >= 0 ? '+' : ''}${deltaFrames}`
    switch (editPreview.kind) {
      case 'trim-start':
        startFrame = timelineRange.startFrame + deltaFrames
        durationFrames = timelineRange.durationFrames - deltaFrames
        break
      case 'ripple-start':
        durationFrames = timelineRange.durationFrames - deltaFrames
        break
      case 'trim-end':
      case 'ripple-end':
        durationFrames = timelineRange.durationFrames + deltaFrames
        break
      case 'slide':
        startFrame = timelineRange.startFrame + deltaFrames
        break
      case 'slip':
        break
    }
  }

  let sourceTimeMap = clipSourceTimeMap(clip)
  if (
    !isStillSource
    && editPreview
    && (
      editPreview.kind === 'slip'
      || editPreview.kind === 'trim-start'
      || editPreview.kind === 'ripple-start'
    )
  ) {
    sourceTimeMap = editPreview.kind === 'slip'
      ? {
          ...sourceTimeMap,
          sourceStartTicks:
            sourceTimeMap.sourceStartTicks
            + editPreview.deltaFrames * SOURCE_TIME_TICKS_PER_FRAME,
        }
      : sourceTimeMapAtOffset(sourceTimeMap, editPreview.deltaFrames)
  }

  const clippedStartFrame = Math.max(startFrame, timelineOriginFrame)
  const clippedEndFrame = Math.min(
    startFrame + durationFrames,
    timelineWindowEndFrame,
  )
  const hasVisibleSlice = clippedEndFrame > clippedStartFrame
  if (!hasVisibleSlice && !ownsLiveGesture) return null

  const displayedStartFrame = hasVisibleSlice
    ? clippedStartFrame
    : Math.min(
        timelineWindowEndFrame,
        Math.max(timelineOriginFrame, startFrame),
      )
  const displayedEndFrame = hasVisibleSlice
    ? clippedEndFrame
    : displayedStartFrame
  const displayedDurationFrames = displayedEndFrame - displayedStartFrame
  const surfaceWidthPx = Math.max(
    1,
    (timelineWindowEndFrame - timelineOriginFrame) * zoom,
  )
  const localStartPx = hasVisibleSlice
    ? frameToTimelineLocalPx(
        displayedStartFrame,
        timelineOriginFrame,
        zoom,
      )
    : startFrame + durationFrames <= timelineOriginFrame
      ? 0
      : Math.max(0, surfaceWidthPx - 1)

  const showEdges = hasVisibleSlice && (tool === 'select' || tool === 'trim')
  const accessibleKind = clip.text !== undefined
    ? 'text overlay'
    : isStillSource
      ? 'still image'
      : trackKind
  const interactionTitle =
    tool === 'slip' && (isStillSource || clip.text !== undefined)
      ? clip.text !== undefined
        ? 'Text overlays have no source media, so Slip is unavailable.'
        : 'Still images always show their single source frame, so Slip is unavailable.'
      : 'Select clip. Hold Ctrl or Command while clicking, or with Enter or Space, to add or remove it from the selection.'

  return {
    isStillSource,
    dragging: movePreviewDelta !== null || editPreview !== null,
    badge,
    hasVisibleSlice,
    displayedStartFrame,
    displayedEndFrame,
    displayedDurationFrames,
    localStartPx,
    showStartEdge: showEdges && displayedStartFrame === startFrame,
    showEndEdge:
      showEdges && displayedEndFrame === startFrame + durationFrames,
    accessibleKind,
    interactionTitle,
    visual: planGeneratedVisual({
      trackKind,
      zoom,
      isStillSource,
      assetDurationFrames,
      visuals,
      hasVisibleSlice,
      displayedStartFrame,
      displayedDurationFrames,
      clipStartFrame: startFrame,
      clipDurationFrames: durationFrames,
      sourceTimeMap,
    }),
  }
}
