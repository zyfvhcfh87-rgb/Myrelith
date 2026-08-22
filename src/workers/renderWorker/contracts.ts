
import type { AssetId } from '../../domain/schema';
import type { VideoScopeAnalysis } from '../../domain/videoScopes';
import { type LocalDecoderBudget } from '../../codecs/mediaCodecFallbacks';
import type { Composite2D } from '../../pipeline/render';
import type { WebGl2LensRemapBackend } from '../../pipeline/lensRemapWebgl';
import { type DecodedStaticImage, type StaticImageDecodedByteReserver } from '../../pipeline/static-image';
import type { BitmapLike } from '../decode-types';
import { type LegacyRenderWorkerEnv } from '../render-legacy';
import type { FromRenderWorker } from '../render-protocol';
import type { DecodedVideoFrame, WorkerVideoSource } from '../video-source';

/** A larger forward gap is a discontinuity, not useful sequential catch-up. */
export const PLAYBACK_RESTART_GAP_US = 1_000_000

/* ------------------------------------------------------------------ */
/* Structural types for injectable browser deps                         */
/* ------------------------------------------------------------------ */

/**
 * The slice of OffscreenCanvas the worker uses. Its 2D context must
 * satisfy pipeline/render's Composite2D — the real
 * OffscreenCanvasRenderingContext2D does.
 */
export interface RenderCanvasLike {
  width: number
  height: number
  getContext(
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings,
  ): Composite2D | null
}

export const SRGB_2D_CONTEXT: CanvasRenderingContext2DSettings = {
  colorSpace: 'srgb',
}

/** Everything the core needs from the outside world. */
export interface RenderWorkerEnv extends LegacyRenderWorkerEnv {
  post(msg: FromRenderWorker, transfer?: Transferable[]): void
  /** Open one worker-owned Mediabunny source for a structured-cloned Blob. */
  openVideoSource(
    blob: Blob,
    sourceId: AssetId,
    budget: LocalDecoderBudget,
  ): Promise<WorkerVideoSource>
  /** Decode and transfer one bounded frame-zero image source to this owner. */
  decodeImage(
    blob: Blob,
    signal: AbortSignal,
    reserveDecodedBytes: StaticImageDecodedByteReserver,
  ): Promise<DecodedStaticImage>
  /** Forget session capability facts before an asset source changes. */
  invalidateDecoderSource(sourceId: AssetId): void
  /** Forget every realm-local capability fact when this worker closes. */
  invalidateDecoderRuntime(): void
  /** Normalize orientation and copy a streamed frame. Does not close it. */
  createStreamingBitmap(frame: DecodedVideoFrame): Promise<BitmapLike>
  /** Create the scratch compositing surface (new OffscreenCanvas). */
  createCanvas(width: number, height: number): RenderCanvasLike
  /** Create this worker owner's one reusable manual lens-remap backend. */
  createLensRemapBackend?(): WebGl2LensRemapBackend
  /** Yield non-critical analysis until after the current render task. */
  schedule?(callback: () => void): void
  /** Analyze the tiny scope sample away from the render worker when available. */
  analyzeVideoScopes?(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<VideoScopeAnalysis>
  /** Terminate analysis resources and settle after the child worker retires. */
  releaseVideoScopes?(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Core                                                                 */
/* ------------------------------------------------------------------ */
