/** One bounded lookup/cache and task queue per serialized render owner. */
import { COLOR_LUT_LIMITS, applyColorLut, colorLutSampleCount, decodeColorLut, type DecodedColorLut, type PortableColorLutV1 } from '../domain/colorLut'
import { colorLutCatalogError, isColorLutV1, type PortableColorLut } from '../domain/colorLutCatalog'
import { materializeCurveChannels } from '../domain/colorCurves'
import { materializeWheelChannels } from '../domain/colorWheels'
import { applyChannelTables, colorPixelRange, type ChannelTables } from '../domain/colorChannels'
import { EMPTY_COLOR_GRADING_CONTEXT, isColorGradingPixel, type ColorGradingContext, type ColorLutFact } from '../domain/colorGradingEffects'
import type { CanvasPixelEffect } from '../domain/effectStack'
import { applyOrderedPixelEffectsToRgba, type PixelEffectGeometry } from '../domain/effectPixels'

export class ColorGradingExecutionError extends Error { constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = 'ColorGradingExecutionError' } }
export class ColorGradingCancelledError extends Error { constructor() { super('Color grading was cancelled or superseded.'); this.name = 'ColorGradingCancelledError' } }
type Cached = { readonly bytes: number } & ({ readonly kind: 'lut'; readonly value: DecodedColorLut } | { readonly kind: 'channels'; readonly value: ChannelTables })
export interface ColorGradingFrame {
  readonly runtime: ColorGradingRuntime
  readonly context: ColorGradingContext
  readonly check: () => void
  readonly policy: 'bypass' | 'fail'
}

export class ColorGradingRuntime {
  private catalog: readonly PortableColorLut[] = []
  private cache = new Map<PortableColorLutV1 | string, Cached>()
  private bytes = 0
  private peak = 0
  private closed = false
  private active = false
  private channel: MessageChannel | null = null
  private resume: (() => void) | null = null
  private readonly injectedYield?: () => Promise<void>
  context: ColorGradingContext = EMPTY_COLOR_GRADING_CONTEXT
  constructor(yieldTask?: () => Promise<void>) { this.injectedYield = yieldTask }
  private checkOpen(): void { if (this.closed) throw new ColorGradingCancelledError() }
  private admit(key: PortableColorLutV1 | string, bytes: number, make: () => Cached): Cached {
    this.checkOpen()
    const existing = this.cache.get(key)
    if (existing) { this.cache.delete(key); this.cache.set(key, existing); return existing }
    if (bytes > COLOR_LUT_LIMITS.runtimeBytes) throw new ColorGradingExecutionError('The color lookup exceeds 2 MiB.')
    while (this.bytes + bytes > COLOR_LUT_LIMITS.runtimeBytes || this.cache.size >= COLOR_LUT_LIMITS.runtimeEntries) {
      const oldest = this.cache.entries().next().value
      if (!oldest) throw new ColorGradingExecutionError('Color lookup admission failed.')
      this.cache.delete(oldest[0]); this.bytes -= oldest[1].bytes
    }
    // Reserve before materialization, including allocations still in progress.
    this.bytes += bytes; this.peak = Math.max(this.peak, this.bytes)
    try { const entry = make(); this.cache.set(key, entry); return entry }
    catch (cause) { this.bytes -= bytes; throw cause }
  }
  private lut(record: PortableColorLutV1): DecodedColorLut {
    const entry = this.admit(record, colorLutSampleCount(record.kind, record.size) * 8,
      () => ({ kind: 'lut', bytes: colorLutSampleCount(record.kind, record.size) * 8, value: decodeColorLut(record) }))
    if (entry.kind !== 'lut') throw new ColorGradingExecutionError('Color lookup identity mismatch.')
    return entry.value
  }
  /** Owners call this only after prior work settles; never mutate a live cache. */
  setCatalog(catalog: readonly PortableColorLut[], check: () => void = () => {}): void {
    this.checkOpen()
    if (catalog === this.catalog) return
    if (this.active) throw new ColorGradingExecutionError('Color catalog replacement must wait for the active frame.')
    const error = colorLutCatalogError(catalog)
    if (error) throw new ColorGradingExecutionError(error)
    this.cache.clear(); this.bytes = 0; this.catalog = catalog
    const facts: ColorLutFact[] = []
    try {
      for (const record of catalog) {
        check(); this.checkOpen()
        if (!isColorLutV1(record)) facts.push({ id: record.id, identity: false, error: `Embedded LUT version ${record.version} is unsupported.` })
        else facts.push({ id: record.id, identity: this.lut(record).identity, error: null })
      }
      this.context = Object.freeze({ colorLuts: Object.freeze(facts) })
    } catch (cause) { this.cache.clear(); this.bytes = 0; this.catalog = []; this.context = EMPTY_COLOR_GRADING_CONTEXT; throw cause }
  }
  private async yieldTask(): Promise<void> {
    if (this.injectedYield) { await this.injectedYield(); return }
    if (!this.channel) {
      this.channel = new MessageChannel()
      this.channel.port1.onmessage = () => { const resume = this.resume; this.resume = null; resume?.() }
    }
    await new Promise<void>((resolve) => { this.resume = resolve; this.channel!.port2.postMessage(null) })
  }
  async apply(pixels: Uint8ClampedArray, effects: readonly CanvasPixelEffect[], geometry: PixelEffectGeometry, check: () => void = () => {}): Promise<void> {
    this.checkOpen(); check()
    if (this.active) throw new ColorGradingExecutionError('Color grading frames must be serialized by their owner.')
    colorPixelRange(pixels, 0, geometry.surfaceWidth * geometry.surfaceHeight)
    if (pixels.length !== geometry.surfaceWidth * geometry.surfaceHeight * 4) throw new ColorGradingExecutionError('Color grading dimensions do not match the pixel buffer.')
    this.active = true
    try {
      for (const effect of effects) {
        this.checkOpen(); check()
        if (!isColorGradingPixel(effect)) { applyOrderedPixelEffectsToRgba(pixels, [effect], geometry); continue }
        let lut: DecodedColorLut | null = null, channels: ChannelTables | null = null
        if (effect.kind === 'cube-lut') {
          const record = this.catalog.find((entry) => entry.id === effect.params.lutId)
          if (!record || !isColorLutV1(record)) throw new ColorGradingExecutionError('The embedded LUT is unavailable in this render owner.')
          lut = this.lut(record)
        } else {
          const key = `${effect.kind}:1:${JSON.stringify(effect.params)}`
          const cached = this.admit(key, 3 * 256, () => ({ kind: 'channels', bytes: 3 * 256,
            value: effect.kind === 'rgb-curves' ? materializeCurveChannels(effect.params) : materializeWheelChannels(effect.params) }))
          if (cached.kind !== 'channels') throw new ColorGradingExecutionError('Color channel identity mismatch.')
          channels = cached.value
        }
        for (let start = 0; start < pixels.length / 4; start += 4096) {
          check(); this.checkOpen()
          const count = Math.min(4096, pixels.length / 4 - start)
          if (lut && effect.kind === 'cube-lut') applyColorLut(pixels, lut, effect.params.strength, start, count)
          else if (channels) applyChannelTables(pixels, channels, start, count)
          await this.yieldTask()
        }
        check(); this.checkOpen()
      }
    } finally { this.active = false; if (this.closed) this.releaseEntries() }
  }
  clearCache(): void {
    if (this.active) throw new ColorGradingExecutionError('Cannot clear a borrowed grading cache.')
    this.cache.clear(); this.bytes = 0
  }
  ledger() { return { bytes: this.bytes, peakBytes: this.peak, entries: this.cache.size, pendingTasks: this.resume ? 1 : 0, active: this.active, ports: this.channel ? 2 : 0 } }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    const resume = this.resume; this.resume = null; resume?.()
    this.channel?.port1.close(); this.channel?.port2.close(); this.channel = null
    if (!this.active) this.releaseEntries()
  }
  private releaseEntries(): void { this.cache.clear(); this.bytes = 0; this.catalog = []; this.context = EMPTY_COLOR_GRADING_CONTEXT }
}
