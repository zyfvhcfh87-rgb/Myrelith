/**
 * workers/video-source.ts — worker-owned streaming video decode cursors.
 *
 * One source owns one Mediabunny Input for an asset. Each visible clip opens
 * its own playback cursor, while scrubs use short-lived seek cursors. This is
 * the seam that lets preview playback decode forward once instead of rebuilding
 * a keyframe-to-target GOP for every displayed frame.
 *
 * Public time stays in integer microseconds. Seconds exist only at the
 * Mediabunny boundary. A cursor closes every yielded VideoSample immediately
 * after creating an independently owned VideoFrame; ownership of that frame is
 * transferred to the caller, which must close it.
 */

import {
  ALL_FORMATS,
  BlobSource,
  Input,
  VideoSampleSink,
} from 'mediabunny'
import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import type { InputVideoTrack } from 'mediabunny'

const MICROSECONDS_PER_SECOND = 1_000_000

export type VideoRotation = 0 | 90 | 180 | 270

/** The VideoFrame surface this module owns and transfers. */
export interface VideoFrameLike {
  close(): void
}

/** A decoded frame whose ownership has transferred to the cursor caller. */
export interface DecodedVideoFrame {
  /** Exact presentation timestamp from Mediabunny. May be negative. */
  timestampUs: number
  durationUs: number
  /** Container/sample orientation retained for later bitmap normalization. */
  rotation: VideoRotation
  displayWidth: number
  displayHeight: number
  /** Caller-owned. Close after copying it into a stable bitmap. */
  frame: VideoFrameLike
}

export interface PlaybackLaneOptions {
  startTimestampUs: number
  /** Exclusive source-time bound. */
  endTimestampUs?: number
}

export interface VideoFrameCursor {
  /** Pull one presentation-order frame. Only one call may be in flight. */
  next(): Promise<DecodedVideoFrame | null>
  /** Cancel pending work and release the cursor's decoder. Idempotent. */
  close(): Promise<void>
}

export interface WorkerVideoSource {
  openPlaybackLane(options: PlaybackLaneOptions): VideoFrameCursor
  /** Opens a sparse, one-target cursor. The caller still closes it. */
  openSeekLane(targetTimestampUs: number): VideoFrameCursor
  /** Closes all child cursors before disposing the shared input. */
  close(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Injectable Mediabunny surface (keeps Vitest free of browser codecs) */
/* ------------------------------------------------------------------ */

export interface VideoSampleLike {
  readonly microsecondTimestamp: number
  readonly microsecondDuration: number
  readonly rotation: VideoRotation
  readonly displayWidth: number
  readonly displayHeight: number
  toVideoFrame(): VideoFrameLike
  close(): void
}

export interface VideoTrackLike {
  canDecode(): Promise<boolean>
}

export interface VideoInputLike {
  getPrimaryVideoTrack(): Promise<VideoTrackLike | null>
  dispose(): void
}

type SampleIterator = AsyncIterator<VideoSampleLike | null, void, unknown>

export interface VideoSampleSinkLike {
  samples(
    startTimestamp?: number,
    endTimestamp?: number,
  ): AsyncIterator<VideoSampleLike, void, unknown>
  samplesAtTimestamps(
    timestamps: Iterable<number>,
  ): SampleIterator
}

export interface WorkerVideoSourceEnv {
  createInput(blob: Blob): VideoInputLike
  /** Called once per lane so clips sharing an asset keep independent cursors. */
  createSampleSink(track: VideoTrackLike): VideoSampleSinkLike
}

export interface WorkerVideoSourceOpenFailure {
  trackKind: 'video' | null
  reason: MediaRuntimeFailure['reason']
}

/** Typed pre-ready failure carried through the worker protocol. */
export class WorkerVideoSourceOpenError extends Error {
  readonly failure: WorkerVideoSourceOpenFailure

  constructor(failure: WorkerVideoSourceOpenFailure, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(detail.slice(0, 2_048), { cause })
    this.name = 'WorkerVideoSourceOpenError'
    this.failure = failure
  }
}

function workerVideoSourceOpenError(
  failure: WorkerVideoSourceOpenFailure,
  cause: unknown,
): WorkerVideoSourceOpenError {
  if (cause instanceof WorkerVideoSourceOpenError) return cause
  return new WorkerVideoSourceOpenError(failure, cause)
}

const browserEnv: WorkerVideoSourceEnv = {
  createInput: (blob) => new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  }),
  createSampleSink: (track) => new VideoSampleSink(
    track as InputVideoTrack,
    { optimizeForLatency: true },
  ),
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function assertTimestampUs(value: number, label: string, allowNegative: boolean): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    const sign = allowNegative ? '' : ' non-negative'
    throw new TypeError(`${label} must be a${sign} safe integer`)
  }
}

function timestampUsToSeconds(value: number, label: string): number {
  assertTimestampUs(value, label, false)
  return value / MICROSECONDS_PER_SECOND
}

function assertSampleMetadata(sample: VideoSampleLike): void {
  assertTimestampUs(sample.microsecondTimestamp, 'sample timestamp', true)
  assertTimestampUs(sample.microsecondDuration, 'sample duration', false)
  if (!Number.isSafeInteger(sample.displayWidth) || sample.displayWidth <= 0) {
    throw new TypeError('sample displayWidth must be a positive safe integer')
  }
  if (!Number.isSafeInteger(sample.displayHeight) || sample.displayHeight <= 0) {
    throw new TypeError('sample displayHeight must be a positive safe integer')
  }
  if (![0, 90, 180, 270].includes(sample.rotation)) {
    throw new TypeError('sample rotation must be 0, 90, 180, or 270')
  }
}

/* ------------------------------------------------------------------ */
/* Cursor                                                               */
/* ------------------------------------------------------------------ */

class VideoFrameCursorImpl implements VideoFrameCursor {
  private readonly iterator: SampleIterator
  private readonly onClosed: () => void
  private closed = false
  private ended = false
  private pendingNext: Promise<DecodedVideoFrame | null> | null = null
  private closePromise: Promise<void> | null = null

  constructor(iterator: SampleIterator, onClosed: () => void) {
    this.iterator = iterator
    this.onClosed = onClosed
  }

  next(): Promise<DecodedVideoFrame | null> {
    if (this.closed || this.ended) return Promise.resolve(null)
    if (this.pendingNext) {
      return Promise.reject(new Error('video cursor already has a next() call in flight'))
    }

    const pending = this.readNext()
    this.pendingNext = pending
    const clearPending = () => {
      if (this.pendingNext === pending) this.pendingNext = null
    }
    void pending.then(clearPending, clearPending)
    return pending
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.finishClose(this.pendingNext)
    return this.closePromise
  }

  private async readNext(): Promise<DecodedVideoFrame | null> {
    let result: IteratorResult<VideoSampleLike | null, void>
    try {
      result = await this.iterator.next()
    } catch (error) {
      // Input.dispose() and iterator.return() may reject a parked read. That is
      // expected after deliberate cancellation, but real decode errors surface.
      if (this.closed) return null
      throw error
    }

    if (result.done) {
      this.ended = true
      return null
    }

    const sample = result.value
    if (sample === null) return null
    if (this.closed) {
      sample.close()
      return null
    }

    try {
      assertSampleMetadata(sample)
      const frame = sample.toVideoFrame()
      if (this.closed) {
        frame.close()
        return null
      }
      return {
        timestampUs: sample.microsecondTimestamp,
        durationUs: sample.microsecondDuration,
        rotation: sample.rotation,
        displayWidth: sample.displayWidth,
        displayHeight: sample.displayHeight,
        frame,
      }
    } finally {
      sample.close()
    }
  }

  private async finishClose(
    pending: Promise<DecodedVideoFrame | null> | null,
  ): Promise<void> {
    const tasks: Promise<unknown>[] = []
    if (this.iterator.return) {
      try {
        tasks.push(Promise.resolve(this.iterator.return()))
      } catch (error) {
        tasks.push(Promise.reject(error))
      }
    }
    if (pending) tasks.push(pending)

    const results = await Promise.allSettled(tasks)
    this.onClosed()
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close video cursor')
    }
  }
}

/* ------------------------------------------------------------------ */
/* Source                                                               */
/* ------------------------------------------------------------------ */

class WorkerVideoSourceImpl implements WorkerVideoSource {
  private readonly input: VideoInputLike
  private readonly track: VideoTrackLike
  private readonly env: WorkerVideoSourceEnv
  private readonly cursors = new Set<VideoFrameCursorImpl>()
  private closed = false
  private closePromise: Promise<void> | null = null

  constructor(
    input: VideoInputLike,
    track: VideoTrackLike,
    env: WorkerVideoSourceEnv,
  ) {
    this.input = input
    this.track = track
    this.env = env
  }

  openPlaybackLane(options: PlaybackLaneOptions): VideoFrameCursor {
    this.assertOpen()
    const startSeconds = timestampUsToSeconds(
      options.startTimestampUs,
      'startTimestampUs',
    )
    const endSeconds = options.endTimestampUs === undefined
      ? undefined
      : timestampUsToSeconds(options.endTimestampUs, 'endTimestampUs')
    if (
      options.endTimestampUs !== undefined
      && options.endTimestampUs < options.startTimestampUs
    ) {
      throw new RangeError('endTimestampUs must be greater than or equal to startTimestampUs')
    }

    const sink = this.env.createSampleSink(this.track)
    return this.addCursor(sink.samples(startSeconds, endSeconds))
  }

  openSeekLane(targetTimestampUs: number): VideoFrameCursor {
    this.assertOpen()
    const targetSeconds = timestampUsToSeconds(
      targetTimestampUs,
      'targetTimestampUs',
    )
    const sink = this.env.createSampleSink(this.track)
    return this.addCursor(sink.samplesAtTimestamps([targetSeconds]))
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.finishClose()
    return this.closePromise
  }

  private addCursor(iterator: SampleIterator): VideoFrameCursorImpl {
    let cursor: VideoFrameCursorImpl
    cursor = new VideoFrameCursorImpl(iterator, () => this.cursors.delete(cursor))
    this.cursors.add(cursor)
    return cursor
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('video source is closed')
  }

  private async finishClose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.cursors].map((cursor) => cursor.close()),
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)

    try {
      this.input.dispose()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close worker video source')
    }
  }
}

/**
 * Open a worker-owned video source. Initialization is intentionally async so
 * configureAsset can acknowledge readiness only after a usable track exists.
 */
export async function openWorkerVideoSource(
  blob: Blob,
  env: WorkerVideoSourceEnv = browserEnv,
): Promise<WorkerVideoSource> {
  if (!(blob instanceof Blob)) throw new TypeError('blob must be a Blob')

  let input: VideoInputLike
  try {
    input = env.createInput(blob)
  } catch (cause) {
    throw workerVideoSourceOpenError({
      trackKind: null,
      reason: 'resource-unavailable',
    }, cause)
  }
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('media has no video track')
    if (!(await track.canDecode())) {
      throw new Error('video track cannot be decoded in this worker')
    }
    return new WorkerVideoSourceImpl(input, track, env)
  } catch (cause) {
    const error = workerVideoSourceOpenError({
      trackKind: 'video',
      reason: 'decode-failed',
    }, cause)
    try {
      input.dispose()
    } catch (disposeError) {
      throw new WorkerVideoSourceOpenError(
        error.failure,
        new AggregateError(
          [error, disposeError],
          'Failed to open worker video source',
          { cause: error },
        ),
      )
    }
    throw error
  }
}
