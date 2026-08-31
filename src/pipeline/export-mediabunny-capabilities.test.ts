import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
  updateExportProfile,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'

interface FakeCanvasSourceRecord {
  canvas: unknown
  config: unknown
  add: Mock<(timestamp: number, duration: number) => Promise<void>>
  close: Mock<() => void>
}

interface FakeAudioSourceRecord {
  config: unknown
  add: Mock<(sample: FakeAudioSampleRecord) => Promise<void>>
  close: Mock<() => void>
}

interface FakeAudioSampleRecord {
  init: {
    data: Float32Array
    format: string
    numberOfChannels: number
    sampleRate: number
    timestamp: number
  }
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
  formats: [] as Array<{ kind: 'mp4' | 'webm' }>,
  targets: [] as unknown[],
  canvasSources: [] as FakeCanvasSourceRecord[],
  audioSources: [] as FakeAudioSourceRecord[],
  audioSamples: [] as FakeAudioSampleRecord[],
  outputs: [] as FakeOutputRecord[],
  videoAddHandlers: [] as Array<(timestamp: number, duration: number) => Promise<void>>,
  audioAddHandlers: [] as Array<(sample: FakeAudioSampleRecord) => Promise<void>>,
  outputStartHandlers: [] as Array<() => Promise<void>>,
  outputFinalizeHandlers: [] as Array<() => Promise<void>>,
  outputCancelHandlers: [] as Array<() => Promise<void>>,
  canEncodeVideo: vi.fn(),
  canEncodeAudio: vi.fn(),
}))

vi.mock('mediabunny', () => {
  class Mp4OutputFormat {
    kind = 'mp4' as const
    fileExtension = '.mp4'
    mimeType = 'video/mp4'

    constructor() {
      mb.formats.push(this)
    }

    getSupportedVideoCodecs() {
      return ['avc', 'hevc', 'vp9', 'av1']
    }

    getSupportedAudioCodecs() {
      return ['aac', 'opus']
    }
  }

  class WebMOutputFormat {
    kind = 'webm' as const
    fileExtension = '.webm'
    mimeType = 'video/webm'

    constructor() {
      mb.formats.push(this)
    }

    getSupportedVideoCodecs() {
      return ['vp9', 'av1']
    }

    getSupportedAudioCodecs() {
      return ['opus']
    }
  }

  class NullTarget {
    constructor() {
      mb.targets.push(this)
    }
  }

  class CanvasSource {
    canvas: unknown
    config: unknown
    add: Mock<(timestamp: number, duration: number) => Promise<void>>
    close: Mock<() => void>

    constructor(canvas: unknown, config: unknown) {
      this.canvas = canvas
      this.config = config
      this.add = vi.fn(
        mb.videoAddHandlers.shift() ?? (async () => undefined),
      )
      this.close = vi.fn()
      mb.canvasSources.push(this)
    }
  }

  class AudioSampleSource {
    config: unknown
    add: Mock<(sample: FakeAudioSampleRecord) => Promise<void>>
    close: Mock<() => void>

    constructor(config: unknown) {
      this.config = config
      this.add = vi.fn(
        mb.audioAddHandlers.shift() ?? (async () => undefined),
      )
      this.close = vi.fn()
      mb.audioSources.push(this)
    }
  }

  class AudioSample {
    init: FakeAudioSampleRecord['init']
    close: Mock<() => void>

    constructor(init: FakeAudioSampleRecord['init']) {
      this.init = init
      this.close = vi.fn()
      mb.audioSamples.push(this)
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
      this.start = vi.fn(
        mb.outputStartHandlers.shift() ?? (async () => undefined),
      )
      this.finalize = vi.fn(
        mb.outputFinalizeHandlers.shift() ?? (async () => undefined),
      )
      this.cancel = vi.fn(
        mb.outputCancelHandlers.shift() ?? (async () => undefined),
      )
      mb.outputs.push(this)
    }
  }

  return {
    AudioSample,
    AudioSampleSource,
    CanvasSource,
    Mp4OutputFormat,
    NullTarget,
    Output,
    WebMOutputFormat,
    canEncodeAudio: mb.canEncodeAudio,
    canEncodeVideo: mb.canEncodeVideo,
  }
})

interface FakeContext {
  fillStyle: string
  fillRect: Mock<(x: number, y: number, width: number, height: number) => void>
}

interface FakeCanvasRecord {
  width: number
  height: number
  getContext: Mock<(kind: string, options?: unknown) => FakeContext>
  context: FakeContext
}

const canvases: FakeCanvasRecord[] = []

class FakeOffscreenCanvas {
  width: number
  height: number
  getContext: FakeCanvasRecord['getContext']
  context: FakeContext

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.context = {
      fillStyle: '',
      fillRect: vi.fn(),
    }
    this.getContext = vi.fn(() => this.context)
    canvases.push(this)
  }
}

import {
  createMediabunnyOutputFormat,
  mediabunnyExportCapabilityProbe,
  runFreshMediabunnyExportProbe,
} from './export-mediabunny-capabilities'
import {
  checkExportProfileSupport,
  verifyExportProfileSupportFresh,
} from './export-capabilities'

function makeDoc({
  durationFrames = 30,
  frameRate = { num: 30_000, den: 1_001 },
  width = 64,
  height = 48,
}: {
  durationFrames?: number
  frameRate?: TimelineDoc['frameRate']
  width?: number
  height?: number
} = {}): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'fresh-probe-doc',
    name: 'Fresh probe',
    frameRate,
    width,
    height,
    audioSampleRate: 48_000,
    tracks: durationFrames === 0
      ? []
      : [{
          id: 'V1',
          kind: 'video',
          name: 'V1',
          clips: [{
            id: 'video-clip',
            assetId: 'video-asset',
            name: 'video.mp4',
            sourceMode: 'timed',
            sourceRange: { startFrame: 0, durationFrames },
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
          }],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        }],
  }
}

function make96KhzAudioDoc(): TimelineDoc {
  const doc = makeDoc()
  const videoClip = doc.tracks[0].clips[0]
  return {
    ...doc,
    audioSampleRate: 96_000,
    tracks: [
      ...doc.tracks,
      {
        id: 'A1',
        kind: 'audio',
        name: 'A1',
        clips: [{
          ...videoClip,
          id: 'audio-clip',
          assetId: 'audio-asset',
          name: 'audio.wav',
        }],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
    ],
  }
}

beforeEach(() => {
  mb.formats.length = 0
  mb.targets.length = 0
  mb.canvasSources.length = 0
  mb.audioSources.length = 0
  mb.audioSamples.length = 0
  mb.outputs.length = 0
  mb.videoAddHandlers.length = 0
  mb.audioAddHandlers.length = 0
  mb.outputStartHandlers.length = 0
  mb.outputFinalizeHandlers.length = 0
  mb.outputCancelHandlers.length = 0
  mb.canEncodeVideo.mockReset().mockResolvedValue(true)
  mb.canEncodeAudio.mockReset().mockResolvedValue(true)
  canvases.length = 0
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
})

describe('Mediabunny capability adapter', () => {
  test('constructs the exact selected output format', () => {
    expect(createMediabunnyOutputFormat('mp4')).toMatchObject({
      kind: 'mp4',
      fileExtension: '.mp4',
      mimeType: 'video/mp4',
    })
    expect(createMediabunnyOutputFormat('webm')).toMatchObject({
      kind: 'webm',
      fileExtension: '.webm',
      mimeType: 'video/webm',
    })
  })

  test('forwards cached hint options without defaults or substitutions', async () => {
    await mediabunnyExportCapabilityProbe.canEncodeVideo('vp9', {
      width: 2560,
      height: 1440,
      bitrate: 12_000_000,
      bitrateMode: 'constant',
    })
    await mediabunnyExportCapabilityProbe.canEncodeAudio('opus', {
      numberOfChannels: 1,
      sampleRate: 96_000,
      bitrate: 128_000,
      bitrateMode: 'variable',
    })

    expect(mb.canEncodeVideo).toHaveBeenCalledWith('vp9', {
      width: 2560,
      height: 1440,
      bitrate: 12_000_000,
      bitrateMode: 'constant',
    })
    expect(mb.canEncodeAudio).toHaveBeenCalledWith('opus', {
      numberOfChannels: 1,
      sampleRate: 96_000,
      bitrate: 128_000,
      bitrateMode: 'variable',
    })
  })

  test('shares the generalized buffered sink matrix with capability discovery', async () => {
    const mono = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioChannelLayout: 'mono',
    })
    const directFile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    const hevc = exportPresetById('hevc').profile
    const web = exportPresetById('web').profile

    expect(mediabunnyExportCapabilityProbe.getImplementationUnavailableReason(
      DEFAULT_EXPORT_PROFILE,
      true,
    )).toBeNull()
    expect(mediabunnyExportCapabilityProbe.getImplementationUnavailableReason(
      directFile,
      true,
    )).toBeNull()
    expect(mediabunnyExportCapabilityProbe.getImplementationUnavailableReason(
      mono,
      false,
    )).toBeNull()
    expect(mediabunnyExportCapabilityProbe.getImplementationUnavailableReason(
      mono,
      true,
    )).toBeNull()
    expect(mediabunnyExportCapabilityProbe.getImplementationUnavailableReason(
      hevc,
      false,
    )).toBeNull()
    expect(mediabunnyExportCapabilityProbe.getImplementationUnavailableReason(
      web,
      false,
    )).toBeNull()
    expect(mediabunnyExportCapabilityProbe.getImplementationUnavailableReason(
      web,
      true,
    )).toBeNull()

    await expect(checkExportProfileSupport(
      makeDoc(),
      hevc,
      mediabunnyExportCapabilityProbe,
    )).resolves.toMatchObject({ supported: true, reason: null })
    await expect(checkExportProfileSupport(
      makeDoc(),
      web,
      mediabunnyExportCapabilityProbe,
    )).resolves.toMatchObject({ supported: true, reason: null })
    expect(mb.canEncodeVideo).toHaveBeenCalledTimes(2)
    expect(mb.canEncodeAudio).not.toHaveBeenCalled()
  })

  test.each([
    ['vertical 9:16', 1080, 1920],
    ['square 1:1', 1080, 1080],
    ['social portrait 4:5', 1080, 1350],
    ['maximum portrait', 2160, 3840],
  ])('probes the exact %s canvas dimensions', async (_label, width, height) => {
    await expect(checkExportProfileSupport(
      makeDoc({ width, height }),
      DEFAULT_EXPORT_PROFILE,
      mediabunnyExportCapabilityProbe,
    )).resolves.toMatchObject({ supported: true, reason: null })

    expect(mb.canEncodeVideo).toHaveBeenCalledWith('avc', expect.objectContaining({
      width,
      height,
    }))
  })
})

describe('runFreshMediabunnyExportProbe', () => {
  test.each([
    ['Compatibility', DEFAULT_EXPORT_PROFILE],
    ['HEVC', exportPresetById('hevc').profile],
  ])(
    'keeps a 96 kHz project available for the %s fresh AAC probe',
    async (_label, profile) => {
      mb.audioAddHandlers.push(async (sample) => {
        // Pre-#178 forwarded the 96 kHz document rate here; Chromium surfaced
        // the resulting adapter failure as Issue #180's `Flushing error`.
        if (sample.init.sampleRate !== 48_000) {
          throw new Error('Flushing error')
        }
      })

      const result = await verifyExportProfileSupportFresh(
        make96KhzAudioDoc(),
        profile,
        mediabunnyExportCapabilityProbe,
      )

      expect(result).toMatchObject({
        supported: true,
        profile,
        reason: null,
      })
      expect(mb.audioSamples.length).toBeGreaterThan(0)
      expect(new Set(
        mb.audioSamples.map((sample) => sample.init.sampleRate),
      )).toEqual(new Set([48_000]))
      expect(mb.audioSources[0].config).toMatchObject({ codec: 'aac' })
      expect(mb.outputs[0].finalize).toHaveBeenCalledTimes(1)
      expect(mb.outputs[0].cancel).not.toHaveBeenCalled()
    },
  )

  test('performs a disposable exact AVC/AAC encode with real profile fields', async () => {
    const doc = makeDoc()

    await runFreshMediabunnyExportProbe(
      doc,
      DEFAULT_EXPORT_PROFILE,
      true,
    )

    expect(canvases).toHaveLength(1)
    expect(canvases[0]).toMatchObject({ width: 64, height: 48 })
    expect(canvases[0].getContext).toHaveBeenCalledWith('2d', {
      alpha: false,
      colorSpace: 'srgb',
    })
    expect(canvases[0].context.fillStyle).toBe('#000000')
    expect(canvases[0].context.fillRect).toHaveBeenCalledWith(0, 0, 64, 48)

    expect(mb.formats).toEqual([expect.objectContaining({ kind: 'mp4' })])
    expect(mb.targets).toHaveLength(1)
    expect(mb.canvasSources[0].config).toEqual({
      codec: 'avc',
      bitrate: 8_000_000,
      bitrateMode: 'variable',
      keyFrameInterval: 2,
    })
    expect(mb.outputs[0].addVideoTrack).toHaveBeenCalledWith(
      mb.canvasSources[0],
      { frameRate: 30_000 / 1_001 },
    )
    expect(mb.canvasSources[0].add).toHaveBeenCalledTimes(2)
    expect(mb.canvasSources[0].add).toHaveBeenNthCalledWith(
      1,
      0,
      1_001 / 30_000,
    )
    expect(mb.canvasSources[0].add).toHaveBeenNthCalledWith(
      2,
      1_001 / 30_000,
      1_001 / 30_000,
    )

    expect(mb.audioSources[0].config).toEqual({
      codec: 'aac',
      bitrate: 192_000,
      bitrateMode: 'variable',
    })
    expect(mb.outputs[0].addAudioTrack).toHaveBeenCalledWith(mb.audioSources[0])
    expect(mb.audioSamples).toHaveLength(3)
    expect(mb.audioSamples[0].init).toMatchObject({
      format: 'f32',
      numberOfChannels: 2,
      sampleRate: 48_000,
      timestamp: 0,
    })
    expect(mb.audioSamples.map((sample) => sample.init.data.length)).toEqual([
      4_096,
      2_048,
      262,
    ])
    expect(mb.audioSamples.map((sample) => sample.init.timestamp)).toEqual([
      0,
      2_048 / 48_000,
      3_072 / 48_000,
    ])
    for (const sample of mb.audioSamples) {
      expect(sample.close).toHaveBeenCalledTimes(1)
    }
    expect(mb.canvasSources[0].close).toHaveBeenCalledTimes(1)
    expect(mb.audioSources[0].close).toHaveBeenCalledTimes(1)
    expect(mb.outputs[0].start).toHaveBeenCalledTimes(1)
    expect(mb.outputs[0].finalize).toHaveBeenCalledTimes(1)
    expect(mb.outputs[0].cancel).not.toHaveBeenCalled()
  })

  test.each([
    ['vertical 9:16', 1080, 1920],
    ['square 1:1', 1080, 1080],
    ['social portrait 4:5', 1080, 1350],
    ['maximum portrait', 2160, 3840],
  ])('allocates the exact %s preflight canvas', async (_label, width, height) => {
    await runFreshMediabunnyExportProbe(
      makeDoc({ width, height }),
      DEFAULT_EXPORT_PROFILE,
      false,
    )

    expect(canvases).toHaveLength(1)
    expect(canvases[0]).toMatchObject({ width, height })
    expect(canvases[0].context.fillRect)
      .toHaveBeenCalledWith(0, 0, width, height)
  })

  test('creates exact mono samples and selected encoding modes', async () => {
    const mono = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      audioChannelLayout: 'mono',
      videoBitrate: 4_000_000,
      audioBitrate: 96_000,
      videoBitrateMode: 'constant',
      audioBitrateMode: 'constant',
      keyFrameIntervalMicroseconds: 500_000,
    })

    await runFreshMediabunnyExportProbe(makeDoc(), mono, true)

    expect(mb.canvasSources[0].config).toMatchObject({
      bitrate: 4_000_000,
      bitrateMode: 'constant',
      keyFrameInterval: 0.5,
    })
    expect(mb.audioSources[0].config).toMatchObject({
      bitrate: 96_000,
      bitrateMode: 'constant',
    })
    expect(mb.audioSamples).toHaveLength(3)
    for (const sample of mb.audioSamples) {
      expect(sample.init.numberOfChannels).toBe(1)
    }
    expect(mb.audioSamples.map((sample) => sample.init.data.length)).toEqual([
      2_048,
      1_024,
      131,
    ])
  })

  test('probes exact WebM/Opus through the selected profile fields', async () => {
    const web = exportPresetById('web').profile

    await runFreshMediabunnyExportProbe(makeDoc(), web, true)

    expect(mb.formats).toEqual([expect.objectContaining({ kind: 'webm' })])
    expect(mb.canvasSources[0].config).toMatchObject({ codec: 'vp9' })
    expect(mb.audioSources[0].config).toEqual({
      codec: 'opus',
      bitrate: web.audioBitrate,
      bitrateMode: web.audioBitrateMode,
    })
    expect(mb.outputs[0].addAudioTrack).toHaveBeenCalledWith(mb.audioSources[0])
    expect(mb.outputs[0].finalize).toHaveBeenCalledTimes(1)
    expect(mb.outputs[0].cancel).not.toHaveBeenCalled()
  })

  test('pads a shorter timeline to Chromium AAC startup input', async () => {
    const oneFrame60Fps = makeDoc({
      durationFrames: 1,
      frameRate: { num: 60, den: 1 },
    })

    await runFreshMediabunnyExportProbe(
      oneFrame60Fps,
      DEFAULT_EXPORT_PROFILE,
      true,
    )

    expect(mb.audioSamples).toHaveLength(1)
    expect(mb.audioSamples[0].init).toMatchObject({
      numberOfChannels: 2,
      sampleRate: 48_000,
      timestamp: 0,
    })
    expect(mb.audioSamples[0].init.data).toHaveLength(4_096)
    expect(mb.canvasSources[0].add).toHaveBeenCalledTimes(1)
  })

  test('assembles whole 60 fps document frames into stable AAC input', async () => {
    const long60Fps = makeDoc({ frameRate: { num: 60, den: 1 } })

    await runFreshMediabunnyExportProbe(
      long60Fps,
      DEFAULT_EXPORT_PROFILE,
      true,
    )

    expect(mb.canvasSources[0].add).toHaveBeenCalledTimes(3)
    expect(mb.audioSamples).toHaveLength(2)
    expect(mb.audioSamples.map((sample) => sample.init.data.length)).toEqual([
      4_096,
      704,
    ])
    expect(mb.audioSamples.map((sample) => sample.init.timestamp)).toEqual([
      0,
      2_048 / 48_000,
    ])
  })

  test('pads a short 30 fps probe to Chromium AAC startup input', async () => {
    const oneFrame30Fps = makeDoc({
      durationFrames: 1,
      frameRate: { num: 30, den: 1 },
    })

    await runFreshMediabunnyExportProbe(
      oneFrame30Fps,
      DEFAULT_EXPORT_PROFILE,
      true,
    )

    expect(mb.audioSamples).toHaveLength(1)
    expect(mb.audioSamples.map((sample) => sample.init.data.length)).toEqual([
      4_096,
    ])
    expect(mb.audioSamples.map((sample) => sample.init.timestamp)).toEqual([
      0,
    ])
  })

  test('omits audio resources for a video-only probe', async () => {
    await runFreshMediabunnyExportProbe(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      false,
    )

    expect(mb.audioSources).toHaveLength(0)
    expect(mb.audioSamples).toHaveLength(0)
    expect(mb.outputs[0].addAudioTrack).not.toHaveBeenCalled()
    expect(mb.outputs[0].finalize).toHaveBeenCalledTimes(1)
  })

  test('closes borrowed audio and cancels output when a write fails', async () => {
    let releaseAudio!: () => void
    const audioGate = new Promise<void>((resolve) => {
      releaseAudio = resolve
    })
    mb.videoAddHandlers.push(async () => {
      throw new Error('fresh video encode failed')
    })
    mb.audioAddHandlers.push(async () => audioGate)

    const pending = runFreshMediabunnyExportProbe(
      makeDoc(),
      exportPresetById('web').profile,
      true,
    )
    const rejection = expect(pending).rejects.toThrow('fresh video encode failed')

    await vi.waitFor(() => expect(mb.audioSamples).toHaveLength(1))
    await Promise.resolve()
    expect(mb.audioSamples[0].close).not.toHaveBeenCalled()
    expect(mb.outputs[0].cancel).not.toHaveBeenCalled()

    releaseAudio()
    await rejection

    expect(mb.audioSamples).toHaveLength(2)
    for (const sample of mb.audioSamples) {
      expect(sample.close).toHaveBeenCalledTimes(1)
    }
    expect(mb.outputs[0].cancel).toHaveBeenCalledTimes(1)
    expect(mb.outputs[0].finalize).not.toHaveBeenCalled()
  })

  test('closes borrowed audio when the audio adapter throws synchronously', async () => {
    mb.audioAddHandlers.push(() => {
      throw new Error('synchronous audio adapter failure')
    })

    await expect(runFreshMediabunnyExportProbe(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      true,
    )).rejects.toThrow('synchronous audio adapter failure')

    expect(mb.audioSamples[0].close).toHaveBeenCalledTimes(1)
    expect(mb.outputs[0].cancel).toHaveBeenCalledTimes(1)
    expect(mb.outputs[0].finalize).not.toHaveBeenCalled()
  })

  test('preserves the primary failure when cancel also rejects', async () => {
    mb.outputStartHandlers.push(async () => {
      throw new Error('start failed')
    })
    mb.outputCancelHandlers.push(async () => {
      throw new Error('cancel failed')
    })

    await expect(runFreshMediabunnyExportProbe(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      false,
    )).rejects.toThrow('start failed')
    expect(mb.outputs[0].cancel).toHaveBeenCalledTimes(1)
  })

  test('rejects cancellation before allocating browser or codec resources', async () => {
    const abort = new AbortController()
    abort.abort(new Error('stop now'))

    await expect(runFreshMediabunnyExportProbe(
      makeDoc(),
      DEFAULT_EXPORT_PROFILE,
      false,
      abort.signal,
    )).rejects.toThrow('stop now')

    expect(canvases).toHaveLength(0)
    expect(mb.outputs).toHaveLength(0)
  })

  test('rejects an empty audio timeline before allocating codec resources', async () => {
    await expect(runFreshMediabunnyExportProbe(
      makeDoc({ durationFrames: 0 }),
      DEFAULT_EXPORT_PROFILE,
      true,
    )).rejects.toThrow('Cannot probe audio for an empty export timeline')

    expect(canvases).toHaveLength(0)
    expect(mb.outputs).toHaveLength(0)
  })
})
