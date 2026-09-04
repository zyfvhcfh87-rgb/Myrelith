/**
 * State-layer projection for multicam UI.
 *
 * The domain planner is compiled once per immutable definition reference, so
 * playhead renders remain logarithmic and React never reaches through the
 * state boundary to execute domain policy directly.
 */

import { createMulticamPlanner } from '../domain/multicam'
import type {
  FrameRate,
  MulticamAngleId,
  MulticamDefinition,
  MulticamInstance,
} from '../domain/schema'
import { microsecondsDurationToFrames, rangeContains } from '../domain/time'
import type { SequenceProject } from '../domain/projectSequences'

export interface MulticamPlayheadPresentation {
  readonly inside: boolean
  readonly definitionFrame: number
  readonly selectedAngleId: MulticamAngleId
  readonly switchFrame: number
  readonly switchComparisons: number
}

export interface MulticamInstancePresentation {
  atPlayhead(playheadFrame: number): MulticamPlayheadPresentation
}

export function createMulticamInstancePresentation(
  definition: MulticamDefinition,
  instance: MulticamInstance,
): MulticamInstancePresentation {
  const planner = createMulticamPlanner(definition)
  return Object.freeze({
    atPlayhead(playheadFrame: number): MulticamPlayheadPresentation {
      const definitionFrame = Math.min(
        definition.durationFrames - 1,
        Math.max(
          0,
          instance.sourceStartFrame
            + playheadFrame
            - instance.timelineRange.startFrame,
        ),
      )
      const selected = planner.select(definitionFrame)
      return Object.freeze({
        inside: rangeContains(instance.timelineRange, playheadFrame),
        definitionFrame,
        selectedAngleId: selected.video.angleId,
        switchFrame: selected.switchFrame,
        switchComparisons: selected.switchComparisons,
      })
    },
  })
}

export function multicamAssetDurationFrames(
  durationMicroseconds: number,
  frameRate: FrameRate,
): number {
  return microsecondsDurationToFrames(durationMicroseconds, frameRate)
}

export function multicamInstanceVisibleRange(
  instance: MulticamInstance,
  timelineOriginFrame: number,
  timelineWindowEndFrame: number,
): { readonly startFrame: number; readonly endFrame: number } | null {
  const startFrame = Math.max(instance.timelineRange.startFrame, timelineOriginFrame)
  const endFrame = Math.min(
    instance.timelineRange.startFrame + instance.timelineRange.durationFrames,
    timelineWindowEndFrame,
  )
  return startFrame < endFrame
    ? Object.freeze({ startFrame, endFrame })
    : null
}

/** A shared definition is protected when any rendered reference is locked. */
export function multicamDefinitionIsLocked(
  project: SequenceProject,
  definitionId: MulticamDefinition['id'],
): boolean {
  return project.sequences.some((sequence) => sequence.tracks.some((track) => (
    track.locked
    && (track.multicamInstances ?? []).some((instance) => (
      instance.multicamId === definitionId
    ))
  )))
}
