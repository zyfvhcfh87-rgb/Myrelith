/** Exact sample occupancy, not a high-water mark. Opus padding is bounded separately. */
export class PcmCoverage {
  readonly channels = [new Float32Array(48000), new Float32Array(48000)]
  readonly ranges: { timestamp: number; start: number; end: number; overlap: number; padding: number }[] = []
  private readonly covered = new Uint8Array(48000)
  private count = 0
  private overlaps = 0
  add(timestamp: number, sampleRate: number, planes: readonly Float32Array[]) {
    if (!Number.isFinite(timestamp) || sampleRate !== 48000 || planes.length !== 2 || planes[0].length !== planes[1].length) throw new Error('Invalid PCM buffer format')
    const start = Math.round(timestamp * 48000), end = start + planes[0].length
    if (start < -960 || end > 48960 || this.ranges.length >= 1024) throw new Error('PCM padding or buffer count exceeds bounds')
    let overlap = 0
    for (let i = 0; i < planes[0].length; i++) {
      if (!Number.isFinite(planes[0][i]) || !Number.isFinite(planes[1][i])) throw new Error('Nonfinite decoded PCM')
      const target = start + i
      if (target < 0 || target >= 48000) continue
      if (this.covered[target]) overlap++
      else { this.covered[target] = 1; this.count++ }
      for (let c = 0; c < 2; c++) this.channels[c][target] = planes[c][i]
    }
    this.overlaps += overlap
    this.ranges.push({ timestamp, start, end, overlap, padding: Math.max(0, -start) + Math.max(0, end - 48000) })
    if (overlap > 1 || this.overlaps > 16) throw new Error('PCM overlaps exceed timestamp-rounding allowance')
  }
  snapshot() { return { coveredSamples: this.count, overlaps: this.overlaps, ranges: this.ranges } }
  finish() { if (this.count !== 48000) throw new Error(`PCM has gaps: ${this.count}/48000 samples`); return this.snapshot() }
}
