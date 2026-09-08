import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const observed = vi.hoisted(() => ({ inputDisposed: vi.fn(), sampleClosed: vi.fn(), frameClosed: vi.fn(), iteratorClosed: vi.fn(),
  encoderClosed: vi.fn(), encoderCancelled: vi.fn(), encoderAdded: vi.fn(), constructEncoder: vi.fn(), prepareFixture: vi.fn() }))
vi.mock('./exportResourceGate', () => ({ RESOURCE_EXPORT_PROFILE: { videoCodec: 'avc', videoBitrate: 2_000_000,
  videoBitrateMode: 'variable', keyFrameIntervalMicroseconds: 2_000_000 }, prepareExportFixture: observed.prepareFixture }))
vi.mock('./exportPixelDiagnostic', () => ({ IMMUTABLE_DIAGNOSTIC_INPUTS: [{ name: 'source.mp4' }, { name: 'export-complete-0.mp4' }],
  immutableBlob: async () => new Blob(['inert']), staticOracle: () => { throw new Error('Unexpected raster call') } }))
vi.mock('mediabunny', async (original) => ({ ...await original<typeof import('mediabunny')>(),
  Input: class {
    async getPrimaryVideoTrack() { return { displayWidth: 1280, displayHeight: 720,
      getCodec: async () => 'avc', getDecoderConfig: async () => ({ codec: 'avc1', codedWidth: 1280, codedHeight: 720 }) } }
    async computeDuration() { return 10 }
    async getPrimaryAudioTrack() { return null }
    dispose() { observed.inputDisposed() }
  },
  VideoSampleSink: class {
    async *samples() {
      try { yield { timestamp: 0, duration: 1 / 30, close: observed.sampleClosed,
        toVideoFrame: () => ({ displayWidth: 1, displayHeight: 1, close: observed.frameClosed }) } }
      finally { observed.iteratorClosed() }
    }
  },
  Output: class {
    addVideoTrack() {}
    async start() {}
    async cancel() { observed.encoderCancelled() }
  },
  CanvasSource: class { constructor() { observed.constructEncoder() }; close() { observed.encoderClosed() }; async add() { observed.encoderAdded() } },
}))

import { controlComparison, prepareExportCompletion } from './exportCompletionGate'

const surfaces: { width: number; height: number }[] = []
beforeEach(() => {
  vi.clearAllMocks(); surfaces.length = 0
  vi.stubGlobal('OffscreenCanvas', class {
    width: number; height: number
    constructor(width: number, height: number) { this.width = width; this.height = height; surfaces.push(this) }
    getContext() { return {} }
  })
})
afterEach(() => vi.unstubAllGlobals())

function pixels(value: number) {
  const result = new Uint8ClampedArray(64 * 4)
  for (let offset = 0; offset < result.length; offset += 4) { result.fill(value, offset, offset + 3); result[offset + 3] = 255 }
  return result
}

test('exact codec control agreement can pass mean quality while retaining a failed max-12 result', () => {
  const reference = pixels(0), actual = pixels(0); actual[0] = 19
  const result = controlComparison(actual, actual.slice(), reference, 8, 8)
  expect(result).toMatchObject({ accepted: true, legacyMaximumPassed: false,
    agreement: { maximumDelta: 0 }, quality: { maximumDelta: 19, meanDelta: 19 / 192, originalTolerance: { satisfied: false } } })
})

test('a one-channel control disagreement fails even when both absolute quality limits pass', () => {
  const reference = pixels(0), actual = pixels(0); actual[0] = 1
  expect(controlComparison(actual, reference, reference, 8, 8)).toMatchObject({ accepted: false,
    agreement: { maximumDelta: 1 }, quality: { originalTolerance: { satisfied: true } } })
})

test('matching a poor codec control cannot bypass the unchanged mean limit', () => {
  const actual = pixels(3)
  expect(controlComparison(actual, actual.slice(), pixels(0), 8, 8)).toMatchObject({ accepted: false,
    agreement: { maximumDelta: 0 }, quality: { meanDelta: 3 } })
})

test('an invalid actual decoded extent closes every acquired control owner and never starts lifecycle', async () => {
  const records: Record<string, unknown>[] = [], persist = vi.fn()
  await expect(prepareExportCompletion(async (value) => { records.push(value) }, persist)).rejects.toThrow('Completion decoded extent differs')
  for (const key of ['inputDisposed', 'sampleClosed', 'frameClosed', 'iteratorClosed', 'encoderClosed', 'encoderCancelled'] as const) expect(observed[key]).toHaveBeenCalledOnce()
  expect(observed.encoderAdded).not.toHaveBeenCalled(); expect(observed.prepareFixture).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled()
  expect(surfaces).toHaveLength(2); expect(surfaces.every(({ width, height }) => width === 1 && height === 1)).toBe(true)
  expect(records.find((value) => value.kind === 'completion-reader-released')).toMatchObject({ samples: 1, samplesClosed: 1, frames: 1, framesClosed: 1 })
  expect(records.at(-1)).toMatchObject({ kind: 'completion-pixels-released', success: false, pixels: { bytes: 0, buffers: 0 },
    work: { ordinalSamples: 1, controlFrames: 0, productionSourceRequests: 0 } })
})

test('an evidence failure before decoding still cancels the control and clears its canvas', async () => {
  const failure = new Error('record failed')
  await expect(prepareExportCompletion(async (value) => { if (value.kind === 'control-encoder-start') throw failure }, vi.fn())).rejects.toBe(failure)
  expect(observed.encoderClosed).toHaveBeenCalledOnce(); expect(observed.encoderCancelled).toHaveBeenCalledOnce()
  expect(observed.prepareFixture).not.toHaveBeenCalled(); expect(observed.encoderAdded).not.toHaveBeenCalled()
  expect(surfaces).toEqual([{ width: 1, height: 1 }])
})

test('a control source constructor failure still cancels its output and releases its canvas', async () => {
  const failure = new Error('codec unavailable')
  observed.constructEncoder.mockImplementationOnce(() => { throw failure })
  await expect(prepareExportCompletion(async () => {}, vi.fn())).rejects.toBe(failure)
  expect(observed.encoderCancelled).toHaveBeenCalledOnce(); expect(observed.encoderClosed).not.toHaveBeenCalled()
  expect(observed.prepareFixture).not.toHaveBeenCalled(); expect(surfaces).toEqual([{ width: 1, height: 1 }])
})
