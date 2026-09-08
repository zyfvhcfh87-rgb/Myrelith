/** Bounded statistics only; these do not replace the frozen export acceptance. */
export const DIAGNOSTIC_FRAMES = [0, 126, 127, 128, 255, 299] as const
export const MAX_COORDINATES = 64
export const MAX_DIAGNOSTIC_PIXEL_BYTES = 64 * 1024 * 1024
export type DiagnosticPixels = Uint8ClampedArray<ArrayBuffer>
export const DIAGNOSTIC_WORK_LIMITS = { ordinal: 600, sparse: 12, productionSource: 128, composite: 1, candidate: 6 } as const

export class DiagnosticWorkOwner {
  private counts = { ordinal: 0, sparse: 0, productionSource: 0, composite: 0, candidate: 0 }
  claim(kind: keyof typeof DIAGNOSTIC_WORK_LIMITS) {
    if (this.counts[kind] >= DIAGNOSTIC_WORK_LIMITS[kind]) throw new Error(`Diagnostic ${kind} work cap exceeded`)
    this.counts[kind]++
  }
  snapshot() { return { ...this.counts, publicSampleAndSourceRequests: this.counts.ordinal + this.counts.sparse + this.counts.productionSource, requestLimit: 740 } }
  assertComplete() {
    for (const kind of Object.keys(DIAGNOSTIC_WORK_LIMITS) as (keyof typeof DIAGNOSTIC_WORK_LIMITS)[]) {
      if (this.counts[kind] !== DIAGNOSTIC_WORK_LIMITS[kind]) throw new Error(`Diagnostic ${kind} work did not complete`)
    }
  }
}

function region() { return { channels: 0, totalAbsoluteDelta: 0, maximumDelta: 0, nonzero: 0, above12: 0 } }
export function pixelErrors(actual: DiagnosticPixels, reference: DiagnosticPixels, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > 1280 || height > 720 || actual.length !== width * height * 4 || reference.length !== actual.length) throw new Error('Invalid diagnostic pixel extent')
  const regions = { opaque: region(), feather: region(), outside: region() }
  const histogram = Array<number>(256).fill(0)
  const coordinates: { x: number; y: number; channel: number; actual: number; expected: number; delta: number; region: keyof typeof regions }[] = []
  const maximumCoordinates: typeof coordinates = []
  let maximumDelta = 0, maximumCount = 0, totalAbsoluteDelta = 0, nonzero = 0, above12 = 0
  for (let offset = 0; offset < actual.length; offset += 4) {
    const alpha = reference[offset + 3]!, name = alpha === 0 ? 'outside' : alpha === 255 ? 'opaque' : 'feather'
    const bucket = regions[name]
    for (let channel = 0; channel < 3; channel++) {
      const value = actual[offset + channel]!, expected = reference[offset + channel]!, delta = Math.abs(value - expected)
      const coordinate = (): (typeof coordinates)[number] => ({ x: offset / 4 % width, y: Math.floor(offset / 4 / width), channel, actual: value, expected, delta, region: name })
      histogram[delta]!++; totalAbsoluteDelta += delta; bucket.channels++; bucket.totalAbsoluteDelta += delta
      bucket.maximumDelta = Math.max(bucket.maximumDelta, delta)
      if (delta) { nonzero++; bucket.nonzero++ }
      if (delta > 12) { above12++; bucket.above12++; if (coordinates.length < MAX_COORDINATES) coordinates.push(coordinate()) }
      if (delta > maximumDelta) { maximumDelta = delta; maximumCount = 0; maximumCoordinates.length = 0 }
      if (delta === maximumDelta) {
        maximumCount++
        if (delta && maximumCoordinates.length < MAX_COORDINATES) maximumCoordinates.push(coordinate())
      }
    }
  }
  const channels = width * height * 3, meanDelta = totalAbsoluteDelta / channels
  return { channels, maximumDelta, maximumCount, totalAbsoluteDelta, meanDelta, nonzero, above12,
    histogram, regions, firstAbove12: coordinates, maximumCoordinates, coordinateLimit: MAX_COORDINATES,
    originalTolerance: { maximum: 12, mean: 2, satisfied: maximumDelta <= 12 && meanDelta <= 2 } }
}

/** Keeps the mask alpha for region attribution; RGB becomes the original black-background oracle. */
export function compositeReferenceOverBlack(pixels: DiagnosticPixels) {
  for (let offset = 0; offset < pixels.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
    pixels[offset + channel] = Math.round(pixels[offset + channel]! * pixels[offset + 3]! / 255)
  }
}

export class DiagnosticPixelOwner {
  private active = new Set<DiagnosticPixels>()
  private bytes = 0
  private peak = 0
  private allocations = 0
  private releases = 0
  create(bytes: number, make: () => DiagnosticPixels) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.bytes + bytes > MAX_DIAGNOSTIC_PIXEL_BYTES) throw new Error('Diagnostic pixel ownership cap exceeded before allocation')
    const pixels = make()
    if (pixels.byteLength !== bytes) { pixels.fill(0); throw new Error('Diagnostic pixel allocation extent differs') }
    return this.own(pixels)
  }
  copy(pixels: DiagnosticPixels) { return this.create(pixels.byteLength, () => pixels.slice()) }
  own(pixels: DiagnosticPixels) {
    if (this.active.has(pixels)) throw new Error('Diagnostic pixels already owned')
    if (this.bytes + pixels.byteLength > MAX_DIAGNOSTIC_PIXEL_BYTES) { pixels.fill(0); throw new Error('Diagnostic pixel ownership cap exceeded') }
    this.active.add(pixels); this.bytes += pixels.byteLength; this.peak = Math.max(this.peak, this.bytes); this.allocations++
    return pixels
  }
  release(pixels: DiagnosticPixels) {
    if (!this.active.delete(pixels)) throw new Error('Diagnostic pixels released twice')
    this.bytes -= pixels.byteLength; this.releases++; pixels.fill(0)
  }
  close() { for (const pixels of this.active) this.release(pixels) }
  snapshot() { return { bytes: this.bytes, peakBytes: this.peak, buffers: this.active.size, allocations: this.allocations, releases: this.releases, limitBytes: MAX_DIAGNOSTIC_PIXEL_BYTES } }
}
