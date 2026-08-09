/** Ephemeral, state-only guide for the snap target chosen by a live edit. */

import { useTransportStore } from '../../state/transportStore'
import { frameToTimelineLocalPx } from './timelineViewport'

interface AlignmentGuideProps {
  timelineOriginFrame: number
  timelineWindowEndFrame: number
}

export default function AlignmentGuide({
  timelineOriginFrame,
  timelineWindowEndFrame,
}: AlignmentGuideProps) {
  const guide = useTransportStore((state) => state.snapGuide)
  const zoom = useTransportStore((state) => state.zoom)
  if (
    guide === null
    || guide.frame < timelineOriginFrame
    || guide.frame > timelineWindowEndFrame
  ) return null

  return (
    <>
      <div
        className="timeline-alignment-guide"
        data-testid="timeline-alignment-guide"
        data-snap-kind={guide.candidateKind}
        data-snap-frame={guide.frame}
        aria-hidden="true"
        style={{
          transform: `translateX(${frameToTimelineLocalPx(
            guide.frame,
            timelineOriginFrame,
            zoom,
          )}px)`,
        }}
      >
        <span>{guide.label}</span>
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        Aligned to {guide.label} at frame {guide.frame}
      </span>
    </>
  )
}
