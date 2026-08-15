/** Browser-free allocation policy shared by project parsing and render hosts. */

export const MAX_RENDER_SURFACE_DIMENSION = 16_384
export const MAX_RENDER_SURFACE_PIXELS = 16 * 1024 * 1024
export const RENDER_SURFACE_BYTES_PER_PIXEL = 4
export const RENDER_COMPOSITOR_SURFACE_COUNT = 4
export const LENS_REMAP_REUSABLE_SURFACE_COUNT = 2
export const EXPORT_READBACK_SURFACE_COUNT = 1
export const MAX_RENDER_AGGREGATE_SURFACE_BYTES = 256 * 1024 * 1024

export interface RenderSurfaceBudget {
  readonly allowed: boolean
  readonly width: number
  readonly height: number
  readonly pixelCount: number
  readonly surfaceCount: number
  readonly aggregateBytes: number
  readonly reason: string | null
}

export interface LensRemapSurfaceBudget {
  readonly allowed: boolean
  readonly compositorBytes: number
  readonly remapReusableBytes: number
  readonly exportReadbackBytes: number
  readonly aggregateBytes: number
  readonly reason: string | null
}

export function renderSurfaceBudget(
  width: number,
  height: number,
): RenderSurfaceBudget {
  const validDimensions = Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width > 0
    && height > 0
  const pixelCount = validDimensions ? width * height : Number.NaN
  const aggregateBytes = pixelCount
    * RENDER_SURFACE_BYTES_PER_PIXEL
    * RENDER_COMPOSITOR_SURFACE_COUNT
  let reason: string | null = null

  if (!validDimensions) {
    reason = 'Render dimensions must be positive safe integers.'
  } else if (
    width > MAX_RENDER_SURFACE_DIMENSION
    || height > MAX_RENDER_SURFACE_DIMENSION
  ) {
    reason = `A render dimension exceeds the ${MAX_RENDER_SURFACE_DIMENSION}-pixel limit.`
  } else if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_RENDER_SURFACE_PIXELS) {
    reason = `The render surface exceeds the ${MAX_RENDER_SURFACE_PIXELS}-pixel limit.`
  } else if (
    !Number.isSafeInteger(aggregateBytes)
    || aggregateBytes > MAX_RENDER_AGGREGATE_SURFACE_BYTES
  ) {
    reason = 'The reusable compositor surfaces exceed the render memory limit.'
  }

  return Object.freeze({
    allowed: reason === null,
    width,
    height,
    pixelCount,
    surfaceCount: RENDER_COMPOSITOR_SURFACE_COUNT,
    aggregateBytes,
    reason,
  })
}

export function assertRenderSurfaceBudget(width: number, height: number): void {
  const budget = renderSurfaceBudget(width, height)
  if (!budget.allowed) throw new RangeError(budget.reason ?? 'Unsafe render surface')
}

/**
 * Admission for source-space lens remapping plus the existing compositor.
 * Preview has four reusable compositor surfaces plus two remap surfaces;
 * export adds one request-scoped output readback for the proven seven-surface
 * 4K peak. Source and output sizes are independent and both stay bounded.
 */
export function lensRemapSurfaceBudget(
  outputWidth: number,
  outputHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  includeExportReadback: boolean,
): LensRemapSurfaceBudget {
  const compositor = renderSurfaceBudget(outputWidth, outputHeight)
  const sourceValid = Number.isSafeInteger(sourceWidth)
    && Number.isSafeInteger(sourceHeight)
    && sourceWidth > 0
    && sourceHeight > 0
  const sourcePixels = sourceValid ? sourceWidth * sourceHeight : Number.NaN
  const outputFrameBytes = compositor.pixelCount * RENDER_SURFACE_BYTES_PER_PIXEL
  const remapReusableBytes = sourcePixels
    * RENDER_SURFACE_BYTES_PER_PIXEL
    * LENS_REMAP_REUSABLE_SURFACE_COUNT
  const exportReadbackBytes = includeExportReadback
    ? outputFrameBytes * EXPORT_READBACK_SURFACE_COUNT
    : 0
  const aggregateBytes = compositor.aggregateBytes
    + remapReusableBytes
    + exportReadbackBytes
  let reason = compositor.reason
  if (!sourceValid) {
    reason ??= 'Lens-remap source dimensions must be positive safe integers.'
  } else if (
    sourceWidth > MAX_RENDER_SURFACE_DIMENSION
    || sourceHeight > MAX_RENDER_SURFACE_DIMENSION
  ) {
    reason ??= `A lens-remap source dimension exceeds the ${MAX_RENDER_SURFACE_DIMENSION}-pixel limit.`
  } else if (!Number.isSafeInteger(sourcePixels) || sourcePixels > MAX_RENDER_SURFACE_PIXELS) {
    reason ??= `The lens-remap source exceeds the ${MAX_RENDER_SURFACE_PIXELS}-pixel limit.`
  } else if (
    !Number.isSafeInteger(aggregateBytes)
    || aggregateBytes > MAX_RENDER_AGGREGATE_SURFACE_BYTES
  ) {
    reason ??= 'Lens remap plus compositor/readback exceeds the render memory limit.'
  }
  return Object.freeze({
    allowed: reason === null,
    compositorBytes: compositor.aggregateBytes,
    remapReusableBytes,
    exportReadbackBytes,
    aggregateBytes,
    reason,
  })
}
