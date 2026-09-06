/** Atomic static track/master video edits using ordinary project descriptors. */
import type { EffectDescriptor, EffectParamValue } from './schema'
import { cloneEffectDescriptor, effectParamsValidationError, effectRegistration } from './effectStack'
import { createProjectEffectIdAllocator, replaceProjectSequence, sequenceById, type SequenceIdFactory, type SequenceProject } from './projectSequences'
import { videoBusEffectIneligibility, videoBusStageIneligibility, videoBusRenderBudgetError, videoBusStackBoundsError } from './videoBusStage'

export type VideoBusTarget = { readonly sequenceId: string; readonly kind: 'master' } | { readonly sequenceId: string; readonly kind: 'track'; readonly trackId: string }
export type VideoBusEdit =
  | { kind: 'apply'; effects: readonly EffectDescriptor[]; mode: 'append' | 'replace' }
  | { kind: 'params'; effectId: string; patch: Readonly<Record<string, EffectParamValue>> }
  | { kind: 'enabled'; effectId: string; enabled: boolean }
  | { kind: 'reorder'; effectId: string; index: number }
  | { kind: 'reset'; effectId: string }
  | { kind: 'remove'; effectId: string }
export function videoBusOwner(project: SequenceProject, target: VideoBusTarget) {
  const sequence = sequenceById(project, target.sequenceId)
  if (!sequence) return null
  if (target.kind === 'master') return { sequence, effects: sequence.masterVideoEffects ?? [], name: `${sequence.name} · Master video`, locked: false }
  const track = sequence.tracks.find((track) => track.id === target.trackId && track.kind === 'video')
  return track ? { sequence, effects: track.videoEffects ?? [], name: `${sequence.name} · ${track.name}`, locked: track.locked } : null
}
export function editVideoBus(project: SequenceProject, target: VideoBusTarget, command: VideoBusEdit, idFactory: SequenceIdFactory): { ok: true; project: SequenceProject } | { ok: false; reason: string } {
  const reject = (reason: string) => ({ ok: false as const, reason })
  const owner = videoBusOwner(project, target)
  if (!owner) return reject('The video bus no longer exists.')
  if (owner.locked) return reject('This video track is locked.')
  const effects = owner.effects.map(cloneEffectDescriptor)
  if (command.kind === 'apply') {
    const bounds = videoBusStackBoundsError(command.effects)
    if (bounds) return reject(bounds)
    for (const effect of command.effects) {
      const reason = videoBusEffectIneligibility(effect)
      if (reason) return reject(reason)
    }
    const allocate = createProjectEffectIdAllocator(project, idFactory)
    const added: EffectDescriptor[] = []
    for (const effect of command.effects) {
      const id = allocate()
      if (!id) return reject('Could not allocate a unique effect id.')
      added.push({ ...cloneEffectDescriptor(effect), id })
    }
    if (command.mode === 'replace') effects.splice(0, effects.length, ...added)
    else effects.push(...added)
  } else {
    const index = effects.findIndex((effect) => effect.id === command.effectId)
    if (index < 0) return reject('The effect no longer exists on this video bus.')
    const effect = effects[index]
    if (command.kind === 'remove') effects.splice(index, 1)
    else if (command.kind === 'reorder') {
      if (!Number.isSafeInteger(command.index) || command.index < 0 || command.index >= effects.length) return reject('Invalid effect position.')
      effects.splice(index, 1); effects.splice(command.index, 0, effect)
    } else if (command.kind === 'enabled') {
      if (typeof command.enabled !== 'boolean') return reject('Enabled must be a boolean.')
      effect.enabled = command.enabled
    } else {
      if (videoBusStageIneligibility(effect)) return reject('This preserved effect has no supported video-bus editing contract.')
      effect.params = { ...effect.params, ...(command.kind === 'reset' ? effectRegistration(effect.type)!.defaultParams : command.patch) }
      const invalid = effectParamsValidationError(effect)
      if (invalid) return reject(invalid)
    }
  }
  const error = videoBusStackBoundsError(effects)
  if (error) return reject(error)
  if (JSON.stringify(effects) === JSON.stringify(owner.effects)) return { ok: true, project }
  // Removing an unsupported/oversized stack must always remain possible.
  if (command.kind !== 'remove' && effects.some((effect) => effect.enabled && !videoBusEffectIneligibility(effect))) {
    const budget = videoBusRenderBudgetError(owner.sequence.width, owner.sequence.height)
    if (budget) return reject(budget)
  }
  const sequence = target.kind === 'master' ? { ...owner.sequence, masterVideoEffects: effects } : {
    ...owner.sequence, tracks: owner.sequence.tracks.map((track) => track.id === target.trackId ? { ...track, videoEffects: effects } : track),
  }
  const next = replaceProjectSequence(project, target.sequenceId, sequence)
  return next === project ? reject('This edit exceeds the project effect or identity budget.') : { ok: true, project: next }
}
