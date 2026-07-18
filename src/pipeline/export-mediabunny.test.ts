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
import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { compositeFrame } from './render'
import type { ExportSettings } from './export'

interface FakeInputRecord {
  source: unknown
  getPrimaryVideoTrack: Mock<() => Promise<unknown | null>>
  getPrimaryAudioTrack: Mock<() => Promise<unknown | null>>
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

interface FakeAudioSampleRecord {
  data: Float32Array
  format: string
  numberOfChannels: number
  numberOfFrames: number
  sampleRate: number
  timestamp: number
  copyTo: Mock<
    (
      destination: Float32Array,
      options: { planeIndex: number; format: string },
    ) => void
  >
  close: Mock<() => void>
}

interface FakeAudioSampleSinkRecord {
  track: unknown
  samples: Mock<
    (
      startTimestamp?: number,
      endTimestamp?: number,
    ) => AsyncGenerator<unknown, void, unknown>
  >
}

interface FakeAudioIteratorRecord {
  return: Mock<(value?: void) => Promise<IteratorResult<unknown, void>>>
}

interface FakeAudioSampleSourceRecord {
  encodingConfig: unknown
  add: Mock<(sample: FakeAudioSampleRecord) => Promise<void>>
  close: Mock<() => void>
}

interface FakeOutputRecord {
  options: unknown
  addVideoTrack: Mock<(source: unknown, metadata: unknown) => void>
  addAudioTrack: Mock<(source: unknown) => void>
  start: Mock<() => Promise<void>>
  finalize: Mock<() => Promise<void>>
  cancel: Mock<() => Promise<void>>
}

const mb = vi.hoisted(() => ({
  allFormats: { kind: 'all-formats' },
  blobSources: [] as Array<{ blob: Blob }>,
  inputs: [] as unknown[],
  inputTracks: [] as Array<unknown | null>,
  audioTracks: [] as Array<unknown | null>,
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
  audioSinkSampleSequences: [] as Array<unknown[]>,
  audioSinks: [] as unknown[],
  audioIterators: [] as unknown[],
  audioSourceAddHandlers: [] as Array<
    (sample: FakeAudioSampleRecord) => Promise<void>
  >,
  audioSources: [] as unknown[],
  encodedAudioSamples: [] as unknown[],
  outputStartHandlers: [] as Array<() => Promise<void>>,
  outputFinalizeHandlers: [] as Array<() => Promise<void>>,
  outputCancelHandlers: [] as Array<() => Promise<void>>,
  outputs: [] as unknown[],
  formats: [] as unknown[],
  canEncodeAudio: vi.fn(),
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
    getPrimaryAudioTrack: Mock<() => Promise<unknown | null>>
    dispose: Mock<() => void>

    constructor(options: { source: unknown }) {
      this.source = options.source
      this.getPrimaryVideoTrack = vi.fn(async () => {
        if (mb.inputTracks.length === 0) return null
        return mb.inputTracks.shift() ?? null
      })
      this.getPrimaryAudioTrack = vi.fn(async () => {
        if (mb.audioTracks.length === 0) return null
        return mb.audioTracks.shift() ?? null
      })
      this.dispose = vi.fn()
      mb.inputs.push(this)
    }
  }

  class AudioSample {
    data: Float32Array
    format: string
    numberOfChannels: number
    numberOfFrames: number
    sampleRate: number
    timestamp: number
    copyTo: Mock<
      (
        destination: Float32Array,
        options: { planeIndex: number; format: string },
      ) => void
    >
    close: Mock<() => void>

    constructor(init: {
      data: Float32Array
      format: string
      numberOfChannels: number
      sampleRate: number
      timestamp: number
    }) {
      this.data = init.data
      this.format = init.format
      this.numberOfChannels = init.numberOfChannels
      this.numberOfFrames = init.data.length / init.numberOfChannels
      this.sampleRate = init.sampleRate
      this.timestamp = init.timestamp
      this.copyTo = vi.fn()
      this.close = vi.fn()
      mb.encodedAudioSamples.push(this)
    }
  }

  class AudioSampleSink {
    track: unknown
    samples: Mock<
      (
        startTimestamp?: number,
        endTimestamp?: number,
      ) => AsyncGenerator<unknown, void, unknown>
    >

    constructor(track: unknown) {
      this.track = track
      this.samples = vi.fn(() => {
        const sequence = mb.audioSinkSampleSequences.shift() ?? []
        const iterator = (async function* () {
          for (const sample of sequence) yield sample
        })()
        const returnIterator = iterator.return.bind(iterator)
        iterator.return = vi.fn(returnIterator)
        mb.audioIterators.push(iterator)
        return iterator
      })
      mb.audioSinks.push(this)
    }
  }

  class AudioSampleSource {
    encodingConfig: unknown
    add: Mock<(sample: FakeAudioSampleRecord) => Promise<void>>
    close: Mock<() => void>

    constructor(encodingConfig: unknown) {
      this.encodingConfig = encodingConfig
      const handler =
        mb.audioSourceAddHandlers.shift() ?? (async () => undefined)
      this.add = vi.fn(handler)
      this.close = vi.fn()
      mb.audioSources.push(this)
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
    addAudioTrack: Mock<(source: unknown) => void>
    start: Mock<() => Promise<void>>
    finalize: Mock<() => Promise<void>>
    cancel: Mock<() => Promise<void>>

    constructor(options: unknown) {
      this.options = options
      this.addVideoTrack = vi.fn()
      this.addAudioTrack = vi.fn()
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
    AudioSample,
    AudioSampleSink,
    AudioSampleSource,
    BlobSource,
    BufferTarget,
    CanvasSink,
    CanvasSource,
    Input,
    Mp4OutputFormat,
    Output,
    canEncodeAudio: mb.canEncodeAudio,
    canEncodeVideo: mb.canEncodeVideo,
  }
})

import {
  EXPORT_AUDIO_BITRATE,
  EXPORT_AUDIO_CODEC,
  createMediabunnyExportDeps,
  createMediabunnyExportMediaSource,
  createMediabunnyExportSink,
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

function makeAudioClip(
  id: string,
  assetId: string,
  durationFrames: number,
  options: {
    timelineStart?: number
    sourceStart?: number
    volume?: number
  } = {},
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceRange: {
      startFrame: options.sourceStart ?? 0,
      durationFrames,
    },
    timelineRange: {
      startFrame: options.timelineStart ?? 0,
      durationFrames,
    },
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
    volume: options.volume ?? 1,
    effects: [],
  }
}

function makeAudioTrack(
  id: string,
  clip: Clip,
  flags: { muted?: boolean; solo?: boolean } = {},
): Track {
  return {
    id,
    kind: 'audio',
    name: id,
    clips: [clip],
    transitions: [],
    hidden: false,
    muted: flags.muted ?? false,
    solo: flags.solo ?? false,
    locked: false,
  }
}

function makeAudioDoc(tracks: Track[]): TimelineDoc {
  return { ...makeDoc(), tracks }
}

function makeTransitionVideoDoc(): TimelineDoc {
  const from = makeAudioClip('from', 'asset-a', 3, { sourceStart: 10 })
  const to = makeAudioClip('to', 'asset-a', 3, {
    timelineStart: 3,
    sourceStart: 20,
  })
  return {
    ...makeDoc(),
    tracks: [{
      id: 'V1',
      kind: 'video',
      name: 'V1',
      clips: [from, to],
      transitions: [{
        id: 'dissolve',
        type: 'crossfade',
        fromClipId: from.id,
        toClipId: to.id,
        durationFrames: 3,
      }],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
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

function audioSinkAt(index = 0): FakeAudioSampleSinkRecord {
  return mb.audioSinks[index] as FakeAudioSampleSinkRecord
}

function audioIteratorAt(index = 0): FakeAudioIteratorRecord {
  return mb.audioIterators[index] as FakeAudioIteratorRecord
}

function audioSourceAt(index = 0): FakeAudioSampleSourceRecord {
  return mb.audioSources[index] as FakeAudioSampleSourceRecord
}

function encodedAudioSampleAt(index = 0): FakeAudioSampleRecord {
  return mb.encodedAudioSamples[index] as FakeAudioSampleRecord
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

function audioTrack(canDecode = true, numberOfChannels = 1) {
  return {
    canDecode: vi.fn(async () => canDecode),
    getNumberOfChannels: vi.fn(async () => numberOfChannels),
  }
}

function decodedAudioSample(
  channels: readonly Float32Array[],
  sampleRate: number,
  timestamp = 0,
): FakeAudioSampleRecord {
  if (channels.length === 0) throw new Error('Decoded sample needs a channel')
  const frameCount = channels[0].length
  if (channels.some((channel) => channel.length !== frameCount)) {
    throw new Error('Decoded sample channels must have equal lengths')
  }
  const copyTo = vi.fn(
    (
      destination: Float32Array,
      options: { planeIndex: number; format: string },
    ) => {
      if (options.format !== 'f32-planar') {
        throw new Error('Unexpected decoded copy format')
      }
      const source = channels[options.planeIndex]
      if (!source) throw new Error('Unexpected decoded plane')
      destination.set(source)
    },
  )
  return {
    data: channels[0],
    format: 'f32-planar',
    numberOfChannels: channels.length,
    numberOfFrames: frameCount,
    sampleRate,
    timestamp,
    copyTo,
    close: vi.fn(),
  }
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
  mb.audioTracks.length = 0
  mb.canvasSinkHandlers.length = 0
  mb.canvasSinks.length = 0
  mb.canvasIterators.length = 0
  mb.targetBuffers.length = 0
  mb.targets.length = 0
  mb.canvasSourceAddHandlers.length = 0
  mb.canvasSources.length = 0
  mb.audioSinkSampleSequences.length = 0
  mb.audioSinks.length = 0
  mb.audioIterators.length = 0
  mb.audioSourceAddHandlers.length = 0
  mb.audioSources.length = 0
  mb.encodedAudioSamples.length = 0
  mb.outputStartHandlers.length = 0
  mb.outputFinalizeHandlers.length = 0
  mb.outputCancelHandlers.length = 0
  mb.outputs.length = 0
  mb.formats.length = 0
  mb.canEncodeAudio.mockReset().mockResolvedValue(true)
  mb.canEncodeVideo.mockReset().mockResolvedValue(true)
  fakeCanvases.length = 0
  fakeBitmaps.length = 0
  createBitmap.mockClear()
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('createImageBitmap', createBitmap)
})

describe('createMediabunnyExportMediaSource', () => {
  test('uses the canonical crossfade plan for exact ordered decode timestamps', async () => {
    const doc = makeTransitionVideoDoc()
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      doc,
      async () => new Blob(['asset-a']),
    )
    const ctx = new FakeOffscreenCanvas(doc.width, doc.height).context
    const drawn: string[][] = []

    for (let frame = 0; frame < 6; frame++) {
      const lease = await media.openFrame(frame)
      const result = await compositeFrame(doc, frame, ctx, lease)
      drawn.push(result.drawn)
      await lease.close()
    }
    await media.close()

    expect(drawn).toEqual([
      ['from'],
      ['from'],
      ['from', 'to'],
      ['from', 'to'],
      ['from', 'to'],
      ['to'],
    ])
    expect(mb.inputs).toHaveLength(1)
    expect(canvasSinkAt().canvasesAtTimestamps).toHaveBeenCalledWith(
      [10, 11, 12, 20, 12, 20, 12, 21, 22].map(
        (frame) => (frame * 1_001) / 30_000,
      ),
    )
    expect(createBitmap).toHaveBeenCalledTimes(9)
    for (const bitmap of fakeBitmaps) {
      expect(bitmap.close).toHaveBeenCalledOnce()
    }
    expect(canvasIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('fails lease close when a scheduled render request was omitted', async () => {
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => new Blob(['asset-a']),
    )
    const lease = await media.openFrame(0)

    expect(() => lease.close()).toThrow(
      'Export document frame 0 received 0 of 1 scheduled media requests',
    )
    await media.close()
  })

  test('closes acquired bitmaps before reporting a partially omitted schedule', async () => {
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
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

    const bitmap = await lease.getFrame('asset-a', 0)
    expect(bitmap).toBe(fakeBitmaps[0])
    expect(() => lease.close()).toThrow(
      'Export document frame 0 received 1 of 2 scheduled media requests',
    )
    expect(fakeBitmaps[0].close).toHaveBeenCalledOnce()

    await media.close()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('rejects an out-of-order request against the frame-local render plan', async () => {
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

    await expect(lease.getFrame('asset-b', 0)).rejects.toThrow(
      'Export document frame 0 expected asset-a@0, got asset-b@0',
    )
    expect(() => lease.close()).toThrow(
      'Export document frame 0 received 0 of 2 scheduled media requests',
    )
    await media.close()
  })

  test('rejects an extra request after the frame-local render plan is consumed', async () => {
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => new Blob(['asset-a']),
    )
    const lease = await media.openFrame(0)

    await lease.getFrame('asset-a', 0)
    await expect(lease.getFrame('asset-a', 0)).rejects.toThrow(
      'Export document frame 0 received an extra media request',
    )
    await lease.close()
    await media.close()
  })

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

    const failure = await lease.getFrame('asset-a', 0).catch((cause) => cause)
    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'asset-a',
      message: expect.stringContaining(message),
      failure: {
        surface: 'export',
        trackKind: 'video',
        reason: 'decode-failed',
        detail: expect.stringContaining(message),
      },
    })
    await lease.close()
    await media.close()

    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(mb.canvasSinks).toHaveLength(0)
  })

  test('types Blob resolution and decode-stream failures without typing bitmap-copy failures', async () => {
    const unavailable = new Error('captured Blob is unavailable')
    const unavailableMedia = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => { throw unavailable },
    )
    const unavailableLease = await unavailableMedia.openFrame(0)

    const sourceFailure = await unavailableLease.getFrame('asset-a', 0)
      .catch((cause) => cause)
    expect(sourceFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(sourceFailure).toMatchObject({
      assetId: 'asset-a',
      message: unavailable.message,
      failure: {
        surface: 'export',
        trackKind: null,
        reason: 'resource-unavailable',
        detail: unavailable.message,
      },
    })
    expect(sourceFailure.cause).toBe(unavailable)
    await unavailableLease.close()
    await unavailableMedia.close()

    const decodeFailure = new Error('video cursor failed')
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => { throw decodeFailure })
    const decodeMedia = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-b', sourceStart: 0 }], 1),
      async () => new Blob(['asset-b']),
    )
    const decodeLease = await decodeMedia.openFrame(0)
    const typedDecodeFailure = await decodeLease.getFrame('asset-b', 0)
      .catch((cause) => cause)
    expect(typedDecodeFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(typedDecodeFailure).toMatchObject({
      assetId: 'asset-b',
      failure: {
        surface: 'export',
        trackKind: 'video',
        reason: 'decode-failed',
        detail: decodeFailure.message,
      },
    })
    expect(typedDecodeFailure.cause).toBe(decodeFailure)
    await decodeLease.close()
    await decodeMedia.close()

    const bitmapFailure = new Error('bitmap copy failed')
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    createBitmap.mockRejectedValueOnce(bitmapFailure)
    const bitmapMedia = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-c', sourceStart: 0 }], 1),
      async () => new Blob(['asset-c']),
    )
    const bitmapLease = await bitmapMedia.openFrame(0)
    await expect(bitmapLease.getFrame('asset-c', 0)).rejects.toBe(bitmapFailure)
    expect(bitmapFailure).not.toBeInstanceOf(MediaAssetRuntimeError)
    await bitmapLease.close()
    await bitmapMedia.close()
  })
})

describe('createMediabunnyExportSink video behavior', () => {
  test('probes AVC and wires an exact-rate MP4 canvas track without audio for a video-only document', async () => {
    const doc = makeDoc()
    const resolveAsset = vi.fn(async () => new Blob(['unused']))
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

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
    expect(mb.canEncodeAudio).not.toHaveBeenCalled()
    expect(mb.audioSources).toHaveLength(0)
    expect(outputAt().addAudioTrack).not.toHaveBeenCalled()
    expect(outputAt().start).toHaveBeenCalledOnce()
    expect(sink.ctx).toBe(fakeCanvases[0].context)
    const deps = createMediabunnyExportDeps(resolveAsset)
    expect(deps.composite).toBe(compositeFrame)
    expect(deps.createVideoSink).toEqual(expect.any(Function))
  })

  test('awaits encoder backpressure and finalizes to the target buffer', async () => {
    const add = deferred<void>()
    const resultBuffer = new Uint8Array([8, 9, 10]).buffer
    mb.canvasSourceAddHandlers.push(async () => add.promise)
    mb.targetBuffers.push(resultBuffer)
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 0 }],
      1,
    )
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => new Blob(['unused']),
    )

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
      createMediabunnyExportSink(
        makeDoc(),
        SETTINGS,
        async () => new Blob(['unused']),
      ),
    ).rejects.toThrow('AVC encoding is not supported for 64x48')

    expect(fakeCanvases).toHaveLength(0)
    expect(mb.outputs).toHaveLength(0)
  })

  test('cancels a started output exactly once without normal-closing the source', async () => {
    const sink = await createMediabunnyExportSink(
      makeDoc(),
      SETTINGS,
      async () => new Blob(['unused']),
    )

    await sink.cancel()
    await sink.cancel()

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).not.toHaveBeenCalled()
    await expect(sink.addFrame(0, 1 / 30)).rejects.toThrow(
      'Export sink is closed',
    )
  })

  test('cancels setup when output start fails and preserves the start error', async () => {
    const startError = new Error('start failed')
    mb.outputStartHandlers.push(async () => {
      throw startError
    })

    await expect(
      createMediabunnyExportSink(
        makeDoc(),
        SETTINGS,
        async () => new Blob(['unused']),
      ),
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
    const doc =
      kind === 'add'
        ? makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1)
        : makeDoc()
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => new Blob(['unused']),
    )

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
    const sink = await createMediabunnyExportSink(
      makeDoc(),
      SETTINGS,
      async () => new Blob(['unused']),
    )

    await expect(sink.finalize()).rejects.toThrow(
      'Mediabunny finalized without an output buffer',
    )
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
  })
})

describe('createMediabunnyExportSink audio behavior', () => {
  test('registers AAC, resamples mono, and writes the exact NTSC sample schedule with closed resources', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A1',
        makeAudioClip('audio-clip', 'audio-asset', 3),
      ),
    ])
    const nativeMono = new Float32Array(3_000)
    nativeMono[1] = 1
    const decoded = decodedAudioSample([nativeMono], 24_000)
    const track = audioTrack(true, 1)
    const resolveAsset = vi.fn(async () => new Blob(['audio']))
    mb.audioTracks.push(track)
    mb.audioSinkSampleSequences.push([decoded])

    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    expect(mb.canEncodeAudio).toHaveBeenCalledWith(EXPORT_AUDIO_CODEC, {
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: EXPORT_AUDIO_BITRATE,
    })
    expect(audioSourceAt().encodingConfig).toEqual({
      codec: EXPORT_AUDIO_CODEC,
      bitrate: EXPORT_AUDIO_BITRATE,
      onEncodedPacket: expect.any(Function),
    })
    const encodingConfig = audioSourceAt().encodingConfig as {
      onEncodedPacket(packet: { timestamp: number; duration: number }): void
    }
    const paddedPacket = {
      timestamp: 4_096 / 48_000,
      duration: 1_024 / 48_000,
    }
    encodingConfig.onEncodedPacket(paddedPacket)
    expect(paddedPacket.duration).toBe(709 / 48_000)
    expect(outputAt().addAudioTrack).toHaveBeenCalledWith(audioSourceAt())

    const frameDuration = 1_001 / 30_000
    for (let frame = 0; frame < 3; frame++) {
      await sink.addFrame(frame * frameDuration, frameDuration)
    }
    await sink.finalize()

    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    expect(encoded.map((sample) => sample.numberOfFrames)).toEqual([
      1_024,
      578,
      1_024,
      577,
      1_024,
      578,
    ])
    expect(encoded.map((sample) => sample.timestamp)).toEqual(
      [0, 1_024, 1_602, 2_626, 3_203, 4_227].map(
        (sample) => sample / 48_000,
      ),
    )
    expect(
      encoded.reduce((total, sample) => total + sample.numberOfFrames, 0),
    ).toBe(4_805)
    expect([...encodedAudioSampleAt().data.slice(0, 8)]).toEqual([
      0,
      0,
      0.5,
      0.5,
      1,
      1,
      0.5,
      0.5,
    ])

    expect(audioSinkAt().samples).toHaveBeenCalledWith(0)
    expect(decoded.copyTo).toHaveBeenCalledOnce()
    expect(decoded.copyTo.mock.calls[0][1]).toEqual({
      planeIndex: 0,
      format: 'f32-planar',
    })
    expect(decoded.close).toHaveBeenCalledOnce()
    expect(encoded.every((sample) => sample.close.mock.calls.length === 1)).toBe(
      true,
    )
    expect(audioIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(audioSourceAt().close).toHaveBeenCalledOnce()
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
    expect(outputAt().cancel).not.toHaveBeenCalled()
  })

  test('downmixes 5.1 audio to the stereo export bus', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('surround', 'surround-asset', 1)),
    ])
    const values = [0.05, 0.1, 0.05, 0.02, 0.05, 0.1]
    const decoded = decodedAudioSample(
      values.map((value) => new Float32Array(2_000).fill(value)),
      48_000,
    )
    mb.audioTracks.push(audioTrack(true, 6))
    mb.audioSinkSampleSequences.push([decoded])
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => new Blob(['surround']),
    )

    await sink.addFrame(0, 1_001 / 30_000)
    await sink.finalize()

    const data = encodedAudioSampleAt().data
    expect(data[0]).toBeCloseTo(0.05 + 0.05 * Math.SQRT1_2 + 0.01 + 0.05 * Math.SQRT1_2)
    expect(data[1]).toBeCloseTo(0.1 + 0.05 * Math.SQRT1_2 + 0.01 + 0.1 * Math.SQRT1_2)
    expect(decoded.copyTo).toHaveBeenCalledTimes(6)
    expect(decoded.close).toHaveBeenCalledOnce()
  })

  test('awaits audio backpressure and cancellation closes active decode resources exactly once', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A1',
        makeAudioClip('long-audio', 'audio-asset', 2),
      ),
    ])
    const decoded = decodedAudioSample(
      [new Float32Array(4_000).fill(0.25)],
      48_000,
    )
    const firstAdd = deferred<void>()
    mb.audioTracks.push(audioTrack())
    mb.audioSinkSampleSequences.push([decoded])
    mb.audioSourceAddHandlers.push(async () => firstAdd.promise)
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => new Blob(['audio']),
    )

    let settled = false
    const pending = sink.addFrame(0, 1_001 / 30_000)
    void pending.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(audioSourceAt().add).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(encodedAudioSampleAt().close).not.toHaveBeenCalled()

    firstAdd.resolve()
    await pending
    expect(audioSourceAt().add).toHaveBeenCalledTimes(2)
    expect(settled).toBe(true)

    await sink.cancel()
    await sink.cancel()
    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(audioIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(decoded.close).toHaveBeenCalledOnce()
    expect(
      (mb.encodedAudioSamples as FakeAudioSampleRecord[]).every(
        (sample) => sample.close.mock.calls.length === 1,
      ),
    ).toBe(true)
    expect(audioSourceAt().close).not.toHaveBeenCalled()
  })

  test('waits for the sibling audio write before cleaning up a failed video write', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('audio', 'audio-asset', 1)),
    ])
    const decoded = decodedAudioSample(
      [new Float32Array(2_000).fill(0.25)],
      48_000,
    )
    const audioAdd = deferred<void>()
    const primary = new Error('video write failed')
    mb.audioTracks.push(audioTrack())
    mb.audioSinkSampleSequences.push([decoded])
    mb.canvasSourceAddHandlers.push(async () => {
      throw primary
    })
    mb.audioSourceAddHandlers.push(async () => audioAdd.promise)
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => new Blob(['audio']),
    )

    let rejected = false
    const pending = sink.addFrame(0, 1_001 / 30_000)
    void pending.catch(() => {
      rejected = true
    })
    await vi.waitFor(() => expect(audioSourceAt().add).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(rejected).toBe(false)

    audioAdd.resolve()
    await expect(pending).rejects.toBe(primary)
    expect(audioSourceAt().add).toHaveBeenCalledTimes(2)
    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(
      (mb.encodedAudioSamples as FakeAudioSampleRecord[]).every(
        (sample) => sample.close.mock.calls.length === 1,
      ),
    ).toBe(true)
    expect(audioIteratorAt().return).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })

  test('mute, solo exclusion, and zero volume avoid decoding while exact silence is still encoded', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A-muted',
        makeAudioClip('muted', 'asset-muted', 1),
        { muted: true },
      ),
      makeAudioTrack(
        'A-nonsolo',
        makeAudioClip('nonsolo', 'asset-nonsolo', 1),
      ),
      makeAudioTrack(
        'A-solo-zero',
        makeAudioClip('solo-zero', 'asset-zero', 1, { volume: 0 }),
        { solo: true },
      ),
    ])
    const resolveAsset = vi.fn(async () => new Blob(['should-not-open']))
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    await sink.addFrame(0, 1_001 / 30_000)
    await sink.finalize()

    expect(resolveAsset).not.toHaveBeenCalled()
    expect(mb.inputs).toHaveLength(0)
    expect(mb.audioSinks).toHaveLength(0)
    expect(outputAt().addAudioTrack).toHaveBeenCalledOnce()
    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    expect(encoded.map((sample) => sample.numberOfFrames)).toEqual([
      1_024,
      578,
    ])
    expect(encoded.every((sample) => sample.data.every((value) => value === 0))).toBe(
      true,
    )
    expect(encoded.every((sample) => sample.close.mock.calls.length === 1)).toBe(
      true,
    )
    expect(audioSourceAt().close).toHaveBeenCalledOnce()
  })

  test.each([
    ['has no audio track', 'missing'],
    ['audio cannot be decoded', 'undecodable'],
  ])('fails when an audible asset %s and cleans up exactly once', async (message, kind) => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A1',
        makeAudioClip('bad-audio', 'bad-asset', 1),
      ),
    ])
    mb.audioTracks.push(kind === 'missing' ? null : audioTrack(false))
    const resolveAsset = vi.fn(async () => new Blob(['bad']))
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    const failure = await sink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)
    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'bad-asset',
      message: expect.stringContaining(message),
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason: 'decode-failed',
        detail: expect.stringContaining(message),
      },
    })
    await sink.cancel()

    expect(resolveAsset).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(audioSourceAt().add).not.toHaveBeenCalled()
    expect(audioSourceAt().close).not.toHaveBeenCalled()
    expect(mb.audioSinks).toHaveLength(0)
  })

  test('types audio Blob and decoded-sample read failures with the exact asset id', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('bad-audio', 'bad-asset', 1)),
    ])
    const unavailable = new Error('audio Blob is unavailable')
    const unavailableSink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => { throw unavailable },
    )

    const sourceFailure = await unavailableSink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)
    expect(sourceFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(sourceFailure).toMatchObject({
      assetId: 'bad-asset',
      failure: {
        surface: 'export',
        trackKind: null,
        reason: 'resource-unavailable',
        detail: unavailable.message,
      },
    })
    expect(sourceFailure.cause).toBe(unavailable)

    const decoded = decodedAudioSample([new Float32Array([0.25])], 48_000)
    const readFailure = new Error('decoded plane read failed')
    decoded.copyTo.mockImplementationOnce(() => { throw readFailure })
    mb.audioTracks.push(audioTrack())
    mb.audioSinkSampleSequences.push([decoded])
    const readSink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => new Blob(['audio']),
    )
    const typedReadFailure = await readSink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)
    expect(typedReadFailure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(typedReadFailure).toMatchObject({
      assetId: 'bad-asset',
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason: 'decode-failed',
        detail: readFailure.message,
      },
    })
    expect(typedReadFailure.cause).toBe(readFailure)
    expect(decoded.close).toHaveBeenCalledOnce()
  })
})
