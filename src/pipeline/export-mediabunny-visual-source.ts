/** Bounded Mediabunny/static-image visual source for timeline export. */

import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
} from 'mediabunny'
import {
  ensureMediaDecoderSupport,
  refineVideoDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type { AssetId, TimelineDoc } from '../domain/schema'
import type { PluginVideoEffectContributionSnapshot } from '../domain/pluginVideoEffectStagePlan'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  createVideoCompositionPlanner,
  videoCompositionRequests,
} from '../domain/videoCompositionPlan'
import type {
  ExportFrameLease,
  ExportMediaSource,
} from './export'
import {
  exportAssetError,
  type ExportAssetResolver,
  type ResolvedExportAsset,
} from './export-mediabunny-common'
import {
  decodeStaticImage,
  StaticImageDecodeError,
  type StaticImageRenderSource,
} from './static-image'

interface DecodedVideoAsset {
  kind: 'video'
  input: Input
  sink: CanvasSink
  sourceFrames: readonly number[]
  canvases: ReturnType<CanvasSink['canvasesAtTimestamps']>
  nextRequestIndex: number
  /** Same-asset decodes serialize so the one-canvas pool is never reused early. */
  decodeTail: Promise<void>
}

interface DecodedImageAsset {
  kind: 'image'
  source: StaticImageRenderSource
  sourceFrames: readonly number[]
  nextRequestIndex: number
}

type DecodedVisualAsset = DecodedVideoAsset | DecodedImageAsset

function assertFrame(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function closeBitmaps(bitmaps: Set<ImageBitmap>): void {
  let failure: unknown
  for (const bitmap of bitmaps) {
    try {
      bitmap.close()
    } catch (cause) {
      failure ??= cause
    }
  }
  bitmaps.clear()
  if (failure !== undefined) throw failure
}

/**
 * Build the exact per-asset request order compositeFrame will issue. Giving
 * that full stream to one canvasesAtTimestamps iterator keeps one decoder
 * alive per asset instead of creating a decoder for every exported frame.
 */
interface VideoFrameRequest {
  assetId: AssetId
  sourceFrame: number
}

interface VideoRequestSchedule {
  frameCount: number
  byAsset: Map<AssetId, number[]>
}

const EXPORT_SCHEDULE_YIELD_FRAMES = 32

function yieldExportSchedule(): Promise<void> {
  const scheduler = (globalThis as {
    scheduler?: { yield?: () => Promise<void> }
  }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(undefined)
    })
  }
  return Promise.resolve()
}

async function videoRequestSchedule(
  doc: TimelineDoc,
  planner: ReturnType<typeof createVideoCompositionPlanner>,
  closed: () => boolean,
): Promise<VideoRequestSchedule> {
  const frameCount = docDurationFrames(doc)
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError('Cannot schedule an invalid export timeline')
  }

  const byAsset = new Map<AssetId, number[]>()
  for (let frame = 0; frame < frameCount; frame++) {
    if (closed()) throw new Error('Export media source is closed')
    if (frame > 0 && frame % EXPORT_SCHEDULE_YIELD_FRAMES === 0) {
      await yieldExportSchedule()
      if (closed()) throw new Error('Export media source is closed')
    }
    const plan = planner.planFrame(frame)
    for (const request of videoCompositionRequests(plan)) {
      const assetRequests = byAsset.get(request.clip.assetId)
      if (assetRequests) assetRequests.push(request.sourceFrame)
      else byAsset.set(request.clip.assetId, [request.sourceFrame])
    }
  }
  return { frameCount, byAsset }
}

/**
 * Creates the real browser media source consumed by exportTimeline.
 * Inputs open lazily and stay alive until the whole export closes.
 */
export function createMediabunnyExportMediaSource(
  doc: TimelineDoc,
  resolveAsset: ExportAssetResolver,
  sourceBounds: SourceBoundsCatalog,
  pluginSnapshot?: PluginVideoEffectContributionSnapshot,
): ExportMediaSource {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }
  // Validate the rational once, while retaining independent per-frame math.
  framesToSeconds(0, doc.frameRate)
  const sessions = new Map<AssetId, Promise<DecodedVisualAsset>>()
  const openInputs = new Set<Input>()
  const planner = createVideoCompositionPlanner(doc, sourceBounds, pluginSnapshot)
  const imageAbort = new AbortController()
  let closed = false
  let closePromise: Promise<void> | null = null
  const schedulePromise = videoRequestSchedule(doc, planner, () => closed)

  const openAsset = (assetId: AssetId): Promise<DecodedVisualAsset> => {
    const cached = sessions.get(assetId)
    if (cached) return cached

    const pending = (async (): Promise<DecodedVisualAsset> => {
      if (closed) throw new Error('Export media source is closed')
      const requests = await schedulePromise
      const sourceFrames = requests.byAsset.get(assetId)
      if (!sourceFrames || sourceFrames.length === 0) {
        throw new Error(`Export asset "${assetId}" was not scheduled`)
      }
      let resolved: ResolvedExportAsset
      try {
        resolved = await resolveAsset(assetId)
      } catch (cause) {
        throw exportAssetError(
          assetId,
          null,
          'resource-unavailable',
          cause,
        )
      }
      const { blob } = resolved
      if (closed) throw new Error('Export media source is closed')

      if (resolved.kind === 'image') {
        let decoded: Awaited<ReturnType<typeof decodeStaticImage>>
        try {
          decoded = await decodeStaticImage(blob, { signal: imageAbort.signal })
        } catch (cause) {
          throw exportAssetError(
            assetId,
            null,
            cause instanceof StaticImageDecodeError
              && cause.reason === 'resource-limit'
              ? 'resource-limit'
              : 'decode-failed',
            cause,
          )
        }
        if (closed) {
          decoded.source.close()
          throw new Error('Export media source is closed')
        }
        return {
          kind: 'image',
          source: decoded.source,
          sourceFrames,
          nextRequestIndex: 0,
        }
      }
      if (resolved.kind !== 'video') {
        throw exportAssetError(
          assetId,
          'video',
          'decode-failed',
          new Error(
            `Export asset "${assetId}" is not a visual video or image source`,
          ),
        )
      }

      let input: Input
      try {
        input = new Input({
          source: new BlobSource(blob),
          formats: ALL_FORMATS,
        })
      } catch (cause) {
        throw exportAssetError(
          assetId,
          null,
          'resource-unavailable',
          cause,
        )
      }
      openInputs.add(input)

      try {
        let track: Awaited<ReturnType<Input['getPrimaryVideoTrack']>>
        try {
          track = await input.getPrimaryVideoTrack()
        } catch (cause) {
          throw exportAssetError(assetId, 'video', 'decode-failed', cause)
        }
        if (!track) {
          throw exportAssetError(
            assetId,
            'video',
            'decode-failed',
            new Error(`Export asset "${assetId}" has no video track`),
          )
        }
        let support: Awaited<ReturnType<typeof ensureMediaDecoderSupport>>
        try {
          const codec = await track.getCodec()
          const configuration = await track.getDecoderConfig()
          support = await ensureMediaDecoderSupport({
            codec,
            canDecode: () => track.canDecode(),
            configuration,
            trackKind: 'video',
            sourceId: assetId,
            boundary: 'export-video',
            policy: 'revalidate',
            budget: refineVideoDecoderBudget(
              resolved.budget,
              blob.size,
              configuration,
            ),
          })
        } catch (cause) {
          throw exportAssetError(assetId, 'video', 'decode-failed', cause)
        }
        if (!support.decodable) {
          throw exportAssetError(
            assetId,
            'video',
            support.failure.reason,
            new Error(
              `Export asset "${assetId}" cannot be decoded: ${support.failure.detail}`,
            ),
          )
        }
        if (closed) throw new Error('Export media source is closed')

        const timestamps = sourceFrames.map((sourceFrame) =>
          framesToSeconds(sourceFrame, doc.frameRate),
        )
        let sink: CanvasSink
        let canvases: ReturnType<CanvasSink['canvasesAtTimestamps']>
        try {
          sink = new CanvasSink(track, { poolSize: 1 })
          canvases = sink.canvasesAtTimestamps(timestamps)
        } catch (cause) {
          throw exportAssetError(assetId, 'video', 'decode-failed', cause)
        }
        return {
          kind: 'video',
          input,
          sink,
          sourceFrames,
          canvases,
          nextRequestIndex: 0,
          decodeTail: Promise.resolve(),
        }
      } catch (cause) {
        try {
          input.dispose()
        } catch {
          // Preserve the asset open/decode failure over disposal cleanup.
        }
        openInputs.delete(input)
        throw cause
      }
    })()

    sessions.set(assetId, pending)
    return pending
  }

  const openFrame = async (docFrame: number): Promise<ExportFrameLease> => {
    assertFrame(docFrame, 'Document frame')
    if (closed) throw new Error('Export media source is closed')
    const requests = await schedulePromise
    if (docFrame >= requests.frameCount) {
      throw new Error(`Export received an extra document frame ${docFrame}`)
    }
    const plan = planner.planFrame(docFrame)
    if (plan.frame !== docFrame) {
      throw new Error(`Export frame ${docFrame} has no visual plan`)
    }
    const frameRequests: VideoFrameRequest[] = videoCompositionRequests(plan)
      .map((request) => ({
        assetId: request.clip.assetId,
        sourceFrame: request.sourceFrame,
      }))

    const bitmaps = new Set<ImageBitmap>()
    let leaseClosed = false
    let nextFrameRequestIndex = 0

    return {
      plan,
      getFrame: async (
        assetId: AssetId,
        sourceFrame: number,
      ): Promise<StaticImageRenderSource | null> => {
        assertFrame(sourceFrame, 'Source frame')
        if (closed || leaseClosed) {
          throw new Error('Export frame lease is closed')
        }

        const frameRequest = frameRequests[nextFrameRequestIndex]
        if (!frameRequest) {
          throw new Error(
            `Export document frame ${docFrame} received an extra media request`,
          )
        }
        if (
          frameRequest.assetId !== assetId ||
          frameRequest.sourceFrame !== sourceFrame
        ) {
          throw new Error(
            `Export document frame ${docFrame} expected ` +
              `${frameRequest.assetId}@${frameRequest.sourceFrame}, got ` +
              `${assetId}@${sourceFrame}`,
          )
        }
        nextFrameRequestIndex++

        const asset = await openAsset(assetId)
        const expectedFrame = asset.sourceFrames[asset.nextRequestIndex]
        if (expectedFrame === undefined) {
          throw new Error(`Export asset "${assetId}" received an extra frame request`)
        }
        if (sourceFrame !== expectedFrame) {
          throw new Error(
            `Export asset "${assetId}" expected source frame ` +
              `${expectedFrame}, got ${sourceFrame}`,
          )
        }
        asset.nextRequestIndex++

        if (asset.kind === 'image') return asset.source
        if (typeof createImageBitmap !== 'function') {
          throw exportAssetError(
            assetId,
            'video',
            'decode-failed',
            new Error('ImageBitmap creation is not supported in this browser'),
          )
        }

        const decode = async (): Promise<ImageBitmap | null> => {
          if (closed || leaseClosed) {
            throw new Error('Export frame lease is closed')
          }
          let step: Awaited<ReturnType<typeof asset.canvases.next>>
          try {
            step = await asset.canvases.next()
          } catch (cause) {
            throw exportAssetError(assetId, 'video', 'decode-failed', cause)
          }
          if (step.done) {
            throw exportAssetError(
              assetId,
              'video',
              'decode-failed',
              new Error(
                `Export asset "${assetId}" decode stream ended early`,
              ),
            )
          }
          const wrapped = step.value
          if (!wrapped) return null

          const bitmap = await createImageBitmap(wrapped.canvas)
          if (closed || leaseClosed) {
            bitmap.close()
            throw new Error('Export frame lease is closed')
          }
          bitmaps.add(bitmap)
          return bitmap
        }

        const result = asset.decodeTail.then(decode, decode)
        asset.decodeTail = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      },
      close: (): void => {
        if (leaseClosed) return
        leaseClosed = true
        let failure: unknown
        try {
          closeBitmaps(bitmaps)
        } catch (cause) {
          failure = cause
        }
        if (
          nextFrameRequestIndex !== frameRequests.length &&
          failure === undefined
        ) {
          failure = new Error(
            `Export document frame ${docFrame} received ` +
              `${nextFrameRequestIndex} of ${frameRequests.length} ` +
              'scheduled media requests',
          )
        }
        if (failure !== undefined) throw failure
      },
    }
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    imageAbort.abort()
    closePromise = (async () => {
      await schedulePromise.catch(() => undefined)
      const settled = await Promise.allSettled(sessions.values())
      await Promise.all(
        settled.flatMap((entry) =>
          entry.status === 'fulfilled' && entry.value.kind === 'video'
            ? [entry.value.decodeTail]
            : [],
        ),
      )

      let failure: unknown
      for (const entry of settled) {
        if (entry.status !== 'fulfilled') continue
        if (entry.value.kind === 'image') {
          try {
            entry.value.source.close()
          } catch (cause) {
            failure ??= cause
          }
        } else {
          try {
            await entry.value.canvases.return()
          } catch (cause) {
            failure ??= cause
          }
        }
      }
      for (const input of openInputs) {
        try {
          input.dispose()
        } catch (cause) {
          failure ??= cause
        }
      }
      openInputs.clear()
      if (failure !== undefined) throw failure
    })()
    return closePromise
  }

  return { openFrame, close }
}
