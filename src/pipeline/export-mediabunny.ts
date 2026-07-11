/**
 * pipeline/export-mediabunny.ts — browser adapters for video-only export.
 *
 * Decoding owns one Mediabunny Input/CanvasSink per asset. CanvasSink's
 * pooled canvas is copied immediately into a lease-owned ImageBitmap so a
 * later decode can never mutate pixels still being composited. Encoding owns
 * one OffscreenCanvas + CanvasSource + MP4 Output and awaits every write.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  canEncodeVideo,
} from 'mediabunny'
import type { AssetId, TimelineDoc } from '../domain/schema'
import {
  activeClipAt,
  clipSourceFrame,
  docDurationFrames,
} from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import type {
  ExportDeps,
  ExportFrameLease,
  ExportMediaSource,
  ExportResult,
  ExportSettings,
  ExportVideoSink,
} from './export'
import { compositeFrame, type Composite2D } from './render'

/** Resolves the session Blob/File behind a timeline asset id. */
export type ExportAssetResolver = (
  assetId: AssetId,
) => Blob | Promise<Blob>

interface DecodedAsset {
  input: Input
  sink: CanvasSink
  sourceFrames: readonly number[]
  canvases: ReturnType<CanvasSink['canvasesAtTimestamps']>
  nextRequestIndex: number
  /** Same-asset decodes serialize so the one-canvas pool is never reused early. */
  decodeTail: Promise<void>
}

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
function videoRequestSchedule(doc: TimelineDoc): Map<AssetId, number[]> {
  const frameCount = docDurationFrames(doc)
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError('Cannot schedule an invalid export timeline')
  }

  const requests = new Map<AssetId, number[]>()
  for (let frame = 0; frame < frameCount; frame++) {
    // Keep this filtering and track order aligned with compositeFrame.
    for (const track of doc.tracks) {
      if (track.kind !== 'video' || track.hidden) continue
      const clip = activeClipAt(track, frame)
      if (!clip || clip.text !== undefined || clip.opacity <= 0) continue
      const sourceFrame = clipSourceFrame(clip, frame)
      const assetRequests = requests.get(clip.assetId)
      if (assetRequests) assetRequests.push(sourceFrame)
      else requests.set(clip.assetId, [sourceFrame])
    }
  }
  return requests
}

/**
 * Creates the real browser media source consumed by exportTimeline.
 * Inputs open lazily and stay alive until the whole export closes.
 */
export function createMediabunnyExportMediaSource(
  doc: TimelineDoc,
  resolveAsset: ExportAssetResolver,
): ExportMediaSource {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }
  // Validate the rational once, while retaining independent per-frame math.
  framesToSeconds(0, doc.frameRate)
  if (typeof createImageBitmap !== 'function') {
    throw new Error('ImageBitmap creation is not supported in this browser')
  }

  const sessions = new Map<AssetId, Promise<DecodedAsset>>()
  const openInputs = new Set<Input>()
  const requests = videoRequestSchedule(doc)
  let closed = false
  let closePromise: Promise<void> | null = null

  const openAsset = (assetId: AssetId): Promise<DecodedAsset> => {
    const cached = sessions.get(assetId)
    if (cached) return cached

    const pending = (async (): Promise<DecodedAsset> => {
      if (closed) throw new Error('Export media source is closed')
      const sourceFrames = requests.get(assetId)
      if (!sourceFrames || sourceFrames.length === 0) {
        throw new Error(`Export asset "${assetId}" was not scheduled`)
      }
      const blob = await resolveAsset(assetId)
      if (closed) throw new Error('Export media source is closed')

      const input = new Input({
        source: new BlobSource(blob),
        formats: ALL_FORMATS,
      })
      openInputs.add(input)

      try {
        const track = await input.getPrimaryVideoTrack()
        if (!track) {
          throw new Error(`Export asset "${assetId}" has no video track`)
        }
        if (!(await track.canDecode())) {
          throw new Error(
            `Export asset "${assetId}" cannot be decoded in this browser`,
          )
        }
        if (closed) throw new Error('Export media source is closed')

        const sink = new CanvasSink(track, { poolSize: 1 })
        const timestamps = sourceFrames.map((sourceFrame) =>
          framesToSeconds(sourceFrame, doc.frameRate),
        )
        return {
          input,
          sink,
          sourceFrames,
          canvases: sink.canvasesAtTimestamps(timestamps),
          nextRequestIndex: 0,
          decodeTail: Promise.resolve(),
        }
      } catch (cause) {
        input.dispose()
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

    const bitmaps = new Set<ImageBitmap>()
    let leaseClosed = false

    return {
      getFrame: async (
        assetId: AssetId,
        sourceFrame: number,
      ): Promise<ImageBitmap | null> => {
        assertFrame(sourceFrame, 'Source frame')
        if (closed || leaseClosed) {
          throw new Error('Export frame lease is closed')
        }

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

        const decode = async (): Promise<ImageBitmap | null> => {
          if (closed || leaseClosed) {
            throw new Error('Export frame lease is closed')
          }
          const step = await asset.canvases.next()
          if (step.done) {
            throw new Error(
              `Export asset "${assetId}" decode stream ended early`,
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
        closeBitmaps(bitmaps)
      },
    }
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      const settled = await Promise.allSettled(sessions.values())
      await Promise.all(
        settled.flatMap((entry) =>
          entry.status === 'fulfilled' ? [entry.value.decodeTail] : [],
        ),
      )

      let failure: unknown
      for (const entry of settled) {
        if (entry.status !== 'fulfilled') continue
        try {
          await entry.value.canvases.return()
        } catch (cause) {
          failure ??= cause
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

function assertVideoSinkInputs(
  doc: TimelineDoc,
  settings: ExportSettings,
): number {
  if (settings.format !== 'mp4' || settings.videoCodec !== 'avc') {
    throw new TypeError('Mediabunny video export supports MP4/AVC only')
  }
  if (
    !Number.isSafeInteger(settings.videoBitrate) ||
    settings.videoBitrate <= 0
  ) {
    throw new TypeError('videoBitrate must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.width) || doc.width <= 0) {
    throw new RangeError('Export width must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.height) || doc.height <= 0) {
    throw new RangeError('Export height must be a positive safe integer')
  }
  framesToSeconds(1, doc.frameRate)
  return doc.frameRate.num / doc.frameRate.den
}

async function cancelSetup(output: Output, primary: unknown): Promise<never> {
  try {
    await output.cancel()
  } catch {
    // The setup failure remains primary; Output owns its own cancel promise.
  }
  throw primary
}

/** Creates and starts the real Mediabunny AVC/MP4 sink. */
export async function createMediabunnyVideoSink(
  doc: TimelineDoc,
  settings: ExportSettings,
): Promise<ExportVideoSink> {
  const frameRate = assertVideoSinkInputs(doc, settings)
  const supported = await canEncodeVideo('avc', {
    width: doc.width,
    height: doc.height,
    bitrate: settings.videoBitrate,
  })
  if (!supported) {
    throw new Error(
      `AVC encoding is not supported for ${doc.width}x${doc.height} ` +
        `at ${settings.videoBitrate} bps`,
    )
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }

  const canvas = new OffscreenCanvas(doc.width, doc.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create the export 2D context')

  const target = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  })
  let source: CanvasSource
  try {
    source = new CanvasSource(canvas, {
      codec: 'avc',
      bitrate: settings.videoBitrate,
    })
    output.addVideoTrack(source, { frameRate })
    await output.start()
  } catch (cause) {
    return cancelSetup(output, cause)
  }

  type SinkState =
    | 'open'
    | 'finalizing'
    | 'finalized'
    | 'canceling'
    | 'canceled'
  let state: SinkState = 'open'
  let cancelPromise: Promise<void> | null = null

  const cancel = (): Promise<void> => {
    if (state === 'finalized' || state === 'canceled') {
      return Promise.resolve()
    }
    if (cancelPromise) return cancelPromise
    state = 'canceling'
    cancelPromise = (async () => {
      try {
        await output.cancel()
      } finally {
        state = 'canceled'
      }
    })()
    return cancelPromise
  }

  const failAfterCancel = async (primary: unknown): Promise<never> => {
    try {
      await cancel()
    } catch {
      // Preserve the encode/finalize failure over cleanup failure.
    }
    throw primary
  }

  const addFrame = async (
    timestampSec: number,
    durationSec: number,
  ): Promise<void> => {
    if (state !== 'open') throw new Error('Video export sink is closed')
    try {
      await source.add(timestampSec, durationSec)
    } catch (cause) {
      return failAfterCancel(cause)
    }
  }

  const finalize = async (): Promise<ExportResult> => {
    if (state !== 'open') throw new Error('Video export sink is closed')
    state = 'finalizing'
    try {
      source.close()
      await output.finalize()
    } catch (cause) {
      return failAfterCancel(cause)
    }

    state = 'finalized'
    if (target.buffer === null) {
      throw new Error('Mediabunny finalized without an output buffer')
    }
    return { buffer: target.buffer, mimeType: 'video/mp4' }
  }

  return {
    ctx: context as Composite2D,
    addFrame,
    finalize,
    cancel,
  }
}

/** Production dependencies for exportTimeline; the media resolver stays injected. */
export const mediabunnyExportDeps: ExportDeps = {
  composite: compositeFrame,
  createVideoSink: createMediabunnyVideoSink,
}
