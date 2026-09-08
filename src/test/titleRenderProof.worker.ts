/** Real worker realm for the shared production planner/compositor proof. */
import { renderTitleProof } from './titleRenderProof'
import type { SequenceProject } from '../domain/projectSequences'
import type { PresentationResolvedQuality } from '../domain/presentationProfile'

self.onmessage = async (event: MessageEvent<{ id: number; project: SequenceProject; frame: number; quality: PresentationResolvedQuality }>) => {
  const { id, project, frame, quality } = event.data
  try {
    const result = await renderTitleProof(project, frame, quality, { offscreen: true, canvasPolicy: 'production' })
    self.postMessage({ id, result }, { transfer: [result.rgba.buffer] })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
