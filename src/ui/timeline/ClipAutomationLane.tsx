/** Timeline overlay for the persisted speed map; authoring remains Inspector-owned. */

import type { Clip, SourceTimeMap } from '../../domain/schema'
import { sourceTimeSpeedPointsAtClip } from '../../domain/sourceTimeMap'
import { sourceTimeMapSpeedSegments } from './clipAutomationPlan'

interface ClipAutomationLaneProps {
  clip: Clip
  previewedClipStartFrame: number
  previewedClipDurationFrames: number
  previewedSourceTimeMap: SourceTimeMap
  displayedStartFrame: number
  displayedEndFrame: number
  zoom: number
}

export default function ClipAutomationLane({
  clip,
  previewedClipStartFrame,
  previewedClipDurationFrames,
  previewedSourceTimeMap,
  displayedStartFrame,
  displayedEndFrame,
  zoom,
}: ClipAutomationLaneProps) {
  const segments = sourceTimeMapSpeedSegments(
    previewedSourceTimeMap,
    previewedClipDurationFrames,
  )
  if (segments.length === 0) return null
  const visibleStartLocal = displayedStartFrame - previewedClipStartFrame
  const visibleEndLocal = displayedEndFrame - previewedClipStartFrame
  const visibleSegments = segments.flatMap((segment) => {
    const startFrame = Math.max(segment.startFrame, visibleStartLocal)
    const endFrame = Math.min(segment.endFrame, visibleEndLocal)
    return endFrame > startFrame ? [{ ...segment, startFrame, endFrame }] : []
  })
  const visiblePoints = sourceTimeSpeedPointsAtClip(previewedSourceTimeMap)
    .filter((point) => point.frame >= visibleStartLocal && point.frame < visibleEndLocal)
  const summary = segments.slice(0, 8).map((segment) =>
    `frames ${segment.startFrame} to ${segment.endFrame}: ${segment.label}`,
  ).join('; ')

  return (
    <span
      className="clip-speed-lane"
      data-testid={`clip-${clip.id}-speed-lane`}
      role="img"
      aria-label={`Speed changes. ${summary}${segments.length > 8 ? `; and ${segments.length - 8} more sections` : ''}.`}
    >
      {visibleSegments.map((segment) => (
        <span
          key={`${segment.startFrame}:${segment.endFrame}`}
          className={`clip-speed-segment speed-${segment.tone}`}
          title={`Clip frames ${segment.startFrame}-${segment.endFrame}: ${segment.label}`}
          style={{
            left: (segment.startFrame - visibleStartLocal) * zoom,
            width: (segment.endFrame - segment.startFrame) * zoom,
          }}
          aria-hidden="true"
        >
          <span>{segment.label}</span>
        </span>
      ))}
      {visiblePoints.map((point) => (
        <span
          key={point.frame}
          className="clip-speed-boundary"
          style={{ left: (point.frame - visibleStartLocal) * zoom }}
          aria-hidden="true"
        />
      ))}
    </span>
  )
}
