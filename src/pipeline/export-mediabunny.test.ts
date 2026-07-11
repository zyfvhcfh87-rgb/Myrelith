/**
 * pipeline/export-mediabunny.test.ts — real-adapter ownership and wiring.
 *
 * Mediabunny and browser canvas primitives are recorded fakes here. The real
 * codec/container path is exercised separately in the browser gate.
 */

import {
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from 'vitest'
import type { TimelineDoc } from '../domain/schema'
import { compositeFrame } from './render'
import type { ExportSettings } from './export'

interface FakeInputRecord {
  source: unknown
  getPrimaryVideoTrack: Mock<() => Promise<unknown | null>>
  dispose: Mock<() => void>
}

interface FakeCanvasSinkRecord {
  track: unknown
  options: unknown
  getCanvas: Mock<(timestampSec: number) => Promise<unknown>>
  canvasesAtTimestamps: Mock<
    (timestamps: Iterable<number>) => AsyncGenerator<unknown, void, unknown>
  >
}

interface FakeCanvasIteratorRecord {
  return: Mock<(value?: void) => Promise<IteratorResult<unknown, void>>>
}

interface FakeCanvasSourceRecord {
  canvas: unknown
  encodingConfig: unknown
  add: Mock<(timestampSec: number, durationSec: number) => Promise<void>>
  close: Mock<() => void>
}

interface FakeOutputRecord {
  options: unknown
  addVideoTrack: Mock<(source: unknown, metadata: unknown) => void>
  start: Mock<() => Promise<void>>
  finalize: Mock<() => Promise<void>>
  cancel: Mock<() => Promise<void>>
}

const mb = vi.hoisted(() => ({
  allFormats: { kind: 'all-formats' },
  blobSources: [] as Array<{ blob: Blob }>,
  inputs: [] as unknown[],
  inputTracks: [] as Array<unknown | null>,
  canvasSinkHandlers: [] as Array<
    (timestampSec: number) => Promise<unknown>
  >,
  canvasSinks: [] as unknown[],
  canvasIterators: [] as unknown[],
  targetBuffers: [] as Array<ArrayBuffer | null>,
  targets: [] as Array<{ buffer: ArrayBuffer | null }>,
  canvasSourceAddHandlers: [] as Array<
    (timestampSec: number, durationSec: number) => Promise<void>
  >,
  canvasSources: [] as unknown[],
  outputStartHandlers: [] as Array<() => Promise<void>>,
  outputFinalizeHandlers: [] as Array<() => Promise<void>>,
  outputCancelHandlers: [] as Array<() => Promise<void>>,
  outputs: [] as unknown[],
  formats: [] as unknown[],
  canEncodeVideo: vi.fn(),
}))

vi.mock('mediabunny', () => {
  class BlobSource {
    blob: Blob

    constructor(blob: Blob) {
      this.blob = blob
      mb.blobSources.push(this)
    }
  }

  class Input {
    source: unknown
    getPrimaryVideoTrack: Mock<() => Promise<unknown | null>>
    dispose: Mock<() => void>

    constructor(options: { source: unknown }) {
      this.source = options.source
      this.getPrimaryVideoTrack = vi.fn(async () => {
        if (mb.inputTracks.length === 0) return null
        return mb.inputTracks.shift() ?? null
      })
      this.dispose = vi.fn()
      mb.inputs.push(this)
    }
  }

  class CanvasSink {
    track: unknown
    options: unknown
    getCanvas: Mock<(timestampSec: number) => Promise<unknown>>
    canvasesAtTimestamps: Mock<
      (timestamps: Iterable<number>) => AsyncGenerator<unknown, void, unknown>
    >

    constructor(track: unknown, options: unknown) {
      this.track = track
      this.options = options
      const handler =
        mb.canvasSinkHandlers.shift() ?? (async () => null)
      this.getCanvas = vi.fn(handler)
      this.canvasesAtTimestamps = vi.fn((timestamps: Iterable<number>) => {
        const requested = [...timestamps]
        const iterator = (async function* () {
          for (const timestamp of requested) yield await handler(timestamp)
        })()
        const returnIterator = iterator.return.bind(iterator)
        iterator.return = vi.fn(returnIterator)
        mb.canvasIterators.push(iterator)
        return iterator
      })
      mb.canvasSinks.push(this)
    }
  }

  class BufferTarget {
    buffer: ArrayBuffer | null

    constructor() {
      this.buffer =
        mb.targetBuffers.length > 0
          ? (mb.targetBuffers.shift() ?? null)
          : new Uint8Array([1, 2, 3]).buffer
      mb.targets.push(this)
    }
  }

  class Mp4OutputFormat {
    constructor() {
      mb.formats.push(this)
    }
  }

  class CanvasSource {
    canvas: unknown
    encodingConfig: unknown
    add: Mock<(timestampSec: number, durationSec: number) => Promise<void>>
    close: Mock<() => void>

    constructor(canvas: unknown, encodingConfig: unknown) {
      this.canvas = canvas
      this.encodingConfig = encodingConfig
      const handler =
        mb.canvasSourceAddHandlers.shift() ?? (async () => undefined)
      this.add = vi.fn(handler)
      this.close = vi.fn()
      mb.canvasSources.push(this)
    }
  }

  class Output {
    options: unknown
    addVideoTrack: Mock<(source: unknown, metadata: unknown) => void>
    start: Mock<() => Promise<void>>
    finalize: Mock<() => Promise<void>>
    cancel: Mock<() => Promise<void>>

    constructor(options: unknown) {
      this.options = options
      this.addVideoTrack = vi.fn()
      const start = mb.outputStartHandlers.shift() ?? (async () => undefined)
      const finalize =
        mb.outputFinalizeHandlers.shift() ?? (async () => undefined)
      const cancel =
        mb.outputCancelHandlers.shift() ?? (async () => undefined)
      this.start = vi.fn(start)
      this.finalize = vi.fn(finalize)
      this.cancel = vi.fn(cancel)
      mb.outputs.push(this)
    }
  }

  return {
    ALL_FORMATS: mb.allFormats,
    BlobSource,
    BufferTarget,
    CanvasSink,
    CanvasSource,
    Input,
    Mp4OutputFormat,
    Output,
    canEncodeVideo: mb.canEncodeVideo,
  }
})

import {
  createMediabunnyExportMediaSource,
  createMediabunnyVideoSink,
  mediabunnyExportDeps,
} from './export-mediabunny'

const SETTINGS: ExportSettings = {
  format: 'mp4',
  videoCodec: 'avc',
  videoBitrate: 250_000,
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc',
    name: 'doc',
    frameRate: { num: 30_000, den: 1_001 },
    width: 64,
    height: 48,
    audioSampleRate: 48_000,
    tracks: [],
  }
}

function makeVideoDoc(
  requests: Array<{ assetId: string; sourceStart: number }>,
  durationFrames: number,
): TimelineDoc {
  const doc = makeDoc()
  return {
    ...doc,
    tracks: requests.map((request, index) => ({
      id: `V${index + 1}`,
      kind: 'video' as const,
      name: `V${index + 1}`,
      clips: [
        {
          id: `clip-${index + 1}`,
          assetId: request.assetId,
          name: `clip-${index + 1}`,
          sourceRange: {
            startFrame: request.sourceStart,
            durationFrames,
          },
          timelineRange: { startFrame: 0, durationFrames },
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            anchorX: 0.5,
            anchorY: 0.5,
          },
          opacity: 1,
          volume: 1,
          effects: [],
        },
      ],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    })),
  }
}

interface FakeBitmap extends ImageBitmap {
  close: Mock<() => void>
}

const fakeCanvases: FakeOffscreenCanvas[] = []
const fakeBitmaps: FakeBitmap[] = []
const createBitmap = vi.fn(async (source: ImageBitmapSource) => {
  const dimensions = source as { width?: number; height?: number }
  const bitmap = {
    width: dimensions.width ?? 320,
    height: dimensions.height ?? 180,
    close: vi.fn(),
  } as unknown as FakeBitmap
  fakeBitmaps.push(bitmap)
  return bitmap
})

class FakeOffscreenCanvas {
  width: number
  height: number
  readonly context = {
    globalAlpha: 1,
    fillStyle: '#000000',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  }
  readonly getContext = vi.fn((kind: string) =>
    kind === '2d' ? this.context : null,
  )

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    fakeCanvases.push(this)
  }
}

function inputAt(index = 0): FakeInputRecord {
  return mb.inputs[index] as FakeInputRecord
}

function canvasSinkAt(index = 0): FakeCanvasSinkRecord {
  return mb.canvasSinks[index] as FakeCanvasSinkRecord
}

function canvasSourceAt(index = 0): FakeCanvasSourceRecord {
  return mb.canvasSources[index] as FakeCanvasSourceRecord
}

function canvasIteratorAt(index = 0): FakeCanvasIteratorRecord {
  return mb.canvasIterators[index] as FakeCanvasIteratorRecord
}

function outputAt(index = 0): FakeOutputRecord {
  return mb.outputs[index] as FakeOutputRecord
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function videoTrack(canDecode = true) {
  return { canDecode: vi.fn(async () => canDecode) }
}

function wrappedCanvas(width = 320, height = 180) {
  return {
    canvas: { width, height },
    timestamp: 0,
    duration: 1 / 30,
  }
}

beforeEach(() => {
  mb.blobSources.length = 0
  mb.inputs.length = 0
  mb.inputTracks.length = 0
  mb.canvasSinkHandlers.length = 0
  mb.canvasSinks.length = 0
  mb.canvasIterators.length = 0
  mb.targetBuffers.length = 0
  mb.targets.length = 0
  mb.canvasSourceAddHandlers.length = 0
  mb.canvasSources.length = 0
  mb.outputStartHandlers.length = 0
  mb.outputFinalizeHandlers.length = 0
  mb.outputCancelHandlers.length = 0
  mb.outputs.length = 0
  mb.formats.length = 0
  mb.canEncodeVideo.mockReset().mockResolvedValue(true)
  fakeCanvases.length = 0
  fakeBitmaps.length = 0
  createBitmap.mockClear()
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('createImageBitmap', createBitmap)
})

describe('createMediabunnyExportMediaSource', () => {
  test('opens one decoder per asset and leases stable bitmap copies', async () => {
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 3 }],
      2,
    )
    const blob = new Blob(['asset-a'])
    const resolveAsset = vi.fn(async () => blob)
    const track = videoTrack()
    const wrapped = wrappedCanvas()
    mb.inputTracks.push(track)
    mb.canvasSinkHandlers.push(async () => wrapped)
    const media = createMediabunnyExportMediaSource(doc, resolveAsset)

    const firstLease = await media.openFrame(0)
    const first = await firstLease.getFrame('asset-a', 3)
    await firstLease.close()
    const secondLease = await media.openFrame(1)
    const second = await secondLease.getFrame('asset-a', 4)
    await secondLease.close()
    await media.close()
    await media.close()

    expect(resolveAsset).toHaveBeenCalledOnce()
    expect(resolveAsset).toHaveBeenCalledWith('asset-a')
    expect(mb.blobSources).toHaveLength(1)
    expect(mb.blobSources[0].blob).toBe(blob)
    expect(mb.inputs).toHaveLength(1)
    expect(track.canDecode).toHaveBeenCalledOnce()
    expect(canvasSinkAt().track).toBe(track)
    expect(canvasSinkAt().options).toEqual({ poolSize: 1 })
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledOnce()
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledWith([
      3_003 / 30_000,
      4_004 / 30_000,
    ])
    expect(canvasSinkAt().getCanvas).not.toHaveBeenCalled()
    expect(createBitmap.mock.calls).toEqual([[wrapped.canvas], [wrapped.canvas]])
    expect(first).toBe(fakeBitmaps[0])
    expect(second).toBe(fakeBitmaps[1])
    expect(fakeBitmaps[0].close).toHaveBeenCalledOnce()
    expect(fakeBitmaps[1].close).toHaveBeenCalledOnce()
    expect(canvasIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('serializes same-asset canvas reuse until each bitmap copy is stable', async () => {
    const firstCanvas = deferred<unknown>()
    let request = 0
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => {
      request++
      if (request === 1) return firstCanvas.promise
      return wrappedCanvas(640, 360)
    })
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc(
        [
          { assetId: 'asset-a', sourceStart: 0 },
          { assetId: 'asset-a', sourceStart: 1 },
        ],
        1,
      ),
      async () => new Blob(['asset-a']),
    )
    const lease = await media.openFrame(0)

    const first = lease.getFrame('asset-a', 0)
    const second = lease.getFrame('asset-a', 1)
    await vi.waitFor(() => expect(request).toBe(1))
    firstCanvas.resolve(wrappedCanvas(320, 180))

    const firstBitmap = await first
    const secondBitmap = await second
    expect(firstBitmap).toBe(fakeBitmaps[0])
    expect(secondBitmap).toBe(fakeBitmaps[1])
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledOnce()
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledWith([0, 1_001 / 30_000])
    expect(canvasSinkAt().getCanvas).not.toHaveBeenCalled()
    await lease.close()
    await media.close()
  })

  test('lets different asset decoders run concurrently', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let started = 0
    mb.inputTracks.push(videoTrack(), videoTrack())
    mb.canvasSinkHandlers.push(
      async () => {
        started++
        return first.promise
      },
      async () => {
        started++
        return second.promise
      },
    )
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc(
        [
          { assetId: 'asset-a', sourceStart: 0 },
          { assetId: 'asset-b', sourceStart: 0 },
        ],
        1,
      ),
      async (assetId) => new Blob([assetId]),
    )
    const lease = await media.openFrame(0)

    const a = lease.getFrame('asset-a', 0)
    const b = lease.getFrame('asset-b', 0)
    await vi.waitFor(() => expect(started).toBe(2))
    first.resolve(wrappedCanvas())
    second.resolve(wrappedCanvas())

    await Promise.all([a, b])
    await lease.close()
    await media.close()
    expect(inputAt(0).dispose).toHaveBeenCalledOnce()
    expect(inputAt(1).dispose).toHaveBeenCalledOnce()
  })

  test.each([
    ['has no video track', null],
    ['cannot be decoded', videoTrack(false)],
  ])('rejects an asset that %s and still disposes its input', async (message, track) => {
    mb.inputTracks.push(track)
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => new Blob(['bad']),
    )
    const lease = await media.openFrame(0)

    await expect(lease.getFrame('asset-a', 0)).rejects.toThrow(message)
    await lease.close()
    await media.close()

    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(mb.canvasSinks).toHaveLength(0)
  })
})

describe('createMediabunnyVideoSink', () => {
  test('probes AVC and wires an exact-rate MP4 canvas track', async () => {
    const doc = makeDoc()
    const sink = await createMediabunnyVideoSink(doc, SETTINGS)

    expect(mb.canEncodeVideo).toHaveBeenCalledWith('avc', {
      width: 64,
      height: 48,
      bitrate: 250_000,
    })
    expect(fakeCanvases).toHaveLength(1)
    expect(fakeCanvases[0]).toMatchObject({ width: 64, height: 48 })
    expect(fakeCanvases[0].getContext).toHaveBeenCalledWith('2d')
    expect(canvasSourceAt().canvas).toBe(fakeCanvases[0])
    expect(canvasSourceAt().encodingConfig).toEqual({
      codec: 'avc',
      bitrate: 250_000,
    })
    expect(outputAt().options).toEqual({
      format: mb.formats[0],
      target: mb.targets[0],
    })
    expect(outputAt().addVideoTrack).toHaveBeenCalledWith(canvasSourceAt(), {
      frameRate: 30_000 / 1_001,
    })
    expect(outputAt().start).toHaveBeenCalledOnce()
    expect(sink.ctx).toBe(fakeCanvases[0].context)
    expect(mediabunnyExportDeps.composite).toBe(compositeFrame)
    expect(mediabunnyExportDeps.createVideoSink).toBe(
      createMediabunnyVideoSink,
    )
  })

  test('awaits encoder backpressure and finalizes to the target buffer', async () => {
    const add = deferred<void>()
    const resultBuffer = new Uint8Array([8, 9, 10]).buffer
    mb.canvasSourceAddHandlers.push(async () => add.promise)
    mb.targetBuffers.push(resultBuffer)
    const sink = await createMediabunnyVideoSink(makeDoc(), SETTINGS)

    let settled = false
    const pending = sink.addFrame(1_001 / 30_000, 1_001 / 30_000)
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(canvasSourceAt().add).toHaveBeenCalledWith(
      1_001 / 30_000,
      1_001 / 30_000,
    )
    add.resolve()
    await pending

    await expect(sink.finalize()).resolves.toEqual({
      buffer: resultBuffer,
      mimeType: 'video/mp4',
    })
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
    expect(outputAt().cancel).not.toHaveBeenCalled()
  })

  test('rejects unsupported AVC before allocating output resources', async () => {
    mb.canEncodeVideo.mockResolvedValue(false)

    await expect(
      createMediabunnyVideoSink(makeDoc(), SETTINGS),
    ).rejects.toThrow('AVC encoding is not supported for 64x48')

    expect(fakeCanvases).toHaveLength(0)
    expect(mb.outputs).toHaveLength(0)
  })

  test('cancels a started output exactly once without normal-closing the source', async () => {
    const sink = await createMediabunnyVideoSink(makeDoc(), SETTINGS)

    await sink.cancel()
    await sink.cancel()

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).not.toHaveBeenCalled()
    await expect(sink.addFrame(0, 1 / 30)).rejects.toThrow(
      'Video export sink is closed',
    )
  })

  test('cancels setup when output start fails and preserves the start error', async () => {
    const startError = new Error('start failed')
    mb.outputStartHandlers.push(async () => {
      throw startError
    })

    await expect(
      createMediabunnyVideoSink(makeDoc(), SETTINGS),
    ).rejects.toBe(startError)

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).not.toHaveBeenCalled()
  })

  test.each([
    ['add', new Error('add failed')],
    ['finalize', new Error('finalize failed')],
  ])('cancels after %s fails while preserving the primary error', async (kind, primary) => {
    if (kind === 'add') {
      mb.canvasSourceAddHandlers.push(async () => {
        throw primary
      })
    } else {
      mb.outputFinalizeHandlers.push(async () => {
        throw primary
      })
    }
    const sink = await createMediabunnyVideoSink(makeDoc(), SETTINGS)

    const operation =
      kind === 'add' ? sink.addFrame(0, 1 / 30) : sink.finalize()
    await expect(operation).rejects.toBe(primary)
    await sink.cancel()

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).toHaveBeenCalledTimes(
      kind === 'finalize' ? 1 : 0,
    )
  })

  test('rejects a finalized output whose target buffer is missing', async () => {
    mb.targetBuffers.push(null)
    const sink = await createMediabunnyVideoSink(makeDoc(), SETTINGS)

    await expect(sink.finalize()).rejects.toThrow(
      'Mediabunny finalized without an output buffer',
    )
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
  })
})
