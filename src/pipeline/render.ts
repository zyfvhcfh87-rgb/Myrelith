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
 * - The canvas must already be doc.width × doc.height with an IDENTITY
 *   transform and default state; compositeFrame restores whatever state it
 *   changes (per-clip save/restore, try/finally — a bad bitmap cannot
 *   poison the transform stack for the next composite).
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
 * - Visual selection, including crossfade source frames and opacity, comes
 *   only from domain.visibleVideoLayersAtFrame. Preview and export consume
 *   that same ordered plan and must never duplicate its rules.
 */

import type { AssetId, Clip, ClipId, TimelineDoc } from '../domain/schema'
import {
  visibleVideoLayersAtFrame,
  type VisibleVideoLayer,
} from '../domain/selectors'

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
  fillStyle: string | CanvasGradient | CanvasPattern
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angleRad: number): void
  scale(x: number, y: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  drawImage(image: RenderFrameSource, dx: number, dy: number): void
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
  frame: number,
  ctx: Composite2D,
  source: FrameSource,
): Promise<CompositeResult> {
  // Phase 1 — collect what needs pixels, bottom-to-top.
  const jobs = visibleVideoLayersAtFrame(doc, frame)

  // Phase 2 — fetch every needed frame concurrently.
  const images = await Promise.all(
    jobs.map((job) =>
      source.getFrame(job.clip.assetId, job.sourceFrame).catch((e) => {
        console.warn(
          `[render] getFrame failed for clip "${job.clip.id}":`,
          e instanceof Error ? e.message : e,
        )
        return null
      }),
    ),
  )

  // Phase 3 — draw synchronously (no yields: images stay valid throughout).
  const drawn: ClipId[] = []
  const missing: ClipId[] = []

  ctx.save()
  try {
    ctx.globalAlpha = 1
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, doc.width, doc.height)

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]
      const clip = job.clip
      const image = images[i]
      if (image === null) {
        missing.push(clip.id)
        continue
      }
      try {
        drawClip(ctx, doc, job, image)
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
  layer: VisibleVideoLayer,
  image: RenderFrameSource,
): void {
  const clip: Clip = layer.clip
  const t = clip.transform
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
    ctx.globalAlpha = layer.opacity
    ctx.translate(canvasX, canvasY)
    ctx.rotate((t.rotation * Math.PI) / 180)
    ctx.scale(t.scaleX, t.scaleY)
    ctx.drawImage(image, -anchorX, -anchorY)
  } finally {
    ctx.restore()
  }
}
