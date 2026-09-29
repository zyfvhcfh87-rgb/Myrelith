
/**
 * Browser-worker wiring only. The stateful render owner lives in renderWorker/core;
 * environment adapters stay here so tests can construct the core directly.
 */
import { invalidateMediaDecoderRuntime, invalidateMediaDecoderSource } from '../codecs/mediaCodecFallbacks';
import { WebGl2LensRemapBackend } from '../pipeline/lensRemapWebgl';
import { decodeStaticImage } from '../pipeline/static-image';
import type { FromRenderWorker, ToRenderWorker } from './render-protocol';
import { openWorkerVideoSource } from './video-source';
import { createRenderWorkerCore } from './renderWorker/core';
import { createOrientedBitmapNormalizer } from './renderWorker/orientedBitmap';
import { createVideoScopeAnalyzer } from './renderWorker/videoScopeAnalyzer';
export type { RenderCanvasLike, RenderWorkerEnv } from './renderWorker/contracts'
export { createRenderWorkerCore } from './renderWorker/core'
export { createOrientedBitmapNormalizer } from './renderWorker/orientedBitmap'
export { createVideoScopeAnalyzer } from './renderWorker/videoScopeAnalyzer'

declare const WorkerGlobalScope: unknown

if (typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined') {
  const renderWorkerGlobal = self as unknown as {
    postMessage(message: FromRenderWorker, transfer: Transferable[]): void
  }
  const videoScopeAnalyzer = createVideoScopeAnalyzer()
  const orientedBitmaps = createOrientedBitmapNormalizer()
  const core = createRenderWorkerCore({
    post: (msg, transfer = []) => renderWorkerGlobal.postMessage(msg, transfer),
    openVideoSource: (blob, sourceId, budget) => openWorkerVideoSource(
      blob,
      { sourceId, budget },
    ),
    decodeImage: (blob, signal, reserveDecodedBytes) =>
      decodeStaticImage(blob, { signal, reserveDecodedBytes }),
    invalidateDecoderSource: invalidateMediaDecoderSource,
    invalidateDecoderRuntime: invalidateMediaDecoderRuntime,
    createStreamingBitmap: (decoded) => orientedBitmaps.normalize(decoded),
    releaseStreamingBitmapSurface: () => orientedBitmaps.release(),
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
    createLensRemapBackend: () => new WebGl2LensRemapBackend(),
    now: () => performance.now(),
    schedule: (callback) => setTimeout(callback, 0),
    analyzeVideoScopes: (rgba, width, height) =>
      videoScopeAnalyzer.analyze(rgba, width, height),
    releaseVideoScopes: () => videoScopeAnalyzer.release(),
  })

  self.addEventListener('message', (event: MessageEvent<ToRenderWorker>) => {
    void core.handleMessage(event.data)
  })
}
