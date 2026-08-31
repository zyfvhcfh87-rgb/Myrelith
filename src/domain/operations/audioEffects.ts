import type {
  AudioEffectDescriptor,
  AudioEffectId,
  ClipId,
  EffectParamValue,
  TimelineDoc,
  TrackId,
} from '../schema'
import {
  audioEffectAppendBudgetError,
  audioEffectCollectionAppendBudgetError,
  audioEffectDescriptorBoundsError,
  audioEffectIdExists,
  audioEffectReplacementBudgetError,
  clipAudioEffects,
  masterAudioEffects,
  trackAudioEffects,
} from '../audioEffectBounds'
import {
  audioEffectParamsValidationError,
  audioEffectRegistration,
  cloneAudioEffectDescriptor,
} from '../audioEffectStack'
import { masterAudioSettings } from '../audioMixer'
import { audioEffectPreset } from '../audioEffectPresets'
import { locateClip, newId, reject, withTrack } from './operationInternals'

export type AudioEffectTarget =
  | { readonly kind: 'clip'; readonly clipId: ClipId }
  | { readonly kind: 'track'; readonly trackId: TrackId }
  | { readonly kind: 'master' }

interface LocatedAudioEffectStack {
  readonly stack: readonly AudioEffectDescriptor[]
  readonly locked: boolean
  readonly write: (next: AudioEffectDescriptor[]) => TimelineDoc
}

function locateAudioEffectStack(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  op: string,
): LocatedAudioEffectStack | null {
  if (target.kind === 'master') {
    return {
      stack: masterAudioEffects(doc.masterAudio),
      locked: false,
      write: (next) => ({
        ...doc,
        masterAudio: { ...masterAudioSettings(doc), audioEffects: next },
      }),
    }
  }
  if (target.kind === 'track') {
    const trackIndex = doc.tracks.findIndex((track) => track.id === target.trackId)
    if (trackIndex < 0) {
      reject(doc, op, `track ${target.trackId} not found`)
      return null
    }
    const track = doc.tracks[trackIndex]
    return {
      stack: trackAudioEffects(track),
      locked: track.locked,
      write: (next) => withTrack(doc, trackIndex, { ...track, audioEffects: next }),
    }
  }
  const loc = locateClip(doc, target.clipId)
  if (!loc) {
    reject(doc, op, `clip ${target.clipId} not found`)
    return null
  }
  return {
    stack: clipAudioEffects(loc.clip),
    locked: loc.track.locked,
    write: (next) => {
      const clips = loc.track.clips.slice()
      clips[loc.clipIndex] = { ...loc.clip, audioEffects: next }
      return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
    },
  }
}

function audioEffectDescriptorValidationError(
  effect: AudioEffectDescriptor,
): string | null {
  return audioEffectDescriptorBoundsError(effect)
    ?? audioEffectParamsValidationError(effect)
}

function updateAudioEffect(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  effectId: AudioEffectId,
  op: string,
  update: (
    effect: AudioEffectDescriptor,
    index: number,
    stack: readonly AudioEffectDescriptor[],
  ) => AudioEffectDescriptor[] | null,
): TimelineDoc {
  const located = locateAudioEffectStack(doc, target, op)
  if (!located) return doc
  if (located.locked) {
    return reject(doc, op, 'target track is locked')
  }
  const effectIndex = located.stack.findIndex((effect) => effect.id === effectId)
  if (effectIndex < 0) {
    return reject(doc, op, `audio effect ${effectId} not found`)
  }
  const next = update(located.stack[effectIndex], effectIndex, located.stack)
  if (!next) return doc
  return located.write(next)
}

export function addAudioEffect(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  effect: AudioEffectDescriptor,
): TimelineDoc {
  const op = 'addAudioEffect'
  const located = locateAudioEffectStack(doc, target, op)
  if (!located) return doc
  if (located.locked) return reject(doc, op, 'target track is locked')
  const validationError = audioEffectDescriptorValidationError(effect)
  if (validationError) return reject(doc, op, validationError)
  const budgetError = audioEffectAppendBudgetError(doc, located.stack, effect)
  if (budgetError) return reject(doc, op, budgetError)
  if (audioEffectIdExists(doc, effect.id)) {
    return reject(doc, op, `document already has an audio effect with id ${effect.id}`)
  }
  return located.write([...located.stack, cloneAudioEffectDescriptor(effect)])
}

export function setAudioEffectEnabled(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  effectId: AudioEffectId,
  enabled: boolean,
): TimelineDoc {
  if (typeof enabled !== 'boolean') {
    return reject(doc, 'setAudioEffectEnabled', 'enabled must be a boolean')
  }
  return updateAudioEffect(
    doc,
    target,
    effectId,
    'setAudioEffectEnabled',
    (effect, index, current) => {
      if (effect.enabled === enabled) return null
      const stack = current.slice()
      stack[index] = { ...effect, enabled, params: { ...effect.params } }
      return stack
    },
  )
}

export function updateAudioEffectParams(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  effectId: AudioEffectId,
  patch: Readonly<Record<string, EffectParamValue>>,
): TimelineDoc {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return reject(doc, 'updateAudioEffectParams', 'parameter patch must be a record')
  }
  return updateAudioEffect(
    doc,
    target,
    effectId,
    'updateAudioEffectParams',
    (effect, index, current) => {
      const next = { ...effect, params: { ...effect.params, ...patch } }
      const validationError = audioEffectDescriptorValidationError(next)
      if (validationError) {
        reject(doc, 'updateAudioEffectParams', validationError)
        return null
      }
      const budgetError = audioEffectReplacementBudgetError(doc, effect, next)
      if (budgetError) {
        reject(doc, 'updateAudioEffectParams', budgetError)
        return null
      }
      const changed = Object.entries(patch).some(([key, value]) => effect.params[key] !== value)
      if (!changed) return null
      const stack = current.slice()
      stack[index] = next
      return stack
    },
  )
}

export function reorderAudioEffect(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  effectId: AudioEffectId,
  targetIndex: number,
): TimelineDoc {
  if (!Number.isSafeInteger(targetIndex)) {
    return reject(
      doc,
      'reorderAudioEffect',
      `target index must be a safe integer, got ${targetIndex}`,
    )
  }
  return updateAudioEffect(
    doc,
    target,
    effectId,
    'reorderAudioEffect',
    (_effect, index, current) => {
      if (targetIndex < 0 || targetIndex >= current.length) {
        reject(doc, 'reorderAudioEffect', `target index ${targetIndex} is outside the audio-effect stack`)
        return null
      }
      if (targetIndex === index) return null
      const stack = current.slice()
      const [moved] = stack.splice(index, 1)
      stack.splice(targetIndex, 0, moved)
      return stack
    },
  )
}

export function resetAudioEffect(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  effectId: AudioEffectId,
): TimelineDoc {
  const op = 'resetAudioEffect'
  return updateAudioEffect(doc, target, effectId, op, (effect, index, current) => {
    const registration = audioEffectRegistration(effect.type)
    if (!registration || registration.version !== effect.version) {
      reject(doc, op, `audio effect ${effectId} has no supported reset contract`)
      return null
    }
    const params = { ...effect.params, ...registration.defaultParams }
    const candidate = { ...effect, params }
    const boundsError = audioEffectDescriptorBoundsError(candidate)
    if (boundsError) {
      reject(doc, op, boundsError)
      return null
    }
    const budgetError = audioEffectReplacementBudgetError(doc, effect, candidate)
    if (budgetError) {
      reject(doc, op, budgetError)
      return null
    }
    const changed = Object.entries(registration.defaultParams)
      .some(([key, value]) => effect.params[key] !== value)
    if (!changed) return null
    const stack = current.slice()
    stack[index] = candidate
    return stack
  })
}

export function applyAudioEffectPreset(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  presetId: string,
): TimelineDoc {
  const op = 'applyAudioEffectPreset'
  const preset = audioEffectPreset(presetId)
  if (!preset) return reject(doc, op, `unknown audio-effect preset ${presetId}`)
  const located = locateAudioEffectStack(doc, target, op)
  if (!located) return doc
  if (located.locked) return reject(doc, op, 'target track is locked')
  const next: AudioEffectDescriptor[] = preset.effects.map((effect) =>
    cloneAudioEffectDescriptor({ ...effect, id: newId('afx') }),
  )
  const emptied = located.write([])
  const budgetError = audioEffectCollectionAppendBudgetError(emptied, next)
  if (budgetError) return reject(doc, op, budgetError)
  const relocated = locateAudioEffectStack(emptied, target, op)
  if (!relocated) return doc
  return relocated.write(next)
}

export function removeAudioEffect(
  doc: TimelineDoc,
  target: AudioEffectTarget,
  effectId: AudioEffectId,
): TimelineDoc {
  return updateAudioEffect(
    doc,
    target,
    effectId,
    'removeAudioEffect',
    (_effect, index, current) => {
      const stack = current.slice()
      stack.splice(index, 1)
      return stack
    },
  )
}
