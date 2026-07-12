/**
 * Pure layout math for ClipView's generated filmstrip.
 *
 * The source asset is divided into enough evenly spaced display buckets to
 * fill the current zoom without squeezing the generated sprite tiles. The
 * count stays capped by the sprite's existing sample count. ClipView renders
 * only buckets that intersect the displayed half-open source range; integer
 * frame boundaries keep trim, slip and razor halves aligned exactly.
 */

export interface FilmstripBucket {
  index: number
  spriteIndex: number
  startFrame: number
  endFrame: number
}

export function visibleFilmstripBuckets(
  assetDurationFrames: number,
  tileCount: number,
  tileWidth: number,
  zoom: number,
  sourceStartFrame: number,
  sourceDurationFrames: number,
): FilmstripBucket[] {
  if (
    !Number.isSafeInteger(assetDurationFrames) ||
    assetDurationFrames <= 0 ||
    !Number.isSafeInteger(tileCount) ||
    tileCount <= 0 ||
    !Number.isSafeInteger(tileWidth) ||
    tileWidth <= 0 ||
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    !Number.isSafeInteger(sourceStartFrame) ||
    !Number.isSafeInteger(sourceDurationFrames) ||
    sourceDurationFrames <= 0
  ) {
    return []
  }

  const sourceEndFrame = sourceStartFrame + sourceDurationFrames
  if (!Number.isSafeInteger(sourceEndFrame)) return []

  const assetWidth = assetDurationFrames * zoom
  if (!Number.isFinite(assetWidth)) return []
  const displayCount = Math.min(
    tileCount,
    Math.max(1, Math.floor(assetWidth / tileWidth)),
  )

  const buckets: FilmstripBucket[] = []
  const duration = BigInt(assetDurationFrames)
  const divisor = BigInt(displayCount)
  for (let index = 0; index < displayCount; index++) {
    const startFrame = Number((BigInt(index) * duration) / divisor)
    const endFrame = Number((BigInt(index + 1) * duration) / divisor)
    const spriteIndex = Number(
      (BigInt(index * 2 + 1) * BigInt(tileCount)) / (divisor * 2n),
    )
    if (
      startFrame < endFrame &&
      endFrame > sourceStartFrame &&
      startFrame < sourceEndFrame
    ) {
      buckets.push({ index, spriteIndex, startFrame, endFrame })
    }
  }
  return buckets
}
