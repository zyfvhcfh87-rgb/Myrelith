import { describe, expect, test, vi } from 'vitest'
import { attributeClip } from '../test/clipAttributeFixtures'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { DEFAULT_MANUAL_LENS_CORRECTION } from '../domain/lensCorrection'
import { createMaskEffect } from '../domain/effectStack'
import { MAX_RENDER_AGGREGATE_SURFACE_BYTES } from '../domain/renderSurfaceBudget'
import { createDocumentLensRemapProvider, type WebGl2LensRemapBackend } from './lensRemapWebgl'

const P = 3840 * 2160
const source = (width = 3840, height = 2160) => ({ width, height }) as CanvasImageSource
function fixture(retained = 0, hasLens = true) {
  const doc = structuredClone(createTimelineDoc('Lens work', DEFAULT_PROJECT_SETTINGS, 'work'))
  doc.width = 3840; doc.height = 2160
  const clip = attributeClip('lens')
  clip.lensCorrection = hasLens ? { ...DEFAULT_MANUAL_LENS_CORRECTION } : null
  const mask = createMaskEffect('mask', 'bezier')
  mask.params = { ...mask.params, x: 0, y: 0, width: 1, height: 1, feather: 0.05 }
  clip.effects = [mask]; doc.tracks[0].clips = [clip]
  let retainedBytes = retained
  const renderSource = vi.fn((input: CanvasImageSource, width: number, height: number) => {
    retainedBytes = width * height * 8
    return input
  })
  const backend = { maximumTextureSize: 8192, retainedBytes: () => retainedBytes, renderSource } as unknown as WebGl2LensRemapBackend
  const provider = createDocumentLensRemapProvider(doc, backend, 3840, 2160, false)!
  return { doc, clip, mask, provider, renderSource }
}
const frameWork = (additionalOwnedBytes: number, outputWidth = 3840, outputHeight = 2160) => ({
  additionalOwnedBytes, outputWidth, outputHeight, includeExportReadback: false,
})

describe('real lens provider admission before backend allocation', () => {
  test('rejects full 4K mask plus 4K lens, but admits the identical output with a smaller source', () => {
    const { provider, clip, renderSource } = fixture()
    const release = provider.reserveFrameWork!(frameWork(P * 9))
    expect(() => provider.remap(clip, source())).toThrow(/render memory limit/)
    expect(renderSource).not.toHaveBeenCalled()
    expect(provider.remap(clip, source(1920, 1080))).toEqual(source(1920, 1080))
    expect(renderSource).toHaveBeenCalledOnce()
    release()
  })
  test('fallback document admission uses clipped mask geometry without lowering resolution', () => {
    const { doc, clip, mask, renderSource } = fixture()
    mask.params.width = 0.25; mask.params.height = 0.25
    const backend = { maximumTextureSize: 8192, retainedBytes: () => 0, renderSource } as unknown as WebGl2LensRemapBackend
    const provider = createDocumentLensRemapProvider(doc, backend, 3840, 2160, false)!
    provider.remap(clip, source())
    expect(renderSource.mock.calls[0].slice(1, 3)).toEqual([3840, 2160])
  })
  test('retained prior lens surfaces count even after lens intent is removed', () => {
    const { provider, clip, renderSource } = fixture(P * 8, false)
    expect(() => provider.reserveFrameWork!(frameWork(P * 9))).toThrow(/256 MiB/)
    expect(renderSource).not.toHaveBeenCalled()
    const release = provider.reserveFrameWork!(frameWork(P * 4))
    provider.remap(clip, source()); release()
    expect(renderSource).not.toHaveBeenCalled()
  })
  test('an active reservation pins output dimensions across a logical profile change', () => {
    const { provider, clip, renderSource } = fixture()
    const release = provider.reserveFrameWork!(frameWork(P * 9, 1920, 1080))
    provider.setOutputSurface!(3840, 2160, false)
    provider.remap(clip, source())
    expect(renderSource).toHaveBeenCalledOnce()
    release()
    expect(() => provider.remap(clip, source())).toThrow(/render memory limit/)
    expect(renderSource).toHaveBeenCalledOnce()
  })
  test('reservation release is idempotent and an old release cannot release a newer frame', () => {
    const { provider } = fixture()
    const first = provider.reserveFrameWork!(frameWork(0))
    expect(() => provider.reserveFrameWork!(frameWork(0))).toThrow(/unfinished composite/)
    first(); first()
    const second = provider.reserveFrameWork!(frameWork(0))
    first()
    expect(() => provider.reserveFrameWork!(frameWork(0))).toThrow(/unfinished composite/)
    second()
  })
  test.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER])('invalid frame byte count %s never reaches the backend', (bytes) => {
    const { provider, renderSource } = fixture()
    expect(() => provider.reserveFrameWork!(frameWork(bytes))).toThrow()
    expect(renderSource).not.toHaveBeenCalled()
  })
  test.each([[0, 1], [1.5, 10], [8193, 1], [4096, 8192]])('invalid source %s by %s never reaches the backend', (width, height) => {
    const { provider, clip, renderSource } = fixture()
    const release = provider.reserveFrameWork!(frameWork(0))
    expect(() => provider.remap(clip, source(width, height))).toThrow()
    expect(renderSource).not.toHaveBeenCalled(); release()
  })
  test('the inclusive retained-source boundary admits exactly the cap, then rejects one byte more', () => {
    const { provider, renderSource } = fixture(P * 8)
    const extra = MAX_RENDER_AGGREGATE_SURFACE_BYTES - P * 24
    provider.reserveFrameWork!(frameWork(extra))()
    expect(() => provider.reserveFrameWork!(frameWork(extra + 1))).toThrow(/256 MiB/)
    expect(renderSource).not.toHaveBeenCalled()
  })
})
