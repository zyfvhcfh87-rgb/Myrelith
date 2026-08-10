import { defaultClipAnimation } from '../domain/clipAnimation'
import { EFFECT_STACK_LIMITS } from '../domain/effectBounds'
import type { Clip, EffectDescriptor, EffectParamValue, TimelineDoc } from '../domain/schema'

export type AggregateEffectBudget = 'effects' | 'params' | 'stringCharacters'

function opaqueEffect(
  id: string,
  params: Record<string, EffectParamValue> = {},
): EffectDescriptor {
  return {
    id,
    type: 'future.opaque',
    version: 1,
    enabled: true,
    params,
  }
}

function clip(id: string, startFrame: number, effects: EffectDescriptor[]): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 40 },
    timelineRange: { startFrame, durationFrames: 40 },
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
    animation: defaultClipAnimation(),
    effects,
  }
}

function effectCountClips(): Clip[] {
  let remaining = EFFECT_STACK_LIMITS.maxTotalEffects
  const clips: Clip[] = []
  for (let clipIndex = 0; remaining > 0; clipIndex++) {
    const count = Math.min(remaining, EFFECT_STACK_LIMITS.maxEffectsPerClip)
    const effects = Array.from({ length: count }, (_unused, effectIndex) => (
      opaqueEffect(`budget-${clipIndex}-${effectIndex}`)
    ))
    clips.push(clip(`effect-budget-clip-${clipIndex}`, clipIndex * 50, effects))
    remaining -= count
  }
  return clips
}

function parameterBudgetClip(): Clip {
  let remaining = EFFECT_STACK_LIMITS.maxTotalEffectParams
  const effects: EffectDescriptor[] = []
  for (let effectIndex = 0; remaining > 0; effectIndex++) {
    const count = Math.min(remaining, EFFECT_STACK_LIMITS.maxEffectParams)
    effects.push(opaqueEffect(
      `parameter-budget-${effectIndex}`,
      Object.fromEntries(Array.from(
        { length: count },
        (_unused, parameterIndex) => [`value-${parameterIndex}`, parameterIndex],
      )),
    ))
    remaining -= count
  }
  return clip('effect-budget-clip-0', 0, effects)
}

function stringBudgetClip(): Clip {
  const shared = 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters)
  const params: Record<string, EffectParamValue> = {}
  let remaining = EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters
  for (let index = 0; remaining > 0; index++) {
    const length = Math.min(remaining, shared.length)
    params[`value-${index}`] = length === shared.length
      ? shared
      : shared.slice(0, length)
    remaining -= length
  }
  return clip('effect-budget-clip-0', 0, [opaqueEffect('string-budget', params)])
}

/** Structurally valid schema-13 project exactly at one aggregate effect cap. */
export function documentAtAggregateEffectBudget(
  budget: AggregateEffectBudget,
): TimelineDoc {
  const clips = budget === 'effects'
    ? effectCountClips()
    : [budget === 'params' ? parameterBudgetClip() : stringBudgetClip()]
  return {
    schemaVersion: 13,
    id: `doc-${budget}-budget`,
    name: `${budget} budget`,
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'track-1',
      kind: 'video',
      name: 'Video 1',
      clips,
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

export function effectBudgetInsertionClip(
  budget: AggregateEffectBudget,
  startFrame: number,
): Clip {
  return clip('effect-budget-incoming', startFrame, [opaqueEffect(
    'effect-budget-incoming-effect',
    budget === 'effects'
      ? {}
      : { value: budget === 'params' ? 1 : 'x' },
  )])
}
