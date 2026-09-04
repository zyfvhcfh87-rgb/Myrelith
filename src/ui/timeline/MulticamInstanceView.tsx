import { memo } from 'react'
import type { MulticamInstance, TrackId, TrackKind } from '../../domain/schema'
import { multicamInstanceVisibleRange } from '../../state/multicamPresentation'
import { useMulticamSelectionStore } from '../../state/multicamSelectionStore'
import { useSequenceInstanceSelectionStore } from '../../state/sequenceInstanceSelectionStore'
import { useTransportStore } from '../../state/transportStore'
import { frameToTimelineLocalPx } from './timelineViewport'

interface MulticamInstanceViewProps {
  readonly instance: MulticamInstance
  readonly trackId: TrackId
  readonly trackKind: TrackKind
  readonly timelineOriginFrame: number
  readonly timelineWindowEndFrame: number
}

function MulticamInstanceView({
  instance,
  trackId,
  trackKind,
  timelineOriginFrame,
  timelineWindowEndFrame,
}: MulticamInstanceViewProps) {
  const zoom = useTransportStore((state) => state.zoom)
  const selected = useMulticamSelectionStore(
    (state) => state.selectedInstanceId === instance.id,
  )
  const visibleRange = multicamInstanceVisibleRange(
    instance,
    timelineOriginFrame,
    timelineWindowEndFrame,
  )
  if (!visibleRange) return null
  return (
    <button
      type="button"
      className={`multicam-instance-view${selected ? ' selected' : ''}`}
      data-testid={`multicam-instance-${instance.id}`}
      data-instance-id={instance.id}
      data-multicam-id={instance.multicamId}
      data-track-id={trackId}
      data-track-kind={trackKind}
      aria-pressed={selected}
      aria-label={`Multicam ${instance.name} on ${trackKind} track`}
      title={`${instance.name} · manual-sync multicam`}
      style={{
        transform: `translateX(${frameToTimelineLocalPx(
          visibleRange.startFrame,
          timelineOriginFrame,
          zoom,
        )}px)`,
        width: Math.max(1, (visibleRange.endFrame - visibleRange.startFrame) * zoom),
      }}
      onClick={(event) => {
        event.stopPropagation()
        useTransportStore.getState().setSelectedClip(null)
        useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
        useMulticamSelectionStore.getState().setSelectedInstanceId(instance.id)
      }}
    >
      <span aria-hidden="true">MC</span>
      <strong>{instance.name}</strong>
    </button>
  )
}

export default memo(MulticamInstanceView)
