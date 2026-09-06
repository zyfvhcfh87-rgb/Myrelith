/** Shared immutable visual plan for one project sequence, including nesting. */
import { snapshotVideoBusStack } from './videoBusStage'

import type {
  Clip,
  MulticamAngle,
  MulticamInstance,
  SequenceInstanceId,
  TimelineDoc,
  TrackId,
} from './schema'
import type { SourceBoundsCatalog } from './crossfadePlan'
import type { SequenceProject } from './projectSequences'
import { sequenceById } from './projectSequences'
import {
  MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME,
  analyzeNestedSequenceGraph,
  sequenceInstances,
} from './nestedSequences'
import type { PluginVideoEffectContributionSnapshot } from './pluginVideoEffectStagePlan'
import {
  createVideoCompositionPlanner,
  videoCompositionRequests,
  type VideoCompositionItem,
  type VideoCompositionPlan,
  type VideoCompositionPlanner,
} from './videoCompositionPlan'
import { rangeEnd } from './time'
import { createMulticamPlanner } from './multicam'
import { defaultSourceTimeMap } from './sourceTimeMap'
import { resolveBlendMode } from './blendModes'

function activeInstanceAt(
  document: TimelineDoc,
  trackId: TrackId,
  frame: number,
) {
  const track = document.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return null
  for (const instance of sequenceInstances(track)) {
    if (
      instance.timelineRange.startFrame <= frame
      && frame < rangeEnd(instance.timelineRange)
    ) return instance
    if (instance.timelineRange.startFrame > frame) break
  }
  return null
}

function activeMulticamAt(
  document: TimelineDoc,
  trackId: TrackId,
  frame: number,
): MulticamInstance | null {
  const track = document.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return null
  for (const instance of track.multicamInstances ?? []) {
    if (
      instance.timelineRange.startFrame <= frame
      && frame < rangeEnd(instance.timelineRange)
    ) return instance
    if (instance.timelineRange.startFrame > frame) break
  }
  return null
}

function multicamClip(
  instance: MulticamInstance,
  angle: MulticamAngle,
): Clip {
  return {
    id: `multicam:${instance.id}:${angle.id}`,
    assetId: angle.assetId,
    name: `${instance.name} - ${angle.name}`,
    sourceMode: 'timed',
    sourceRange: {
      startFrame: angle.sourceStartFrame,
      durationFrames: angle.coverage.durationFrames,
    },
    sourceTimeMap: defaultSourceTimeMap(
      angle.sourceStartFrame,
      angle.coverage.durationFrames,
    ),
    timelineRange: { ...instance.timelineRange },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function nestedRequestKey(
  instancePath: readonly SequenceInstanceId[],
  clipId: string,
): string {
  return JSON.stringify([...instancePath, clipId])
}

function scopeNestedItem(
  item: VideoCompositionItem,
  instancePath: readonly SequenceInstanceId[],
): VideoCompositionItem {
  if (instancePath.length === 0) return item
  if (item.kind === 'video-bus') return Object.freeze({ ...item, instancePath })
  if ('busScope' in item && item.busScope) item = { ...item, busScope: Object.freeze({ ...item.busScope, instancePath }) }
  if (item.kind === 'clip') {
    return Object.freeze({
      ...item,
      request: Object.freeze({
        ...item.request,
        requestKey: nestedRequestKey(instancePath, item.request.clip.id),
      }),
    })
  }
  if (item.kind === 'crossfade') {
    return Object.freeze({
      ...item,
      requests: Object.freeze([
        Object.freeze({
          ...item.requests[0],
          requestKey: nestedRequestKey(instancePath, item.requests[0].clip.id),
        }),
        Object.freeze({
          ...item.requests[1],
          requestKey: nestedRequestKey(instancePath, item.requests[1].clip.id),
        }),
      ] as const),
    })
  }
  return item
}

/**
 * Resolve refs before render ownership begins. Flat background/leaf operations
 * keep adjustment, caption, transition, plugin, and proxy consumers on the
 * existing VideoCompositionPlan seam.
 */
export function createProjectVideoCompositionPlanner(
  project: SequenceProject,
  rootSequenceId: string,
  catalog: SourceBoundsCatalog,
  pluginContributions?: PluginVideoEffectContributionSnapshot,
): VideoCompositionPlanner {
  analyzeNestedSequenceGraph(project)
  const root = sequenceById(project, rootSequenceId)
  if (!root) throw new RangeError(`missing root sequence "${rootSequenceId}"`)
  const planners = new Map(project.sequences.map((sequence) => [
    sequence.id,
    createVideoCompositionPlanner(sequence, catalog, pluginContributions),
  ]))
  const multicams = new Map((project.multicams ?? []).map((definition) => [
    definition.id,
    {
      definition,
      planner: createMulticamPlanner(definition),
      angles: new Map(definition.angles.map((angle) => [angle.id, angle])),
    },
  ]))

  return Object.freeze({
    planFrame(frame: number): VideoCompositionPlan {
      if (!Number.isSafeInteger(frame) || frame < 0) {
        throw new RangeError('project video frame must be a non-negative safe integer')
      }
      const items: VideoCompositionItem[] = []
      const append = (
        sequence: TimelineDoc,
        localFrame: number,
        instancePath: readonly SequenceInstanceId[],
      ): void => {
        const planner = planners.get(sequence.id)
        if (!planner) throw new RangeError(`missing planner for sequence "${sequence.id}"`)
        const base = planner.planFrame(localFrame)
        const byTrack = new Map<TrackId, VideoCompositionItem[]>()
        const captions: VideoCompositionItem[] = []
        const masters: VideoCompositionItem[] = []
        for (const baseItem of base.items) {
          const item = scopeNestedItem(baseItem, instancePath)
          if (item.kind === 'video-bus') { masters.push(item); continue }
          if (item.kind === 'caption') {
            captions.push(item)
            continue
          }
          const values = byTrack.get(item.trackId) ?? []
          values.push(item)
          byTrack.set(item.trackId, values)
        }
        for (const track of sequence.tracks) {
          if (track.kind !== 'video' || track.hidden) continue
          const finishInstanceTrack = () => {
            if (track.videoEffects?.length) items.push(Object.freeze({ kind: 'video-bus', target: 'track', trackId: track.id, sequenceId: sequence.id, frame: localFrame, instancePath, effects: snapshotVideoBusStack(track.videoEffects) }))
          }
          const instance = activeInstanceAt(sequence, track.id, localFrame)
          const multicamInstance = activeMulticamAt(sequence, track.id, localFrame)
          if (!instance && !multicamInstance) {
            items.push(...(byTrack.get(track.id) ?? []))
            continue
          }
          if (instance) {
            const path = Object.freeze([...instancePath, instance.id])
            items.push(Object.freeze({
              kind: 'sequence-background',
              trackId: track.id,
              frame: localFrame,
              instanceId: instance.id,
              sequenceId: instance.sequenceId,
              instancePath: path,
            }))
            const child = sequenceById(project, instance.sequenceId)
            if (!child) throw new RangeError(`missing sequence "${instance.sequenceId}"`)
            append(
              child,
              instance.sourceStartFrame
                + localFrame
                - instance.timelineRange.startFrame,
              path,
            )
            finishInstanceTrack()
            continue
          }
          const resolved = multicams.get(multicamInstance!.multicamId)
          if (!resolved) {
            throw new RangeError(`missing multicam "${multicamInstance!.multicamId}"`)
          }
          items.push(Object.freeze({
            kind: 'multicam-background',
            trackId: track.id,
            frame: localFrame,
            instanceId: multicamInstance!.id,
            multicamId: multicamInstance!.multicamId,
          }))
          const definitionFrame = multicamInstance!.sourceStartFrame
            + localFrame
            - multicamInstance!.timelineRange.startFrame
          const selected = resolved.planner.select(definitionFrame)
          if (selected.video.sourceFrame === null) { finishInstanceTrack(); continue }
          const angle = resolved.angles.get(selected.video.angleId)!
          const clip = Object.freeze(multicamClip(multicamInstance!, angle))
          items.push(Object.freeze({
            kind: 'clip',
            trackId: track.id,
            frame: localFrame,
            blendMode: resolveBlendMode(undefined),
            request: Object.freeze({
              clip,
              sourceFrame: selected.video.sourceFrame,
              opacity: 1,
              requestKey: nestedRequestKey(instancePath, clip.id),
            }),
          }))
          finishInstanceTrack()
        }
        items.push(...captions, ...masters)
      }
      append(root, frame, [])
      const frozenItems = Object.freeze(items.map((item) => Object.freeze(item)))
      const plan = Object.freeze({
        frame,
        items: frozenItems,
      }) as unknown as VideoCompositionPlan
      if (
        videoCompositionRequests(plan).length
        > MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME
      ) {
        throw new RangeError(
          `nested frame exceeds ${MAX_NESTED_SEQUENCE_LEAVES_PER_FRAME} leaf requests`,
        )
      }
      return plan
    },
  })
}
