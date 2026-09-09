import { describe, expect, test, vi } from 'vitest'
import { maskParams } from '../../src/domain/effectStack'
import { maskPixelWork } from '../../src/domain/maskPixelWork'
import { renderWorkSurfaceBudget } from '../../src/domain/renderSurfaceBudget'
import { videoCompositionPlanAtFrame } from '../../src/domain/videoCompositionPlan'
import { videoPixelWorkBudget } from '../../src/domain/videoPixelWorkBudget'
import { createDocumentLensRemapProvider, type WebGl2LensRemapBackend } from '../../src/pipeline/lensRemapWebgl'
import { ADMISSION_GEOMETRY_CASES, admissionGeometryFixture } from './resourceAdmissionFixtures'

const geometry = { surfaceWidth: 3840, surfaceHeight: 2160, projectWidth: 3840, projectHeight: 2160 }
const bounds = new Map([['matrix-asset', { video: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 10_000_000 }, audio: null }]])

describe('preregistered resource admission geometry without native allocations', () => {
  test('the fixed matrix has sixteen distinct rows and four representable byte-boundary cases', () => {
    expect(ADMISSION_GEOMETRY_CASES).toHaveLength(16)
    expect(new Set(ADMISSION_GEOMETRY_CASES.map((cell) => cell.id)).size).toBe(16)
    expect(ADMISSION_GEOMETRY_CASES.filter((cell) => cell.id.startsWith('cap')).map((cell) => cell.expectedBytes))
      .toEqual([268_435_456, 268_435_457, 268_435_456, 268_435_457])
  })

  test.each(ADMISSION_GEOMETRY_CASES)('$id has exact canonical bounds, bytes and real-provider admission', (cell) => {
    const { doc, clip } = admissionGeometryFixture(cell), before = JSON.stringify(doc)
    const plan = videoCompositionPlanAtFrame(doc, 0, bounds)
    const mask = maskPixelWork(maskParams(clip.effects[0]!), geometry)
    expect([mask.bounds?.width, mask.bounds?.height]).toEqual(cell.maskBounds)
    const work = videoPixelWorkBudget(plan, geometry)
    expect(work.reason).toBeNull()
    expect(work.readbackBytes).toBe(3840 * 2160 * 4)
    expect(work.maskInsideBytes).toBe(cell.maskBounds[0] * cell.maskBounds[1])
    expect(work.maskDistanceBytes).toBe(cell.maskBounds[0] * cell.maskBounds[1] * 4)
    const includeExportReadback = cell.usage === 'export'
    const budget = renderWorkSurfaceBudget(3840, 2160, { additionalOwnedBytes: work.peakAdditionalBytes,
      lensReusableBytes: cell.sourceSize ? cell.sourceSize[0] * cell.sourceSize[1] * 8 : 0, includeExportReadback })
    expect(budget.aggregateBytes).toBe(cell.expectedBytes)
    expect(budget.allowed).toBe(cell.expectedAllowed)
    if (cell.sourceSize) {
      // The provider is real; its backend is explicitly a recording double.
      // This verifies pre-backend refusal, never native/WebGL pixel behavior.
      const renderSource = vi.fn((source: CanvasImageSource) => source)
      const backend = { maximumTextureSize: 8192, retainedBytes: () => 0, renderSource } as unknown as WebGl2LensRemapBackend
      const provider = createDocumentLensRemapProvider(doc, backend, 3840, 2160, includeExportReadback)!
      const reserve = { additionalOwnedBytes: work.peakAdditionalBytes, outputWidth: 3840, outputHeight: 2160, includeExportReadback }
      const release = provider.reserveFrameWork!(reserve)
      const source = { width: cell.sourceSize[0], height: cell.sourceSize[1] } as CanvasImageSource
      try {
        if (cell.expectedAllowed) { expect(provider.remap(clip, source)).toBe(source); expect(renderSource).toHaveBeenCalledOnce() }
        else { expect(() => provider.remap(clip, source)).toThrow(/256 MiB|render memory limit/); expect(renderSource).not.toHaveBeenCalled() }
      } finally { release() }
      provider.reserveFrameWork!(reserve)()
    }
    expect(JSON.stringify(doc)).toBe(before)
  })
})
