/** Source-bound before/after evidence for Issue #59 frame planning. */

import { resolveClipAnimationAtFrame } from '../../domain/clipAnimation'
import {
  crossfadeFrameGroupAt,
  resolveCrossfadePlan,
  type CrossfadeFrameGroup,
  type CrossfadePlan,
  type SourceBoundsCatalog,
} from '../../domain/crossfadePlan'
import type { Clip, TimelineDoc, Track, TrackId, Transition } from '../../domain/schema'
import { rangeContains } from '../../domain/time'
import {
  createVideoCompositionPlanner,
  type OrdinaryVideoPlanItem,
  type TextOverlayPlanItem,
  type VideoCompositionItem,
  type VideoCompositionPlan,
  type VideoCompositionPlanner,
} from '../../domain/videoCompositionPlan'
import {
  summarizeDistribution,
  type DistributionSummary,
  type FramePlanningIndexEvidence,
  type FramePlanningLayout,
  type FramePlanningScenarioEvidence,
} from './contract'

const DEFAULT_CLIPS_PER_TRACK = 4_096
const DEFAULT_TRACK_COUNT = 2
const DEFAULT_TRANSITIONS_PER_TRACK = 12
const DEFAULT_FRAMES_PER_SAMPLE = 256
const DEFAULT_SAMPLE_COUNT = 15
const CLIP_DURATION_FRAMES = 30
const SPARSE_PAIR_STRIDE_FRAMES = 300

interface BenchmarkScenario {
  readonly layout: FramePlanningLayout
  readonly doc: TimelineDoc
  readonly catalog: SourceBoundsCatalog
  readonly frames: readonly number[]
  readonly clipsPerTrack: number
  readonly transitionCount: number
  readonly transitionParityFrameCount: number
}

export interface FramePlanningBenchmarkOptions {
  readonly clipsPerTrack?: number
  readonly trackCount?: number
  readonly transitionsPerTrack?: number
  readonly framesPerSample?: number
  readonly sampleCount?: number
}

export interface FramePlanningBenchmarkDeps {
  readonly now: () => number
}

interface TimedPlanBatch {
  readonly millisecondsPerFrame: number
  readonly checksum: number
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return resolved
}

function clipStartFrame(layout: FramePlanningLayout, index: number): number {
  if (layout === 'dense') return index * CLIP_DURATION_FRAMES
  return Math.floor(index / 2) * SPARSE_PAIR_STRIDE_FRAMES
    + (index % 2) * CLIP_DURATION_FRAMES
}

function benchmarkClip(trackIndex: number, clipIndex: number, startFrame: number): Clip {
  const id = `planning-${trackIndex}-${clipIndex}`
  const clip: Clip = {
    id,
    assetId: `planning-asset-${trackIndex}-${clipIndex}`,
    name: id,
    sourceMode: 'still',
    sourceRange: { startFrame: 0, durationFrames: 1 },
    timelineRange: {
      startFrame,
      durationFrames: CLIP_DURATION_FRAMES,
    },
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
  if (clipIndex % 257 === 0) {
    clip.animation = {
      tracks: [{
        property: 'position-x',
        keyframes: [
          { frame: 0, value: 0, easing: { type: 'linear' } },
          { frame: CLIP_DURATION_FRAMES - 1, value: 100, easing: { type: 'linear' } },
        ],
      }],
    }
  }
  return clip
}

function transitionSeamIndexes(
  layout: FramePlanningLayout,
  clipsPerTrack: number,
  count: number,
): number[] {
  const indexes: number[] = []
  let candidate = clipsPerTrack - 2
  if (layout === 'sparse' && candidate % 2 !== 0) candidate--
  const step = layout === 'dense' ? 257 : 194
  while (candidate >= 0 && indexes.length < count) {
    if (
      clipStartFrame(layout, candidate) + CLIP_DURATION_FRAMES
      === clipStartFrame(layout, candidate + 1)
    ) indexes.push(candidate)
    candidate -= step
    if (layout === 'sparse' && candidate % 2 !== 0) candidate--
  }
  return indexes
}

function benchmarkFrames(
  layout: FramePlanningLayout,
  clipsPerTrack: number,
  count: number,
  transitionIndexes: readonly number[],
): number[] {
  const transitionFrames = transitionIndexes.flatMap((fromIndex) => {
    const cutFrame = clipStartFrame(layout, fromIndex) + CLIP_DURATION_FRAMES
    return [cutFrame - 4, cutFrame, cutFrame + 4]
  })
  const frames: number[] = []
  const tailWindow = Math.min(clipsPerTrack, 512)
  const ordinaryFrameCount = Math.max(0, count - transitionFrames.length)
  for (let index = 0; index < ordinaryFrameCount; index++) {
    const clipIndex = clipsPerTrack - 1 - ((index * 37) % tailWindow)
    const startFrame = clipStartFrame(layout, clipIndex)
    if (layout === 'sparse' && index % 4 === 3 && clipIndex % 2 === 1) {
      frames.push(startFrame + CLIP_DURATION_FRAMES + 1)
      continue
    }
    const offsets = [0, Math.floor(CLIP_DURATION_FRAMES / 2), CLIP_DURATION_FRAMES - 1]
    frames.push(startFrame + offsets[index % offsets.length])
  }
  return [...frames, ...transitionFrames].slice(0, count)
}

function createScenario(
  layout: FramePlanningLayout,
  options: Required<FramePlanningBenchmarkOptions>,
): BenchmarkScenario {
  const tracks: Track[] = []
  let transitionCount = 0
  const transitionIndexes = transitionSeamIndexes(
    layout,
    options.clipsPerTrack,
    options.transitionsPerTrack,
  )
  for (let trackIndex = 0; trackIndex < options.trackCount; trackIndex++) {
    const clips = Array.from({ length: options.clipsPerTrack }, (_, clipIndex) => (
      benchmarkClip(trackIndex, clipIndex, clipStartFrame(layout, clipIndex))
    ))
    const transitions = transitionIndexes.map<Transition>((fromIndex, transitionIndex) => ({
      id: `planning-transition-${trackIndex}-${transitionIndex}`,
      type: 'crossfade',
      fromClipId: clips[fromIndex].id,
      toClipId: clips[fromIndex + 1].id,
      durationFrames: 9,
      audio: { enabled: false, curve: 'equal-power' },
    })).reverse()
    transitionCount += transitions.length
    tracks.push({
      id: `planning-track-${trackIndex}`,
      kind: 'video',
      name: `Planning track ${trackIndex + 1}`,
      clips,
      transitions,
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    })
  }

  return {
    layout,
    doc: {
      schemaVersion: 6,
      id: `frame-planning-${layout}`,
      name: `Frame planning ${layout}`,
      frameRate: { num: 30, den: 1 },
      width: 3_840,
      height: 2_160,
      audioSampleRate: 48_000,
      tracks,
    },
    catalog: new Map(),
    frames: benchmarkFrames(
      layout,
      options.clipsPerTrack,
      options.framesPerSample,
      transitionIndexes,
    ),
    clipsPerTrack: options.clipsPerTrack,
    transitionCount,
    transitionParityFrameCount: Math.min(
      options.framesPerSample,
      transitionIndexes.length * 3,
    ),
  }
}

function clipOpacity(clip: Clip): number {
  if (!Number.isFinite(clip.opacity) || clip.opacity <= 0) return 0
  return Math.min(1, clip.opacity)
}

function legacyOrdinaryItem(
  track: Track,
  frame: number,
): OrdinaryVideoPlanItem | TextOverlayPlanItem | null {
  for (const clip of track.clips) {
    if (clip.timelineRange.startFrame > frame) break
    if (!rangeContains(clip.timelineRange, frame)) continue
    const resolvedClip = resolveClipAnimationAtFrame(clip, frame)
    const opacity = clipOpacity(resolvedClip)
    if (opacity <= 0) return null
    if (resolvedClip.text !== undefined) {
      return {
        kind: 'text',
        trackId: track.id,
        frame,
        clip: resolvedClip,
        opacity,
      }
    }
    return {
      kind: 'clip',
      trackId: track.id,
      frame,
      request: {
        clip: resolvedClip,
        sourceFrame: resolvedClip.sourceMode === 'still'
          ? 0
          : resolvedClip.sourceRange.startFrame
            + (frame - resolvedClip.timelineRange.startFrame),
        opacity,
      },
    }
  }
  return null
}

function resolveGroupAnimation(group: CrossfadeFrameGroup): CrossfadeFrameGroup {
  const resolveRequest = (
    request: CrossfadeFrameGroup['requests'][number],
  ): CrossfadeFrameGroup['requests'][number] => {
    const clip = resolveClipAnimationAtFrame(request.clip, group.frame)
    return { ...request, clip, opacity: clipOpacity(clip) }
  }
  return {
    ...group,
    requests: [
      resolveRequest(group.requests[0]),
      resolveRequest(group.requests[1]),
    ],
  }
}

/** The pre-Issue-59 implementation retained only inside benchmark evidence. */
function createLegacyLinearPlanner(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): VideoCompositionPlanner {
  const plans = new Map<TrackId, CrossfadePlan[]>()
  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    const trackPlans: CrossfadePlan[] = []
    for (const transition of track.transitions) {
      const resolution = resolveCrossfadePlan(
        doc,
        track.id,
        transition.id,
        catalog,
      )
      if (resolution.status === 'available') trackPlans.push(resolution.plan)
    }
    if (trackPlans.length > 0) plans.set(track.id, trackPlans)
  }

  return {
    planFrame(frame: number): VideoCompositionPlan {
      const items: VideoCompositionItem[] = []
      for (const track of doc.tracks) {
        if (track.kind !== 'video' || track.hidden) continue
        const active = (plans.get(track.id) ?? []).filter(
          (plan) => frame >= plan.startFrame && frame < plan.endFrame,
        )
        if (active.length === 1) {
          const rawGroup = crossfadeFrameGroupAt(active[0], frame)
          if (rawGroup) {
            items.push(resolveGroupAnimation(rawGroup))
            continue
          }
        }
        const ordinary = legacyOrdinaryItem(track, frame)
        if (ordinary) items.push(ordinary)
      }
      return { frame, items }
    },
  }
}

function planChecksum(plan: VideoCompositionPlan): number {
  let checksum = plan.frame + plan.items.length
  for (const item of plan.items) {
    if (item.kind === 'clip') checksum += item.request.sourceFrame + item.request.opacity
    else if (item.kind === 'text') checksum += item.opacity + item.clip.id.length
    else {
      checksum += item.requests[0].sourceFrame + item.requests[0].weight
        + item.requests[1].sourceFrame + item.requests[1].weight
    }
  }
  return checksum
}

function timePlanBatch(
  planner: VideoCompositionPlanner,
  frames: readonly number[],
  deps: FramePlanningBenchmarkDeps,
): TimedPlanBatch {
  const startedAt = deps.now()
  let checksum = 0
  for (const frame of frames) checksum += planChecksum(planner.planFrame(frame))
  const duration = deps.now() - startedAt
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error('Frame-planning benchmark clock moved backwards')
  }
  return {
    millisecondsPerFrame: duration / frames.length,
    checksum,
  }
}

function assertParity(
  legacy: VideoCompositionPlanner,
  indexed: VideoCompositionPlanner,
  frames: readonly number[],
): void {
  for (const frame of frames) {
    const legacyPlan = legacy.planFrame(frame)
    const indexedPlan = indexed.planFrame(frame)
    if (JSON.stringify(legacyPlan) !== JSON.stringify(indexedPlan)) {
      throw new Error(`Indexed frame planning diverged at frame ${frame}`)
    }
  }
}

function improvementPercent(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Number.NEGATIVE_INFINITY
  return (before - after) / before * 100
}

function scenarioEvidence(
  scenario: BenchmarkScenario,
  sampleCount: number,
  deps: FramePlanningBenchmarkDeps,
): FramePlanningScenarioEvidence {
  const legacy = createLegacyLinearPlanner(scenario.doc, scenario.catalog)
  const indexed = createVideoCompositionPlanner(scenario.doc, scenario.catalog)
  assertParity(legacy, indexed, scenario.frames)

  // Warm both implementations before the balanced before/after samples.
  timePlanBatch(legacy, scenario.frames, deps)
  timePlanBatch(indexed, scenario.frames, deps)

  const legacySamples: number[] = []
  const indexedSamples: number[] = []
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const first = sampleIndex % 2 === 0 ? legacy : indexed
    const second = sampleIndex % 2 === 0 ? indexed : legacy
    const firstResult = timePlanBatch(first, scenario.frames, deps)
    const secondResult = timePlanBatch(second, scenario.frames, deps)
    if (firstResult.checksum !== secondResult.checksum) {
      throw new Error(`Frame-planning checksum diverged for ${scenario.layout}`)
    }
    if (sampleIndex % 2 === 0) {
      legacySamples.push(firstResult.millisecondsPerFrame)
      indexedSamples.push(secondResult.millisecondsPerFrame)
    } else {
      indexedSamples.push(firstResult.millisecondsPerFrame)
      legacySamples.push(secondResult.millisecondsPerFrame)
    }
  }
  const legacySummary: DistributionSummary = summarizeDistribution(legacySamples)
  const indexedSummary: DistributionSummary = summarizeDistribution(indexedSamples)
  return {
    layout: scenario.layout,
    trackCount: scenario.doc.tracks.length,
    clipsPerTrack: scenario.clipsPerTrack,
    transitionCount: scenario.transitionCount,
    framesPerSample: scenario.frames.length,
    sampleCount,
    parityFrameCount: scenario.frames.length,
    transitionParityFrameCount: scenario.transitionParityFrameCount,
    legacyMillisecondsPerFrame: legacySamples,
    indexedMillisecondsPerFrame: indexedSamples,
    legacy: legacySummary,
    indexed: indexedSummary,
    p95ImprovementPercent: improvementPercent(
      legacySummary.p95,
      indexedSummary.p95,
    ),
  }
}

export function measureFramePlanningIndex(
  options: FramePlanningBenchmarkOptions = {},
  deps: FramePlanningBenchmarkDeps = { now: () => performance.now() },
): FramePlanningIndexEvidence {
  const resolved: Required<FramePlanningBenchmarkOptions> = {
    clipsPerTrack: positiveInteger(
      options.clipsPerTrack,
      DEFAULT_CLIPS_PER_TRACK,
      'clipsPerTrack',
    ),
    trackCount: positiveInteger(options.trackCount, DEFAULT_TRACK_COUNT, 'trackCount'),
    transitionsPerTrack: positiveInteger(
      options.transitionsPerTrack,
      DEFAULT_TRANSITIONS_PER_TRACK,
      'transitionsPerTrack',
    ),
    framesPerSample: positiveInteger(
      options.framesPerSample,
      DEFAULT_FRAMES_PER_SAMPLE,
      'framesPerSample',
    ),
    sampleCount: positiveInteger(options.sampleCount, DEFAULT_SAMPLE_COUNT, 'sampleCount'),
  }
  if (resolved.clipsPerTrack < 2) {
    throw new RangeError('clipsPerTrack must allow at least one transition seam')
  }

  return {
    version: 'issue-59-v1',
    lookup: 'immutable-per-track-binary-search',
    rebuildPolicy: 'planner-construction-on-document-or-source-catalog-change',
    scenarios: (['dense', 'sparse'] as const).map((layout) => scenarioEvidence(
      createScenario(layout, resolved),
      resolved.sampleCount,
      deps,
    )),
  }
}
