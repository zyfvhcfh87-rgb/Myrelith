/**
 * pipeline/visuals.ts — Generate the timeline's clip visuals, once per
 * asset: a FILMSTRIP (a horizontal strip of evenly spaced frames) for
 * video, and a WAVEFORM image for audio. Layering: pipeline/ → domain/
 * only (mediabunny + canvas are runtime hosts, same as demux.ts).
 *
 * Both images span the asset's FULL source duration by construction. The UI
 * maps waveform time with CSS and filmstrip time with integer-frame sprite
 * buckets, so trim, slip and zoom stay aligned without another decode.
 *
 * Decoding goes through mediabunny sinks (WebCodecs under the hood):
 * CanvasSink hands us pre-scaled frames, AudioBufferSink streams decoded
 * audio CHUNKS — peaks fold into a fixed-size array on the fly, so a long
 * file never holds its whole PCM in memory. Frame-closing rule: sink
 * canvases are drawn immediately (poolSize 1 reuses them), AudioBuffers
 * die with each loop turn, and the only outputs are two small image blobs.
 *
 * The `filmstripTimestamps` / `waveformWidth` / `accumulatePeaks` /
 * `waveformPath` helpers are pure and unit-tested; the two generators are
 * thin async shells over them, verified in the browser (jsdom has neither
 * WebCodecs nor canvas).
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny'
import {
  ensureMediaDecoderSupport,
  refineAudioDecoderBudget,
  refineVideoDecoderBudget,
  type DecoderCheckFailure,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'

/* ------------------------------------------------------------------ */
/* Tunables                                                             */
/* ------------------------------------------------------------------ */

/** One filmstrip tile per this many seconds of source material. */
const TILE_SECONDS = 2
/** Filmstrip tile cap — a 10-minute file still yields a sane strip. */
const MAX_TILES = 48
/** Tile height ≈ the clip block's inner height (56px lane − insets). */
export const TILE_HEIGHT = 44
/** Keep both decoder output and the joined strip below browser canvas limits. */
const FILMSTRIP_MAX_WIDTH = 16_000

/** Waveform image resolution: pixels per second of audio. */
const WAVEFORM_PX_PER_SECOND = 100
/** Canvas width bounds (Chrome caps canvases at 32k edge px). */
const WAVEFORM_MIN_WIDTH = 16
const WAVEFORM_MAX_WIDTH = 16000
export const WAVEFORM_HEIGHT = 44

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                           */
/* ------------------------------------------------------------------ */

/**
 * Center-of-bucket sample timestamps for a filmstrip: the asset is split
 * into N equal buckets (one per TILE_SECONDS, clamped to [1, MAX_TILES])
 * and each tile shows the frame at its bucket's midpoint — so the strip
 * as a whole maps 1:1 onto the asset's duration.
 */
export function filmstripTimestamps(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return []
  const tiles = Math.max(
    1,
    Math.min(MAX_TILES, Math.round(durationSec / TILE_SECONDS)),
  )
  const step = durationSec / tiles
  return Array.from({ length: tiles }, (_, i) => (i + 0.5) * step)
}

/** Waveform image width in px for a duration, clamped to canvas limits. */
export function waveformWidth(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0
  return Math.max(
    WAVEFORM_MIN_WIDTH,
    Math.min(WAVEFORM_MAX_WIDTH, Math.round(durationSec * WAVEFORM_PX_PER_SECOND)),
  )
}

/**
 * Fold one decoded chunk into the peak array: peaks[x] is the max |sample|
 * of everything that maps onto pixel column x (columns spread evenly over
 * `totalSec`). Call once per channel per chunk; out-of-range samples (a
 * chunk running past the reported duration) clamp into the last column.
 */
export function accumulatePeaks(
  peaks: Float32Array,
  samples: Float32Array,
  sampleRate: number,
  chunkStartSec: number,
  totalSec: number,
): void {
  if (peaks.length === 0 || totalSec <= 0 || sampleRate <= 0) return
  const columnsPerSecond = peaks.length / totalSec
  for (let i = 0; i < samples.length; i++) {
    const t = chunkStartSec + i / sampleRate
    let x = Math.floor(t * columnsPerSecond)
    if (x < 0) x = 0
    else if (x >= peaks.length) x = peaks.length - 1
    const v = Math.abs(samples[i])
    if (v > peaks[x]) peaks[x] = v
  }
}

/** A linearly connected waveform silhouette that stays natural at any zoom. */
export function waveformPath(peaks: Float32Array, height: number): string {
  if (peaks.length === 0 || !Number.isFinite(height) || height <= 0) return ''
  const mid = height / 2
  const halves = Array.from(peaks, (peak) =>
    Math.max(0.5, Math.min(1, Number.isFinite(peak) ? peak : 0) * mid),
  )

  let path = `M0 ${mid - halves[0]}`
  for (let x = 1; x < halves.length; x++) {
    path += `L${x} ${mid - halves[x]}`
  }
  const end = halves.length
  const lastHalf = halves[end - 1]
  path += `L${end} ${mid - lastHalf}L${end} ${mid + lastHalf}`
  for (let x = end - 1; x >= 0; x--) {
    path += `L${x} ${mid + halves[x]}`
  }
  return `${path}Z`
}

/* ------------------------------------------------------------------ */
/* Browser generators (thin shells; browser-verified)                   */
/* ------------------------------------------------------------------ */

export interface FilmstripResult {
  url: string
  tiles: number
  tileWidth: number
  tileHeight: number
}

export interface WaveformResult {
  url: string
  width: number
  height: number
}

function filmstripTileWidth(
  displayWidth: number,
  displayHeight: number,
  tileCount: number,
): number {
  if (
    !Number.isSafeInteger(displayWidth)
    || displayWidth <= 0
    || !Number.isSafeInteger(displayHeight)
    || displayHeight <= 0
    || !Number.isSafeInteger(tileCount)
    || tileCount <= 0
    || tileCount > MAX_TILES
  ) return 0

  const perTileLimit = Math.floor(FILMSTRIP_MAX_WIDTH / tileCount)
  const aspectWidth = Math.max(
    1,
    Math.round((displayWidth / displayHeight) * TILE_HEIGHT),
  )
  return Math.max(1, Math.min(perTileLimit, aspectWidth))
}

/** Pre-track source setup failed, so no video/audio track can be blamed. */
export class MediaVisualSourceError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(detail.slice(0, 2_048), { cause })
    this.name = 'MediaVisualSourceError'
  }
}

/** A decoder capability boundary rejected the selected visual track. */
export class MediaVisualDecodeError extends Error {
  readonly failure: DecoderCheckFailure

  constructor(failure: DecoderCheckFailure) {
    super(failure.detail)
    this.name = 'MediaVisualDecodeError'
    this.failure = { ...failure }
  }
}

export interface MediaVisualDecodeOptions {
  sourceId?: string
  budget: LocalDecoderBudget
  signal?: AbortSignal
}

function mediaVisualAbortError(): Error {
  const error = new Error('Media visual generation was cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfVisualAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw mediaVisualAbortError()
}

function ownVisualInput(input: Input, signal?: AbortSignal): () => void {
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      input.dispose()
    } catch {
      // Cancellation/cleanup cannot hide the primary decode result.
    }
  }
  signal?.addEventListener('abort', dispose, { once: true })
  if (signal?.aborted) dispose()
  return () => {
    signal?.removeEventListener('abort', dispose)
    dispose()
  }
}

function createVisualInput(file: Blob): Input {
  try {
    return new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  } catch (cause) {
    throw new MediaVisualSourceError(cause)
  }
}

/** Waveform ink — light, so it reads on the green audio clip blocks. */
const WAVEFORM_COLOR = 'rgba(226, 248, 236, 0.85)'

/**
 * Decode evenly spaced frames and join them into one horizontal strip
 * image (JPEG object URL). Returns null when the file has no video track.
 * The caller owns the returned URL (mediaStore takes it over).
 */
export async function generateFilmstrip(
  file: Blob,
  options: MediaVisualDecodeOptions,
): Promise<FilmstripResult | null> {
  throwIfVisualAborted(options.signal)
  const input = createVisualInput(file)
  const releaseInput = ownVisualInput(input, options.signal)
  try {
    throwIfVisualAborted(options.signal)
    const track = await input.getPrimaryVideoTrack()
    throwIfVisualAborted(options.signal)
    if (!track) return null
    const [codec, configuration, displayWidth, displayHeight] = await Promise.all([
      track.getCodec(),
      track.getDecoderConfig(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
    ])
    const support = await ensureMediaDecoderSupport({
      codec,
      canDecode: () => track.canDecode(),
      configuration,
      trackKind: 'video',
      sourceId: options.sourceId,
      boundary: 'filmstrip',
      policy: 'revalidate',
      budget: refineVideoDecoderBudget(
        options.budget,
        file.size,
        configuration,
      ),
    })
    throwIfVisualAborted(options.signal)
    if (!support.decodable) throw new MediaVisualDecodeError(support.failure)
    const durationSec = await input.computeDuration([track])
    throwIfVisualAborted(options.signal)
    const timestamps = filmstripTimestamps(durationSec)
    if (timestamps.length === 0) return null
    const tileWidth = filmstripTileWidth(
      displayWidth,
      displayHeight,
      timestamps.length,
    )
    if (tileWidth === 0) {
      throw new RangeError('Video display dimensions are invalid for a filmstrip')
    }
    const stripWidth = tileWidth * timestamps.length
    if (
      !Number.isSafeInteger(stripWidth)
      || stripWidth > FILMSTRIP_MAX_WIDTH
    ) {
      throw new RangeError('Filmstrip dimensions exceed the safe canvas limit')
    }

    // poolSize 1: the sink reuses one canvas; we draw each frame into the
    // strip before pulling the next, so reuse can never corrupt a tile. Both
    // sink dimensions are explicit so hostile aspect ratios cannot allocate
    // an oversized intermediate canvas before the joined strip is bounded.
    const sink = new CanvasSink(track, {
      width: tileWidth,
      height: TILE_HEIGHT,
      fit: 'contain',
      poolSize: 1,
    })
    let strip: OffscreenCanvas | null = null
    let ctx: OffscreenCanvasRenderingContext2D | null = null
    let index = 0
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      throwIfVisualAborted(options.signal)
      if (wrapped) {
        if (!strip) {
          strip = new OffscreenCanvas(stripWidth, TILE_HEIGHT)
          ctx = strip.getContext('2d')
          if (!ctx) return null
        }
        ctx?.drawImage(wrapped.canvas, index * tileWidth, 0, tileWidth, TILE_HEIGHT)
      }
      index++ // an undecodable timestamp leaves its tile black, strip stays aligned
    }
    if (!strip) return null

    const blob = await strip.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
    throwIfVisualAborted(options.signal)
    const url = URL.createObjectURL(blob)
    if (options.signal?.aborted) {
      URL.revokeObjectURL(url)
      throw mediaVisualAbortError()
    }
    return {
      url,
      tiles: timestamps.length,
      tileWidth,
      tileHeight: TILE_HEIGHT,
    }
  } catch (cause) {
    if (options.signal?.aborted) throw mediaVisualAbortError()
    throw cause
  } finally {
    releaseInput()
  }
}

/**
 * Decode the audio track chunk by chunk, fold peaks on the fly, and draw
 * one waveform image (SVG object URL — vector edges stay sharp at timeline
 * zoom). Returns null when the file has no audio track. The
 * caller owns the returned URL (mediaStore takes it over).
 */
export async function generateWaveform(
  file: Blob,
  options: MediaVisualDecodeOptions,
): Promise<WaveformResult | null> {
  throwIfVisualAborted(options.signal)
  const input = createVisualInput(file)
  const releaseInput = ownVisualInput(input, options.signal)
  try {
    throwIfVisualAborted(options.signal)
    const track = await input.getPrimaryAudioTrack()
    throwIfVisualAborted(options.signal)
    if (!track) return null
    const [codec, configuration] = await Promise.all([
      track.getCodec(),
      track.getDecoderConfig(),
    ])
    const support = await ensureMediaDecoderSupport({
      codec,
      canDecode: () => track.canDecode(),
      configuration,
      trackKind: 'audio',
      sourceId: options.sourceId,
      boundary: 'waveform',
      policy: 'revalidate',
      budget: refineAudioDecoderBudget(
        options.budget,
        file.size,
        configuration,
      ),
    })
    throwIfVisualAborted(options.signal)
    if (!support.decodable) throw new MediaVisualDecodeError(support.failure)
    const durationSec = await input.computeDuration([track])
    throwIfVisualAborted(options.signal)
    const width = waveformWidth(durationSec)
    if (width === 0) return null

    const peaks = new Float32Array(width)
    const sink = new AudioBufferSink(track)
    for await (const { buffer, timestamp } of sink.buffers()) {
      throwIfVisualAborted(options.signal)
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        accumulatePeaks(
          peaks,
          buffer.getChannelData(ch),
          buffer.sampleRate,
          timestamp,
          durationSec,
        )
      }
    }

    const path = waveformPath(peaks, WAVEFORM_HEIGHT)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${WAVEFORM_HEIGHT}" preserveAspectRatio="none"><path d="${path}" fill="${WAVEFORM_COLOR}"/></svg>`
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    throwIfVisualAborted(options.signal)
    const url = URL.createObjectURL(blob)
    if (options.signal?.aborted) {
      URL.revokeObjectURL(url)
      throw mediaVisualAbortError()
    }
    return { url, width, height: WAVEFORM_HEIGHT }
  } catch (cause) {
    if (options.signal?.aborted) throw mediaVisualAbortError()
    throw cause
  } finally {
    releaseInput()
  }
}
