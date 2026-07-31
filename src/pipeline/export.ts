/**
 * pipeline/export.ts — CFR timeline export orchestration.
 *
 * Browser decoding and A/V muxing are injected. This module owns validation,
 * integer-frame scheduling, compositeFrame reuse, encoder backpressure,
 * progress, and exact-once cleanup for per-frame and whole-export resources.
 */

import type { TimelineDoc } from '../domain/schema'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  compositeFrame,
  type Composite2D,
  type FrameSource,
  type TransitionSurfaceProvider,
} from './render'

export interface ExportSettings {
  format: 'mp4'
  videoCodec: 'avc'
  videoBitrate: number
}

export interface ExportResult {
  buffer: ArrayBuffer
  mimeType: 'video/mp4'
}

export interface ExportFrameLease extends FrameSource {
  /** Exact shared plan used to schedule every decode in this lease. */
  plan: VideoCompositionPlan
  close(): void | Promise<void>
}

export interface ExportMediaSource {
  openFrame(docFrame: number): Promise<ExportFrameLease>
  close(): void | Promise<void>
}

export interface ExportVideoSink {
  ctx: Composite2D
  transitionSurfaceProvider: TransitionSurfaceProvider
  /** Adds all encoded media belonging to this document frame. */
  addFrame(timestampSec: number, durationSec: number): Promise<void>
  finalize(): Promise<ExportResult>
  cancel(): Promise<void>
}

export interface ExportDeps {
  composite: typeof compositeFrame
  createVideoSink(
    doc: TimelineDoc,
    settings: ExportSettings,
  ): Promise<ExportVideoSink>
}

function assertSettings(settings: ExportSettings): void {
  if (typeof settings !== 'object' || settings === null) {
    throw new TypeError('Export settings must be an object')
  }
  if (settings.format !== 'mp4') {
    throw new TypeError('Unsupported export format: ' + settings.format)
  }
  if (settings.videoCodec !== 'avc') {
    throw new TypeError(
      'Unsupported export video codec: ' + settings.videoCodec,
    )
  }
  if (
    !Number.isSafeInteger(settings.videoBitrate) ||
    settings.videoBitrate <= 0
  ) {
    throw new TypeError('videoBitrate must be a positive safe integer')
  }
}

function exportFrameCount(doc: TimelineDoc): number {
  const frameCount = docDurationFrames(doc)
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError('Cannot export an empty or invalid timeline')
  }
  return frameCount
}

function assertBoundaryTime(
  value: number,
  label: 'timestamp' | 'duration',
): number {
  if (
    !Number.isFinite(value) ||
    (label === 'timestamp' ? value < 0 : value <= 0)
  ) {
    throw new RangeError('Invalid export frame ' + label + ': ' + value)
  }
  return value
}

async function compositeAndCloseLease(
  doc: TimelineDoc,
  frame: number,
  sink: ExportVideoSink,
  lease: ExportFrameLease,
  composite: typeof compositeFrame,
): Promise<void> {
  let failed = false
  let failure: unknown
  let sourceFailed = false
  let sourceFailure: unknown
  const observedSource: FrameSource = {
    getFrame: async (assetId, sourceFrame) => {
      try {
        return await lease.getFrame(assetId, sourceFrame)
      } catch (cause) {
        if (!sourceFailed) {
          sourceFailed = true
          sourceFailure = cause
        }
        throw cause
      }
    },
  }

  try {
    if (lease.plan.frame !== frame) {
      throw new Error('Export media lease returned a plan for the wrong frame')
    }
    const result = await composite(
      doc,
      lease.plan,
      sink.ctx,
      observedSource,
      sink.transitionSurfaceProvider,
    )
    // Preview intentionally softens source failures into `missing` so a later
    // repaint can recover. Export has no retry boundary: preserve the exact
    // adapter error (including typed asset identity) instead of replacing it
    // with the generic missing-media fallback below.
    if (sourceFailed) throw sourceFailure
    if (result.missing.length > 0) {
      throw new Error(
        'Missing source media for clips: ' + result.missing.join(', '),
      )
    }
  } catch (cause) {
    failed = true
    failure = cause
  }

  try {
    await lease.close()
  } catch (cause) {
    if (!failed) {
      failed = true
      failure = cause
    }
  }

  if (failed) throw failure
}

async function cleanupExport(
  sink: ExportVideoSink | null,
  sinkFinalized: boolean,
  closeMedia: () => Promise<void>,
  preserveOperationalFailure: boolean,
): Promise<void> {
  let cleanupFailed = false
  let cleanupFailure: unknown

  if (sink !== null && !sinkFinalized) {
    try {
      await sink.cancel()
    } catch (cause) {
      cleanupFailed = true
      cleanupFailure = cause
    }
  }

  try {
    await closeMedia()
  } catch (cause) {
    if (!cleanupFailed) {
      cleanupFailed = true
      cleanupFailure = cause
    }
  }

  if (!preserveOperationalFailure && cleanupFailed) throw cleanupFailure
}

export async function* exportTimeline(
  doc: TimelineDoc,
  settings: ExportSettings,
  media: ExportMediaSource,
  deps: ExportDeps,
): AsyncGenerator<number, ExportResult | undefined, void> {
  let sink: ExportVideoSink | null = null
  let sinkFinalized = false
  let mediaClosed = false
  let operationalFailure = false

  const closeMedia = async (): Promise<void> => {
    if (mediaClosed) return
    mediaClosed = true
    await media.close()
  }

  try {
    assertSettings(settings)
    const frameCount = exportFrameCount(doc)
    const frameDurationSec = assertBoundaryTime(
      framesToSeconds(1, doc.frameRate),
      'duration',
    )
    yield 0

    sink = await deps.createVideoSink(doc, settings)
    for (let frame = 0; frame < frameCount; frame++) {
      const lease = await media.openFrame(frame)
      await compositeAndCloseLease(
        doc,
        frame,
        sink,
        lease,
        deps.composite,
      )

      const timestampSec = assertBoundaryTime(
        framesToSeconds(frame, doc.frameRate),
        'timestamp',
      )
      await sink.addFrame(timestampSec, frameDurationSec)
      yield (frame + 1) / (frameCount + 1)
    }

    const result = await sink.finalize()
    sinkFinalized = true
    await closeMedia()
    yield 1
    return result
  } catch (cause) {
    operationalFailure = true
    throw cause
  } finally {
    await cleanupExport(
      sink,
      sinkFinalized,
      closeMedia,
      operationalFailure,
    )
  }
}
