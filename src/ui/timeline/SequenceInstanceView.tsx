import { memo } from 'react'
import type { SequenceInstance, TrackId, TrackKind } from '../../domain/schema'
import { rangeEnd } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useSequenceInstanceSelectionStore } from '../../state/sequenceInstanceSelectionStore'
import { useTransportStore } from '../../state/transportStore'
import { frameToTimelineLocalPx } from './timelineViewport'

interface SequenceInstanceViewProps {
  instance: SequenceInstance
  trackId: TrackId
  trackKind: TrackKind
  timelineOriginFrame: number
  timelineWindowEndFrame: number
}

function SequenceInstanceView({
  instance,
  trackId,
  trackKind,
  timelineOriginFrame,
  timelineWindowEndFrame,
}: SequenceInstanceViewProps) {
  const zoom = useTransportStore((state) => state.zoom)
  const selected = useSequenceInstanceSelectionStore(
    (state) => state.selectedInstanceId === instance.id,
  )
  const visibleStart = Math.max(instance.timelineRange.startFrame, timelineOriginFrame)
  const visibleEnd = Math.min(rangeEnd(instance.timelineRange), timelineWindowEndFrame)
  if (visibleStart >= visibleEnd) return null
  return (
    <button
      type="button"
      className={`sequence-instance-view${selected ? ' selected' : ''}`}
      data-testid={`sequence-instance-${instance.id}`}
      data-instance-id={instance.id}
      data-sequence-id={instance.sequenceId}
      data-track-id={trackId}
      data-track-kind={trackKind}
      aria-pressed={selected}
      aria-label={`Compound ${instance.name}`}
      title={`${instance.name} · double-click to open`}
      style={{
        transform: `translateX(${frameToTimelineLocalPx(
          visibleStart,
          timelineOriginFrame,
          zoom,
        )}px)`,
        width: Math.max(1, (visibleEnd - visibleStart) * zoom),
      }}
      onClick={(event) => {
        event.stopPropagation()
        useTransportStore.getState().setSelectedClip(null)
        useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(instance.id)
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        const childFrame = useDocumentStore.getState().openSequenceInstance(
          instance.id,
          useTransportStore.getState().playheadFrame,
        )
        if (childFrame !== null) {
          useTransportStore.getState().setPlayheadFrame(childFrame)
          useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
        }
      }}
    >
      <span aria-hidden="true">◆</span>
      <strong>{instance.name}</strong>
    </button>
  )
}

export default memo(SequenceInstanceView)
