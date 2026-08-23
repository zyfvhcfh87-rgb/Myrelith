import type { ClipId } from '../../domain/schema'

export interface MarqueePoint {
  x: number
  y: number
}

export interface MarqueeRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface MarqueeCandidate {
  clipId: ClipId
  rect: Pick<MarqueeRect, 'left' | 'top' | 'right' | 'bottom'>
  selectable?: boolean
}

export function marqueeRectFromPoints(
  start: MarqueePoint,
  current: MarqueePoint,
): MarqueeRect {
  const left = Math.min(start.x, current.x)
  const top = Math.min(start.y, current.y)
  const right = Math.max(start.x, current.x)
  const bottom = Math.max(start.y, current.y)
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

export function selectedClipIdsInMarquee(
  marquee: MarqueeRect,
  candidates: readonly MarqueeCandidate[],
): ClipId[] {
  if (marquee.width <= 0 || marquee.height <= 0) return []
  const selected: ClipId[] = []
  const seen = new Set<ClipId>()
  for (const candidate of candidates) {
    if (candidate.selectable === false || seen.has(candidate.clipId)) continue
    const { rect } = candidate
    if (
      rect.right <= rect.left
      || rect.bottom <= rect.top
      || rect.right <= marquee.left
      || rect.left >= marquee.right
      || rect.bottom <= marquee.top
      || rect.top >= marquee.bottom
    ) continue
    seen.add(candidate.clipId)
    selected.push(candidate.clipId)
  }
  return selected
}
