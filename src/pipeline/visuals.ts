/**
 * pipeline/visuals.ts — Generate the timeline's clip visuals, once per
 * asset: a FILMSTRIP (a horizontal strip of evenly spaced frames) for
 * video, and a WAVEFORM image for audio. Layering: pipeline/ → domain/
 * only (mediabunny + canvas are runtime hosts, same as demux.ts).
 *
 * Both images span the asset's FULL source duration by construction, so
 * the UI maps them onto any clip with two CSS background values
 * (size = assetDuration×zoom, position = −sourceStart×zoom) — trim, slip
 * and zoom stay correct without ever redrawing.
 *
 * Decoding goes through mediabunny sinks (WebCodecs under the hood):
 * CanvasSink hands us pre-scaled frames, AudioBufferSink streams decoded
 * audio CHUNKS — peaks fold into a fixed-size array on the fly, so a long
 * file never holds its whole PCM in memory. Frame-closing rule: sink
 * canvases are drawn immediately (poolSize 1 reuses them), AudioBuffers
 * die with each loop turn, and the only outputs are two small blobs.
 *
 * The `filmstripTimestamps` / `waveformWidth` / `accumulatePeaks` /
 * `drawWaveform` helpers are pure and unit-tested; the two generators are
 * thin async shells over them, verified in the browser (jsdom has neither
 * WebCodecs nor canvas).
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny'

/* ------------------------------------------------------------------ */
/* Tunables                                                             */
/* ------------------------------------------------------------------ */

/** One filmstrip tile per this many seconds of source material. */
const TILE_SECONDS = 2
/** Filmstrip tile cap — a 10-minute file still yields a sane strip. */
const MAX_TILES = 48
/** Tile height ≈ the clip block's inner height (56px lane − insets). */
export const TILE_HEIGHT = 44

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

/** The 2D-context surface drawWaveform needs (structural, for tests). */
export interface Waveform2D {
  fillStyle: string | CanvasGradient | CanvasPattern
  fillRect(x: number, y: number, w: number, h: number): void
}

/**
 * Draw symmetric peak columns around the vertical center — the classic
 * NLE waveform. True amplitude (no normalization: quiet audio LOOKS
 * quiet), clamped to 1.0; silent columns keep a 1px center hairline so
 * the clip still reads as "audio lives here".
 */
export function drawWaveform(
  ctx: Waveform2D,
  peaks: Float32Array,
  height: number,
  color: string,
): void {
  ctx.fillStyle = color
  const mid = height / 2
  for (let x = 0; x < peaks.length; x++) {
    const half = Math.max(0.5, Math.min(1, peaks[x]) * mid)
    ctx.fillRect(x, mid - half, 1, half * 2)
  }
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

/** Waveform ink — light, so it reads on the green audio clip blocks. */
const WAVEFORM_COLOR = 'rgba(226, 248, 236, 0.85)'

/**
 * Decode evenly spaced frames and join them into one horizontal strip
 * image (JPEG object URL). Returns null when the file has no video track.
 * The caller owns the returned URL (mediaStore takes it over).
 */
export async function generateFilmstrip(file: Blob): Promise<FilmstripResult | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) return null
  const durationSec = await input.computeDuration()
  const timestamps = filmstripTimestamps(durationSec)
  if (timestamps.length === 0) return null

  // poolSize 1: the sink reuses one canvas; we draw each frame into the
  // strip before pulling the next, so reuse can never corrupt a tile.
  const sink = new CanvasSink(track, { height: TILE_HEIGHT, poolSize: 1 })
  let strip: OffscreenCanvas | null = null
  let ctx: OffscreenCanvasRenderingContext2D | null = null
  let tileWidth = 0
  let index = 0
  for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
    if (wrapped) {
      if (!strip) {
        tileWidth = Math.max(1, wrapped.canvas.width)
        strip = new OffscreenCanvas(tileWidth * timestamps.length, TILE_HEIGHT)
        ctx = strip.getContext('2d')
        if (!ctx) return null
      }
      ctx?.drawImage(wrapped.canvas, index * tileWidth, 0, tileWidth, TILE_HEIGHT)
    }
    index++ // an undecodable timestamp leaves its tile black, strip stays aligned
  }
  if (!strip) return null

  const blob = await strip.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
  return {
    url: URL.createObjectURL(blob),
    tiles: timestamps.length,
    tileWidth,
    tileHeight: TILE_HEIGHT,
  }
}

/**
 * Decode the audio track chunk by chunk, fold peaks on the fly, and draw
 * one waveform image (PNG object URL — transparency lets the clip color
 * show through). Returns null when the file has no audio track. The
 * caller owns the returned URL (mediaStore takes it over).
 */
export async function generateWaveform(file: Blob): Promise<WaveformResult | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const track = await input.getPrimaryAudioTrack()
  if (!track) return null
  const durationSec = await input.computeDuration()
  const width = waveformWidth(durationSec)
  if (width === 0) return null

  const peaks = new Float32Array(width)
  const sink = new AudioBufferSink(track)
  for await (const { buffer, timestamp } of sink.buffers()) {
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      accumulatePeaks(peaks, buffer.getChannelData(ch), buffer.sampleRate, timestamp, durationSec)
    }
  }

  const canvas = new OffscreenCanvas(width, WAVEFORM_HEIGHT)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  drawWaveform(ctx, peaks, WAVEFORM_HEIGHT, WAVEFORM_COLOR)

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { url: URL.createObjectURL(blob), width, height: WAVEFORM_HEIGHT }
}
