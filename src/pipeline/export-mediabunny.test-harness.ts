/**
 * Shared real-adapter ownership and wiring harness for the split
 * Mediabunny export adapter suites.
 *
 * Mediabunny and browser canvas primitives are recorded fakes here. The real
 * codec/container path is exercised separately in the browser gate.
 */

import {
  beforeEach,
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

const lensBackends = vi.hoisted(() => [] as Array<{
  dispose: Mock<() => void>
}>)

vi.mock('./lensRemapWebgl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lensRemapWebgl')>()
  return {
    ...actual,
    WebGl2LensRemapBackend: class {
      readonly dispose = vi.fn()

      constructor() {
        lensBackends.push(this)
      }
    },
  }
})

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
    schemaVersion: 3,
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
  lensBackends.length = 0
  fakeCanvases.length = 0
  fakeBitmaps.length = 0
  createBitmap.mockClear()
  staticImageDecode.decode.mockReset()
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('createImageBitmap', createBitmap)
})

const adapterTestSubject = {
  DEFAULT_EXPORT_PROFILE,
  LOCAL_DECODER_LIMITS,
  MediaAssetRuntimeError,
  StaticImageDecodeError,
  audioSampleBoundary,
  compositeFrame,
  createMediabunnyExportAudioSource,
  createMediabunnyExportDeps,
  createMediabunnyExportSink,
  exportPresetById,
  exportTimeline,
  updateExportProfile,
}

export {
  DECODE_BUDGET,
  SETTINGS,
  adapterTestSubject,
  audioIteratorAt,
  audioSinkAt,
  audioSourceAt,
  audioTrack,
  canvasIteratorAt,
  canvasSinkAt,
  canvasSourceAt,
  createBitmap,
  createMediabunnyExportMediaSource,
  decodedAudioSample,
  decoderChecks,
  deferred,
  encodedAudioSampleAt,
  fakeBitmaps,
  fakeCanvases,
  fakeTransitionSurfaceProvider,
  FakeOffscreenCanvas,
  inputAt,
  localDecoders,
  lensBackends,
  makeAudioClip,
  makeAudioCrossfadeDoc,
  makeAudioDoc,
  makeAudioTrack,
  makeDoc,
  makeStillDoc,
  makeTransitionVideoDoc,
  makeVideoDoc,
  makeVisualTransitionDoc,
  mb,
  outputAt,
  resolvedAsset,
  staticImageDecode,
  streamTargetAt,
  videoTrack,
  wrappedCanvas,
}

export type { FakeAudioSampleRecord, FakeBitmap }
