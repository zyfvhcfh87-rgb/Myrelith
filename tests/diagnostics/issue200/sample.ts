import { renderTitleProof, exportTitleProof } from '../../../src/test/titleRenderProof'
import type { TitleProofCanvasPolicy, TitleProofPixels } from '../../../src/test/titleRenderProof'
import type { SequenceProject } from '../../../src/domain/projectSequences'
import { resolvePresentationProfile } from '../../../src/domain/presentationProfile'
import type { PresentationResolvedQuality } from '../../../src/domain/presentationProfile'
import type { compositeFrame } from '../../../src/pipeline/render'
import type { createVideoCompositionPlanner } from '../../../src/domain/videoCompositionPlan'

export interface DiagnosticRequest {
  project: SequenceProject
  renderer: 'baseline' | 'current'
  quality: PresentationResolvedQuality
  offscreen: boolean
  canvasPolicy: TitleProofCanvasPolicy
  export?: boolean
}
export interface DiagnosticSample {
  pixels: TitleProofPixels
  fixtureSha256: string
  readback: string
  profile: ReturnType<typeof resolvePresentationProfile>
  realm: string
  userAgent: string
  fontStatus: string
  exportOwnership: { leases: number; closed: number; finalized: boolean } | null
}
export async function diagnosticSample(request: DiagnosticRequest): Promise<DiagnosticSample> {
  const { project, quality, offscreen, canvasPolicy } = request
  const inputJson = JSON.stringify(project)
  const doc = project.sequences[0]
  let pixels: TitleProofPixels, exportOwnership: DiagnosticSample['exportOwnership'] = null
  if (request.export) {
    if (request.renderer !== 'current' || quality !== 'full' || !offscreen) throw new Error('Invalid diagnostic export request')
    const result = await exportTitleProof(project, canvasPolicy)
    if (result.frames.length !== 1) throw new Error('Diagnostic export must produce one frame')
    pixels = result.frames[0]
    exportOwnership = { leases: result.leases, closed: result.closed, finalized: result.finalized }
  } else if (request.renderer === 'baseline') {
    // Runtime URLs ensure genuine archived modules load in EACH requested realm.
    const renderPath = '/.tmp/issue200-baseline/src/pipeline/render.ts'
    const planPath = '/.tmp/issue200-baseline/src/domain/videoCompositionPlan.ts'
    const renderer: { compositeFrame: typeof compositeFrame } = await import(/* @vite-ignore */ renderPath)
    const planner: { createVideoCompositionPlanner: typeof createVideoCompositionPlanner } = await import(/* @vite-ignore */ planPath)
    pixels = await renderTitleProof(project, 0, quality, { offscreen, canvasPolicy,
      compositor: renderer.compositeFrame, plan: planner.createVideoCompositionPlanner(doc, new Map()).planFrame(0) })
  } else pixels = await renderTitleProof(project, 0, quality, { offscreen, canvasPolicy })
  if (JSON.stringify(project) !== inputJson) throw new Error('Diagnostic render mutated fixture input')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inputJson))
  const fixtureSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return { pixels, fixtureSha256, readback: 'destination.getImageData(0, 0, outputWidth, outputHeight).data', profile: resolvePresentationProfile(doc, { qualityMode: quality, reason: request.export ? 'export' : 'paused', viewport: null }),
    realm: typeof document === 'undefined' ? 'worker' : 'main', userAgent: navigator.userAgent,
    fontStatus: (globalThis as unknown as { fonts?: { status: string } }).fonts?.status ?? (typeof document === 'undefined' ? 'unavailable' : document.fonts.status), exportOwnership }
}
