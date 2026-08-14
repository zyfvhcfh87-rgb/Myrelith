/** Pure, bounded presentation facts for clip animation shown on the timeline. */

import { clipAnimation } from '../../domain/clipAnimation'
import type { Clip } from '../../domain/schema'
import {
  clipSourceTimeMap,
  sourceTimeMapUsesSpeedCurve,
  sourceTimeSpeedAtTimelineOffset,
  sourceTimeSpeedPointsAtClip,
  sourceTimeSpeedRatePercent,
} from '../../domain/sourceTimeMap'

export type ClipAutomationMarkerKind = 'property' | 'effect'

export interface ClipAutomationMarker {
  frame: number
  kinds: readonly ClipAutomationMarkerKind[]
}

export type ClipSpeedSegmentTone = 'normal' | 'slow' | 'fast' | 'freeze' | 'mixed'

export interface ClipSpeedSegment {
  startFrame: number
  endFrame: number
  startPercent: number
  endPercent: number
  label: string
  tone: ClipSpeedSegmentTone
}

function roundedPercent(speed: number): number {
  return Math.round(speed * 10_000) / 100
}

function formatPercent(percent: number): string {
  const value = Number.isInteger(percent)
    ? String(percent)
    : percent.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `${value}%`
}

function segmentTone(startPercent: number, endPercent: number): ClipSpeedSegmentTone {
  const low = Math.min(startPercent, endPercent)
  const high = Math.max(startPercent, endPercent)
  if (high === 0) return 'freeze'
  if (low === 100 && high === 100) return 'normal'
  if (high <= 100) return 'slow'
  if (low >= 100) return 'fast'
  return 'mixed'
}

/** Collect ordinary and effect-parameter keys without duplicating shared frames. */
export function clipAutomationMarkers(clip: Clip): ClipAutomationMarker[] {
  const byFrame = new Map<number, Set<ClipAutomationMarkerKind>>()
  const add = (frame: number, kind: ClipAutomationMarkerKind): void => {
    if (frame < 0 || frame >= clip.timelineRange.durationFrames) return
    const kinds = byFrame.get(frame) ?? new Set<ClipAutomationMarkerKind>()
    kinds.add(kind)
    byFrame.set(frame, kinds)
  }
  const animation = clipAnimation(clip)
  for (const track of animation.tracks) {
    for (const keyframe of track.keyframes) add(keyframe.frame, 'property')
  }
  for (const track of animation.effectTracks ?? []) {
    for (const keyframe of track.keyframes) add(keyframe.frame, 'effect')
  }
  return [...byFrame.entries()]
    .sort(([left], [right]) => left - right)
    .map(([frame, kinds]) => ({ frame, kinds: [...kinds].sort() }))
}

/**
 * Build Resolve-style speed sections from the same curve evaluated by preview
 * and export. Points outside a trimmed clip still influence the boundary value,
 * while only clip-local visible boundaries become timeline sections.
 */
export function clipSpeedSegments(clip: Clip): ClipSpeedSegment[] {
  const map = clipSourceTimeMap(clip)
  if (!sourceTimeMapUsesSpeedCurve(map)) return []
  const duration = clip.timelineRange.durationFrames
  const points = sourceTimeSpeedPointsAtClip(map)
  const boundaries = Array.from(new Set([
    0,
    ...points
      .map((point) => point.frame)
      .filter((frame) => frame > 0 && frame < duration),
    duration,
  ])).sort((left, right) => left - right)
  const percentAtBoundary = (frame: number): number => {
    const authored = points.find((point) => point.frame === frame)
    return authored
      ? sourceTimeSpeedRatePercent(authored.rate)
      : roundedPercent(sourceTimeSpeedAtTimelineOffset(map, frame))
  }

  const segments: ClipSpeedSegment[] = []
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startFrame = boundaries[index]!
    const endFrame = boundaries[index + 1]!
    if (endFrame <= startFrame) continue
    const startPercent = percentAtBoundary(startFrame)
    const activePoint = points.findLast((point) => point.frame <= startFrame) ?? points[0]
    const endSampleFrame = endFrame < duration ? endFrame : Math.max(startFrame, endFrame - 1)
    const endPercent = activePoint?.easing === 'hold'
      ? startPercent
      : percentAtBoundary(endSampleFrame)
    segments.push({
      startFrame,
      endFrame,
      startPercent,
      endPercent,
      label: startPercent === endPercent
        ? formatPercent(startPercent)
        : `${formatPercent(startPercent)} -> ${formatPercent(endPercent)}`,
      tone: segmentTone(startPercent, endPercent),
    })
  }
  return segments
}

export function clipHasSpeedLane(clip: Clip): boolean {
  return sourceTimeMapUsesSpeedCurve(clipSourceTimeMap(clip))
}
