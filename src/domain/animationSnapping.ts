/** Indexed animation snapping delegates final tie/bounds policy to the timeline authority. */
import { animationKeyKey, animationLaneKey, type AnimationKeyAddress } from './animationAddresses'
import type { AnimationLaneIndex } from './animationLaneIndex'
import { MAX_KEYFRAME_FRAME } from './scalarAnimation'
import { createTimelineSnapIndex, resolveTimelineSnap, timelineSnapCandidates, type TimelineSnapCandidate, type TimelineSnapMovingPoint } from './timelineSnapping'

export function createAnimationSnapSession(index: AnimationLaneIndex, selection: readonly AnimationKeyAddress[], playheadFrame: number) {
  const excluded = new Set(selection.map(animationKeyKey))
  const candidates: TimelineSnapCandidate[] = [...timelineSnapCandidates(index.document, { playheadFrame })]
  const order = new Map(index.document.tracks.map((track, position) => [track.id, position]))
  for (const lane of index.lanes) {
    if (lane.owner.track.hidden || lane.owner.track.locked) continue
    for (let offset = 0; offset < lane.frames.length; offset++) {
      const id = animationKeyKey({ lane: lane.address, frame: lane.frames[offset] })
      if (!excluded.has(id)) candidates.push({ id, kind: 'keyframe', frame: lane.globalFrames[offset], label: `${lane.label} key`, trackId: lane.owner.track.id, trackKind: lane.owner.track.kind, trackIndex: order.get(lane.owner.track.id)! })
    }
  }
  const candidateIndex = createTimelineSnapIndex(candidates), points: TimelineSnapMovingPoint[] = []
  let minDeltaFrames = -Infinity, maxDeltaFrames = Infinity
  for (const key of selection) {
    const lane = index.byId.get(animationLaneKey(key.lane))
    if (!lane) continue
    minDeltaFrames = Math.max(minDeltaFrames, -MAX_KEYFRAME_FRAME - key.frame)
    maxDeltaFrames = Math.min(maxDeltaFrames, MAX_KEYFRAME_FRAME - key.frame)
    points.push({ id: animationKeyKey(key), kind: 'cursor', frame: lane.owner.item.timelineRange.startFrame + key.frame, deltaDirection: 1, trackKind: lane.owner.track.kind, trackIndex: order.get(lane.owner.track.id)! })
  }
  return {
    candidateCount: [...candidateIndex.buckets.values()].reduce((sum, bucket) => sum + bucket.length, 0),
    resolve(rawDeltaFrames: number, zoom: number, bypass: boolean) {
      return resolveTimelineSnap({ candidates: [], candidateIndex: bypass ? undefined : candidateIndex,
        movingPoints: points.map((point) => ({ ...point, frame: point.frame + rawDeltaFrames })), rawDeltaFrames, minDeltaFrames, maxDeltaFrames, zoom })
    },
  }
}
