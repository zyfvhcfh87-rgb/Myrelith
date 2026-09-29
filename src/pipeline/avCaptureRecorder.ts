/**
 * Worker-side camera/screen recorder (Issue #209): reads capture-stamped
 * frames and audio, applies the pure A/V clock rules, encodes with Mediabunny,
 * and writes a fragmented MP4 straight into a synchronous file with bounded
 * writes and periodic flushes. Main-thread arrival time is never used.
 *
 * Every VideoFrame/AudioData is closed in `finally`. Only a bounded pre-roll
 * of audio (≤ 1 s) is held while waiting for the first video frame.
 */
import {
  AudioSample,
  AudioSampleSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny'
import {
  createAvClock,
  describeAvClock,
  microsecondsForSamples,
  planAvAudioChunk,
  planAvVideoFrame,
  type AvClockState,
} from '../domain/avCaptureClock'

export const AV_CAPTURE_LIMITS = {
  /** One take, including container overhead. */
  maxBytes: 4 * 1024 * 1024 * 1024,
  /** Reserve for the final fragment and index when the byte limit stops a take. */
  finalizeReserveBytes: 64 * 1024 * 1024,
  maxDurationUs: 60 * 60 * 1_000_000,
  /** Flush the file at least this often so a crash loses at most ~this much. */
  flushBytes: 1024 * 1024,
  /** Audio held while waiting for the first video frame. */
  maxHeldAudioUs: 1_000_000,
  /** Silence is written in pieces no longer than this. */
  silenceChunkFrames: 4_800,
  /** Fragments close at least this often (seconds). */
  fragmentSeconds: 1,
  /** A static picture is re-encoded this often so audio keeps reaching disk. */
  repeatFrameUs: 1_000_000,
  /** Video running this far ahead of the audio sample clock ends the take. */
  maxAudioStallUs: 2_000_000,
  progressIntervalMs: 250,
} as const

export interface AvSyncFile {
  write(bytes: Uint8Array, options: { at: number }): number
  flush(): void
  getSize(): number
  truncate(size: number): void
  close(): void
}

export interface AvEncodingChoice {
  readonly video: { readonly codec: VideoCodec; readonly bitrate: number }
  readonly audio: { readonly codec: AudioCodec; readonly bitrate: number } | null
}

/**
 * Pick an import-compatible MP4 encoding the browser can produce: H.264 first
 * (then VP9), AAC first (then Opus). Returns null when no video codec fits.
 */
export async function chooseAvEncoding(
  width: number,
  height: number,
  audio: { numberOfChannels: number; sampleRate: number } | null,
): Promise<AvEncodingChoice | null> {
  const bitrate = width * height <= 1280 * 720 ? 5_000_000 : 10_000_000
  const video = await getFirstEncodableVideoCodec(['avc', 'vp9'], { width, height, bitrate })
  if (!video) return null
  if (!audio) return { video: { codec: video, bitrate }, audio: null }
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'],
    { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate, bitrate: 128_000 })
  return { video: { codec: video, bitrate }, audio: audioCodec ? { codec: audioCodec, bitrate: 128_000 } : null }
}

export interface AvRecorderProgress {
  readonly bytes: number
  readonly durationUs: number
  readonly videoFrames: number
  readonly droppedVideoFrames: number
  readonly audioSamples: number
  readonly audioSampleRate: number | null
  readonly driftUs: number
  readonly maxAbsDriftUs: number
  readonly gapEvents: number
  readonly uncorrectedDriftEvents: number
  readonly width: number | null
  readonly height: number | null
}

export type AvRecorderEnd = 'stopped' | 'source-ended' | 'limit'

export interface AvRecorderResult extends AvRecorderProgress {
  readonly reason: AvRecorderEnd
  readonly clockNote: string | null
}

export interface AvRecorderInput {
  readonly video: ReadableStream<VideoFrame>
  readonly audio: ReadableStream<AudioData> | null
  readonly file: AvSyncFile
  readonly encoding: AvEncodingChoice
  /**
   * Video frames are stamped on the tick clock, audio on page time (Chromium
   * 151). Subtracting this measured constant puts both on page time.
   */
  readonly videoClockOffsetUs: number
  readonly onProgress?: (progress: AvRecorderProgress) => void
  /** The recorder ended itself (source ended or limit); the owner then reviews. */
  readonly onSelfStop?: (reason: Exclude<AvRecorderEnd, 'stopped'>) => void
}

class Faulted extends Error {}

export class AvCaptureRecorder {
  private readonly input: AvRecorderInput
  private readonly output: Output
  private readonly videoSource: VideoSampleSource
  private readonly audioSource: AudioSampleSource | null
  private readonly videoReader: ReadableStreamDefaultReader<VideoFrame>
  private readonly audioReader: ReadableStreamDefaultReader<AudioData> | null
  private clock: AvClockState
  private held: AudioData[] = []
  private bytes = 0
  private flushedBytes = 0
  private videoFrames = 0
  private repeatedFrames = 0
  private lastVideoUs = 0
  /** One clone of the latest written frame, re-encoded while the picture is static. */
  private lastFrame: VideoFrame | null = null
  /** One clone of a frame that arrived before any audio (a static screen may send no other). */
  private pendingFrame: VideoFrame | null = null
  /** Serializes every video add (capture loop and watchdog). */
  private videoChain: Promise<void> = Promise.resolve()
  private baseWallMs: number | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private width: number | null = null
  private height: number | null = null
  private stopping = false
  private endReason: AvRecorderEnd = 'stopped'
  private stopNote: string | null = null
  private fault: Error | null = null
  private lastProgressAt = 0
  private loops: Promise<void> = Promise.resolve()
  private finishing: Promise<AvRecorderResult> | null = null

  constructor(input: AvRecorderInput) {
    this.input = input
    this.clock = createAvClock(input.audio !== null)
    this.videoReader = input.video.getReader()
    this.audioReader = input.audio?.getReader() ?? null
    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => this.write(chunk),
    }, { highWaterMark: 1 })
    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: AV_CAPTURE_LIMITS.fragmentSeconds }),
      target: new StreamTarget(writable),
    })
    this.videoSource = new VideoSampleSource({ codec: input.encoding.video.codec,
      bitrate: input.encoding.video.bitrate, keyFrameInterval: 1, sizeChangeBehavior: 'contain' })
    this.output.addVideoTrack(this.videoSource)
    this.audioSource = input.encoding.audio && input.audio
      ? new AudioSampleSource({ codec: input.encoding.audio.codec, bitrate: input.encoding.audio.bitrate })
      : null
    if (this.audioSource) this.output.addAudioTrack(this.audioSource)
  }

  async start(): Promise<void> {
    await this.output.start()
    // Either source ending (camera unplugged, sharing stopped, mic removed)
    // ends the take at once: the muxer cannot interleave a track that stops.
    const ended = () => { if (!this.stopping) this.selfStop('source-ended') }
    const audio = this.audioReader ? this.audioLoop().finally(ended) : Promise.resolve()
    this.loops = Promise.all([this.videoLoop().finally(ended), audio]).then(() => undefined)
    void this.loops.catch(() => {})
    this.watchdog = setInterval(() => this.tick(), AV_CAPTURE_LIMITS.progressIntervalMs)
  }

  /** Output time now: the audio sample clock, or wall time for video-only takes. */
  private nowUs(): number {
    const rate = this.clock.audioSampleRate
    if (this.audioSource && rate) return microsecondsForSamples(this.clock.audioSamples, rate)
    if (this.baseWallMs === null) return 0
    return Math.round((performance.now() - this.baseWallMs) * 1000)
  }

  get progress(): AvRecorderProgress {
    const clock = this.clock
    return { bytes: this.bytes, durationUs: Math.max(this.lastVideoUs, this.nowUs()), videoFrames: this.videoFrames,
      droppedVideoFrames: clock.droppedVideoFrames, audioSamples: clock.audioSamples,
      audioSampleRate: clock.audioSampleRate, driftUs: clock.driftUs, maxAbsDriftUs: clock.maxAbsDriftUs,
      gapEvents: clock.gapEvents, uncorrectedDriftEvents: clock.uncorrectedDriftEvents,
      width: this.width, height: this.height }
  }

  private write(chunk: StreamTargetChunk): void {
    const end = chunk.position + chunk.data.byteLength
    if (end > AV_CAPTURE_LIMITS.maxBytes) throw new Faulted('Capture file limit exceeded')
    const written = this.input.file.write(chunk.data, { at: chunk.position })
    if (written !== chunk.data.byteLength) throw new Faulted(`Capture short write: ${written}/${chunk.data.byteLength}`)
    this.bytes = Math.max(this.bytes, end)
    if (this.bytes - this.flushedBytes >= AV_CAPTURE_LIMITS.flushBytes) {
      this.input.file.flush()
      this.flushedBytes = this.bytes
    }
    if (!this.stopping && this.bytes >= AV_CAPTURE_LIMITS.maxBytes - AV_CAPTURE_LIMITS.finalizeReserveBytes) {
      this.selfStop('limit')
    }
  }

  private report(): void {
    const now = Date.now()
    if (now - this.lastProgressAt < AV_CAPTURE_LIMITS.progressIntervalMs) return
    this.lastProgressAt = now
    this.input.onProgress?.(this.progress)
  }

  private selfStop(reason: Exclude<AvRecorderEnd, 'stopped'>): void {
    if (this.stopping) return
    this.endReason = reason
    this.input.onSelfStop?.(reason)
  }

  /**
   * Keeps the fragmented muxer moving. Its interleaver writes nothing until
   * every open track has data, so a static screen would otherwise hold all
   * audio in memory and nothing would reach disk.
   */
  private tick(): void {
    if (this.stopping || this.fault) return
    // A frame that preceded the first audio chunk becomes the base once audio exists.
    if (this.clock.baseUs === null && this.clock.firstAudioUs !== null && this.pendingFrame) {
      const frame = this.pendingFrame
      this.pendingFrame = null
      void this.enqueueVideo(frame, frame.timestamp - this.input.videoClockOffsetUs).finally(() => frame.close())
      return
    }
    if (this.clock.baseUs === null) return
    const now = this.nowUs()
    if (now >= AV_CAPTURE_LIMITS.maxDurationUs) { this.selfStop('limit'); return }
    // Audio that stops arriving cannot be interleaved: end the take for review.
    if (this.audioSource && this.lastVideoUs - now > AV_CAPTURE_LIMITS.maxAudioStallUs) {
      this.stopNote = 'Audio stopped arriving, so the recording ended there.'
      this.selfStop('source-ended')
      return
    }
    if (this.lastFrame && now - this.lastVideoUs >= AV_CAPTURE_LIMITS.repeatFrameUs) this.repeatLastFrame(this.lastVideoUs + AV_CAPTURE_LIMITS.repeatFrameUs)
    this.report()
  }

  /** Re-encode the latest picture at `atUs` (output time) while nothing changes on screen. */
  private repeatLastFrame(atUs: number): Promise<void> {
    const source = this.lastFrame
    if (!source || this.clock.baseUs === null) return Promise.resolve()
    const copy = source.clone()
    this.repeatedFrames++
    return this.enqueueVideo(copy, this.clock.baseUs + atUs, true).finally(() => copy.close())
  }

  private enqueueVideo(frame: VideoFrame, captureUs: number, repeat = false): Promise<void> {
    const task = this.videoChain.then(async () => {
      if (this.fault) return
      const planned = planAvVideoFrame(this.clock, captureUs)
      this.clock = planned.state
      if (planned.decision.action !== 'write') {
        if (planned.decision.reason === 'waiting-for-audio' && !repeat) {
          this.pendingFrame?.close()
          this.pendingFrame = frame.clone()
        }
        return
      }
      if (planned.decision.timestampUs >= AV_CAPTURE_LIMITS.maxDurationUs) { this.selfStop('limit'); return }
      this.baseWallMs ??= performance.now()
      // Closing the sample closes the frame it wraps, so keep the clone first.
      const keep = repeat ? null : frame.clone()
      const sample = new VideoSample(frame, { timestamp: planned.decision.timestampUs / 1_000_000 })
      try { await this.videoSource.add(sample) }
      catch (cause) { keep?.close(); throw cause }
      finally { sample.close() }
      this.videoFrames++
      this.lastVideoUs = planned.decision.timestampUs
      if (keep) {
        this.lastFrame?.close()
        this.lastFrame = keep
      }
      this.report()
    })
    this.videoChain = task.catch((cause) => this.fail(cause))
    return this.videoChain
  }

  private async videoLoop(): Promise<void> {
    for (;;) {
      const { value: frame, done } = await this.videoReader.read()
      if (done) return
      try {
        if (this.stopping || this.fault) continue
        this.width ??= frame.displayWidth
        this.height ??= frame.displayHeight
        await this.enqueueVideo(frame, frame.timestamp - this.input.videoClockOffsetUs)
      } finally {
        frame.close()
      }
    }
  }

  private async audioLoop(): Promise<void> {
    const reader = this.audioReader
    if (!reader) return
    for (;;) {
      const { value: data, done } = await reader.read()
      if (done) return
      let retained = false
      try {
        if (this.stopping || this.fault) continue
        if (this.clock.baseUs === null) {
          retained = this.hold(data)
          continue
        }
        const earlier = this.held.splice(0)
        try {
          for (const chunk of earlier) await this.writeAudio(chunk)
        } finally {
          for (const chunk of earlier) chunk.close()
        }
        await this.writeAudio(data)
      } catch (cause) {
        this.fail(cause)
      } finally {
        if (!retained) data.close()
      }
    }
  }

  /** Bounded pre-roll: keep at most ~1 s of audio while no video has started. */
  private hold(data: AudioData): boolean {
    const planned = planAvAudioChunk(this.clock, data.timestamp, data.numberOfFrames, data.sampleRate)
    this.clock = planned.state
    if (planned.decision.action === 'fault') throw new Faulted(planned.decision.reason)
    this.held.push(data)
    while (this.held.length > 1 &&
      data.timestamp - this.held[0]!.timestamp > AV_CAPTURE_LIMITS.maxHeldAudioUs) {
      this.held.shift()!.close()
    }
    return true
  }

  private async writeAudio(data: AudioData): Promise<void> {
    const source = this.audioSource
    if (!source) return
    const planned = planAvAudioChunk(this.clock, data.timestamp, data.numberOfFrames, data.sampleRate)
    this.clock = planned.state
    const decision = planned.decision
    if (decision.action === 'fault') throw new Faulted(decision.reason)
    if (decision.action !== 'write') return
    const rate = data.sampleRate
    const channels = data.numberOfChannels
    let at = decision.timestampUs
    let silence = decision.leadingSilenceSamples
    while (silence > 0) {
      const frames = Math.min(silence, AV_CAPTURE_LIMITS.silenceChunkFrames)
      const sample = new AudioSample({ data: new Float32Array(frames * channels), format: 'f32',
        numberOfChannels: channels, sampleRate: rate, timestamp: at / 1_000_000 })
      try { await source.add(sample) } finally { sample.close() }
      silence -= frames
      at += microsecondsForSamples(frames, rate)
    }
    if (decision.trimSamples >= data.numberOfFrames) return
    const whole = new AudioSample(data)
    let sample = whole
    try {
      if (decision.trimSamples > 0) sample = whole.trim(decision.trimSamples)
      sample.setTimestamp(at / 1_000_000)
      await source.add(sample)
    } finally {
      if (sample !== whole) sample.close()
      whole.close()
    }
  }

  private fail(cause: unknown): void {
    if (this.fault) return
    this.fault = cause instanceof Error ? cause : new Error(String(cause))
    if (!this.stopping) this.selfStop('source-ended')
  }

  private async quiesce(): Promise<void> {
    this.stopping = true
    if (this.watchdog !== null) clearInterval(this.watchdog)
    this.watchdog = null
    await Promise.allSettled([this.videoReader.cancel(), this.audioReader?.cancel()])
    await this.loops.catch(() => {})
    await this.videoChain
    for (const data of this.held.splice(0)) data.close()
    this.pendingFrame?.close()
    this.pendingFrame = null
  }

  /** Stop reading, finalize the container, flush, and report. Idempotent. */
  stop(): Promise<AvRecorderResult> {
    this.finishing ??= this.finish()
    return this.finishing
  }

  private async finish(): Promise<AvRecorderResult> {
    await this.quiesce()
    try {
      if (this.fault) {
        await this.output.cancel().catch(() => {})
        this.input.file.flush()
        throw this.fault
      }
      // Hold the last picture until the end so a static tail is not lost.
      const end = this.nowUs()
      if (this.lastFrame && end - this.lastVideoUs >= AV_CAPTURE_LIMITS.repeatFrameUs / 2) {
        await this.repeatLastFrame(end)
      }
      this.videoSource.close()
      this.audioSource?.close()
      await this.output.finalize()
      this.input.file.flush()
      this.flushedBytes = this.bytes
      if (this.videoFrames === 0) throw new Error('No video frame was captured')
      const note = [this.stopNote, describeAvClock(this.clock)].filter(Boolean).join(' ') || null
      return { ...this.progress, reason: this.endReason, clockNote: note }
    } finally {
      this.lastFrame?.close()
      this.lastFrame = null
    }
  }

  /** Cut immediately without finalizing; the flushed prefix stays recoverable. */
  async abort(): Promise<void> {
    await this.quiesce()
    this.lastFrame?.close()
    this.lastFrame = null
    await this.output.cancel().catch(() => {})
    try { this.input.file.flush() } catch { /* The prefix already flushed stays valid. */ }
  }
}
