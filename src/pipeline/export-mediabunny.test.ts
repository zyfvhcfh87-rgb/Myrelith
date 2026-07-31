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
import {
  LOCAL_DECODER_LIMITS,
  type DecoderCheckTarget,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
  updateExportProfile,
} from '../domain/exportProfile'
import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type { AssetKind, Clip, TimelineDoc, Track } from '../domain/schema'
import {
  compositeFrame,
  type TransitionSurfaceProvider,
} from './render'
import {
  exportTimeline,
  type ExportSettings,
  type ExportVideoSink,
} from './export'
import { StaticImageDecodeError } from './static-image'
import { audioSampleBoundary } from './export-audio'

const DECODE_BUDGET: LocalDecoderBudget = {
  fileBytes: 64,
  durationMicroseconds: 1_000_000,
  width: 1920,
  height: 1080,
  framesPerSecond: 30,
  sampleRate: 48_000,
  channels: 6,
}

const resolvedAsset = (
  blob: Blob,
  kind: AssetKind = 'video',
) => ({ blob, budget: DECODE_BUDGET, kind })

const localDecoders = vi.hoisted(() => ({
  proresRegistered: false,
  proresRegistrations: 0,
  ac3Registered: false,
  ac3Registrations: 0,
}))

const decoderChecks = vi.hoisted(() => ({
  targets: [] as DecoderCheckTarget[],
}))

const staticImageDecode = vi.hoisted(() => ({
  decode: vi.fn(),
}))

vi.mock('./static-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./static-image')>()
  return {
    ...actual,
    decodeStaticImage: staticImageDecode.decode,
  }
})

vi.mock('../codecs/mediaCodecFallbacks', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../codecs/mediaCodecFallbacks')
  >()
  return {
    ...actual,
    ensureMediaDecoderSupport: (
      target: DecoderCheckTarget,
      signal?: AbortSignal,
    ) => {
      decoderChecks.targets.push(target)
      return actual.ensureMediaDecoderSupport(target, signal)
    },
  }
})

vi.mock('@mediabunny/prores', () => ({
  registerProresDecoder: () => {
    localDecoders.proresRegistered = true
    localDecoders.proresRegistrations++
  },
}))

vi.mock('@mediabunny/ac3', () => ({
  registerAc3Decoder: () => {
    localDecoders.ac3Registered = true
    localDecoders.ac3Registrations++
  },
}))

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

interface FakeStreamTargetRecord {
  options: unknown
  write(chunk: {
    type: 'write'
    data: Uint8Array
    position: number
  }): Promise<void>
  close(): Promise<void>
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
  streamTargets: [] as unknown[],
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
    kind = 'mp4' as const

    constructor() {
      mb.formats.push(this)
    }
  }

  class StreamTarget {
    options: unknown
    #writer: WritableStreamDefaultWriter<unknown>
    #closed = false

    constructor(stream: WritableStream<unknown>, options: unknown) {
      this.options = options
      this.#writer = stream.getWriter()
      mb.streamTargets.push(this)
    }

    write(chunk: unknown): Promise<void> {
      return this.#writer.write(chunk)
    }

    async close(): Promise<void> {
      if (this.#closed) return
      this.#closed = true
      await this.#writer.close()
    }
  }

  class WebMOutputFormat {
    kind = 'webm' as const

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

    constructor(options: { target?: unknown }) {
      this.options = options
      this.addVideoTrack = vi.fn()
      this.addAudioTrack = vi.fn()
      const start = mb.outputStartHandlers.shift() ?? (async () => undefined)
      const finalize =
        mb.outputFinalizeHandlers.shift() ?? (async () => undefined)
      const cancel =
        mb.outputCancelHandlers.shift() ?? (async () => undefined)
      this.start = vi.fn(start)
      this.finalize = vi.fn(async () => {
        await finalize()
        if (options.target instanceof StreamTarget) {
          await options.target.close()
        }
      })
      this.cancel = vi.fn(async () => {
        try {
          await cancel()
        } finally {
          if (options.target instanceof StreamTarget) {
            await options.target.close()
          }
        }
      })
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
    StreamTarget,
    WebMOutputFormat,
    canEncodeAudio: mb.canEncodeAudio,
    canEncodeVideo: mb.canEncodeVideo,
  }
})

import {
  createMediabunnyExportDeps,
  createMediabunnyExportAudioSource,
  createMediabunnyExportMediaSource as createRealExportMediaSource,
  createMediabunnyExportSink,
} from './export-mediabunny'

const SETTINGS: ExportSettings = {
  ...DEFAULT_EXPORT_PROFILE,
  videoBitrate: 250_000,
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 2,
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
          sourceMode: 'timed',
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
    linkGroupId?: string
  } = {},
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode: 'timed',
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
    ...(options.linkGroupId ? { linkGroupId: options.linkGroupId } : {}),
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

function makeAudioCrossfadeDoc(): {
  doc: TimelineDoc
  sourceBounds: SourceBoundsCatalog
} {
  const videoFrom = makeAudioClip('video-from', 'video-from-asset', 3, {
    sourceStart: 10,
    linkGroupId: 'from-link',
  })
  const videoTo = makeAudioClip('video-to', 'video-to-asset', 3, {
    timelineStart: 3,
    sourceStart: 20,
    linkGroupId: 'to-link',
  })
  const audioFrom = makeAudioClip('audio-from', 'audio-from-asset', 3, {
    sourceStart: 10,
    linkGroupId: 'from-link',
  })
  const audioTo = makeAudioClip('audio-to', 'audio-to-asset', 3, {
    timelineStart: 3,
    sourceStart: 20,
    linkGroupId: 'to-link',
  })
  const videoTrack: Track = {
    id: 'V1',
    kind: 'video',
    name: 'V1',
    clips: [videoFrom, videoTo],
    transitions: [{
      id: 'crossfade',
      type: 'crossfade',
      fromClipId: videoFrom.id,
      toClipId: videoTo.id,
      durationFrames: 3,
      audio: { enabled: true, curve: 'equal-power' },
    }],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
  const doc = makeAudioDoc([
    videoTrack,
    makeAudioTrack('A1', audioFrom),
    makeAudioTrack('A2', audioTo),
  ])
  const bounds = {
    video: {
      status: 'exact' as const,
      firstTimestampUs: 0,
      endTimestampUs: 10_000_000,
    },
    audio: {
      status: 'exact' as const,
      firstTimestampUs: 0,
      endTimestampUs: 10_000_000,
    },
  }
  return {
    doc: { ...doc, schemaVersion: 3 },
    sourceBounds: new Map([
      ['video-from-asset', bounds],
      ['video-to-asset', bounds],
      ['audio-from-asset', bounds],
      ['audio-to-asset', bounds],
    ]),
  }
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
        audio: { enabled: true, curve: 'equal-power' },
      }],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

function testSourceBounds(doc: TimelineDoc) {
  return new Map(
    doc.tracks.flatMap((track) => track.clips.map((clip) => [
      clip.assetId,
      {
        video: {
          status: 'exact' as const,
          firstTimestampUs: 0,
          endTimestampUs: 1_000_000_000_000,
        },
        audio: null,
      },
    ] as const)),
  )
}

function createMediabunnyExportMediaSource(
  doc: TimelineDoc,
  resolveAsset: Parameters<typeof createRealExportMediaSource>[1],
) {
  return createRealExportMediaSource(doc, resolveAsset, testSourceBounds(doc))
}

function makeStillDoc(durationFrames = 5): TimelineDoc {
  const doc = makeVideoDoc(
    [{ assetId: 'image-asset', sourceStart: 0 }],
    durationFrames,
  )
  const clip = doc.tracks[0].clips[0]
  return {
    ...doc,
    tracks: [{
      ...doc.tracks[0],
      clips: [{
        ...clip,
        sourceMode: 'still',
        sourceRange: { startFrame: 0, durationFrames: 1 },
      }],
    }],
  }
}

function makeVisualTransitionDoc(
  fromKind: 'image' | 'video',
  toKind: 'image' | 'video',
): TimelineDoc {
  const from = makeAudioClip(`${fromKind}-from`, `${fromKind}-asset`, 3, {
    sourceStart: fromKind === 'video' ? 10 : 0,
  })
  const to = makeAudioClip(`${toKind}-to`, `${toKind}-asset`, 3, {
    timelineStart: 3,
    sourceStart: toKind === 'video' ? 20 : 0,
  })
  if (fromKind === 'image') {
    from.sourceMode = 'still'
    from.sourceRange = { startFrame: 0, durationFrames: 1 }
  }
  if (toKind === 'image') {
    to.sourceMode = 'still'
    to.sourceRange = { startFrame: 0, durationFrames: 1 }
  }
  return {
    ...makeDoc(),
    tracks: [{
      id: 'V1',
      kind: 'video',
      name: 'V1',
      clips: [from, to],
      transitions: [{
        id: `${fromKind}-${toKind}-dissolve`,
        type: 'crossfade',
        fromClipId: from.id,
        toClipId: to.id,
        durationFrames: 3,
        audio: { enabled: true, curve: 'equal-power' },
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
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    fillStyle: '#000000',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  }
  readonly getContext = vi.fn((kind: string, _options?: unknown) =>
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

function streamTargetAt(index = 0): FakeStreamTargetRecord {
  return mb.streamTargets[index] as FakeStreamTargetRecord
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

function videoTrack(
  canDecode: boolean | (() => boolean) = true,
  codec = 'avc',
  configuration: VideoDecoderConfig = {
    codec: codec === 'prores' ? 'apcn' : codec,
    codedHeight: 180,
    codedWidth: 320,
  },
) {
  return {
    getCodec: vi.fn(async () => codec),
    getDecoderConfig: vi.fn(async () => configuration),
    canDecode: vi.fn(async () => (
      typeof canDecode === 'function' ? canDecode() : canDecode
    )),
  }
}

function fakeTransitionSurfaceProvider(
  width: number,
  height: number,
): TransitionSurfaceProvider {
  let surfaces: ReturnType<TransitionSurfaceProvider['get']> | null = null
  return {
    get: () => {
      if (surfaces) return surfaces
      const leg = new FakeOffscreenCanvas(width, height)
      const group = new FakeOffscreenCanvas(width, height)
      surfaces = {
        leg: {
          canvas: leg as unknown as CanvasImageSource,
          ctx: leg.context,
        },
        group: {
          canvas: group as unknown as CanvasImageSource,
          ctx: group.context,
        },
      }
      return surfaces
    },
  }
}

function audioTrack(
  canDecode: boolean | (() => boolean) = true,
  numberOfChannels = 1,
  codec = 'aac',
  configuration: AudioDecoderConfig = {
    codec: codec === 'eac3' ? 'ec-3' : codec,
    numberOfChannels,
    sampleRate: 48_000,
  },
) {
  return {
    getCodec: vi.fn(async () => codec),
    getDecoderConfig: vi.fn(async () => configuration),
    canDecode: vi.fn(async () => (
      typeof canDecode === 'function' ? canDecode() : canDecode
    )),
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
  decoderChecks.targets.length = 0
  mb.blobSources.length = 0
  mb.inputs.length = 0
  mb.inputTracks.length = 0
  mb.audioTracks.length = 0
  mb.canvasSinkHandlers.length = 0
  mb.canvasSinks.length = 0
  mb.canvasIterators.length = 0
  mb.targetBuffers.length = 0
  mb.targets.length = 0
  mb.streamTargets.length = 0
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
  staticImageDecode.decode.mockReset()
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('createImageBitmap', createBitmap)
})

describe('createMediabunnyExportMediaSource', () => {
  test('decodes one retained still and closes it only with the export source', async () => {
    const doc = makeStillDoc()
    const blob = new Blob(['still'])
    const source = {
      width: 800,
      height: 600,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockResolvedValue({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })
    const resolveAsset = vi.fn(async () => resolvedAsset(blob, 'image'))
    const media = createMediabunnyExportMediaSource(doc, resolveAsset)
    const borrowed: Array<ImageBitmap | VideoFrame | null> = []

    for (let frame = 0; frame < 5; frame++) {
      const lease = await media.openFrame(frame)
      borrowed.push(await lease.getFrame('image-asset', 0))
      await lease.close()
      expect(source.close).not.toHaveBeenCalled()
    }
    await media.close()
    await media.close()

    expect(borrowed).toEqual([source, source, source, source, source])
    expect(resolveAsset).toHaveBeenCalledOnce()
    expect(resolveAsset).toHaveBeenCalledWith('image-asset')
    expect(staticImageDecode.decode).toHaveBeenCalledOnce()
    expect(staticImageDecode.decode).toHaveBeenCalledWith(blob, {
      signal: expect.any(AbortSignal),
    })
    expect(mb.inputs).toHaveLength(0)
    expect(mb.canvasSinks).toHaveLength(0)
    expect(createBitmap).not.toHaveBeenCalled()
    expect(source.close).toHaveBeenCalledOnce()
  })

  test.each([
    ['image-to-video', 'image', 'video', 4, 5, 1],
    ['video-to-image', 'video', 'image', 5, 4, 1],
    ['same-image-to-image', 'image', 'image', 0, 9, 0],
  ] as const)(
    'composites a %s crossfade with one retained still decode',
    async (
      _label,
      fromKind,
      toKind,
      expectedVideoCopies,
      expectedImageDraws,
      expectedVideoInputs,
    ) => {
      const doc = makeVisualTransitionDoc(fromKind, toKind)
      const source = {
        width: 320,
        height: 180,
        close: vi.fn(),
      } as unknown as FakeBitmap
      staticImageDecode.decode.mockResolvedValue({
        source,
        sourceKind: 'image-bitmap',
        width: source.width,
        height: source.height,
        animation: { animated: false, frameCount: 1, loopCount: null },
        decoderRepetitionCount: null,
        decodePath: 'image-bitmap',
      })
      if (expectedVideoInputs > 0) {
        mb.inputTracks.push(videoTrack())
        mb.canvasSinkHandlers.push(async () => wrappedCanvas())
      }
      const media = createMediabunnyExportMediaSource(
        doc,
        async (assetId) => resolvedAsset(
          new Blob([assetId]),
          assetId === 'image-asset' ? 'image' : 'video',
        ),
      )
      const canvas = new FakeOffscreenCanvas(doc.width, doc.height)
      const transitionSurfaceProvider = fakeTransitionSurfaceProvider(
        doc.width,
        doc.height,
      )
      const drawn: string[][] = []

      for (let frame = 0; frame < 6; frame++) {
        const lease = await media.openFrame(frame)
        const result = await compositeFrame(
          doc,
          lease.plan,
          canvas.context,
          lease,
          transitionSurfaceProvider,
        )
        drawn.push(result.drawn)
        await lease.close()
      }

      expect(drawn).toEqual([
        [`${fromKind}-from`],
        [`${fromKind}-from`],
        [`${fromKind}-from`, `${toKind}-to`],
        [`${fromKind}-from`, `${toKind}-to`],
        [`${fromKind}-from`, `${toKind}-to`],
        [`${toKind}-to`],
      ])
      expect(staticImageDecode.decode).toHaveBeenCalledOnce()
      expect(mb.inputs).toHaveLength(expectedVideoInputs)
      expect(createBitmap).toHaveBeenCalledTimes(expectedVideoCopies)
      expect(
        fakeCanvases.flatMap(
          (candidate) => candidate.context.drawImage.mock.calls,
        ).filter(([image]) => image === source),
      ).toHaveLength(expectedImageDraws)
      expect(source.close).not.toHaveBeenCalled()
      for (const bitmap of fakeBitmaps) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }

      await media.close()
      expect(source.close).toHaveBeenCalledOnce()
      if (expectedVideoInputs > 0) {
        expect(canvasIteratorAt().return).toHaveBeenCalledOnce()
        expect(inputAt().dispose).toHaveBeenCalledOnce()
      } else {
        expect(mb.canvasIterators).toHaveLength(0)
      }
    },
  )

  test('preserves static-image resource-limit identity at the export boundary', async () => {
    const decodeFailure = new StaticImageDecodeError('resource-limit', 'png')
    staticImageDecode.decode.mockRejectedValue(decodeFailure)
    const media = createMediabunnyExportMediaSource(
      makeStillDoc(1),
      async () => resolvedAsset(new Blob(['oversized']), 'image'),
    )
    const lease = await media.openFrame(0)

    const failure = await lease.getFrame('image-asset', 0).catch((cause) => cause)

    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'image-asset',
      failure: {
        surface: 'export',
        trackKind: null,
        reason: 'resource-limit',
      },
    })
    expect(failure.cause).toBe(decodeFailure)
    await lease.close()
    await media.close()
  })

  test('closes a still that finishes decoding after source shutdown', async () => {
    const decoded = deferred<{
      source: FakeBitmap
      sourceKind: 'image-bitmap'
      width: number
      height: number
      animation: {
        animated: false
        frameCount: 1
        loopCount: null
      }
      decoderRepetitionCount: null
      decodePath: 'image-bitmap'
    }>()
    const source = {
      width: 16,
      height: 16,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockReturnValue(decoded.promise)
    const media = createMediabunnyExportMediaSource(
      makeStillDoc(1),
      async () => resolvedAsset(new Blob(['late']), 'image'),
    )
    const lease = await media.openFrame(0)
    const borrowed = lease.getFrame('image-asset', 0)
    const rejected = borrowed.catch((cause) => cause)
    await vi.waitFor(() => expect(staticImageDecode.decode).toHaveBeenCalledOnce())

    const closed = media.close()
    const decodeOptions = staticImageDecode.decode.mock.calls[0][1] as {
      signal: AbortSignal
    }
    expect(decodeOptions.signal.aborted).toBe(true)
    decoded.resolve({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })

    await expect(rejected).resolves.toMatchObject({
      message: 'Export media source is closed',
    })
    await closed
    await lease.close()
    expect(source.close).toHaveBeenCalledOnce()
  })

  test('early export return cancels the sink and closes its retained still once', async () => {
    const doc = makeStillDoc(3)
    const source = {
      width: 64,
      height: 48,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockResolvedValue({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })
    const media = createMediabunnyExportMediaSource(
      doc,
      async () => resolvedAsset(new Blob(['still']), 'image'),
    )
    const openFrame = vi.spyOn(media, 'openFrame')
    const closeMedia = vi.spyOn(media, 'close')
    const canvas = new FakeOffscreenCanvas(doc.width, doc.height)
    const sink: ExportVideoSink = {
      ctx: canvas.context,
      transitionSurfaceProvider: fakeTransitionSurfaceProvider(
        doc.width,
        doc.height,
      ),
      addFrame: vi.fn(async () => undefined),
      finalize: vi.fn(async () => ({
        destination: 'download' as const,
        buffer: new ArrayBuffer(0),
        mimeType: 'video/mp4' as const,
        fileExtension: 'mp4' as const,
        profile: DEFAULT_EXPORT_PROFILE,
      })),
      cancel: vi.fn(async () => undefined),
    }
    const run = exportTimeline(doc, SETTINGS, media, {
      composite: compositeFrame,
      createVideoSink: async () => sink,
    })

    await expect(run.next()).resolves.toEqual({ done: false, value: 0 })
    await expect(run.next()).resolves.toEqual({ done: false, value: 1 / 4 })
    expect(source.close).not.toHaveBeenCalled()
    await expect(run.return(undefined)).resolves.toMatchObject({ done: true })

    expect(openFrame).toHaveBeenCalledOnce()
    expect(sink.addFrame).toHaveBeenCalledOnce()
    expect(sink.finalize).not.toHaveBeenCalled()
    expect(sink.cancel).toHaveBeenCalledOnce()
    expect(closeMedia).toHaveBeenCalledOnce()
    expect(source.close).toHaveBeenCalledOnce()
    const decodeOptions = staticImageDecode.decode.mock.calls[0][1] as {
      signal: AbortSignal
    }
    expect(decodeOptions.signal.aborted).toBe(true)
  })

  test('encoder failure stays primary while the retained still closes once', async () => {
    const doc = makeStillDoc(2)
    const source = {
      width: 64,
      height: 48,
      close: vi.fn(),
    } as unknown as FakeBitmap
    staticImageDecode.decode.mockResolvedValue({
      source,
      sourceKind: 'image-bitmap',
      width: source.width,
      height: source.height,
      animation: { animated: false, frameCount: 1, loopCount: null },
      decoderRepetitionCount: null,
      decodePath: 'image-bitmap',
    })
    const media = createMediabunnyExportMediaSource(
      doc,
      async () => resolvedAsset(new Blob(['still']), 'image'),
    )
    const openFrame = vi.spyOn(media, 'openFrame')
    const closeMedia = vi.spyOn(media, 'close')
    const primary = new Error('encoder failed')
    const canvas = new FakeOffscreenCanvas(doc.width, doc.height)
    const sink: ExportVideoSink = {
      ctx: canvas.context,
      transitionSurfaceProvider: fakeTransitionSurfaceProvider(
        doc.width,
        doc.height,
      ),
      addFrame: vi.fn(async () => {
        throw primary
      }),
      finalize: vi.fn(async () => ({
        destination: 'download' as const,
        buffer: new ArrayBuffer(0),
        mimeType: 'video/mp4' as const,
        fileExtension: 'mp4' as const,
        profile: DEFAULT_EXPORT_PROFILE,
      })),
      cancel: vi.fn(async () => undefined),
    }
    const run = exportTimeline(doc, SETTINGS, media, {
      composite: compositeFrame,
      createVideoSink: async () => sink,
    })

    await expect(run.next()).resolves.toEqual({ done: false, value: 0 })
    await expect(run.next()).rejects.toBe(primary)

    expect(openFrame).toHaveBeenCalledOnce()
    expect(sink.addFrame).toHaveBeenCalledOnce()
    expect(sink.finalize).not.toHaveBeenCalled()
    expect(sink.cancel).toHaveBeenCalledOnce()
    expect(closeMedia).toHaveBeenCalledOnce()
    expect(source.close).toHaveBeenCalledOnce()
    const decodeOptions = staticImageDecode.decode.mock.calls[0][1] as {
      signal: AbortSignal
    }
    expect(decodeOptions.signal.aborted).toBe(true)
  })

  test('uses the canonical crossfade plan for exact ordered decode timestamps', async () => {
    const doc = makeTransitionVideoDoc()
    mb.inputTracks.push(videoTrack())
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      doc,
      async () => resolvedAsset(new Blob(['asset-a'])),
    )
    const ctx = new FakeOffscreenCanvas(doc.width, doc.height).context
    const transitionSurfaceProvider = fakeTransitionSurfaceProvider(
      doc.width,
      doc.height,
    )
    const drawn: string[][] = []

    for (let frame = 0; frame < 6; frame++) {
      const lease = await media.openFrame(frame)
      const result = await compositeFrame(
        doc,
        lease.plan,
        ctx,
        lease,
        transitionSurfaceProvider,
      )
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
      [10, 11, 12, 19, 13, 20, 14, 21, 22].map(
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
      async () => resolvedAsset(new Blob(['asset-a'])),
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
      async (assetId) => resolvedAsset(new Blob([assetId])),
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
      async (assetId) => resolvedAsset(new Blob([assetId])),
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
      async () => resolvedAsset(new Blob(['asset-a'])),
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
    const resolveAsset = vi.fn(async () => resolvedAsset(blob))
    const configuration: VideoDecoderConfig = {
      codec: 'avc1.64001f',
      codedHeight: 180,
      codedWidth: 320,
      description: new Uint8Array([1, 2, 3]),
    }
    const track = videoTrack(true, 'avc', configuration)
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
    expect(track.getDecoderConfig).toHaveBeenCalledOnce()
    expect(track.canDecode).toHaveBeenCalledOnce()
    expect(decoderChecks.targets).toHaveLength(1)
    expect(decoderChecks.targets[0]).toMatchObject({
      codec: 'avc',
      configuration,
      trackKind: 'video',
      sourceId: 'asset-a',
      boundary: 'export-video',
      policy: 'revalidate',
    })
    expect(decoderChecks.targets[0].configuration).toBe(configuration)
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

  test('loads local ProRes support before allocating the export sink', async () => {
    const track = videoTrack(
      () => localDecoders.proresRegistered,
      'prores',
    )
    const registrationsBefore = localDecoders.proresRegistrations
    mb.inputTracks.push(track)
    mb.canvasSinkHandlers.push(async () => wrappedCanvas())
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'prores-asset', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['prores'])),
    )
    const lease = await media.openFrame(0)

    const bitmap = await lease.getFrame('prores-asset', 0)

    expect(bitmap).toBe(fakeBitmaps[0])
    expect(localDecoders.proresRegistrations).toBe(registrationsBefore + 1)
    expect(track.canDecode).toHaveBeenCalledTimes(2)
    expect(canvasSinkAt().track).toBe(track)
    await lease.close()
    await media.close()
  })

  test('preserves a ProRes resource limit and allocates no export sink', async () => {
    const track = videoTrack(false, 'prores')
    const registrationsBefore = localDecoders.proresRegistrations
    mb.inputTracks.push(track)
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'large-prores', sourceStart: 0 }], 1),
      async () => ({
        blob: new Blob(['prores']),
        kind: 'video',
        budget: {
          ...DECODE_BUDGET,
          fileBytes: LOCAL_DECODER_LIMITS.maxFileBytes + 1,
        },
      }),
    )
    const lease = await media.openFrame(0)

    const failure = await lease.getFrame('large-prores', 0)
      .catch((cause) => cause)

    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'large-prores',
      failure: {
        surface: 'export',
        trackKind: 'video',
        reason: 'resource-limit',
      },
    })
    expect(localDecoders.proresRegistrations).toBe(registrationsBefore)
    expect(mb.canvasSinks).toHaveLength(0)
    await lease.close()
    await media.close()
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
      async () => resolvedAsset(new Blob(['asset-a'])),
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
      async (assetId) => resolvedAsset(new Blob([assetId])),
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
    ['has no video track', null, 'decode-failed'],
    ['cannot be decoded', videoTrack(false), 'unsupported-codec'],
  ])('rejects an asset that %s and still disposes its input', async (
    message,
    track,
    reason,
  ) => {
    mb.inputTracks.push(track)
    const media = createMediabunnyExportMediaSource(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      async () => resolvedAsset(new Blob(['bad'])),
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
        reason,
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
      async () => resolvedAsset(new Blob(['asset-b'])),
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
      async () => resolvedAsset(new Blob(['asset-c'])),
    )
    const bitmapLease = await bitmapMedia.openFrame(0)
    await expect(bitmapLease.getFrame('asset-c', 0)).rejects.toBe(bitmapFailure)
    expect(bitmapFailure).not.toBeInstanceOf(MediaAssetRuntimeError)
    await bitmapLease.close()
    await bitmapMedia.close()
  })
})

describe('createMediabunnyExportSink video behavior', () => {
  test('wires an exact-rate MP4 canvas track without audio for a video-only document', async () => {
    const doc = makeDoc()
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['unused'])))
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    expect(mb.canEncodeVideo).not.toHaveBeenCalled()
    expect(fakeCanvases).toHaveLength(1)
    expect(fakeCanvases[0]).toMatchObject({ width: 64, height: 48 })
    expect(fakeCanvases[0].getContext).toHaveBeenCalledWith(
      '2d',
      { colorSpace: 'srgb' },
    )
    expect(canvasSourceAt().canvas).toBe(fakeCanvases[0])
    expect(canvasSourceAt().encodingConfig).toEqual({
      codec: 'avc',
      bitrate: 250_000,
      bitrateMode: 'variable',
      keyFrameInterval: 2,
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
    const transitionSurfaces = sink.transitionSurfaceProvider.get()
    expect(fakeCanvases).toHaveLength(3)
    expect(transitionSurfaces.leg.canvas).toBe(fakeCanvases[1])
    expect(transitionSurfaces.group.canvas).toBe(fakeCanvases[2])
    expect(fakeCanvases[1].getContext).toHaveBeenCalledWith(
      '2d',
      { colorSpace: 'srgb' },
    )
    expect(fakeCanvases[2].getContext).toHaveBeenCalledWith(
      '2d',
      { colorSpace: 'srgb' },
    )
    expect(sink.transitionSurfaceProvider.get()).toBe(transitionSurfaces)
    expect(fakeCanvases).toHaveLength(3)
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
      async () => resolvedAsset(new Blob(['unused'])),
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
      destination: 'download',
      buffer: resultBuffer,
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      profile: SETTINGS,
    })
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
    expect(outputAt().cancel).not.toHaveBeenCalled()
  })

  test('does not reuse a stale cached capability result after fresh preflight', async () => {
    mb.canEncodeVideo.mockResolvedValue(false)

    const sink = await createMediabunnyExportSink(
      makeDoc(),
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
    )

    expect(mb.canEncodeVideo).not.toHaveBeenCalled()
    expect(fakeCanvases).toHaveLength(1)
    expect(mb.outputs).toHaveLength(1)
    await sink.cancel()
  })

  test('cancels a started output exactly once without normal-closing the source', async () => {
    const sink = await createMediabunnyExportSink(
      makeDoc(),
      SETTINGS,
      async () => resolvedAsset(new Blob(['unused'])),
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
        async () => resolvedAsset(new Blob(['unused'])),
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
      async () => resolvedAsset(new Blob(['unused'])),
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
      async () => resolvedAsset(new Blob(['unused'])),
    )

    await expect(sink.finalize()).rejects.toThrow(
      'Mediabunny finalized without an output buffer',
    )
    expect(canvasSourceAt().close).toHaveBeenCalledOnce()
    expect(outputAt().finalize).toHaveBeenCalledOnce()
  })
})

describe('createMediabunnyExportAudioSource exact ranges', () => {
  test('fails an exact crossfade handle instead of zero-filling early EOF', async () => {
    const decoded = decodedAudioSample(
      [new Float32Array(4).fill(0.25)],
      48_000,
    )
    mb.audioTracks.push(audioTrack(true, 1))
    mb.audioSinkSampleSequences.push([decoded])
    const source = createMediabunnyExportAudioSource(
      async () => resolvedAsset(new Blob(['short-audio'])),
    )
    const reader = await source.openClip({
      clipId: 'exact-handle',
      assetId: 'audio-asset',
      startSample: 0,
      endSample: 10,
      sampleRate: 48_000,
      channelCount: 2,
      requireComplete: true,
    })

    const failure = await reader.read(10).catch((cause) => cause)
    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'audio-asset',
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason: 'decode-failed',
        detail: expect.stringContaining('source ended early'),
      },
    })

    await reader.close()
    await source.close()
    expect(decoded.close).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })
})

describe('createMediabunnyExportSink selected profiles', () => {
  test.each([
    ['hevc', 'mp4', 'hevc', 'video/mp4', 'mp4'],
    ['web', 'webm', 'vp9', 'video/webm', 'webm'],
    ['modern', 'webm', 'av1', 'video/webm', 'webm'],
  ] as const)(
    'writes the %s video profile through its exact format and codec',
    async (presetId, formatKind, codec, mimeType, fileExtension) => {
      const profile = updateExportProfile(exportPresetById(presetId).profile, {
        videoBitrate: 3_210_000,
        videoBitrateMode: 'constant',
        keyFrameIntervalMicroseconds: 750_000,
      })
      const doc = makeVideoDoc(
        [{ assetId: 'asset-a', sourceStart: 0 }],
        1,
      )
      const sink = await createMediabunnyExportSink(
        doc,
        profile,
        async () => resolvedAsset(new Blob(['unused'])),
      )

      expect(mb.formats.at(-1)).toMatchObject({ kind: formatKind })
      expect(canvasSourceAt().encodingConfig).toEqual({
        codec,
        bitrate: 3_210_000,
        bitrateMode: 'constant',
        keyFrameInterval: 0.75,
      })
      expect(mb.audioSources).toHaveLength(0)

      await sink.addFrame(0, 1_001 / 30_000)
      const result = await sink.finalize()
      expect(result).toMatchObject({
        destination: 'download',
        mimeType,
        fileExtension,
        profile,
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.profile)).toBe(true)
    },
  )

  test('streams a direct-file profile and returns metadata without a buffer', async () => {
    const directFile = updateExportProfile(SETTINGS, { destination: 'file' })
    const write = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const abort = vi.fn(async () => undefined)
    const writable = { write, close, abort } as unknown as
      FileSystemWritableFileStream
    const createWritable = vi.fn(async () => writable)
    const handle = {
      name: 'chosen-output.mp4',
      createWritable,
    } as unknown as FileSystemFileHandle
    const takeFileHandle = vi.fn(() => handle)
    const doc = makeVideoDoc(
      [{ assetId: 'asset-a', sourceStart: 0 }],
      1,
    )
    const sink = await createMediabunnyExportSink(
      doc,
      directFile,
      async () => resolvedAsset(new Blob(['unused'])),
      new Map(),
      { fileName: 'chosen-output.mp4', takeFileHandle },
    )

    await streamTargetAt().write({
      type: 'write',
      data: Uint8Array.from([1, 2, 3]),
      position: 4,
    })
    await streamTargetAt().write({
      type: 'write',
      data: Uint8Array.from([9, 8]),
      position: 0,
    })
    await sink.addFrame(0, 1_001 / 30_000)
    const result = await sink.finalize()

    expect(result).toEqual({
      destination: 'file',
      fileName: 'chosen-output.mp4',
      byteLength: 7,
      mimeType: 'video/mp4',
      fileExtension: 'mp4',
      profile: directFile,
    })
    expect(result).not.toHaveProperty('buffer')
    expect(result).not.toHaveProperty('handle')
    expect(takeFileHandle).toHaveBeenCalledOnce()
    expect(createWritable).toHaveBeenCalledWith({ keepExistingData: false })
    expect(write).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
    expect(mb.targets).toHaveLength(0)
  })

  test('cancels a direct-file sink exactly once without committing it', async () => {
    const directFile = updateExportProfile(SETTINGS, { destination: 'file' })
    const close = vi.fn(async () => undefined)
    const abort = vi.fn(async () => undefined)
    const writable = {
      write: vi.fn(async () => undefined),
      close,
      abort,
    } as unknown as FileSystemWritableFileStream
    const handle = {
      name: 'cancelled.mp4',
      createWritable: vi.fn(async () => writable),
    } as unknown as FileSystemFileHandle
    const sink = await createMediabunnyExportSink(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      directFile,
      async () => resolvedAsset(new Blob(['unused'])),
      new Map(),
      {
        fileName: 'cancelled.mp4',
        takeFileHandle: vi.fn(() => handle),
      },
    )

    await Promise.all([sink.cancel(), sink.cancel()])

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  })

  test('aborts a direct file once and preserves an Output.start failure', async () => {
    const directFile = updateExportProfile(SETTINGS, { destination: 'file' })
    const failure = new Error('output start failed')
    mb.outputStartHandlers.push(async () => {
      throw failure
    })
    const close = vi.fn(async () => undefined)
    const abort = vi.fn(async () => undefined)
    const writable = {
      write: vi.fn(async () => undefined),
      close,
      abort,
    } as unknown as FileSystemWritableFileStream
    const handle = {
      name: 'failed.mp4',
      createWritable: vi.fn(async () => writable),
    } as unknown as FileSystemFileHandle

    await expect(createMediabunnyExportSink(
      makeVideoDoc([{ assetId: 'asset-a', sourceStart: 0 }], 1),
      directFile,
      async () => resolvedAsset(new Blob(['unused'])),
      new Map(),
      {
        fileName: 'failed.mp4',
        takeFileHandle: vi.fn(() => handle),
      },
    )).rejects.toBe(failure)

    expect(outputAt().cancel).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledWith(failure)
    expect(close).not.toHaveBeenCalled()
  })

  test('rejects exact-duration Opus before allocating an output', async () => {
    const audioDoc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('opus-clip', 'opus-asset', 1)),
    ])
    await expect(createMediabunnyExportSink(
      audioDoc,
      exportPresetById('web').profile,
      async () => resolvedAsset(new Blob(['unused'])),
    )).rejects.toThrow(/exact Opus end-padding metadata/)

    expect(fakeCanvases).toHaveLength(0)
    expect(mb.targets).toHaveLength(0)
    expect(mb.streamTargets).toHaveLength(0)
    expect(mb.outputs).toHaveLength(0)
  })
})

describe('createMediabunnyExportSink audio behavior', () => {
  test('explicit audio-off skips the mixer and output track even with audio clips', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('muted-export', 'audio-asset', 1)),
    ])
    const audioOff = updateExportProfile(SETTINGS, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    })
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['audio'])))

    const sink = await createMediabunnyExportSink(doc, audioOff, resolveAsset)
    await sink.addFrame(0, 1_001 / 30_000)
    await sink.finalize()

    expect(resolveAsset).not.toHaveBeenCalled()
    expect(mb.audioSources).toHaveLength(0)
    expect(mb.audioSinks).toHaveLength(0)
    expect(outputAt().addAudioTrack).not.toHaveBeenCalled()
  })

  test('encodes the shared absolute equal-power crossfade plan', async () => {
    const fixture = makeAudioCrossfadeDoc()
    const decodedFrom = decodedAudioSample([
      new Float32Array(48_000).fill(1),
      new Float32Array(48_000),
    ], 48_000)
    const decodedTo = decodedAudioSample([
      new Float32Array(48_000),
      new Float32Array(48_000).fill(1),
    ], 48_000)
    mb.audioTracks.push(audioTrack(true, 2), audioTrack(true, 2))
    mb.audioSinkSampleSequences.push([decodedFrom], [decodedTo])
    const sink = await createMediabunnyExportSink(
      fixture.doc,
      SETTINGS,
      async (assetId) => resolvedAsset(new Blob([assetId])),
      fixture.sourceBounds,
    )

    const frameDuration = 1_001 / 30_000
    for (let frame = 0; frame < 6; frame++) {
      await sink.addFrame(frame * frameDuration, frameDuration)
    }
    await sink.finalize()

    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    const sampleAt = (sample: number): [number, number] => {
      const block = encoded.find((candidate) => {
        const start = Math.round(candidate.timestamp * candidate.sampleRate)
        return sample >= start && sample < start + candidate.numberOfFrames
      })
      if (!block) throw new Error(`Missing encoded sample ${sample}`)
      const start = Math.round(block.timestamp * block.sampleRate)
      const offset = (sample - start) * 2
      return [block.data[offset], block.data[offset + 1]]
    }
    const start = audioSampleBoundary(2, fixture.doc)
    const end = audioSampleBoundary(5, fixture.doc)
    const span = end - start
    for (const offset of [0, Math.floor(span / 2), span - 1]) {
      const progress = offset / span
      const [left, right] = sampleAt(start + offset)
      expect(left).toBeCloseTo(Math.cos(progress * Math.PI / 2), 5)
      expect(right).toBeCloseTo(Math.sin(progress * Math.PI / 2), 5)
    }
    expect(mb.audioSinks).toHaveLength(2)
    expect(decodedFrom.close).toHaveBeenCalledOnce()
    expect(decodedTo.close).toHaveBeenCalledOnce()
  })

  test('loads local E-AC-3 support before allocating the audio sink', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('eac3-clip', 'eac3-asset', 1)),
    ])
    const configuration: AudioDecoderConfig = {
      codec: 'ec-3',
      description: new Uint8Array([4, 5, 6]),
      numberOfChannels: 6,
      sampleRate: 48_000,
    }
    const track = audioTrack(
      () => localDecoders.ac3Registered,
      6,
      'eac3',
      configuration,
    )
    const decoded = decodedAudioSample(
      Array.from({ length: 6 }, () => new Float32Array(1_602)),
      48_000,
    )
    const registrationsBefore = localDecoders.ac3Registrations
    mb.audioTracks.push(track)
    mb.audioSinkSampleSequences.push([decoded])
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => resolvedAsset(new Blob(['eac3'])),
    )

    await sink.addFrame(0, 1_001 / 30_000)

    expect(localDecoders.ac3Registrations).toBe(registrationsBefore + 1)
    expect(track.getDecoderConfig).toHaveBeenCalledOnce()
    expect(track.canDecode).toHaveBeenCalledTimes(2)
    expect(decoderChecks.targets).toHaveLength(1)
    expect(decoderChecks.targets[0]).toMatchObject({
      codec: 'eac3',
      configuration,
      trackKind: 'audio',
      sourceId: 'eac3-asset',
      boundary: 'export-audio',
      policy: 'revalidate',
    })
    expect(decoderChecks.targets[0].configuration).toBe(configuration)
    expect(audioSinkAt().track).toBe(track)
    await sink.cancel()
  })

  test('preserves an E-AC-3 resource limit and allocates no audio sink', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('eac3-clip', 'large-eac3', 1)),
    ])
    const track = audioTrack(false, 6, 'eac3')
    const registrationsBefore = localDecoders.ac3Registrations
    mb.audioTracks.push(track)
    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      async () => ({
        blob: new Blob(['eac3']),
        kind: 'audio',
        budget: {
          ...DECODE_BUDGET,
          fileBytes: LOCAL_DECODER_LIMITS.maxFileBytes + 1,
        },
      }),
    )

    const failure = await sink.addFrame(0, 1_001 / 30_000)
      .catch((cause) => cause)

    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'large-eac3',
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason: 'resource-limit',
      },
    })
    expect(localDecoders.ac3Registrations).toBe(registrationsBefore)
    expect(mb.audioSinks).toHaveLength(0)
    expect(inputAt().dispose).toHaveBeenCalledOnce()
    await sink.cancel()
  })

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
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['audio'])))
    mb.audioTracks.push(track)
    mb.audioSinkSampleSequences.push([decoded])

    const sink = await createMediabunnyExportSink(
      doc,
      SETTINGS,
      resolveAsset,
    )

    expect(mb.canEncodeAudio).not.toHaveBeenCalled()
    expect(audioSourceAt().encodingConfig).toEqual({
      codec: SETTINGS.audioCodec,
      bitrate: SETTINGS.audioBitrate,
      bitrateMode: SETTINGS.audioBitrateMode,
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

  test('encodes a mono layout by averaging the bounded stereo mix bus', async () => {
    const doc = makeAudioDoc([
      makeAudioTrack('A1', makeAudioClip('mono-output', 'audio-asset', 1)),
    ])
    const left = new Float32Array(2_000).fill(0.8)
    const right = new Float32Array(2_000).fill(0.2)
    const decoded = decodedAudioSample([left, right], 48_000)
    mb.audioTracks.push(audioTrack(true, 2))
    mb.audioSinkSampleSequences.push([decoded])
    const profile = updateExportProfile(SETTINGS, {
      audioChannelLayout: 'mono',
      audioBitrate: 96_000,
      audioBitrateMode: 'constant',
    })
    const sink = await createMediabunnyExportSink(
      doc,
      profile,
      async () => resolvedAsset(new Blob(['stereo-source'])),
    )

    await sink.addFrame(0, 1_001 / 30_000)
    const result = await sink.finalize()

    expect(audioSourceAt().encodingConfig).toMatchObject({
      codec: 'aac',
      bitrate: 96_000,
      bitrateMode: 'constant',
      onEncodedPacket: expect.any(Function),
    })
    const encoded = mb.encodedAudioSamples as FakeAudioSampleRecord[]
    expect(encoded).toHaveLength(2)
    expect(encoded.every((sample) => sample.numberOfChannels === 1)).toBe(true)
    expect(encoded.every((sample) => (
      [...sample.data].every((value) => Math.abs(value - 0.5) < 1e-6)
    ))).toBe(true)
    expect(result.profile.audioChannelLayout).toBe('mono')
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
      async () => resolvedAsset(new Blob(['surround'])),
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
      async () => resolvedAsset(new Blob(['audio'])),
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
      async () => resolvedAsset(new Blob(['audio'])),
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
    const resolveAsset = vi.fn(async () => (
      resolvedAsset(new Blob(['should-not-open']))
    ))
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
    ['has no audio track', 'missing', 'decode-failed'],
    ['audio cannot be decoded', 'undecodable', 'unsupported-codec'],
  ])('fails when an audible asset %s and cleans up exactly once', async (
    message,
    kind,
    reason,
  ) => {
    const doc = makeAudioDoc([
      makeAudioTrack(
        'A1',
        makeAudioClip('bad-audio', 'bad-asset', 1),
      ),
    ])
    mb.audioTracks.push(kind === 'missing' ? null : audioTrack(false))
    const resolveAsset = vi.fn(async () => resolvedAsset(new Blob(['bad'])))
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
        reason,
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
      async () => resolvedAsset(new Blob(['audio'])),
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
