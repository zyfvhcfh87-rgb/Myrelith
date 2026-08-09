import type { TimelineMarker, TimelineMarkerId } from '../../domain/schema'

export interface TimelineMarkerCluster {
  readonly key: string
  readonly frame: number
  readonly localPx: number
  readonly markers: readonly TimelineMarker[]
  readonly representative: TimelineMarker
}

interface MutableTimelineMarkerCluster extends TimelineMarkerCluster {
  markers: TimelineMarker[]
  representative: TimelineMarker
}

function lowerBound(markers: readonly TimelineMarker[], frame: number): number {
  let low = 0
  let high = markers.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (markers[middle].frame < frame) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Binary-search and pixel-cluster one visible marker slice. The returned DOM
 * plan is bounded by viewport width even for 10k equal-frame markers.
 */
export function planTimelineMarkerClusters(
  markers: readonly TimelineMarker[],
  originFrame: number,
  zoom: number,
  windowStartPx: number,
  windowEndPx: number,
  selectedMarkerId: TimelineMarkerId | null,
  minimumSeparationPx = 14,
): readonly TimelineMarkerCluster[] {
  if (markers.length === 0 || zoom <= 0 || windowEndPx < windowStartPx) return []
  const startFrame = Math.max(originFrame, originFrame + windowStartPx / zoom)
  const endFrame = originFrame + windowEndPx / zoom
  const startIndex = lowerBound(markers, Math.floor(startFrame))
  const clusters: MutableTimelineMarkerCluster[] = []

  for (let index = startIndex; index < markers.length; index++) {
    const marker = markers[index]
    if (marker.frame > endFrame) break
    const localPx = (marker.frame - originFrame) * zoom
    const previous = clusters[clusters.length - 1]
    if (previous && localPx - previous.localPx < minimumSeparationPx) {
      previous.markers.push(marker)
      if (marker.id === selectedMarkerId) previous.representative = marker
      continue
    }
    clusters.push({
      key: marker.id,
      frame: marker.frame,
      localPx,
      markers: [marker],
      representative: marker,
    })
  }

  return clusters
}
