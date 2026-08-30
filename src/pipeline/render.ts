/**
 * pipeline/render.ts — compositeFrame(doc, frame): draw one timeline frame.
 * Phase 4.1.
 *
 * The single compositing implementation for BOTH live preview (inside
 * workers/render.worker.ts) and export (pipeline/export.ts, Phase 5): one
 * code path means the export can never look different from the preview.
 *
 * Layering: pipeline/ → domain/ only. No React, no stores, no Worker
 * globals. The drawing surface and the pixel supplier are INJECTED behind
 * structural interfaces, so unit tests run in jsdom with recording fakes
 * and the render worker passes its real OffscreenCanvas 2D context.
 *
 * Contracts (callers rely on these; keep them true):
 * - The canvas must already match the requested presentation output size with
 *   an IDENTITY transform and default state. Authored geometry remains in
 *   project space; this compositor applies the presentation scale and restores
 *   whatever state it changes (per-clip save/restore, try/finally — a bad
 *   bitmap cannot poison the transform stack for the next composite).
 * - Ownership: compositeFrame never closes images. The FrameSource owns
 *   frame lifetime/caching (single-owner rule); returned images must stay
 *   valid until compositeFrame's returned promise settles. Ordered plugin
 *   stages may yield after the fetch phase, so every borrowed image remains
 *   loaned across those awaited draws and is released only by the caller
 *   after this promise settles.
 * - All getFrame calls for one composite are issued CONCURRENTLY (decoders
 *   for different assets work in parallel), and two clips may request the
 *   SAME asset at different frames in one composite (picture-in-picture).
 *   A FrameSource must therefore resolve every request — per-asset
 *   latest-wins supersession across composites is fine, but dropping
 *   requests WITHIN one composite is not.
 * - Visual selection, including crossfade source frames, intrinsic opacity,
 *   and transition weights, arrives as an explicit VideoCompositionPlan.
 *   Preview and export consume that same
 *   ordered plan; this compositor never reconstructs groups by adjacency.
 */

import type {
  AssetId,
  AdjustmentItem,
  Clip,
  ClipId,
  ClipVisualSettings,
  TextProps,
  TimelineDoc,
  Transform,
} from '../domain/schema'
import type { PresentationProfile } from '../domain/presentationProfile'
import { wrapTextLines } from '../domain/textLayout'
import { textPropsValidationError } from '../domain/textOverlay'
import {
  videoCompositionRequests,
  type PlannedCrossfadeFrameRequest,
  type PlannedVideoFrameRequest,
  type VideoCompositionPlan,
} from '../domain/videoCompositionPlan'
import type { VideoFrameRequest } from '../domain/crossfadePlan'
import { clipVisualSettings } from '../domain/clipInspector'
import {
  LensRemapUnavailableError,
  rethrowLensRemapUnavailable,
  type LensRemapProvider,
} from './lensRemap'
import {
  DEFAULT_BLEND_MODE,
  resolveBlendMode,
  type BlendModeResolution,
} from '../domain/blendModes'
import { probeCanvasBlendMode } from './blendModeCapabilities'
import {
  resolveCanvasEffectStack,
  resolvePostCompositeEffectStack,
  supportsCanvasEffectFilter,
  supportsCanvasEffectPixels,
} from '../domain/effectStack'
import { applyOrderedPixelEffectsToRgba } from '../domain/effectPixels'
import type { VideoEffectStagePlan } from '../domain/pluginVideoEffectStagePlan'
import {
  applyVideoEffectStagePlanToRgba,
  VideoEffectStageExecutionError,
  type VideoEffectStageExecutor,
} from './videoEffectStageExecution'

export type { VideoEffectStageExecutor } from './videoEffectStageExecution'

const NORMAL_BLEND_MODE = resolveBlendMode(DEFAULT_BLEND_MODE)

/**
 * A compositor-ready browser image. VideoFrame is retained here because the
 * bounded static-image decoder can transfer frame zero directly when a Blob
 * createImageBitmap path is unavailable; Canvas2D renders both natively.
 */
export type RenderFrameSource = ImageBitmap | VideoFrame

/**
 * Supplies decoded pixels for an asset's source frame; null when the frame
 * is not (yet) available. Cache misses should kick off decoding so a later
 * composite of the same frame succeeds — the CompositeResult tells the
 * caller whether a repaint will be needed.
 */
export interface FrameSource {
  getFrame(
    assetId: AssetId,
    sourceFrame: number,
  ): Promise<RenderFrameSource | null>
}

/**
 * Structural subset of CanvasRenderingContext2D / OffscreenCanvas-
 * RenderingContext2D that compositing needs. Both real context types
 * satisfy this; tests inject a recording fake.
 */
export interface Composite2D {
  /** Present on real Canvas2D contexts; optional only for lightweight test fakes. */
  readonly canvas?: CanvasImageSource
  globalAlpha: number
  globalCompositeOperation: GlobalCompositeOperation
  /** Optional on test fakes; present on modern Canvas2D/OffscreenCanvas contexts. */
  filter?: string
  getImageData?(sx: number, sy: number, sw: number, sh: number): ImageData
  putImageData?(imageData: ImageData, dx: number, dy: number): void
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle?: string | CanvasGradient | CanvasPattern
  font?: string
  textAlign?: CanvasTextAlign
  textBaseline?: CanvasTextBaseline
  lineWidth?: number
  lineJoin?: CanvasLineJoin
  shadowColor?: string
  shadowBlur?: number
  shadowOffsetX?: number
  shadowOffsetY?: number
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angleRad: number): void
  scale(x: number, y: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  drawImage(
    image: CanvasImageSource,
    sxOrDx: number,
    syOrDy: number,
    sWidth?: number,
    sHeight?: number,
    dx?: number,
    dy?: number,
    dWidth?: number,
    dHeight?: number,
  ): void
  beginPath?(): void
  rect?(x: number, y: number, w: number, h: number): void
  clip?(): void
  measureText?(text: string): Pick<TextMetrics, 'width'>
  fillText?(text: string, x: number, y: number): void
  strokeText?(text: string, x: number, y: number): void
}

type TextComposite2D = Composite2D & Required<Pick<Composite2D,
  | 'strokeStyle'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'lineWidth'
  | 'lineJoin'
  | 'shadowColor'
  | 'shadowBlur'
  | 'shadowOffsetX'
  | 'shadowOffsetY'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'measureText'
  | 'fillText'
  | 'strokeText'
>>

function supportsTextDrawing(ctx: Composite2D): ctx is TextComposite2D {
  return typeof ctx.beginPath === 'function'
    && typeof ctx.rect === 'function'
    && typeof ctx.clip === 'function'
    && typeof ctx.measureText === 'function'
    && typeof ctx.fillText === 'function'
    && typeof ctx.strokeText === 'function'
}

/** One transparent, output-sized scratch surface owned by the caller. */
export interface CompositeSurface {
  canvas: CanvasImageSource
  ctx: Composite2D
}

/**
 * Persistent scratch surfaces for isolated layer/transition composition.
 * Preview and export own separate pairs so concurrent owners cannot overwrite
 * one another. A returned pair is borrowed exclusively until compositeFrame's
 * promise settles because ordered plugin execution may await while its pixels
 * remain live. The compositor clears and reuses surfaces on every borrowed path.
 */
export interface TransitionSurfaces {
  /** Renders one complete transformed clip with ordinary source-over rules. */
  leg: CompositeSurface
  /** Adds weighted premultiplied legs before one destination source-over. */
  group: CompositeSurface
}

/**
 * Lazily supplies caller-owned persistent surfaces. The caller must serialize
 * compositeFrame uses that share a provider so each async borrow stays exclusive.
 */
export interface TransitionSurfaceProvider {
  get(): TransitionSurfaces
}

/** What one composite accomplished, in bottom-to-top track order. */
export interface CompositeResult {
  /** Clips whose pixels were painted this composite. */
  drawn: ClipId[]
  /**
   * Active clips that could NOT be painted (frame not decoded yet, source
   * error, dead bitmap). Non-empty means the caller should re-composite
   * once sources have warmed up.
   */
  missing: ClipId[]
}

function correctedSourceForClip(
  clip: Readonly<Clip>,
  source: CanvasImageSource,
  provider: LensRemapProvider | null | undefined,
): CanvasImageSource {
  if ((clip.lensCorrection ?? null) === null) return source
  if (!provider) {
    throw new LensRemapUnavailableError(
      'Manual lens correction is authored but unavailable in this renderer.',
    )
  }
  return provider.remap(clip, source)
}

function rethrowVideoEffectStageExecutionError(error: unknown): void {
  if (error instanceof VideoEffectStageExecutionError) throw error
}

/** Null selects the visible legacy built-in path without calling the plugin. */
function orderedPixelSurfaces(
  provider: TransitionSurfaceProvider,
): TransitionSurfaces | null {
  const surfaces = provider.get()
  return supportsCanvasEffectPixels(surfaces.leg.ctx) ? surfaces : null
}

/**
 * Composite timeline `frame` of `doc` onto `ctx`: black background, then
 * each visible video track's active clip bottom-to-top (tracks[0] first),
 * with the clip Transform (scale → rotate → translate around the anchor)
 * and opacity applied. Ordinary per-item failures land in `missing`; authored
 * lens unavailability and typed video-effect execution failures reject so the
 * owning preview/export policy can respond explicitly.
 */
export async function compositeFrame(
  doc: TimelineDoc,
  plan: VideoCompositionPlan,
  ctx: Composite2D,
  source: FrameSource,
  transitionSurfaceProvider: TransitionSurfaceProvider,
  presentation?: PresentationProfile,
  lensRemapProvider?: LensRemapProvider | null,
  videoEffectStageExecutor?: VideoEffectStageExecutor | null,
): Promise<CompositeResult> {
  // Phase 1 — collect what needs pixels, bottom-to-top.
  const requests = videoCompositionRequests(plan)

  // Phase 2 — fetch every needed frame concurrently.
  const images = await Promise.all(
    requests.map((request) =>
      source.getFrame(request.clip.assetId, request.sourceFrame).catch((e) => {
        console.warn(
          `[render] getFrame failed for clip "${request.clip.id}":`,
          e instanceof Error ? e.message : e,
        )
        return null
      }),
    ),
  )
  // videoCompositionRequests deliberately removes compositor-only plan fields,
  // so request object identity is not stable for plugin-planned items.
  const imagesByClipId = new Map<ClipId, RenderFrameSource | null>()
  for (let index = 0; index < requests.length; index++) {
    imagesByClipId.set(requests[index].clip.id, images[index])
  }

  // Phase 3 — draw in paint order. Ordered plugin stages may yield; FrameSource
  // loans remain valid until this compositeFrame promise settles.
  const drawn: ClipId[] = []
  const missing: ClipId[] = []
  const presentationScale = {
    x: presentation?.scale ?? 1,
    y: presentation?.scale ?? 1,
  }

  ctx.save()
  try {
    if (presentationScale.x !== 1 || presentationScale.y !== 1) {
      ctx.scale(presentationScale.x, presentationScale.y)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, doc.width, doc.height)

    for (const item of plan.items) {
      if (item.kind === 'adjustment') {
        try {
          compositePostCompositeAdjustment(
            doc,
            ctx,
            transitionSurfaceProvider,
            item.adjustment,
            presentationScale,
          )
        } catch (e) {
          console.warn(
            `[render] applying adjustment "${item.adjustment.id}" failed:`,
            e instanceof Error ? e.message : e,
          )
        }
        continue
      }

      if (item.kind === 'crossfade') {
        await compositeTransitionGroup(
          doc,
          ctx,
          transitionSurfaceProvider,
          item.requests,
          item.blendMode,
          imagesByClipId,
          drawn,
          missing,
          presentationScale,
          lensRemapProvider,
          videoEffectStageExecutor,
          plan.frame,
        )
        continue
      }

      if (item.kind === 'text') {
        try {
          await compositeTextLayer(
            doc,
            ctx,
            transitionSurfaceProvider,
            item.clip,
            item.opacity,
            item.blendMode,
            presentationScale,
            item.effectStagePlan,
            videoEffectStageExecutor,
            plan.frame,
          )
          drawn.push(item.clip.id)
        } catch (e) {
          rethrowVideoEffectStageExecutionError(e)
          console.warn(
            `[render] drawing text clip "${item.clip.id}" failed:`,
            e instanceof Error ? e.message : e,
          )
          missing.push(item.clip.id)
        }
        continue
      }

      if (item.kind === 'caption') {
        try {
          drawTextPayload(
            ctx,
            doc,
            item.paint.text,
            item.paint.transform,
            item.paint.visual,
            item.paint.opacity,
            NORMAL_BLEND_MODE,
          )
          drawn.push(item.paint.id)
        } catch (e) {
          console.warn(
            `[render] drawing caption "${item.paint.id}" failed:`,
            e instanceof Error ? e.message : e,
          )
          missing.push(item.paint.id)
        }
        continue
      }

      const request = item.request
      const clip = request.clip
      const image = imagesByClipId.get(clip.id) ?? null
      if (!image) {
        missing.push(clip.id)
        continue
      }
      try {
        const correctedImage = correctedSourceForClip(clip, image, lensRemapProvider)
        const effectStagePlan = request.effectStagePlan
        const plannedSurfaces = effectStagePlan?.requiresOrderedPixelPath
          ? orderedPixelSurfaces(transitionSurfaceProvider)
          : null
        if (plannedSurfaces && effectStagePlan) {
          await compositeOrderedPixelMediaLayer(
            doc,
            ctx,
            plannedSurfaces,
            request,
            correctedImage,
            item.blendMode,
            presentationScale,
            effectStagePlan,
            videoEffectStageExecutor,
            plan.frame,
          )
        } else if (
          effectStagePlan?.requiresOrderedPixelPath
          && videoEffectStageExecutor?.bypassPolicy === 'fail'
        ) {
          throw new VideoEffectStageExecutionError(
            'Canvas pixel access is unavailable for fail-closed plugin composition',
          )
        } else if (requiresPixelEffects(ctx, clip)) {
          compositePixelCorrectedMediaLayer(
            doc,
            ctx,
            transitionSurfaceProvider,
            request,
            correctedImage,
            item.blendMode,
            presentationScale,
          )
        } else {
          drawClip(ctx, doc, request, correctedImage, item.blendMode)
        }
        drawn.push(clip.id)
      } catch (e) {
        rethrowLensRemapUnavailable(e)
        rethrowVideoEffectStageExecutionError(e)
        // e.g. the bitmap was closed under us — record and keep compositing.
        console.warn(
          `[render] drawing clip "${clip.id}" failed:`,
          e instanceof Error ? e.message : e,
        )
        missing.push(clip.id)
      }
    }
  } finally {
    ctx.restore()
  }

  return { drawn, missing }
}

const MAX_CACHED_TEXT_LAYOUTS_PER_CONTEXT = 64
const MAX_RENDERED_TEXT_LINES = 512
const textLayoutCaches = new WeakMap<object, Map<string, readonly string[]>>()

function textLines(
  ctx: TextComposite2D,
  text: TextProps,
): readonly string[] {
  const lineHeight = Math.ceil(text.fontSizePx * 1.2)
  const innerWidth = text.boxWidthPx - text.paddingPx * 2
  const innerHeight = text.boxHeightPx - text.paddingPx * 2
  const maxLines = Math.max(
    1,
    Math.min(MAX_RENDERED_TEXT_LINES, Math.floor(innerHeight / lineHeight)),
  )
  const key = [
    text.content,
    text.fontFamily,
    text.fontSizePx,
    text.bold,
    text.italic,
    innerWidth,
    maxLines,
  ].join('\u0000')
  let cache = textLayoutCaches.get(ctx as object)
  if (!cache) {
    cache = new Map()
    textLayoutCaches.set(ctx as object, cache)
  }
  const cached = cache.get(key)
  if (cached) return cached
  const lines = wrapTextLines(
    text.content,
    innerWidth,
    maxLines,
    (value) => ctx.measureText(value).width,
  )
  cache.set(key, lines)
  if (cache.size > MAX_CACHED_TEXT_LAYOUTS_PER_CONTEXT) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest !== undefined) cache.delete(oldest)
  }
  return lines
}

/** Paint one procedural overlay with the same transform model as media. */
function drawTextClip(
  ctx: Composite2D,
  doc: TimelineDoc,
  clip: Clip,
  opacity: number,
  blendMode: BlendModeResolution,
): void {
  if (!supportsTextDrawing(ctx)) {
    throw new TypeError('The compositor context does not support text drawing.')
  }
  const text = clip.text
  if (!text) throw new TypeError('Text composition item has no text payload.')
  const validationError = textPropsValidationError(text)
  if (validationError) throw new RangeError(validationError)

  drawTextPayload(
    ctx,
    doc,
    text,
    clip.transform,
    clipVisualSettings(clip),
    opacity,
    blendMode,
  )
}

/** Shared Canvas2D text layout/composition for text clips and captions. */
function drawTextPayload(
  ctx: Composite2D,
  doc: TimelineDoc,
  text: TextProps,
  transform: Transform,
  visual: ClipVisualSettings,
  opacity: number,
  blendMode: BlendModeResolution,
): void {
  if (!supportsTextDrawing(ctx)) {
    throw new TypeError('The compositor context does not support text drawing.')
  }
  const validationError = textPropsValidationError(text)
  if (validationError) throw new RangeError(validationError)

  const anchorX = transform.anchorX * text.boxWidthPx
  const anchorY = transform.anchorY * text.boxHeightPx
  const canvasX = (doc.width - text.boxWidthPx) / 2 + anchorX + transform.x
  const canvasY = (doc.height - text.boxHeightPx) / 2 + anchorY + transform.y
  const lineHeight = Math.ceil(text.fontSizePx * 1.2)
  const x = text.align === 'left'
    ? text.paddingPx
    : text.align === 'right'
      ? text.boxWidthPx - text.paddingPx
      : text.boxWidthPx / 2

  ctx.save()
  try {
    ctx.globalAlpha = opacity
    applyCanvasBlendMode(ctx, blendMode)
    ctx.translate(canvasX, canvasY)
    ctx.rotate((transform.rotation * Math.PI) / 180)
    ctx.scale(
      transform.scaleX * (visual.flipHorizontal ? -1 : 1),
      transform.scaleY * (visual.flipVertical ? -1 : 1),
    )
    ctx.translate(-anchorX, -anchorY)
    const cropX = visual.crop.left * text.boxWidthPx
    const cropY = visual.crop.top * text.boxHeightPx
    const cropWidth = text.boxWidthPx * (1 - visual.crop.left - visual.crop.right)
    const cropHeight = text.boxHeightPx * (1 - visual.crop.top - visual.crop.bottom)
    ctx.beginPath()
    ctx.rect(cropX, cropY, cropWidth, cropHeight)
    ctx.clip()
    if (text.backgroundEnabled) {
      ctx.fillStyle = text.backgroundColor
      ctx.fillRect(0, 0, text.boxWidthPx, text.boxHeightPx)
    }
    ctx.font = `${text.italic ? 'italic' : 'normal'} ${text.bold ? '700' : '400'} ${text.fontSizePx}px ${text.fontFamily}`
    ctx.textAlign = text.align
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    const lines = textLines(ctx, text)
    for (let index = 0; index < lines.length; index++) {
      const y = text.paddingPx + index * lineHeight
      if (text.outlineEnabled && text.outlineWidthPx > 0) {
        ctx.shadowColor = '#00000000'
        ctx.shadowBlur = 0
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
        ctx.strokeStyle = text.outlineColor
        ctx.lineWidth = text.outlineWidthPx
        ctx.strokeText(lines[index], x, y)
      }
      ctx.fillStyle = text.color
      ctx.shadowColor = text.shadowEnabled ? text.shadowColor : '#00000000'
      ctx.shadowBlur = text.shadowEnabled ? text.shadowBlurPx : 0
      ctx.shadowOffsetX = text.shadowEnabled ? text.shadowOffsetXPx : 0
      ctx.shadowOffsetY = text.shadowEnabled ? text.shadowOffsetYPx : 0
      ctx.fillText(lines[index], x, y)
    }
  } finally {
    ctx.restore()
  }
}

function idsNotIn(left: ClipId[], right: ClipId[]): ClipId[] {
  const seen = new Set(left)
  return right.filter((id) => !seen.has(id))
}

/**
 * Render complete legs normally, add their weighted premultiplied pixels
 * with Porter-Duff plus (`lighter`), then source-over the isolated group onto
 * lower tracks exactly once.
 */
async function compositeTransitionGroup(
  doc: TimelineDoc,
  destination: Composite2D,
  surfaceProvider: TransitionSurfaceProvider,
  requests: readonly [PlannedCrossfadeFrameRequest, PlannedCrossfadeFrameRequest],
  blendMode: BlendModeResolution,
  imagesByClipId: ReadonlyMap<ClipId, RenderFrameSource | null>,
  drawn: ClipId[],
  missing: ClipId[],
  presentationScale: { readonly x: number; readonly y: number },
  lensRemapProvider: LensRemapProvider | null | undefined,
  videoEffectStageExecutor: VideoEffectStageExecutor | null | undefined,
  timelineFrame: number,
): Promise<void> {
  const ready: ClipId[] = []
  const surfaceWidth = Math.max(1, Math.round(doc.width * presentationScale.x))
  const surfaceHeight = Math.max(1, Math.round(doc.height * presentationScale.y))
  let borrowedSurfaces: TransitionSurfaces | null = null

  try {
    const surfaces = surfaceProvider.get()
    borrowedSurfaces = surfaces
    inPresentationSpace(surfaces.group.ctx, presentationScale, () => {
      clearSurface(surfaces.group.ctx, doc)
    })

    for (const request of requests) {
      if (request.opacity <= 0 || request.weight <= 0) continue
      const image = imagesByClipId.get(request.clip.id) ?? null
      if (!image) {
        missing.push(request.clip.id)
        continue
      }

      try {
        const correctedImage = correctedSourceForClip(
          request.clip,
          image,
          lensRemapProvider,
        )
        const orderedPixelPath = request.effectStagePlan?.requiresOrderedPixelPath === true
          && supportsCanvasEffectPixels(surfaces.leg.ctx)
        if (
          request.effectStagePlan?.requiresOrderedPixelPath
          && !orderedPixelPath
          && videoEffectStageExecutor?.bypassPolicy === 'fail'
        ) {
          throw new VideoEffectStageExecutionError(
            'Canvas pixel access is unavailable for fail-closed plugin transition composition',
          )
        }
        const pixelEffects = orderedPixelPath
          || requiresPixelEffects(surfaces.leg.ctx, request.clip)
        inPresentationSpace(surfaces.leg.ctx, presentationScale, () => {
          clearSurface(surfaces.leg.ctx, doc)
          drawClip(
            surfaces.leg.ctx,
            doc,
            request,
            correctedImage,
            NORMAL_BLEND_MODE,
            !pixelEffects,
            pixelEffects ? 1 : request.opacity,
          )
        })
        if (orderedPixelPath) {
          await applyPlannedEffectsToSurface(
            surfaces.leg.ctx,
            request.effectStagePlan!,
            videoEffectStageExecutor,
            surfaceWidth,
            surfaceHeight,
            doc,
            timelineFrame,
          )
        } else {
          applyPixelEffectsToSurface(
            surfaces.leg.ctx,
            request.clip,
            surfaceWidth,
            surfaceHeight,
            doc,
          )
        }

        inPresentationSpace(surfaces.group.ctx, presentationScale, () => {
          surfaces.group.ctx.globalAlpha = request.weight
            * (pixelEffects ? request.opacity : 1)
          surfaces.group.ctx.globalCompositeOperation = 'lighter'
          surfaces.group.ctx.drawImage(
            surfaces.leg.canvas,
            0,
            0,
            surfaceWidth,
            surfaceHeight,
            0,
            0,
            doc.width,
            doc.height,
          )
        })
        ready.push(request.clip.id)
      } catch (e) {
        rethrowLensRemapUnavailable(e)
        rethrowVideoEffectStageExecutionError(e)
        console.warn(
          `[render] drawing transition clip "${request.clip.id}" failed:`,
          e instanceof Error ? e.message : e,
        )
        missing.push(request.clip.id)
      }
    }

    if (ready.length === 0) return

    destination.save()
    try {
      destination.globalAlpha = 1
      applyCanvasBlendMode(destination, blendMode)
      destination.drawImage(
        surfaces.group.canvas,
        0,
        0,
        surfaceWidth,
        surfaceHeight,
        0,
        0,
        doc.width,
        doc.height,
      )
    } finally {
      destination.restore()
    }
    drawn.push(...ready)
  } catch (e) {
    rethrowLensRemapUnavailable(e)
    rethrowVideoEffectStageExecutionError(e)
    console.warn(
      '[render] drawing isolated transition group failed:',
      e instanceof Error ? e.message : e,
    )
    missing.push(...idsNotIn(
      missing,
      requests
        .filter((request) => request.opacity > 0 && request.weight > 0)
        .map((request) => request.clip.id),
    ))
  } finally {
    if (borrowedSurfaces) {
      releaseSurfacePixels(borrowedSurfaces.leg.ctx, doc, presentationScale)
      releaseSurfacePixels(borrowedSurfaces.group.ctx, doc, presentationScale)
    }
  }
}

function inPresentationSpace(
  ctx: Composite2D,
  scale: { readonly x: number; readonly y: number },
  draw: () => void,
): void {
  ctx.save()
  try {
    if (scale.x !== 1 || scale.y !== 1) ctx.scale(scale.x, scale.y)
    draw()
  } finally {
    ctx.restore()
  }
}

function clearSurface(ctx: Composite2D, doc: TimelineDoc): void {
  ctx.save()
  try {
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, doc.width, doc.height)
  } finally {
    ctx.restore()
  }
}

/**
 * Draw one clip's image with its Transform + opacity. The image's natural
 * size is its pixel size; the default placement (identity Transform)
 * centers it in the composition. Order around the anchor: scale, then
 * rotate, then translate — expressed to Canvas2D in reverse because
 * context transforms compose right-to-left.
 */
function drawClip(
  ctx: Composite2D,
  doc: TimelineDoc,
  request: VideoFrameRequest,
  image: CanvasImageSource,
  blendMode: BlendModeResolution,
  applyEffects = true,
  opacity = request.opacity,
): void {
  const clip: Clip = request.clip
  const t = clip.transform
  const visual = clipVisualSettings(clip)
  const dimensions = image as unknown as {
    readonly displayWidth?: number
    readonly displayHeight?: number
    readonly width?: number
    readonly height?: number
    readonly videoWidth?: number
    readonly videoHeight?: number
    readonly naturalWidth?: number
    readonly naturalHeight?: number
  }
  const imageWidth = dimensions.displayWidth
    ?? dimensions.videoWidth
    ?? dimensions.naturalWidth
    ?? dimensions.width
  const imageHeight = dimensions.displayHeight
    ?? dimensions.videoHeight
    ?? dimensions.naturalHeight
    ?? dimensions.height
  if (
    typeof imageWidth !== 'number'
    || typeof imageHeight !== 'number'
    || !Number.isFinite(imageWidth)
    || !Number.isFinite(imageHeight)
  ) {
    throw new Error('render source dimensions are unavailable')
  }
  // Anchor point in image pixels.
  const anchorX = t.anchorX * imageWidth
  const anchorY = t.anchorY * imageHeight
  // Where the anchor lands on the canvas: centered default + x/y offset.
  const canvasX = (doc.width - imageWidth) / 2 + anchorX + t.x
  const canvasY = (doc.height - imageHeight) / 2 + anchorY + t.y

  ctx.save()
  try {
    ctx.globalAlpha = opacity
    applyCanvasBlendMode(ctx, blendMode)
    if (applyEffects) applyCanvasEffectStack(ctx, clip)
    ctx.translate(canvasX, canvasY)
    ctx.rotate((t.rotation * Math.PI) / 180)
    ctx.scale(
      t.scaleX * (visual.flipHorizontal ? -1 : 1),
      t.scaleY * (visual.flipVertical ? -1 : 1),
    )
    const crop = visual.crop
    if (crop.left === 0 && crop.right === 0 && crop.top === 0 && crop.bottom === 0) {
      ctx.drawImage(image, -anchorX, -anchorY)
    } else {
      const sourceX = crop.left * imageWidth
      const sourceY = crop.top * imageHeight
      const sourceWidth = imageWidth * (1 - crop.left - crop.right)
      const sourceHeight = imageHeight * (1 - crop.top - crop.bottom)
      ctx.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        -anchorX + sourceX,
        -anchorY + sourceY,
        sourceWidth,
        sourceHeight,
      )
    }
  } finally {
    ctx.restore()
  }
}

function compositePixelCorrectedMediaLayer(
  doc: TimelineDoc,
  destination: Composite2D,
  surfaceProvider: TransitionSurfaceProvider,
  request: VideoFrameRequest,
  image: CanvasImageSource,
  blendMode: BlendModeResolution,
  presentationScale: { readonly x: number; readonly y: number },
): void {
  const surfaces = surfaceProvider.get()
  const surfaceWidth = Math.max(1, Math.round(doc.width * presentationScale.x))
  const surfaceHeight = Math.max(1, Math.round(doc.height * presentationScale.y))
  try {
    inPresentationSpace(surfaces.leg.ctx, presentationScale, () => {
      clearSurface(surfaces.leg.ctx, doc)
      drawClip(
        surfaces.leg.ctx,
        doc,
        request,
        image,
        NORMAL_BLEND_MODE,
        false,
        1,
      )
    })
    applyPixelEffectsToSurface(
      surfaces.leg.ctx,
      request.clip,
      surfaceWidth,
      surfaceHeight,
      doc,
    )
    destination.save()
    try {
      destination.globalAlpha = request.opacity
      applyCanvasBlendMode(destination, blendMode)
      destination.drawImage(
        surfaces.leg.canvas,
        0,
        0,
        surfaceWidth,
        surfaceHeight,
        0,
        0,
        doc.width,
        doc.height,
      )
    } finally {
      destination.restore()
    }
  } finally {
    releaseSurfacePixels(surfaces.leg.ctx, doc, presentationScale)
  }
}

/** Isolate one complete media layer for a unified authored-order pixel plan. */
async function compositeOrderedPixelMediaLayer(
  doc: TimelineDoc,
  destination: Composite2D,
  surfaces: TransitionSurfaces,
  request: PlannedVideoFrameRequest,
  image: CanvasImageSource,
  blendMode: BlendModeResolution,
  presentationScale: { readonly x: number; readonly y: number },
  effectStagePlan: VideoEffectStagePlan,
  videoEffectStageExecutor: VideoEffectStageExecutor | null | undefined,
  timelineFrame: number,
): Promise<void> {
  const surfaceWidth = Math.max(1, Math.round(doc.width * presentationScale.x))
  const surfaceHeight = Math.max(1, Math.round(doc.height * presentationScale.y))
  try {
    inPresentationSpace(surfaces.leg.ctx, presentationScale, () => {
      clearSurface(surfaces.leg.ctx, doc)
      drawClip(
        surfaces.leg.ctx,
        doc,
        request,
        image,
        NORMAL_BLEND_MODE,
        false,
        1,
      )
    })
    await applyPlannedEffectsToSurface(
      surfaces.leg.ctx,
      effectStagePlan,
      videoEffectStageExecutor,
      surfaceWidth,
      surfaceHeight,
      doc,
      timelineFrame,
    )
    destination.save()
    try {
      destination.globalAlpha = request.opacity
      applyCanvasBlendMode(destination, blendMode)
      destination.drawImage(
        surfaces.leg.canvas,
        0,
        0,
        surfaceWidth,
        surfaceHeight,
        0,
        0,
        doc.width,
        doc.height,
      )
    } finally {
      destination.restore()
    }
  } finally {
    releaseSurfacePixels(surfaces.leg.ctx, doc, presentationScale)
  }
}

/** Best-effort release of scratch pixels without transferring surface ownership. */
function releaseSurfacePixels(
  ctx: Composite2D,
  doc: TimelineDoc,
  presentationScale: { readonly x: number; readonly y: number },
): void {
  try {
    inPresentationSpace(ctx, presentationScale, () => clearSurface(ctx, doc))
  } catch {
    // The render result already records the drawing failure; cleanup must not mask it.
  }
}

/** Render procedural text into one transparent layer, then blend it once. */
async function compositeTextLayer(
  doc: TimelineDoc,
  destination: Composite2D,
  surfaceProvider: TransitionSurfaceProvider,
  clip: Clip,
  opacity: number,
  blendMode: BlendModeResolution,
  presentationScale: { readonly x: number; readonly y: number },
  effectStagePlan: VideoEffectStagePlan | undefined,
  videoEffectStageExecutor: VideoEffectStageExecutor | null | undefined,
  timelineFrame: number,
): Promise<void> {
  const surfaces = surfaceProvider.get()
  const surfaceWidth = Math.max(1, Math.round(doc.width * presentationScale.x))
  const surfaceHeight = Math.max(1, Math.round(doc.height * presentationScale.y))
  try {
    inPresentationSpace(surfaces.leg.ctx, presentationScale, () => {
      clearSurface(surfaces.leg.ctx, doc)
      drawTextClip(surfaces.leg.ctx, doc, clip, 1, NORMAL_BLEND_MODE)
    })

    const orderedPixelPath = effectStagePlan?.requiresOrderedPixelPath === true
      && supportsCanvasEffectPixels(surfaces.leg.ctx)
    if (
      effectStagePlan?.requiresOrderedPixelPath
      && !orderedPixelPath
      && videoEffectStageExecutor?.bypassPolicy === 'fail'
    ) {
      throw new VideoEffectStageExecutionError(
        'Canvas pixel access is unavailable for fail-closed plugin text composition',
      )
    }
    const pixelCorrection = orderedPixelPath || requiresPixelEffects(surfaces.leg.ctx, clip)
    if (orderedPixelPath) {
      await applyPlannedEffectsToSurface(
        surfaces.leg.ctx,
        effectStagePlan,
        videoEffectStageExecutor,
        surfaceWidth,
        surfaceHeight,
        doc,
        timelineFrame,
      )
    } else if (pixelCorrection) {
      applyPixelEffectsToSurface(
        surfaces.leg.ctx,
        clip,
        surfaceWidth,
        surfaceHeight,
        doc,
      )
    }

    destination.save()
    try {
      destination.globalAlpha = opacity
      applyCanvasBlendMode(destination, blendMode)
      // Filter the completed transparent text layer once. Applying filters
      // while painting its background/stroke/fill primitives changes their
      // overlap semantics and compounds the authored stack.
      if (!pixelCorrection) applyCanvasEffectStack(destination, clip)
      destination.drawImage(
        surfaces.leg.canvas,
        0,
        0,
        surfaceWidth,
        surfaceHeight,
        0,
        0,
        doc.width,
        doc.height,
      )
    } finally {
      destination.restore()
    }
  } finally {
    releaseSurfacePixels(surfaces.leg.ctx, doc, presentationScale)
  }
}

function applyCanvasBlendMode(
  ctx: Composite2D,
  blendMode: BlendModeResolution,
): void {
  const capability = probeCanvasBlendMode(ctx, blendMode.effective)
  ctx.globalCompositeOperation = capability.operation
}

/**
 * Apply an ordered effect chain to the next draw only. The caller owns a
 * save/restore boundary. Empty, disabled, invalid, and unsupported stacks do
 * not write `filter`, preserving the exact historical no-effect path.
 */
function applyCanvasEffectStack(ctx: Composite2D, clip: Clip): void {
  const supportsCanvasFilter = supportsCanvasEffectFilter(ctx)
  const resolution = resolveCanvasEffectStack(
    clip.effects,
    supportsCanvasFilter,
    supportsCanvasEffectPixels(ctx),
  )
  if (resolution.filter !== null && supportsCanvasFilter) ctx.filter = resolution.filter
}

function requiresPixelEffects(ctx: Composite2D, clip: Clip): boolean {
  return resolveCanvasEffectStack(
    clip.effects,
    supportsCanvasEffectFilter(ctx),
    supportsCanvasEffectPixels(ctx),
  ).pixelEffects.length > 0
}

async function applyPlannedEffectsToSurface(
  ctx: Composite2D,
  plan: VideoEffectStagePlan,
  executor: VideoEffectStageExecutor | null | undefined,
  width: number,
  height: number,
  doc: Pick<TimelineDoc, 'width' | 'height' | 'frameRate'>,
  timelineFrame: number,
): Promise<void> {
  if (
    !supportsCanvasEffectPixels(ctx)
    || !ctx.getImageData
    || !ctx.putImageData
  ) {
    throw new Error('Canvas pixel access is unavailable for ordered effect composition')
  }
  const imageData = ctx.getImageData(0, 0, width, height)
  await applyVideoEffectStagePlanToRgba(imageData.data, plan, executor, {
    timelineFrame,
    frameRate: doc.frameRate,
    surfaceWidth: width,
    surfaceHeight: height,
    projectWidth: doc.width,
    projectHeight: doc.height,
  })
  ctx.putImageData(imageData, 0, 0)
}

function applyPixelEffectsToSurface(
  ctx: Composite2D,
  clip: Clip,
  width: number,
  height: number,
  doc: Pick<TimelineDoc, 'width' | 'height'>,
): void {
  const resolution = resolveCanvasEffectStack(
    clip.effects,
    supportsCanvasEffectFilter(ctx),
    supportsCanvasEffectPixels(ctx),
  )
  if (resolution.pixelEffects.length === 0) return
  if (
    !supportsCanvasEffectPixels(ctx)
    || !ctx.getImageData
    || !ctx.putImageData
  ) {
    throw new Error('Canvas pixel access became unavailable during effect composition')
  }
  const imageData = ctx.getImageData(0, 0, width, height)
  applyOrderedPixelEffectsToRgba(imageData.data, resolution.pixelEffects, {
    surfaceWidth: width,
    surfaceHeight: height,
    projectWidth: doc.width,
    projectHeight: doc.height,
  })
  ctx.putImageData(imageData, 0, 0)
}

/**
 * Apply one full-frame adjustment by borrowing the existing leg surface.
 * This adds no persistent 4K allocation: the same scratch surface already
 * owned by transition, text, lens, and ordered-effect composition is reused.
 */
function compositePostCompositeAdjustment(
  doc: TimelineDoc,
  destination: Composite2D,
  surfaceProvider: TransitionSurfaceProvider,
  adjustment: AdjustmentItem,
  presentationScale: { readonly x: number; readonly y: number },
): void {
  const surfaces = surfaceProvider.get()
  const resolution = resolvePostCompositeEffectStack(
    adjustment.effects,
    supportsCanvasEffectPixels(surfaces.leg.ctx),
  )
  if (resolution.pixelEffects.length === 0) return
  if (!destination.canvas) {
    throw new Error('destination canvas access is unavailable')
  }
  if (
    !supportsCanvasEffectPixels(surfaces.leg.ctx)
    || !surfaces.leg.ctx.getImageData
    || !surfaces.leg.ctx.putImageData
  ) return

  const surfaceWidth = Math.max(1, Math.round(doc.width * presentationScale.x))
  const surfaceHeight = Math.max(1, Math.round(doc.height * presentationScale.y))
  try {
    surfaces.leg.ctx.save()
    try {
      surfaces.leg.ctx.globalAlpha = 1
      surfaces.leg.ctx.globalCompositeOperation = 'source-over'
      surfaces.leg.ctx.clearRect(0, 0, surfaceWidth, surfaceHeight)
      surfaces.leg.ctx.drawImage(
        destination.canvas,
        0,
        0,
        surfaceWidth,
        surfaceHeight,
        0,
        0,
        surfaceWidth,
        surfaceHeight,
      )
    } finally {
      surfaces.leg.ctx.restore()
    }

    const imageData = surfaces.leg.ctx.getImageData(
      0,
      0,
      surfaceWidth,
      surfaceHeight,
    )
    applyOrderedPixelEffectsToRgba(imageData.data, resolution.pixelEffects, {
      surfaceWidth,
      surfaceHeight,
      projectWidth: doc.width,
      projectHeight: doc.height,
    })
    surfaces.leg.ctx.putImageData(imageData, 0, 0)

    destination.save()
    try {
      destination.globalAlpha = adjustment.opacity
      destination.globalCompositeOperation = 'source-over'
      destination.drawImage(
        surfaces.leg.canvas,
        0,
        0,
        surfaceWidth,
        surfaceHeight,
        0,
        0,
        doc.width,
        doc.height,
      )
    } finally {
      destination.restore()
    }
  } finally {
    releaseSurfacePixels(surfaces.leg.ctx, doc, presentationScale)
  }
}
