import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ExportDeps } from '../../src/pipeline/export'
import { videoCompositionPlanAtFrame } from '../../src/domain/videoCompositionPlan'
import { diagnosticDocument } from './diagnosticComposite'
import { DiagnosticPixelOwner } from './diagnosticPixels'

const observed = vi.hoisted(() => ({ prepareFixture: vi.fn(), immutableBlob: vi.fn(), staticOracle: vi.fn() }))
vi.mock('./exportResourceGate', () => ({ RESOURCE_EXPORT_PROFILE: { videoCodec: 'avc', videoBitrate: 2_000_000,
  videoBitrateMode: 'variable', keyFrameIntervalMicroseconds: 2_000_000 }, prepareExportFixture: observed.prepareFixture }))
vi.mock('./exportPixelDiagnostic', () => ({ IMMUTABLE_DIAGNOSTIC_INPUTS: [{ name: 'source.mp4' }, { name: 'export-complete-0.mp4' }],
  immutableBlob: observed.immutableBlob, staticOracle: observed.staticOracle }))

import { comparePreEncode, lossyOutputComparison, prepareExportCompletion } from './exportCompletionGate'

// Recording canvases and oracle double qualify the observer's ownership/order,
// not native pixels or the already accepted canonical raster implementation.
const surfaces: RecordingCanvas[] = []
class RecordingCanvas {
  width: number; height: number; delta = 0
  context = { canvas: this, drawImage: vi.fn(), getImageData: vi.fn(() => {
    const data = new Uint8ClampedArray(1280 * 720 * 4)
    for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255
    data[0] = this.delta
    return { data }
  }) }
  constructor(width: number, height: number) { this.width = width; this.height = height; surfaces.push(this) }
  getContext() { return this.context }
}
beforeEach(() => {
  vi.clearAllMocks(); surfaces.length = 0
  vi.stubGlobal('OffscreenCanvas', RecordingCanvas)
  observed.immutableBlob.mockResolvedValue(new Blob(['inert']))
  observed.prepareFixture.mockResolvedValue({ blob: new Blob(['inert']), identity: 'untouched' })
  observed.staticOracle.mockImplementation((pixels, _path, owner: DiagnosticPixelOwner) => owner.copy(pixels))
})
afterEach(() => vi.unstubAllGlobals())

function requestAt(frame: number, delta = 0) {
  const { doc, asset } = diagnosticDocument(), canvas = new RecordingCanvas(1280, 720)
  canvas.delta = delta
  const image = { width: 1280, height: 720, close: vi.fn() }
  const getFrame = vi.fn(async () => image as unknown as ImageBitmap)
  const plan = videoCompositionPlanAtFrame(doc, frame, new Map([[asset.id, asset.sourceBounds]]))
  const request: Parameters<ExportDeps['composite']> = [doc, plan, canvas.context as unknown as Parameters<ExportDeps['composite']>[2],
    { getFrame }, { get: () => { throw new Error('Unexpected transition request') } }]
  const composite: ExportDeps['composite'] = vi.fn(async (...actual) => {
    expect(await actual[3].getFrame(asset.id, frame)).toBe(image)
    return { drawn: ['resource-mask'], missing: [] }
  })
  return { request, composite, getFrame, image, canvas }
}
function pixels(value: number) {
  const result = new Uint8ClampedArray(64 * 4)
  for (let offset = 0; offset < result.length; offset += 4) { result.fill(value, offset, offset + 3); result[offset + 3] = 255 }
  return result
}

test('lossy mean acceptance retains measured max-12 failure without changing its historical result', () => {
  const actual = pixels(0); actual[0] = 19
  expect(lossyOutputComparison(actual, pixels(0), 8, 8)).toMatchObject({ accepted: true, legacyMaximumPassed: false,
    quality: { maximumDelta: 19, meanDelta: 19 / 192, originalTolerance: { satisfied: false } } })
})
test('encoded mean above two still fails', () => {
  expect(lossyOutputComparison(pixels(3), pixels(0), 8, 8)).toMatchObject({ accepted: false, quality: { meanDelta: 3 } })
})
test('pre-encode observation borrows one actual source, keeps sink pixels and retains only its independent reference', async () => {
  const owner = new DiagnosticPixelOwner(), value = requestAt(127), records: Record<string, unknown>[] = []
  const result = await comparePreEncode(value.composite, value.request, owner, async (event) => { records.push(event) })
  expect(value.getFrame).toHaveBeenCalledOnce(); expect(value.composite).toHaveBeenCalledOnce(); expect(value.image.close).not.toHaveBeenCalled()
  expect(value.canvas.context.getImageData).toHaveBeenCalledOnce(); expect(value.canvas.context.drawImage).not.toHaveBeenCalled()
  expect(observed.staticOracle.mock.calls[0]?.[1]).toBe(1)
  expect(records[0]).toMatchObject({ kind: 'export-pre-encode-parity', frame: 127, sourceFrame: 127, accepted: true, errors: { maximumDelta: 0 } })
  expect(records.at(-1)).toMatchObject({ kind: 'pre-encode-observer-released', surface: { width: 1, height: 1 } })
  expect(value.canvas).toMatchObject({ width: 1280, height: 720 })
  expect(owner.snapshot()).toMatchObject({ bytes: 3_686_400, buffers: 1 })
  owner.release(result.reference); expect(owner.snapshot().bytes).toBe(0)
})
test('one differing pre-encode channel is recorded and fails before returning to the exporter', async () => {
  const owner = new DiagnosticPixelOwner(), value = requestAt(0, 1), records: Record<string, unknown>[] = []
  await expect(comparePreEncode(value.composite, value.request, owner, async (event) => { records.push(event) })).rejects.toThrow('Exact pre-encode RGB parity failed at 0')
  expect(records[0]).toMatchObject({ accepted: false, errors: { maximumDelta: 1 } })
  expect(owner.snapshot()).toMatchObject({ bytes: 0, buffers: 0 }); expect(surfaces.at(-1)).toMatchObject({ width: 1, height: 1 })
  expect(value.image.close).not.toHaveBeenCalled()
})
test('a compositor failure after source capture releases oracle and observer canvas', async () => {
  const owner = new DiagnosticPixelOwner(), value = requestAt(0), failure = new Error('composite failed')
  const composite: ExportDeps['composite'] = async (...request) => { await value.composite(...request); throw failure }
  await expect(comparePreEncode(composite, value.request, owner, async () => {})).rejects.toBe(failure)
  expect(owner.snapshot()).toMatchObject({ bytes: 0, buffers: 0 }); expect(surfaces.at(-1)).toMatchObject({ width: 1, height: 1 })
})
test('the saved-source lifecycle prepares without an encoder and releases a cancelled attempt reference', async () => {
  const records: Record<string, unknown>[] = [], persist = vi.fn()
  const fixture = await prepareExportCompletion(async (event) => { records.push(event) }, persist)
  expect(observed.immutableBlob).toHaveBeenCalledOnce(); expect(surfaces).toHaveLength(0); expect(persist).not.toHaveBeenCalled()
  const value = requestAt(0)
  await fixture.observeComposite(value.composite, value.request, async (event) => { records.push(event) })
  await fixture.finishAttempt('cancel', true)
  expect(records.at(-1)).toMatchObject({ kind: 'pre-encode-attempt-released', success: true, targets: [0], pixels: { bytes: 0, buffers: 0 } })
  await fixture.close(false)
})
test('a completed attempt cannot omit the four pre-encode targets', async () => {
  const fixture = await prepareExportCompletion(async () => {}, vi.fn()), value = requestAt(0)
  await fixture.observeComposite(value.composite, value.request, async () => {})
  await expect(fixture.finishAttempt('complete', true)).rejects.toThrow('Completed attempt omitted pre-encode targets')
  await fixture.close(false)
})
