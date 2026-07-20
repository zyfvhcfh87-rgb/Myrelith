import { describe, expect, test, vi } from 'vitest'
import type { DecoderCheckResult } from '../codecs/mediaCodecFallbacks'
import type {
  VideoFrameLike,
  VideoInputLike,
  VideoRotation,
  VideoSampleLike,
  VideoSampleSinkLike,
  VideoTrackLike,
  WorkerVideoSourceEnv,
} from './video-source'
import {
  WorkerVideoSourceOpenError,
  openWorkerVideoSource,
} from './video-source'

interface TrackedFrame extends VideoFrameLike {
  closeCount: number
}

function makeFrame(): TrackedFrame {
  const frame: TrackedFrame = {
    closeCount: 0,
    close() {
      frame.closeCount++
    },
  }
  return frame
}

class TrackedSample implements VideoSampleLike {
  readonly microsecondTimestamp: number
  readonly microsecondDuration: number
  readonly rotation: VideoRotation
  readonly displayWidth: number
  readonly displayHeight: number
  readonly frame = makeFrame()
  closeCount = 0
  toVideoFrameCount = 0
  conversionError: Error | null = null

  constructor(
    timestampUs: number,
    durationUs = 33_366,
    rotation: VideoRotation = 0,
    displayWidth = 1920,
    displayHeight = 1080,
  ) {
    this.microsecondTimestamp = timestampUs
    this.microsecondDuration = durationUs
    this.rotation = rotation
    this.displayWidth = displayWidth
    this.displayHeight = displayHeight
  }

  toVideoFrame(): VideoFrameLike {
    this.toVideoFrameCount++
    if (this.conversionError) throw this.conversionError
    return this.frame
  }

  close(): void {
    this.closeCount++
  }
}

class FakeIterator<T extends VideoSampleLike | null>
implements AsyncIterator<T, void, unknown> {
  readonly values: T[]
  nextCount = 0
  returnCount = 0
  returnError: Error | null = null
  private index = 0

  constructor(values: T[]) {
    this.values = values
  }

  async next(): Promise<IteratorResult<T, void>> {
    this.nextCount++
    if (this.index >= this.values.length) {
      return { value: undefined, done: true }
    }
    return { value: this.values[this.index++]!, done: false }
  }

  async return(): Promise<IteratorResult<T, void>> {
    this.returnCount++
    if (this.returnError) throw this.returnError
    return { value: undefined, done: true }
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

class PendingIterator<T extends VideoSampleLike | null>
implements AsyncIterator<T, void, unknown> {
  readonly result = deferred<IteratorResult<T, void>>()
  nextCount = 0
  returnCount = 0

  next(): Promise<IteratorResult<T, void>> {
    this.nextCount++
    return this.result.promise
  }

  async return(): Promise<IteratorResult<T, void>> {
    this.returnCount++
    return { value: undefined, done: true }
  }
}

class FakeSink implements VideoSampleSinkLike {
  readonly playbackCalls: Array<[number | undefined, number | undefined]> = []
  readonly seekCalls: number[][] = []
  private readonly playbackIterator: AsyncIterator<VideoSampleLike, void, unknown>
  private readonly seekIterator: AsyncIterator<VideoSampleLike | null, void, unknown>

  constructor(
    playbackIterator: AsyncIterator<VideoSampleLike, void, unknown>
      = new FakeIterator<VideoSampleLike>([]),
    seekIterator: AsyncIterator<VideoSampleLike | null, void, unknown>
      = new FakeIterator<VideoSampleLike | null>([]),
  ) {
    this.playbackIterator = playbackIterator
    this.seekIterator = seekIterator
  }

  samples(
    startTimestamp?: number,
    endTimestamp?: number,
  ): AsyncIterator<VideoSampleLike, void, unknown> {
    this.playbackCalls.push([startTimestamp, endTimestamp])
    return this.playbackIterator
  }

  samplesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncIterator<VideoSampleLike | null, void, unknown> {
    this.seekCalls.push([...timestamps])
    return this.seekIterator
  }
}

class FakeTrack implements VideoTrackLike {
  readonly decodable: boolean
  readonly codec: string
  readonly configuration: VideoDecoderConfig | null
  canDecodeCount = 0

  constructor(
    decodable = true,
    codec = 'avc',
    configuration: VideoDecoderConfig | null = {
      codec: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
    },
  ) {
    this.decodable = decodable
    this.codec = codec
    this.configuration = configuration
  }

  async getCodec(): Promise<string> {
    return this.codec
  }

  async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
    return this.configuration
  }

  async canDecode(): Promise<boolean> {
    this.canDecodeCount++
    return this.decodable
  }
}

class FakeInput implements VideoInputLike {
  readonly track: VideoTrackLike | null
  disposeCount = 0

  constructor(track: VideoTrackLike | null) {
    this.track = track
  }

  async getPrimaryVideoTrack(): Promise<VideoTrackLike | null> {
    return this.track
  }

  dispose(): void {
    this.disposeCount++
  }
}

interface Harness {
  input: FakeInput
  env: WorkerVideoSourceEnv
  begunSourceIds: string[]
  createdSinkCount(): number
}

function makeHarness(
  sinks: FakeSink[] = [],
  track: VideoTrackLike | null = new FakeTrack(),
): Harness {
  const input = new FakeInput(track)
  const begunSourceIds: string[] = []
  let sinkIndex = 0
  const env: WorkerVideoSourceEnv = {
    createInput: () => input,
    beginDecoderSource: (sourceId) => begunSourceIds.push(sourceId),
    ensureDecoderSupport: async (target): Promise<DecoderCheckResult> => {
      const decodable = await target.canDecode()
      return decodable
        ? {
            decodable: true,
            path: 'native',
            attemptedFallback: null,
            failure: null,
          }
        : {
            decodable: false,
            path: null,
            attemptedFallback: null,
            failure: {
              reason: 'unsupported-codec',
              detail: 'video track cannot be decoded in this worker',
            },
          }
    },
    createSampleSink: () => {
      const sink = sinks[sinkIndex++]
      if (!sink) throw new Error('test did not provide a sink for this lane')
      return sink
    },
  }
  return { input, env, begunSourceIds, createdSinkCount: () => sinkIndex }
}

describe('worker video source', () => {
  test('one playback cursor pulls sequential frames and transfers frame ownership', async () => {
    const samples = [
      new TrackedSample(33_366),
      new TrackedSample(66_732, 33_366, 90, 1080, 1920),
      new TrackedSample(100_098),
    ]
    const iterator = new FakeIterator(samples)
    const sink = new FakeSink(iterator)
    const h = makeHarness([sink])
    const source = await openWorkerVideoSource(new Blob(), h.env)
    const cursor = source.openPlaybackLane({
      startTimestampUs: 33_366,
      endTimestampUs: 133_464,
    })

    const decoded = [
      await cursor.next(),
      await cursor.next(),
      await cursor.next(),
    ]

    expect(sink.playbackCalls).toEqual([[0.033366, 0.133464]])
    expect(h.createdSinkCount()).toBe(1)
    expect(iterator.nextCount).toBe(3)
    expect(decoded.map((item) => item?.timestampUs)).toEqual([
      33_366,
      66_732,
      100_098,
    ])
    expect(decoded[1]).toMatchObject({
      durationUs: 33_366,
      rotation: 90,
      displayWidth: 1080,
      displayHeight: 1920,
    })
    expect(samples.every((sample) => sample.closeCount === 1)).toBe(true)
    expect(samples.every((sample) => sample.toVideoFrameCount === 1)).toBe(true)
    expect(samples.every((sample) => sample.frame.closeCount === 0)).toBe(true)

    await cursor.close()
    expect(iterator.returnCount).toBe(1)
    // Cursor teardown never closes frames whose ownership was transferred.
    expect(samples.every((sample) => sample.frame.closeCount === 0)).toBe(true)
    for (const item of decoded) item?.frame.close()
    await source.close()
    await source.close()
    expect(h.input.disposeCount).toBe(1)
  })

  test('playback and seek lanes use independent sinks and timestamp paths', async () => {
    const playbackIterator = new FakeIterator([new TrackedSample(500_000)])
    const seekIterator = new FakeIterator<VideoSampleLike | null>([null])
    const playbackSink = new FakeSink(playbackIterator)
    const seekSink = new FakeSink(undefined, seekIterator)
    const h = makeHarness([playbackSink, seekSink])
    const source = await openWorkerVideoSource(new Blob(), h.env)

    const playback = source.openPlaybackLane({ startTimestampUs: 500_000 })
    const seek = source.openSeekLane(1_234_567)

    const playbackFrame = await playback.next()
    expect(playbackFrame?.timestampUs).toBe(500_000)
    expect(await seek.next()).toBeNull()
    expect(playbackSink.playbackCalls).toEqual([[0.5, undefined]])
    expect(seekSink.seekCalls).toEqual([[1.234567]])
    expect(h.createdSinkCount()).toBe(2)
    playbackFrame?.frame.close()

    await seek.close()
    expect(seekIterator.returnCount).toBe(1)
    expect(playbackIterator.returnCount).toBe(0)
    await playback.close()
    await source.close()
  })

  test('conversion failure still closes the yielded sample exactly once', async () => {
    const sample = new TrackedSample(0)
    sample.conversionError = new Error('VideoFrame conversion failed')
    const iterator = new FakeIterator([sample])
    const h = makeHarness([new FakeSink(iterator)])
    const source = await openWorkerVideoSource(new Blob(), h.env)
    const cursor = source.openPlaybackLane({ startTimestampUs: 0 })

    await expect(cursor.next()).rejects.toThrow('VideoFrame conversion failed')
    expect(sample.closeCount).toBe(1)
    expect(sample.toVideoFrameCount).toBe(1)
    expect(sample.frame.closeCount).toBe(0)

    await cursor.close()
    await source.close()
  })

  test('closing a parked cursor closes a late sample without converting it', async () => {
    const iterator = new PendingIterator<VideoSampleLike>()
    const sample = new TrackedSample(0)
    const h = makeHarness([new FakeSink(iterator)])
    const source = await openWorkerVideoSource(new Blob(), h.env)
    const cursor = source.openPlaybackLane({ startTimestampUs: 0 })

    const pending = cursor.next()
    const closing = cursor.close()
    expect(iterator.returnCount).toBe(1)
    iterator.result.resolve({ value: sample, done: false })

    await expect(pending).resolves.toBeNull()
    await closing
    await cursor.close()
    expect(iterator.returnCount).toBe(1)
    expect(sample.closeCount).toBe(1)
    expect(sample.toVideoFrameCount).toBe(0)
    expect(sample.frame.closeCount).toBe(0)
    expect(await cursor.next()).toBeNull()
    await source.close()
  })

  test('rejects a second next call while the first is in flight', async () => {
    const iterator = new PendingIterator<VideoSampleLike>()
    const sample = new TrackedSample(0)
    const h = makeHarness([new FakeSink(iterator)])
    const source = await openWorkerVideoSource(new Blob(), h.env)
    const cursor = source.openPlaybackLane({ startTimestampUs: 0 })

    const first = cursor.next()
    await expect(cursor.next()).rejects.toThrow('already has a next() call in flight')
    iterator.result.resolve({ value: sample, done: false })
    const decoded = await first
    decoded?.frame.close()

    await cursor.close()
    await source.close()
  })

  test('source close releases every lane and disposes input even if one return fails', async () => {
    const firstIterator = new FakeIterator<VideoSampleLike>([])
    firstIterator.returnError = new Error('first return failed')
    const secondIterator = new FakeIterator<VideoSampleLike>([])
    const h = makeHarness([
      new FakeSink(firstIterator),
      new FakeSink(secondIterator),
    ])
    const source = await openWorkerVideoSource(new Blob(), h.env)
    source.openPlaybackLane({ startTimestampUs: 0 })
    source.openPlaybackLane({ startTimestampUs: 1_000_000 })

    await expect(source.close()).rejects.toThrow('Failed to close worker video source')
    expect(firstIterator.returnCount).toBe(1)
    expect(secondIterator.returnCount).toBe(1)
    expect(h.input.disposeCount).toBe(1)
    // close() is idempotent, including its settled failure.
    await expect(source.close()).rejects.toThrow('Failed to close worker video source')
    expect(h.input.disposeCount).toBe(1)
  })

  test('validates integer source time before opening a sink', async () => {
    const h = makeHarness()
    const source = await openWorkerVideoSource(new Blob(), h.env)

    expect(() => source.openPlaybackLane({ startTimestampUs: 1.5 })).toThrow(
      'startTimestampUs must be a non-negative safe integer',
    )
    expect(() => source.openPlaybackLane({
      startTimestampUs: 10,
      endTimestampUs: 9,
    })).toThrow('endTimestampUs must be greater than or equal')
    expect(() => source.openSeekLane(-1)).toThrow(
      'targetTimestampUs must be a non-negative safe integer',
    )
    expect(h.createdSinkCount()).toBe(0)

    await source.close()
    expect(() => source.openSeekLane(0)).toThrow('video source is closed')
  })

  test('types pre-track Input construction as a file-level resource failure', async () => {
    const cause = new Error('Mediabunny Input construction failed')
    const env: WorkerVideoSourceEnv = {
      createInput: () => { throw cause },
      beginDecoderSource: () => undefined,
      ensureDecoderSupport: () => {
        throw new Error('decoder check must not run')
      },
      createSampleSink: () => { throw new Error('sink must not be created') },
    }

    const failure = await openWorkerVideoSource(new Blob(), env)
      .catch((error) => error)

    expect(failure).toBeInstanceOf(WorkerVideoSourceOpenError)
    expect(failure).toMatchObject({
      message: cause.message,
      failure: {
        trackKind: null,
        reason: 'resource-unavailable',
      },
    })
    expect(failure.cause).toBe(cause)
  })

  test.each([
    { label: 'missing video track', track: null, message: 'media has no video track' },
    {
      label: 'undecodable video track',
      track: new FakeTrack(false),
      message: 'video track cannot be decoded in this worker',
    },
  ])('disposes input after $label initialization failure', async ({ track, message }) => {
    const h = makeHarness([], track)
    await expect(openWorkerVideoSource(new Blob(), h.env)).rejects.toThrow(message)
    expect(h.input.disposeCount).toBe(1)
    expect(h.createdSinkCount()).toBe(0)
  })

  test('awaits the shared worker fallback seam before creating a sink', async () => {
    const configuration: VideoDecoderConfig = {
      codec: 'ap4h',
      codedWidth: 1920,
      codedHeight: 1080,
      description: new Uint8Array([1, 2, 3]),
    }
    const track = new FakeTrack(false, 'prores', configuration)
    const h = makeHarness([], track)
    h.env.ensureDecoderSupport = vi.fn(async (
      target,
    ): Promise<DecoderCheckResult> => {
      expect(target).toMatchObject({
        codec: 'prores',
        configuration,
        trackKind: 'video',
        sourceId: 'asset-prores',
        boundary: 'render',
        policy: 'revalidate',
      })
      return {
        decodable: true,
        path: 'local-prores',
        attemptedFallback: 'prores',
        failure: null,
      }
    })

    const source = await openWorkerVideoSource(
      new Blob(),
      h.env,
      'asset-prores',
    )

    expect(h.begunSourceIds).toEqual(['asset-prores'])
    expect(h.env.ensureDecoderSupport).toHaveBeenCalledOnce()
    expect(h.createdSinkCount()).toBe(0)
    await source.close()
    expect(h.input.disposeCount).toBe(1)
  })
})
