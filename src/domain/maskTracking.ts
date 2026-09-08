/** Convert admitted tracking samples to one mask's ordinary project-space scalar tracks. */
import { resolveScalarAnimationProperty, scalarAnimationValueError } from './animationPropertyCatalog'
import { clipAnimation, clipAnimationKeyframeCount, clipAnimationValidationError, documentAnimationKeyframeGrowthAllowed, resolveClipAnimationAtFrame } from './clipAnimation'
import { clipVisualSettings } from './clipInspector'
import { effectDescriptorBoundsError } from './effectBounds'
import { effectParamsValidationError, MASK_EFFECT_TYPE, MASK_EFFECT_VERSION, MASK_LIMITS, maskParams } from './effectStack'
import { createMaskSourceProjectMapper } from './maskGeometry'
import { maskPathAnimationStatus } from './maskPathEditing'
import { DEFAULT_MOTION_ANALYSIS_BUDGET } from './motionAnalysis'
import { MAX_MOTION_TRACKING_SAMPLES, motionTrackingAvailabilityReason, type MotionTrackingAnalysis, type MotionTrackingAnalysisFailure, type MotionTrackingDirection, type MotionTrackingKind, type MotionTrackingSource } from './motionTracking'
import { keyframesValidationError } from './scalarAnimation'
import type { Clip, ClipAnimation, EffectAnimationTrack, TimelineDoc } from './schema'
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from './sourceTimeMap'
import { rangeEnd } from './time'

export const MASK_TRACKING_POSITION_PARAMETERS = ['x', 'y'] as const
export const MASK_TRACKING_BOX_PARAMETERS = ['x', 'y', 'width', 'height'] as const
export type MaskTrackingParameter = typeof MASK_TRACKING_BOX_PARAMETERS[number]

export interface MaskTrackingTarget {
  readonly kind: 'mask-effect'
  readonly clipId: string
  readonly effectId: string
}

export interface MaskTrackingRequest {
  readonly sourceClipId: string
  readonly source: MotionTrackingSource
  /** The app must first admit the cache/decode dimensions and exact requested schedule. */
  readonly analysis: MotionTrackingAnalysis
  readonly selectionGlobalFrame: number
  readonly target: MaskTrackingTarget
  readonly includeSize: boolean
}

export interface MaskTrackingPlan {
  readonly sequenceId: string
  readonly sourceClipId: string
  readonly target: MaskTrackingTarget
  readonly targetSnapshot: string
  readonly selectionGlobalFrame: number
  readonly firstAcceptedGlobalFrame: number
  readonly lastAcceptedGlobalFrame: number
  readonly kind: MotionTrackingKind
  readonly includeSize: boolean
  readonly direction: MotionTrackingDirection
  readonly sampleCount: number
  readonly confidenceMinimum: number
  readonly confidenceMean: number
  readonly stopped: MotionTrackingAnalysisFailure | null
  readonly tracks: readonly EffectAnimationTrack[]
  readonly replacementRequired: boolean
  /** Explicit replacement consent binds the exact candidate and complete owned lanes. */
  readonly reviewKey: string
}

export type MaskTrackingPlanResult =
  | { readonly ok: true; readonly plan: MaskTrackingPlan }
  | { readonly ok: false; readonly reason: string }

export function maskTrackingParameters(includeSize: boolean): readonly MaskTrackingParameter[] {
  return includeSize ? MASK_TRACKING_BOX_PARAMETERS : MASK_TRACKING_POSITION_PARAMETERS
}

export function maskTrackingOwnedTracks(animation: ClipAnimation, target: MaskTrackingTarget, includeSize: boolean): readonly EffectAnimationTrack[] {
  const owned: readonly string[] = maskTrackingParameters(includeSize)
  return (animation.effectTracks ?? []).filter((track) => track.effectId === target.effectId && owned.includes(track.parameter))
}

export function maskTrackingReviewKey(plan: Pick<MaskTrackingPlan, 'sequenceId' | 'target' | 'includeSize' | 'tracks'>, animation: ClipAnimation): string {
  return JSON.stringify({ sequenceId: plan.sequenceId, target: plan.target, parameters: maskTrackingParameters(plan.includeSize), tracks: plan.tracks, existing: maskTrackingOwnedTracks(animation, plan.target, plan.includeSize) })
}

/** Shared admission is repeated by Apply, independently of whether a plan was previewed. */
export function maskTrackingAnimation(doc: TimelineDoc, clip: Clip, plan: MaskTrackingPlan): ClipAnimation {
  if (plan.sequenceId !== doc.id || plan.target.clipId !== clip.id || plan.targetSnapshot !== JSON.stringify(clip)) throw new Error('The mask target changed; review a fresh attachment.')
  if (!['point', 'box'].includes(plan.kind) || (plan.kind === 'point' && plan.includeSize)) throw new Error('The mask attachment kind is invalid.')
  const expected = maskTrackingParameters(plan.includeSize)
  if (plan.tracks.length !== expected.length || expected.some((parameter) => plan.tracks.filter((track) => track.effectId === plan.target.effectId && track.parameter === parameter && track.parameterIdentity === undefined).length !== 1)) throw new Error('The mask attachment has an invalid scalar track set.')
  if (!Number.isSafeInteger(plan.sampleCount) || plan.sampleCount < 2 || plan.sampleCount > MAX_MOTION_TRACKING_SAMPLES) throw new Error('The mask attachment has an invalid accepted sample count.')
  if (!Number.isSafeInteger(plan.firstAcceptedGlobalFrame) || !Number.isSafeInteger(plan.lastAcceptedGlobalFrame)
    || plan.firstAcceptedGlobalFrame < clip.timelineRange.startFrame || plan.lastAcceptedGlobalFrame >= rangeEnd(clip.timelineRange)
    || plan.firstAcceptedGlobalFrame >= plan.lastAcceptedGlobalFrame || !Number.isSafeInteger(plan.selectionGlobalFrame)
    || (plan.direction === 'forward' ? plan.selectionGlobalFrame !== plan.firstAcceptedGlobalFrame : plan.direction === 'backward' ? plan.selectionGlobalFrame !== plan.lastAcceptedGlobalFrame : true)) throw new Error('The mask attachment does not cover its exact accepted range and directional reference.')
  const targetMap = clipSourceTimeMap(clip)
  const firstTrack = plan.tracks[0]!
  for (const track of plan.tracks) {
    const limit = MASK_LIMITS[track.parameter as MaskTrackingParameter]
    const error = keyframesValidationError(track.keyframes, (value) => !Number.isFinite(value) || value < limit.min || value > limit.max ? 'A mask tracking value exceeds its bounds.' : null)
    if (error) throw new Error(error)
    if (track.keyframes.length !== plan.sampleCount || track.keyframes[0]!.frame + clip.timelineRange.startFrame !== plan.firstAcceptedGlobalFrame
      || track.keyframes.at(-1)!.frame + clip.timelineRange.startFrame !== plan.lastAcceptedGlobalFrame
      || track.keyframes.some((key, index) => key.frame !== firstTrack.keyframes[index]?.frame || key.sourceTimeTicks !== sourceTicksAtTimelineOffset(targetMap, key.frame) || key.easing.type !== 'linear')) throw new Error('Mask attachment keys must retain every accepted frame with exact target source time and linear easing.')
  }
  const current = clipAnimation(clip)
  const owned = new Set(maskTrackingOwnedTracks(current, plan.target, plan.includeSize))
  const animation: ClipAnimation = { ...current, effectTracks: [
    ...(current.effectTracks ?? []).filter((track) => !owned.has(track)),
    ...plan.tracks.map((track) => ({ effectId: track.effectId, parameter: track.parameter, keyframes: track.keyframes.map((key) => ({ ...key, easing: { type: 'linear' as const } })) })),
  ] }
  const error = clipAnimationValidationError(animation)
  if (error) throw new Error(error)
  const growth = Math.max(0, clipAnimationKeyframeCount(animation) - clipAnimationKeyframeCount(current))
  if (!documentAnimationKeyframeGrowthAllowed(doc, growth)) throw new Error('Mask tracking would exceed the document keyframe budget.')
  return animation
}

/** Also used by the independent operation; unsupported competing intent is never replaced. */
export function maskTrackingTarget(doc: TimelineDoc, target: MaskTrackingTarget, globalFrame: number) {
  if (target.kind !== 'mask-effect') throw new Error('Choose a mask-effect attachment.')
  const track = doc.tracks.find((item) => item.clips.some((clip) => clip.id === target.clipId))
  const clip = track?.clips.find((item) => item.id === target.clipId)
  if (!clip || !track || track.kind !== 'video' || clip.text !== undefined) throw new Error('Choose a media clip on a video track for the mask attachment.')
  if (track.locked || track.hidden) throw new Error('Show and unlock the target video track before attaching tracking.')
  if (!Number.isSafeInteger(globalFrame) || globalFrame < clip.timelineRange.startFrame || globalFrame >= rangeEnd(clip.timelineRange)) throw new Error('The target must cover the exact selection frame.')
  const animation = clipAnimation(clip)
  const animationError = clipAnimationValidationError(animation)
  if (animationError) throw new Error(animationError)
  const effects = clip.effects.filter((effect) => effect.id === target.effectId)
  const effect = effects[0]
  if (effects.length !== 1 || !effect || effect.type !== MASK_EFFECT_TYPE || effect.version !== MASK_EFFECT_VERSION || !effect.enabled) throw new Error('Choose an enabled, supported mask effect.')
  const error = effectDescriptorBoundsError(effect) ?? effectParamsValidationError(effect)
  if (error) throw new Error(error)
  // Validate the complete executable mask geometry, including retained size lanes.
  // Unrelated effect, title and future clip tracks remain opaque and untouched.
  for (const track of animation.effectTracks ?? []) {
    if (track.effectId !== effect.id) continue
    if (!Object.hasOwn(MASK_LIMITS, track.parameter)) continue
    const property = resolveScalarAnimationProperty({ kind: 'effect', effect, parameter: track.parameter, identity: track.parameterIdentity })
    if (property.status !== 'available') throw new Error(property.reason)
    const keyError = keyframesValidationError(track.keyframes, (value) => scalarAnimationValueError(property.spec, value))
    if (keyError) throw new Error(keyError)
  }
  for (const track of animation.effectPathTracks ?? []) {
    if (track.effectId === effect.id && Object.hasOwn(MASK_LIMITS, track.parameter)) throw new Error('Preserved path intent already owns a mask scalar parameter.')
  }
  if (effect.params.shape === 'bezier') {
    const pathError = maskPathAnimationStatus(clip, effect).reason
    if (pathError) throw new Error(pathError)
  }
  const resolved = resolveClipAnimationAtFrame(clip, globalFrame).effects.find((item) => item.id === effect.id)!
  const resolvedError = effectParamsValidationError(resolved)
  if (resolvedError) throw new Error(resolvedError)
  return { clip, effect, params: maskParams(resolved) }
}

interface ProjectObservation {
  readonly globalFrame: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Preserve analysis order through every rejection; only valid output keys are sorted. */
function projectObservations(doc: TimelineDoc, sourceClip: Clip, request: MaskTrackingRequest): readonly ProjectObservation[] {
  const { analysis, source, selectionGlobalFrame } = request
  if (analysis.version !== 1 || !['point', 'box'].includes(analysis.kind) || !['forward', 'backward'].includes(analysis.direction)) throw new Error('Tracking analysis has an unsupported version or kind.')
  if (analysis.samples.length < 2 || analysis.samples.length > MAX_MOTION_TRACKING_SAMPLES) throw new Error('Mask attachment requires 2 to 1,024 accepted samples.')
  if (analysis.kind === 'point' && request.includeSize) throw new Error('Point tracking can attach mask position only.')
  if (!Number.isSafeInteger(analysis.width) || !Number.isSafeInteger(analysis.height) || analysis.width < 1 || analysis.height < 1 || analysis.width > DEFAULT_MOTION_ANALYSIS_BUDGET.maxWidth || analysis.height > DEFAULT_MOTION_ANALYSIS_BUDGET.maxHeight) throw new Error('Tracking analysis dimensions exceed the admitted decode bounds.')
  const referenceLocalFrame = selectionGlobalFrame - sourceClip.timelineRange.startFrame
  if (analysis.selectionLocalFrame !== referenceLocalFrame || analysis.samples[0]?.localFrame !== referenceLocalFrame) throw new Error('Tracking needs the exact selection-frame sample as its directional reference.')
  const observations: ProjectObservation[] = []
  let previous: typeof analysis.samples[number] | undefined
  const sourceTimeMap = clipSourceTimeMap(sourceClip)
  for (const sample of analysis.samples) {
    const globalFrame = sourceClip.timelineRange.startFrame + sample.localFrame
    if (!Number.isSafeInteger(sample.localFrame) || sample.localFrame < 0 || sample.localFrame >= sourceClip.timelineRange.durationFrames || !Number.isSafeInteger(globalFrame)
      || !Number.isSafeInteger(sample.timestampUs) || !Number.isSafeInteger(sample.sourceTimeTicks) || sample.sourceTimeTicks !== sourceTicksAtTimelineOffset(sourceTimeMap, sample.localFrame)
      || !Number.isFinite(sample.confidence) || sample.confidence < 0 || sample.confidence > 1) throw new Error('Tracking sample timing or confidence is invalid.')
    if (previous && (analysis.direction === 'forward' ? sample.localFrame <= previous.localFrame || sample.timestampUs < previous.timestampUs : sample.localFrame >= previous.localFrame || sample.timestampUs > previous.timestampUs)) throw new Error('Tracking samples must preserve their original analysis direction.')
    previous = sample
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || sample.x < 0 || sample.x >= analysis.width || sample.y < 0 || sample.y >= analysis.height) throw new Error(`Tracking sample at frame ${globalFrame} is outside the decoded source.`)
    const resolved = resolveClipAnimationAtFrame(sourceClip, globalFrame)
    const mapping = createMaskSourceProjectMapper({ project: doc, source, transform: resolved.transform, visual: clipVisualSettings(resolved), lensCorrection: sourceClip.lensCorrection ?? null })
    if (!mapping.ok) throw new Error(`Source geometry at frame ${globalFrame}: ${mapping.reason}`)
    const point = { x: sample.x / analysis.width, y: sample.y / analysis.height }
    let width = 0, height = 0
    let center = point
    if (analysis.kind === 'box') {
      const box = sample as Extract<MotionTrackingAnalysis, { kind: 'box' }>['samples'][number]
      if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0 || box.x + box.width > analysis.width || box.y + box.height > analysis.height) throw new Error(`Tracking box at frame ${globalFrame} is outside the decoded source.`)
      const right = (box.x + box.width) / analysis.width, bottom = (box.y + box.height) / analysis.height
      const corners = [point, { x: right, y: point.y }, { x: right, y: bottom }, { x: point.x, y: bottom }]
      if (corners.some((corner) => !mapping.mapper.sourcePointVisible(corner))) throw new Error(`Tracking box at frame ${globalFrame} is not wholly inside the resolved source crop. The complete attachment is unavailable.`)
      const projected = corners.map((corner) => mapping.mapper.sourceToProject(corner))
      width = Math.max(...projected.map((corner) => corner.x)) - Math.min(...projected.map((corner) => corner.x))
      height = Math.max(...projected.map((corner) => corner.y)) - Math.min(...projected.map((corner) => corner.y))
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error(`Tracking box at frame ${globalFrame} has unsafe project extents.`)
      center = { x: (point.x + right) / 2, y: (point.y + bottom) / 2 }
    } else if (!mapping.mapper.sourcePointVisible(point)) throw new Error(`Tracking point at frame ${globalFrame} is outside the resolved source crop. The complete attachment is unavailable.`)
    const projectedCenter = mapping.mapper.sourceToProject(center)
    observations.push({ globalFrame, ...projectedCenter, width, height })
  }
  return observations
}

export function createMaskTrackingPlan(doc: TimelineDoc, request: MaskTrackingRequest): MaskTrackingPlanResult {
  try {
    const sourceTrack = doc.tracks.find((track) => track.clips.some((clip) => clip.id === request.sourceClipId))
    const sourceClip = sourceTrack?.clips.find((clip) => clip.id === request.sourceClipId)
    if (!sourceClip || !sourceTrack || sourceTrack.kind !== 'video' || sourceTrack.locked || sourceTrack.hidden) throw new Error('Show and unlock the tracked source video clip.')
    const sourceError = motionTrackingAvailabilityReason(doc, sourceClip, request.source, request.selectionGlobalFrame)
    if (sourceError) throw new Error(sourceError)
    const geometryProperties = new Set(['position-x', 'position-y', 'scale-x', 'scale-y', 'rotation', 'crop-left', 'crop-right', 'crop-top', 'crop-bottom'])
    for (const track of clipAnimation(sourceClip).tracks) {
      if (!geometryProperties.has(track.property)) continue
      const property = resolveScalarAnimationProperty({ kind: 'clip', clip: sourceClip, trackKind: 'video', property: track.property, propertyVersion: track.propertyVersion })
      if (property.status !== 'available') throw new Error('Preserved source geometry animation cannot be resolved for tracking.')
    }
    const owner = maskTrackingTarget(doc, request.target, request.selectionGlobalFrame)
    const observations = projectObservations(doc, sourceClip, request)
    const firstAcceptedGlobalFrame = Math.min(...observations.map((sample) => sample.globalFrame))
    const lastAcceptedGlobalFrame = Math.max(...observations.map((sample) => sample.globalFrame))
    if (firstAcceptedGlobalFrame < owner.clip.timelineRange.startFrame || lastAcceptedGlobalFrame >= rangeEnd(owner.clip.timelineRange)) throw new Error('The target must cover the complete accepted tracking range and exact selection frame.')
    const reference = observations[0]!
    const base = { x: owner.params.x * doc.width, y: owner.params.y * doc.height, width: owner.params.width * doc.width, height: owner.params.height * doc.height }
    const targetTimeMap = clipSourceTimeMap(owner.clip)
    const tracks: EffectAnimationTrack[] = maskTrackingParameters(request.includeSize).map((parameter) => ({ effectId: request.target.effectId, parameter, keyframes: [] }))
    for (const observation of observations) {
      const sx = request.includeSize ? observation.width / reference.width : 1
      const sy = request.includeSize ? observation.height / reference.height : 1
      const values = observation === reference ? owner.params : {
        x: (observation.x + (base.x - reference.x) * sx) / doc.width,
        y: (observation.y + (base.y - reference.y) * sy) / doc.height,
        width: base.width * sx / doc.width,
        height: base.height * sy / doc.height,
      }
      const frame = observation.globalFrame - owner.clip.timelineRange.startFrame
      const sourceTimeTicks = sourceTicksAtTimelineOffset(targetTimeMap, frame)
      for (const track of tracks) {
        const parameter = track.parameter as MaskTrackingParameter
        const value = values[parameter], limit = MASK_LIMITS[parameter]
        if (!Number.isFinite(value) || value < limit.min || value > limit.max) throw new Error(`Mask ${parameter} at frame ${observation.globalFrame} exceeds its bounds. The complete attachment is unavailable.`)
        track.keyframes.push({ frame, sourceTimeTicks, value, easing: { type: 'linear' } })
      }
    }
    for (const track of tracks) track.keyframes.sort((left, right) => left.frame - right.frame)
    const animation = clipAnimation(owner.clip)
    const partial = { sequenceId: doc.id, target: request.target, includeSize: request.includeSize, tracks }
    const plan: MaskTrackingPlan = {
      ...partial, sourceClipId: request.sourceClipId, targetSnapshot: JSON.stringify(owner.clip),
      selectionGlobalFrame: request.selectionGlobalFrame, firstAcceptedGlobalFrame, lastAcceptedGlobalFrame,
      kind: request.analysis.kind, direction: request.analysis.direction, sampleCount: observations.length,
      confidenceMinimum: Math.min(...request.analysis.samples.map((sample) => sample.confidence)),
      confidenceMean: request.analysis.samples.reduce((sum, sample) => sum + sample.confidence, 0) / observations.length,
      stopped: request.analysis.failure,
      replacementRequired: maskTrackingOwnedTracks(animation, request.target, request.includeSize).length > 0,
      reviewKey: maskTrackingReviewKey(partial, animation),
    }
    maskTrackingAnimation(doc, owner.clip, plan)
    return { ok: true, plan }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'This mask tracking attachment is unavailable.' }
  }
}
