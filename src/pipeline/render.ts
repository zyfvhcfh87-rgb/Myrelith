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
 *   valid until compositeFrame's returned promise settles — it draws
 *   synchronously after the fetch phase, never holding images across a
 *   yield.
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
  type VideoCompositionPlan,
} from '../domain/videoCompositionPlan'
import type {
  CrossfadeFrameRequest,
  VideoFrameRequest,
} from '../domain/crossfadePlan'
import { clipVisualSettings } from '../domain/clipInspector'
import {
  DEFAULT_BLEND_MODE,
  resolveBlendMode,
  type BlendModeResolution,
} from '../domain/blendModes'
import { probeCanvasBlendMode } from './blendModeCapabilities'
import {
  resolveCanvasEffectStack,
  supportsCanvasEffectFilter,
  supportsCanvasEffectPixels,
} from '../domain/effectStack'
import { applyOrderedPixelEffectsToRgba } from '../domain/effectPixels'

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
 * Preview and export own separate pairs so concurrent renders cannot overwrite
 * one another. The compositor clears and reuses surfaces on every borrowed path.
 */
export interface TransitionSurfaces {
  /** Renders one complete transformed clip with ordinary source-over rules. */
  leg: CompositeSurface
  /** Adds weighted premultiplied legs before one destination source-over. */
  group: CompositeSurface
}

/** Lazily supplies caller-owned persistent surfaces when a layer needs isolation. */
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

/**
 * Composite timeline `frame` of `doc` onto `ctx`: black background, then
 * each visible video track's active clip bottom-to-top (tracks[0] first),
 * with the clip Transform (scale → rotate → translate around the anchor)
 * and opacity applied. Never rejects; per-clip failures land in `missing`.
 */
export async function compositeFrame(
  doc: TimelineDoc,
  plan: VideoCompositionPlan,
  ctx: Composite2D,
  source: FrameSource,
  transitionSurfaceProvider: TransitionSurfaceProvider,
  presentation?: PresentationProfile,
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
  const imagesByRequest = new Map<
    VideoFrameRequest,
    RenderFrameSource | null
  >()
  for (let index = 0; index < requests.length; index++) {
    imagesByRequest.set(requests[index], images[index])
  }

  // Phase 3 — draw synchronously (no yields: images stay valid throughout).
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
      if (item.kind === 'crossfade') {
        compositeTransitionGroup(
          doc,
          ctx,
          transitionSurfaceProvider,
          item.requests,
          item.blendMode,
          imagesByRequest,
          drawn,
          missing,
          presentationScale,
        )
        continue
      }

      if (item.kind === 'text') {
        try {
          compositeTextLayer(
            doc,
            ctx,
            transitionSurfaceProvider,
            item.clip,
            item.opacity,
            item.blendMode,
            presentationScale,
          )
          drawn.push(item.clip.id)
        } catch (e) {
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
      const image = imagesByRequest.get(request) ?? null
      if (!image) {
        missing.push(clip.id)
        continue
      }
      try {
        if (requiresPixelEffects(ctx, clip)) {
          compositePixelCorrectedMediaLayer(
            doc,
            ctx,
            transitionSurfaceProvider,
            request,
            image,
            item.blendMode,
            presentationScale,
          )
        } else {
          drawClip(ctx, doc, request, image, item.blendMode)
        }
        drawn.push(clip.id)
      } catch (e) {
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
function compositeTransitionGroup(
  doc: TimelineDoc,
  destination: Composite2D,
  surfaceProvider: TransitionSurfaceProvider,
  requests: readonly [CrossfadeFrameRequest, CrossfadeFrameRequest],
  blendMode: BlendModeResolution,
  imagesByRequest: ReadonlyMap<VideoFrameRequest, RenderFrameSource | null>,
  drawn: ClipId[],
  missing: ClipId[],
  presentationScale: { readonly x: number; readonly y: number },
): void {
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
      const image = imagesByRequest.get(request) ?? null
      if (!image) {
        missing.push(request.clip.id)
        continue
      }

      try {
        const pixelEffects = requiresPixelEffects(surfaces.leg.ctx, request.clip)
        inPresentationSpace(surfaces.leg.ctx, presentationScale, () => {
          clearSurface(surfaces.leg.ctx, doc)
          drawClip(
            surfaces.leg.ctx,
            doc,
            request,
            image,
            NORMAL_BLEND_MODE,
            !pixelEffects,
            pixelEffects ? 1 : request.opacity,
          )
        })
        applyPixelEffectsToSurface(
          surfaces.leg.ctx,
          request.clip,
          surfaceWidth,
          surfaceHeight,
          doc,
        )

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
  image: RenderFrameSource,
  blendMode: BlendModeResolution,
  applyEffects = true,
  opacity = request.opacity,
): void {
  const clip: Clip = request.clip
  const t = clip.transform
  const visual = clipVisualSettings(clip)
  const imageWidth = 'displayWidth' in image ? image.displayWidth : image.width
  const imageHeight = 'displayHeight' in image ? image.displayHeight : image.height
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
  image: RenderFrameSource,
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
function compositeTextLayer(
  doc: TimelineDoc,
  destination: Composite2D,
  surfaceProvider: TransitionSurfaceProvider,
  clip: Clip,
  opacity: number,
  blendMode: BlendModeResolution,
  presentationScale: { readonly x: number; readonly y: number },
): void {
  const surfaces = surfaceProvider.get()
  const surfaceWidth = Math.max(1, Math.round(doc.width * presentationScale.x))
  const surfaceHeight = Math.max(1, Math.round(doc.height * presentationScale.y))
  try {
    inPresentationSpace(surfaces.leg.ctx, presentationScale, () => {
      clearSurface(surfaces.leg.ctx, doc)
      drawTextClip(surfaces.leg.ctx, doc, clip, 1, NORMAL_BLEND_MODE)
    })

    const pixelCorrection = requiresPixelEffects(surfaces.leg.ctx, clip)
    if (pixelCorrection) {
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
