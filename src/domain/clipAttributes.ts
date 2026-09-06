/** Resource-free attribute snapshots and atomic project-wide batch edits. */
import type {
  Clip, ClipAnimation, ClipAnimationProperty, ClipAudioSettings,
  ClipVisualSettings, EffectDescriptor, TimelineDoc, TrackKind, Transform,
} from './schema'
import {
  clipAnimation, clipAnimationKindError, clipAnimationValidationError,
  cloneClipAnimation, effectAnimationTracks,
} from './clipAnimation'
import {
  clipAudioSettings, clipVisualSettings, defaultClipAudioSettings,
  defaultClipVisualSettings, defaultClipTransform,
} from './clipInspector'
import { blendModeIntentValidationError } from './blendModes'
import { EFFECT_STACK_LIMITS, effectDescriptorBoundsError } from './effectBounds'
import { cloneEffectDescriptor, effectRegistration } from './effectStack'
import {
  clipSourceTimeMap, sourceTicksAtTimelineOffset, sourceTimeMapHasInvalidSpeedCurve,
} from './sourceTimeMap'
import {
  createProjectEffectIdAllocator, replaceProjectSequence, sequenceById,
  type SequenceIdFactory, type SequenceProject,
} from './projectSequences'
import {
  validateClipAudio, validateClipVisual, validateTransform,
} from './projectFile/clipValidation'

export const CLIP_ATTRIBUTE_LABELS = {
  transform: 'Transform',
  'crop-and-flip': 'Crop and flips',
  opacity: 'Opacity',
  blend: 'Blend mode',
  'audio-settings': 'Audio settings',
  effects: 'Video effects',
} as const
export type ClipAttributeGroup = keyof typeof CLIP_ATTRIBUTE_LABELS
export type StackPasteMode = 'append' | 'replace'

type AttributeValue =
  | { kind: 'transform'; value: Transform }
  | { kind: 'crop-and-flip'; value: ClipVisualSettings }
  | { kind: 'opacity'; value: number }
  | { kind: 'blend'; value: string }
  | { kind: 'audio-settings'; value: { volume: number; audio: ClipAudioSettings } }
  | { kind: 'effects'; value: EffectDescriptor[] }

export interface ClipAttributeTemplate {
  readonly version: 1
  readonly attributes: readonly AttributeValue[]
  readonly animation: ClipAnimation
}
export interface AttributePasteOptions {
  readonly groups: readonly ClipAttributeGroup[]
  readonly includeAnimation: boolean
  readonly effectsMode: StackPasteMode
}
export type ClipAttributeCommand =
  | { readonly kind: 'paste'; readonly targetIds: readonly string[]; readonly template: ClipAttributeTemplate; readonly options: AttributePasteOptions }
  | { readonly kind: 'reset'; readonly targetIds: readonly string[]; readonly groups: readonly ClipAttributeGroup[]; readonly selectedEffectIds?: readonly string[] }
export type AttributeTemplateResult =
  | { readonly ok: true; readonly template: ClipAttributeTemplate }
  | { readonly ok: false; readonly reason: string }
export type AttributeEditResult =
  | { readonly ok: true; readonly project: SequenceProject }
  | { readonly ok: false; readonly reason: string }

const PROPERTY_GROUP: Readonly<Record<ClipAnimationProperty, ClipAttributeGroup>> = {
  'position-x': 'transform', 'position-y': 'transform',
  'scale-x': 'transform', 'scale-y': 'transform', rotation: 'transform',
  opacity: 'opacity', volume: 'audio-settings', balance: 'audio-settings',
}

export function supportedClipAttributeGroups(kind: TrackKind): readonly ClipAttributeGroup[] {
  return kind === 'video'
    ? ['transform', 'crop-and-flip', 'opacity', 'blend', 'effects']
    : ['audio-settings']
}

function validateTemplate(template: ClipAttributeTemplate): void {
  if (template.version !== 1 || template.attributes.length > 6) {
    throw new Error('Unsupported attribute template.')
  }
  const kinds = new Set<string>()
  for (const attribute of template.attributes) {
    if (kinds.has(attribute.kind)) throw new Error('Duplicate attribute group.')
    kinds.add(attribute.kind)
    switch (attribute.kind) {
      case 'transform': validateTransform(attribute.value, 'transform'); break
      case 'crop-and-flip': validateClipVisual(attribute.value, 'visual'); break
      case 'opacity':
        if (!Number.isFinite(attribute.value) || attribute.value < 0 || attribute.value > 1) {
          throw new Error('Opacity must be between 0 and 1.')
        }
        break
      case 'blend': {
        const error = blendModeIntentValidationError(attribute.value)
        if (error) throw new Error(error)
        break
      }
      case 'audio-settings':
        validateClipAudio(attribute.value.audio, 'audio', Number.MAX_SAFE_INTEGER)
        if (!Number.isFinite(attribute.value.volume) || attribute.value.volume < 0 || attribute.value.volume > 2) {
          throw new Error('Volume must be between 0 and 2.')
        }
        break
      case 'effects': {
        if (attribute.value.length > EFFECT_STACK_LIMITS.maxEffectsPerClip) {
          throw new Error('The effect stack exceeds the per-clip limit.')
        }
        const ids = new Set<string>()
        for (const effect of attribute.value) {
          const error = effectDescriptorBoundsError(effect)
          if (error) throw new Error(error)
          if (ids.has(effect.id)) throw new Error('Duplicate effect identity.')
          ids.add(effect.id)
        }
        break
      }
      default: throw new Error('Unknown attribute group.')
    }
  }
  const error = clipAnimationValidationError(template.animation)
  if (error) throw new Error(error)
  if (template.animation.tracks.some((track) => !kinds.has(PROPERTY_GROUP[track.property]))
    || (effectAnimationTracks(template.animation).length > 0 && !kinds.has('effects'))) {
    throw new Error('Animation does not belong to a copied attribute group.')
  }
}

export function captureClipAttributes(
  clip: Clip,
  kind: TrackKind,
  groups: readonly ClipAttributeGroup[] = supportedClipAttributeGroups(kind),
  selectedEffectIds?: readonly string[],
): AttributeTemplateResult {
  try {
    if (groups.length === 0 || new Set(groups).size !== groups.length
      || groups.some((group) => !supportedClipAttributeGroups(kind).includes(group))) {
      throw new Error('Choose supported attributes from one source clip.')
    }
    const selected = selectedEffectIds === undefined ? null : new Set(selectedEffectIds)
    if (selected && (selected.size !== selectedEffectIds!.length
      || [...selected].some((id) => !clip.effects.some((effect) => effect.id === id)))) {
      throw new Error('A selected effect no longer exists.')
    }
    const attributes = groups.map<AttributeValue>((group) => {
      switch (group) {
        case 'transform': return { kind: group, value: { ...clip.transform } }
        case 'crop-and-flip': {
          const visual = clipVisualSettings(clip)
          return { kind: group, value: { ...visual, crop: { ...visual.crop } } }
        }
        case 'opacity': return { kind: group, value: clip.opacity }
        case 'blend': return { kind: group, value: clip.blendMode ?? 'normal' }
        case 'audio-settings': return { kind: group, value: { volume: clip.volume, audio: { ...clipAudioSettings(clip) } } }
        case 'effects': return {
          kind: group,
          value: clip.effects.filter((effect) => !selected || selected.has(effect.id)).map(cloneEffectDescriptor),
        }
      }
    })
    const animation = cloneClipAnimation(clipAnimation(clip))
    animation.tracks = animation.tracks.filter((track) => groups.includes(PROPERTY_GROUP[track.property]))
    animation.effectTracks = effectAnimationTracks(animation).filter((track) => (
      groups.includes('effects') && (!selected || selected.has(track.effectId))
    ))
    const template: ClipAttributeTemplate = { version: 1, attributes, animation }
    validateTemplate(template)
    return { ok: true, template }
  } catch (cause) {
    return { ok: false, reason: errorMessage(cause) }
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The attribute edit could not be validated.'
}

function editTargets(
  project: SequenceProject,
  sequenceId: string,
  targetIds: readonly string[],
  groups: readonly ClipAttributeGroup[],
  edit: (clip: Clip) => Clip,
): AttributeEditResult {
  try {
    const doc = sequenceById(project, sequenceId)
    if (!doc) throw new Error('The destination sequence no longer exists.')
    if (!groups.length || new Set(groups).size !== groups.length
      || groups.some((group) => !Object.hasOwn(CLIP_ATTRIBUTE_LABELS, group))) {
      throw new Error('Choose at least one supported attribute group.')
    }
    if (!targetIds.length || new Set(targetIds).size !== targetIds.length) {
      throw new Error('Choose distinct destination clips.')
    }
    const ids = new Set(targetIds)
    let found = 0
    let changed = false
    const tracks = doc.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (!ids.has(clip.id)) return clip
        found++
        if (track.locked) throw new Error(`Track "${track.name}" is locked.`)
        if (groups.some((group) => !supportedClipAttributeGroups(track.kind).includes(group))) {
          throw new Error(`"${clip.name}" cannot receive all selected attribute groups.`)
        }
        const next = edit(clip)
        const animation = clipAnimation(next)
        const error = clipAnimationValidationError(animation)
          ?? clipAnimationKindError(track.kind, clip.text !== undefined, animation)
        if (error) throw new Error(error)
        if (next.effects.length > EFFECT_STACK_LIMITS.maxEffectsPerClip) {
          throw new Error(`"${clip.name}" would exceed the per-clip effect limit.`)
        }
        // A no-op must retain the original project and populated redo branch.
        if (JSON.stringify(next) === JSON.stringify(clip)) return clip
        changed = true
        return next
      }),
    }))
    if (found !== ids.size) throw new Error('A destination clip no longer exists.')
    if (!changed) return { ok: true, project }
    const nextDoc: TimelineDoc = { ...doc, tracks }
    const candidate = replaceProjectSequence(project, sequenceId, nextDoc)
    if (candidate === project) throw new Error('The edit exceeds project effect, animation or identity limits.')
    return { ok: true, project: candidate }
  } catch (cause) {
    return { ok: false, reason: errorMessage(cause) }
  }
}

export function pasteClipAttributes(
  project: SequenceProject,
  sequenceId: string,
  targetIds: readonly string[],
  template: ClipAttributeTemplate,
  options: AttributePasteOptions,
  factory: SequenceIdFactory,
): AttributeEditResult {
  try {
    validateTemplate(template)
    if (typeof options.includeAnimation !== 'boolean'
      || !['append', 'replace'].includes(options.effectsMode)
      || options.groups.some((group) => !template.attributes.some((attribute) => attribute.kind === group))) {
      throw new Error('The paste options do not match the copied attributes.')
    }
    const sourceEffects = template.attributes.find((attribute) => attribute.kind === 'effects')?.value ?? []
    const allocate = createProjectEffectIdAllocator(project, factory, [
      ...sourceEffects.map((effect) => effect.id),
      ...effectAnimationTracks(template.animation).map((track) => track.effectId),
    ])
    return editTargets(project, sequenceId, targetIds, options.groups, (clip) => {
      const next: Clip = { ...clip }
      const animation = cloneClipAnimation(clipAnimation(clip))
      const ids = new Map<string, string>()
      const remap = (id: string): string => {
        const existing = ids.get(id)
        if (existing) return existing
        const fresh = allocate()
        if (!fresh) throw new Error('Unable to generate fresh effect identities.')
        ids.set(id, fresh)
        return fresh
      }
      for (const attribute of template.attributes) {
        if (!options.groups.includes(attribute.kind)) continue
        switch (attribute.kind) {
          case 'transform': next.transform = { ...attribute.value }; break
          case 'crop-and-flip': next.visual = { ...attribute.value, crop: { ...attribute.value.crop } }; break
          case 'opacity': next.opacity = attribute.value; break
          case 'blend': next.blendMode = attribute.value; break
          case 'audio-settings':
            validateClipAudio(attribute.value.audio, 'audio', clip.timelineRange.durationFrames)
            next.audio = { ...attribute.value.audio }; next.volume = attribute.value.volume
            break
          case 'effects': {
            const effects = attribute.value.map((effect) => ({ ...cloneEffectDescriptor(effect), id: remap(effect.id) }))
            next.effects = options.effectsMode === 'append' ? [...clip.effects, ...effects] : effects
            if (options.effectsMode === 'replace') animation.effectTracks = []
            break
          }
        }
      }
      animation.tracks = animation.tracks.filter((track) => !options.groups.includes(PROPERTY_GROUP[track.property]))
      if (options.includeAnimation) {
        const copied = cloneClipAnimation(template.animation)
        copied.tracks = copied.tracks.filter((track) => options.groups.includes(PROPERTY_GROUP[track.property]))
        const copiedEffects = options.groups.includes('effects') ? [...effectAnimationTracks(copied)] : []
        if (copied.tracks.length || copiedEffects.length) {
          const map = clipSourceTimeMap(clip)
          if (sourceTimeMapHasInvalidSpeedCurve(map)) throw new Error('Destination speed curve is invalid.')
          for (const track of [...copied.tracks, ...copiedEffects]) {
            for (const key of track.keyframes) key.sourceTimeTicks = sourceTicksAtTimelineOffset(map, key.frame)
          }
          for (const track of copiedEffects) track.effectId = remap(track.effectId)
          animation.tracks.push(...copied.tracks)
          animation.effectTracks = [...effectAnimationTracks(animation), ...copiedEffects]
        }
      }
      if (clip.animation || animation.tracks.length || effectAnimationTracks(animation).length) next.animation = animation
      return next
    })
  } catch (cause) {
    return { ok: false, reason: errorMessage(cause) }
  }
}

export function resetClipAttributes(
  project: SequenceProject,
  sequenceId: string,
  targetIds: readonly string[],
  groups: readonly ClipAttributeGroup[],
  selectedEffectIds?: readonly string[],
): AttributeEditResult {
  return editTargets(project, sequenceId, targetIds, groups, (clip) => {
    const next = { ...clip }
    const animation = cloneClipAnimation(clipAnimation(clip))
    animation.tracks = animation.tracks.filter((track) => !groups.includes(PROPERTY_GROUP[track.property]))
    if (groups.includes('transform')) next.transform = defaultClipTransform()
    if (groups.includes('crop-and-flip')) next.visual = defaultClipVisualSettings()
    if (groups.includes('opacity')) next.opacity = 1
    if (groups.includes('blend')) next.blendMode = 'normal'
    if (groups.includes('audio-settings')) { next.volume = 1; next.audio = defaultClipAudioSettings() }
    if (groups.includes('effects')) {
      const selected = selectedEffectIds === undefined ? null : new Set(selectedEffectIds)
      if (selected && (selected.size !== selectedEffectIds!.length
        || [...selected].some((id) => !clip.effects.some((effect) => effect.id === id)))) {
        throw new Error('A selected effect no longer exists.')
      }
      const reset = new Set<string>()
      next.effects = clip.effects.map((effect) => {
        if (selected && !selected.has(effect.id)) return effect
        const registration = effectRegistration(effect.type)
        if (!registration || registration.version !== effect.version) {
          throw new Error(`"${effect.type}" has no supported reset contract. Remove it explicitly instead.`)
        }
        const value = { ...effect, params: { ...effect.params, ...registration.defaultParams } }
        const error = effectDescriptorBoundsError(value)
        if (error) throw new Error(error)
        reset.add(effect.id)
        return value
      })
      animation.effectTracks = effectAnimationTracks(animation).filter((track) => !reset.has(track.effectId))
    }
    if (clip.animation) next.animation = animation
    return next
  })
}
