/**
 * Pure project-level sequence collection and edit authority.
 *
 * A SequenceProject owns portable edit intent only. Browser resources, media
 * descriptors, active navigation, selection, and decoder state stay outside
 * this module. Timeline render/edit callers continue to consume one
 * TimelineDoc selected by the state-layer adapter.
 */

import type { EffectId, FrameRate, TimelineDoc } from './schema'
import { effectDescriptorBudget } from './effectBounds'
import { audioEffectDescriptorBudget } from './audioEffectBounds'
import {
  createTimelineDoc,
  type ProjectSettings,
} from './projectSettings'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'
import { proceduralTextAssetId } from './textOverlay'
import { SEQUENCE_PROJECT_LIMITS } from './sequenceProjectLimits'
import { analyzeNestedSequenceGraph } from './nestedSequences'

export { SEQUENCE_PROJECT_LIMITS } from './sequenceProjectLimits'

export interface SequenceProject {
  /** Stable identity of the portable project and local-resource lineage. */
  id: string
  /** Project label shown by launch, persistence, and recovery surfaces. */
  name: string
  /** Portable default render/delivery truth; never inferred from UI state. */
  rootSequenceId: string
  /** Stable, deterministic display order. Definitions are never recursive. */
  sequences: TimelineDoc[]
}

export type SequenceEntityKind =
  | 'sequence'
  | 'track'
  | 'clip'
  | 'sequence-instance'
  | 'adjustment'
  | 'effect'
  | 'audio-effect'
  | 'transition'
  | 'marker'
  | 'caption-track'
  | 'caption-item'
  | 'link-group'

/** Injected by state/app so the pure domain module owns no random source. */
export type SequenceIdFactory = (
  kind: SequenceEntityKind,
  sourceId?: string,
) => string

export type SequenceProjectEditFailure =
  | 'sequence-not-found'
  | 'sequence-referenced'
  | 'root-sequence-protected'
  | 'invalid-name'
  | 'sequence-limit'
  | 'project-budget'
  | 'id-generation-failed'

export interface SequenceProjectEditResult {
  project: SequenceProject
  /** Created/duplicated/renamed/deleted/root target when accepted. */
  sequenceId: string | null
  failure: SequenceProjectEditFailure | null
}

interface SequenceProjectCounts {
  tracks: number
  clips: number
  sequenceInstances: number
  adjustments: number
  transitions: number
  markers: number
  captionTracks: number
  captionItems: number
  effects: number
  effectParams: number
  effectStringCharacters: number
  audioEffects: number
  audioEffectParams: number
  audioEffectStringCharacters: number
  keyframes: number
  speedPoints: number
  textCharacters: number
}

function unchanged(
  project: SequenceProject,
  failure: SequenceProjectEditFailure,
): SequenceProjectEditResult {
  return { project, sequenceId: null, failure }
}

function accepted(
  project: SequenceProject,
  sequenceId: string,
): SequenceProjectEditResult {
  return { project, sequenceId, failure: null }
}

function boundedName(value: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_PROJECT_NAME_CHARACTERS) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function validGeneratedId(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_DOCUMENT_ID_CHARACTERS
}

function exactFrameRateEqual(
  left: TimelineDoc['frameRate'],
  right: TimelineDoc['frameRate'],
): boolean {
  return left.num * right.den === right.num * left.den
}

export function sequenceSettingsEqual(
  left: TimelineDoc,
  right: TimelineDoc,
): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.audioSampleRate === right.audioSampleRate
    && exactFrameRateEqual(left.frameRate, right.frameRate)
}

export function sequenceById(
  project: SequenceProject,
  sequenceId: string,
): TimelineDoc | null {
  return project.sequences.find((sequence) => sequence.id === sequenceId) ?? null
}

export function rootSequence(project: SequenceProject): TimelineDoc {
  const root = sequenceById(project, project.rootSequenceId)
  if (!root) throw new Error('Sequence project has no root definition')
  return root
}

export function sequenceProjectFromTimeline(
  document: TimelineDoc,
): SequenceProject {
  return {
    id: document.id,
    name: document.name,
    rootSequenceId: document.id,
    sequences: [document],
  }
}

function collectCounts(project: SequenceProject): SequenceProjectCounts {
  const counts: SequenceProjectCounts = {
    tracks: 0,
    clips: 0,
    sequenceInstances: 0,
    adjustments: 0,
    transitions: 0,
    markers: 0,
    captionTracks: 0,
    captionItems: 0,
    effects: 0,
    effectParams: 0,
    effectStringCharacters: 0,
    audioEffects: 0,
    audioEffectParams: 0,
    audioEffectStringCharacters: 0,
    keyframes: 0,
    speedPoints: 0,
    textCharacters: 0,
  }
  for (const sequence of project.sequences) {
    counts.tracks += sequence.tracks.length
    counts.markers += sequence.markers?.length ?? 0
    counts.captionTracks += sequence.captionTracks?.length ?? 0
    for (const effect of sequence.masterAudio?.audioEffects ?? []) {
      counts.audioEffects++
      const budget = audioEffectDescriptorBudget(effect)
      counts.audioEffectParams += budget.params
      counts.audioEffectStringCharacters += budget.stringCharacters
    }
    for (const track of sequence.tracks) {
      counts.clips += track.clips.length
      counts.sequenceInstances += track.sequenceInstances?.length ?? 0
      counts.adjustments += track.adjustments?.length ?? 0
      counts.transitions += track.transitions.length
      for (const effect of track.audioEffects ?? []) {
        counts.audioEffects++
        const budget = audioEffectDescriptorBudget(effect)
        counts.audioEffectParams += budget.params
        counts.audioEffectStringCharacters += budget.stringCharacters
      }
      for (const clip of track.clips) {
        counts.speedPoints += clip.sourceTimeMap?.speedCurve?.points.length ?? 0
        counts.textCharacters += clip.text?.content.length ?? 0
        counts.keyframes += (clip.animation?.tracks ?? []).reduce(
          (sum, animationTrack) => sum + animationTrack.keyframes.length,
          0,
        )
        counts.keyframes += (clip.animation?.effectTracks ?? []).reduce(
          (sum, animationTrack) => sum + animationTrack.keyframes.length,
          0,
        )
        counts.effects += clip.effects.length
        for (const effect of clip.effects) {
          const budget = effectDescriptorBudget(effect)
          counts.effectParams += budget.params
          counts.effectStringCharacters += budget.stringCharacters
        }
        for (const effect of clip.audioEffects ?? []) {
          counts.audioEffects++
          const budget = audioEffectDescriptorBudget(effect)
          counts.audioEffectParams += budget.params
          counts.audioEffectStringCharacters += budget.stringCharacters
        }
      }
      for (const adjustment of track.adjustments ?? []) {
        counts.keyframes += adjustment.animation.tracks.reduce(
          (sum, animationTrack) => sum + animationTrack.keyframes.length,
          0,
        )
        counts.keyframes += adjustment.animation.effectTracks.reduce(
          (sum, animationTrack) => sum + animationTrack.keyframes.length,
          0,
        )
        counts.effects += adjustment.effects.length
        for (const effect of adjustment.effects) {
          const budget = effectDescriptorBudget(effect)
          counts.effectParams += budget.params
          counts.effectStringCharacters += budget.stringCharacters
        }
      }
    }
    for (const track of sequence.captionTracks ?? []) {
      counts.captionItems += track.items.length
    }
  }
  return counts
}

function sequenceProjectIdsAreUnique(project: SequenceProject): boolean {
  const ids = collectUsedIds(project)
  let sequenceCount = 0
  let trackCount = 0
  let clipCount = 0
  let sequenceInstanceCount = 0
  let adjustmentCount = 0
  let effectCount = 0
  let audioEffectCount = 0
  let transitionCount = 0
  let markerCount = 0
  let captionTrackCount = 0
  let captionItemCount = 0
  const projectLinkGroups = new Set<string>()
  for (const sequence of project.sequences) {
    sequenceCount++
    audioEffectCount += sequence.masterAudio?.audioEffects?.length ?? 0
    const sequenceLinkGroups = new Map<string, number>()
    for (const track of sequence.tracks) {
      trackCount++
      adjustmentCount += track.adjustments?.length ?? 0
      audioEffectCount += track.audioEffects?.length ?? 0
      transitionCount += track.transitions.length
      for (const clip of track.clips) {
        clipCount++
        effectCount += clip.effects.length
        audioEffectCount += clip.audioEffects?.length ?? 0
        if (clip.linkGroupId) {
          sequenceLinkGroups.set(
            clip.linkGroupId,
            (sequenceLinkGroups.get(clip.linkGroupId) ?? 0) + 1,
          )
        }
      }
      for (const instance of track.sequenceInstances ?? []) {
        sequenceInstanceCount++
        if (instance.linkGroupId) {
          sequenceLinkGroups.set(
            instance.linkGroupId,
            (sequenceLinkGroups.get(instance.linkGroupId) ?? 0) + 1,
          )
        }
      }
      for (const adjustment of track.adjustments ?? []) {
        effectCount += adjustment.effects.length
      }
    }
    markerCount += sequence.markers?.length ?? 0
    for (const track of sequence.captionTracks ?? []) {
      captionTrackCount++
      captionItemCount += track.items.length
    }
    for (const linkGroupId of sequenceLinkGroups.keys()) {
      if (projectLinkGroups.has(linkGroupId)) return false
      projectLinkGroups.add(linkGroupId)
    }
    if ([...sequenceLinkGroups.values()].some((members) => members < 2)) return false
  }
  return ids.sequence.size === sequenceCount
    && ids.track.size === trackCount
    && ids.timelineItem.size === clipCount + sequenceInstanceCount + adjustmentCount
    && ids.effect.size === effectCount
    && ids.audioEffect.size === audioEffectCount
    && ids.transition.size === transitionCount
    && ids.marker.size === markerCount
    && ids.captionTrack.size === captionTrackCount
    && ids.captionItem.size === captionItemCount
}

export function sequenceProjectWithinEditBudget(
  project: SequenceProject,
): boolean {
  if (
    project.sequences.length < 1
    || project.sequences.length > SEQUENCE_PROJECT_LIMITS.maxSequences
  ) return false
  const root = sequenceById(project, project.rootSequenceId)
  if (
    !root
    || !project.sequences.every((sequence) => sequenceSettingsEqual(root, sequence))
    || !sequenceProjectIdsAreUnique(project)
  ) return false
  try {
    analyzeNestedSequenceGraph(project)
  } catch {
    return false
  }
  const counts = collectCounts(project)
  return counts.tracks <= SEQUENCE_PROJECT_LIMITS.maxTotalTracks
    && counts.clips <= SEQUENCE_PROJECT_LIMITS.maxTotalClips
    && counts.sequenceInstances
      <= SEQUENCE_PROJECT_LIMITS.maxTotalSequenceInstances
    && counts.adjustments <= SEQUENCE_PROJECT_LIMITS.maxTotalAdjustments
    && counts.transitions <= SEQUENCE_PROJECT_LIMITS.maxTotalTransitions
    && counts.markers <= SEQUENCE_PROJECT_LIMITS.maxTotalMarkers
    && counts.captionTracks <= SEQUENCE_PROJECT_LIMITS.maxTotalCaptionTracks
    && counts.captionItems <= SEQUENCE_PROJECT_LIMITS.maxTotalCaptionItems
    && counts.effects <= SEQUENCE_PROJECT_LIMITS.maxTotalEffects
    && counts.effectParams <= SEQUENCE_PROJECT_LIMITS.maxTotalEffectParams
    && counts.effectStringCharacters
      <= SEQUENCE_PROJECT_LIMITS.maxTotalEffectStringCharacters
    && counts.audioEffects <= SEQUENCE_PROJECT_LIMITS.maxTotalAudioEffects
    && counts.audioEffectParams <= SEQUENCE_PROJECT_LIMITS.maxTotalAudioEffectParams
    && counts.audioEffectStringCharacters
      <= SEQUENCE_PROJECT_LIMITS.maxTotalAudioEffectStringCharacters
    && counts.keyframes <= SEQUENCE_PROJECT_LIMITS.maxTotalKeyframes
    && counts.speedPoints <= SEQUENCE_PROJECT_LIMITS.maxTotalSpeedPoints
    && counts.textCharacters <= SEQUENCE_PROJECT_LIMITS.maxTotalTextCharacters
}

/** Match a source rate only while every definition is still content-empty. */
export function matchEmptyProjectFrameRate(
  project: SequenceProject,
  frameRate: FrameRate,
): SequenceProject | null {
  if (
    !Number.isSafeInteger(frameRate.num)
    || !Number.isSafeInteger(frameRate.den)
    || frameRate.num <= 0
    || frameRate.den <= 0
    || project.sequences.some((sequence) => (
      sequence.tracks.some((track) => track.clips.length > 0)
      || sequence.tracks.some((track) => (
        (track.sequenceInstances?.length ?? 0) > 0
      ))
      || sequence.tracks.some((track) => (track.adjustments?.length ?? 0) > 0)
      || (sequence.markers?.length ?? 0) > 0
      || (sequence.captionTracks ?? []).some((track) => track.items.length > 0)
    ))
  ) return null
  const candidate = {
    ...project,
    sequences: project.sequences.map((sequence) => ({
      ...sequence,
      frameRate: { num: frameRate.num, den: frameRate.den },
    })),
  }
  return sequenceProjectWithinEditBudget(candidate) ? candidate : null
}

function cloneDocument(document: TimelineDoc): TimelineDoc {
  return JSON.parse(JSON.stringify(document)) as TimelineDoc
}

interface UsedIds {
  sequence: Set<string>
  track: Set<string>
  timelineItem: Set<string>
  effect: Set<string>
  audioEffect: Set<string>
  transition: Set<string>
  marker: Set<string>
  captionTrack: Set<string>
  captionItem: Set<string>
  linkGroup: Set<string>
}

function collectUsedIds(project: SequenceProject): UsedIds {
  const used: UsedIds = {
    sequence: new Set(),
    track: new Set(),
    timelineItem: new Set(),
    effect: new Set(),
    audioEffect: new Set(),
    transition: new Set(),
    marker: new Set(),
    captionTrack: new Set(),
    captionItem: new Set(),
    linkGroup: new Set(),
  }
  for (const sequence of project.sequences) {
    used.sequence.add(sequence.id)
    for (const effect of sequence.masterAudio?.audioEffects ?? []) {
      used.audioEffect.add(effect.id)
    }
    for (const track of sequence.tracks) {
      used.track.add(track.id)
      for (const effect of track.audioEffects ?? []) used.audioEffect.add(effect.id)
      for (const clip of track.clips) {
        used.timelineItem.add(clip.id)
        if (clip.linkGroupId) used.linkGroup.add(clip.linkGroupId)
        for (const effect of clip.effects) used.effect.add(effect.id)
        for (const effect of clip.audioEffects ?? []) used.audioEffect.add(effect.id)
      }
      for (const instance of track.sequenceInstances ?? []) {
        used.timelineItem.add(instance.id)
        if (instance.linkGroupId) used.linkGroup.add(instance.linkGroupId)
      }
      for (const adjustment of track.adjustments ?? []) {
        used.timelineItem.add(adjustment.id)
        for (const effect of adjustment.effects) used.effect.add(effect.id)
      }
      for (const transition of track.transitions) used.transition.add(transition.id)
    }
    for (const marker of sequence.markers ?? []) used.marker.add(marker.id)
    for (const track of sequence.captionTracks ?? []) {
      used.captionTrack.add(track.id)
      for (const item of track.items) used.captionItem.add(item.id)
    }
  }
  return used
}

function idSet(used: UsedIds, kind: SequenceEntityKind): Set<string> {
  switch (kind) {
    case 'sequence': return used.sequence
    case 'track': return used.track
    case 'clip': return used.timelineItem
    case 'sequence-instance': return used.timelineItem
    case 'adjustment': return used.timelineItem
    case 'effect': return used.effect
    case 'audio-effect': return used.audioEffect
    case 'transition': return used.transition
    case 'marker': return used.marker
    case 'caption-track': return used.captionTrack
    case 'caption-item': return used.captionItem
    case 'link-group': return used.linkGroup
  }
}

function allocateId(
  used: UsedIds,
  factory: SequenceIdFactory,
  kind: SequenceEntityKind,
  sourceId?: string,
): string | null {
  const ids = idSet(used, kind)
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = factory(kind, sourceId)
    if (!validGeneratedId(candidate) || ids.has(candidate)) continue
    ids.add(candidate)
    return candidate
  }
  return null
}

function remapDuplicateIds(
  document: TimelineDoc,
  used: UsedIds,
  factory: SequenceIdFactory,
): TimelineDoc | null {
  const duplicate = cloneDocument(document)
  const sequenceId = allocateId(used, factory, 'sequence', document.id)
  if (!sequenceId) return null
  duplicate.id = sequenceId

  const clipIds = new Map<string, string>()
  const effectIds = new Map<EffectId, EffectId>()
  const linkGroupIds = new Map<string, string>()
  for (const effect of duplicate.masterAudio?.audioEffects ?? []) {
    const effectId = allocateId(used, factory, 'audio-effect', effect.id)
    if (!effectId) return null
    effect.id = effectId
  }
  for (const track of duplicate.tracks) {
    const trackId = allocateId(used, factory, 'track', track.id)
    if (!trackId) return null
    track.id = trackId
    for (const effect of track.audioEffects ?? []) {
      const effectId = allocateId(used, factory, 'audio-effect', effect.id)
      if (!effectId) return null
      effect.id = effectId
    }
    for (const clip of track.clips) {
      const clipId = allocateId(used, factory, 'clip', clip.id)
      if (!clipId) return null
      clipIds.set(clip.id, clipId)
      clip.id = clipId
      if (clip.text !== undefined) clip.assetId = proceduralTextAssetId(clipId)
      if (clip.linkGroupId) {
        let linkGroupId = linkGroupIds.get(clip.linkGroupId)
        if (!linkGroupId) {
          linkGroupId = allocateId(
            used,
            factory,
            'link-group',
            clip.linkGroupId,
          ) ?? undefined
          if (!linkGroupId) return null
          linkGroupIds.set(clip.linkGroupId, linkGroupId)
        }
        clip.linkGroupId = linkGroupId
      }
      for (const effect of clip.effects) {
        const effectId = allocateId(used, factory, 'effect', effect.id)
        if (!effectId) return null
        effectIds.set(effect.id, effectId)
        effect.id = effectId
      }
      for (const effect of clip.audioEffects ?? []) {
        const effectId = allocateId(used, factory, 'audio-effect', effect.id)
        if (!effectId) return null
        effect.id = effectId
      }
      for (const track of clip.animation?.effectTracks ?? []) {
        const effectId = effectIds.get(track.effectId)
        if (effectId) track.effectId = effectId
      }
    }
    for (const instance of track.sequenceInstances ?? []) {
      const instanceId = allocateId(
        used,
        factory,
        'sequence-instance',
        instance.id,
      )
      if (!instanceId) return null
      instance.id = instanceId
      if (instance.linkGroupId) {
        let linkGroupId = linkGroupIds.get(instance.linkGroupId)
        if (!linkGroupId) {
          linkGroupId = allocateId(
            used,
            factory,
            'link-group',
            instance.linkGroupId,
          ) ?? undefined
          if (!linkGroupId) return null
          linkGroupIds.set(instance.linkGroupId, linkGroupId)
        }
        instance.linkGroupId = linkGroupId
      }
    }
    for (const adjustment of track.adjustments ?? []) {
      const adjustmentId = allocateId(
        used,
        factory,
        'adjustment',
        adjustment.id,
      )
      if (!adjustmentId) return null
      adjustment.id = adjustmentId
      for (const effect of adjustment.effects) {
        const effectId = allocateId(used, factory, 'effect', effect.id)
        if (!effectId) return null
        effectIds.set(effect.id, effectId)
        effect.id = effectId
      }
      for (const animationTrack of adjustment.animation.effectTracks) {
        const effectId = effectIds.get(animationTrack.effectId)
        if (effectId) animationTrack.effectId = effectId
      }
    }
  }
  for (const track of duplicate.tracks) {
    for (const transition of track.transitions) {
      const transitionId = allocateId(
        used,
        factory,
        'transition',
        transition.id,
      )
      const fromClipId = clipIds.get(transition.fromClipId)
      const toClipId = clipIds.get(transition.toClipId)
      if (!transitionId || !fromClipId || !toClipId) return null
      transition.id = transitionId
      transition.fromClipId = fromClipId
      transition.toClipId = toClipId
    }
  }
  for (const marker of duplicate.markers ?? []) {
    const markerId = allocateId(used, factory, 'marker', marker.id)
    if (!markerId) return null
    marker.id = markerId
  }
  for (const track of duplicate.captionTracks ?? []) {
    const trackId = allocateId(used, factory, 'caption-track', track.id)
    if (!trackId) return null
    track.id = trackId
    for (const item of track.items) {
      const itemId = allocateId(used, factory, 'caption-item', item.id)
      if (!itemId) return null
      item.id = itemId
    }
  }
  return duplicate
}

function projectSettings(document: TimelineDoc): ProjectSettings {
  return {
    width: document.width,
    height: document.height,
    frameRate: { ...document.frameRate },
    audioSampleRate: document.audioSampleRate,
  }
}

export function createProjectSequence(
  project: SequenceProject,
  name: string,
  factory: SequenceIdFactory,
): SequenceProjectEditResult {
  if (project.sequences.length >= SEQUENCE_PROJECT_LIMITS.maxSequences) {
    return unchanged(project, 'sequence-limit')
  }
  const normalizedName = boundedName(name)
  if (!normalizedName) return unchanged(project, 'invalid-name')
  const used = collectUsedIds(project)
  const sequenceId = allocateId(used, factory, 'sequence')
  if (!sequenceId) return unchanged(project, 'id-generation-failed')
  const document = cloneDocument(createTimelineDoc(
    normalizedName,
    projectSettings(rootSequence(project)),
    sequenceId,
  ))
  for (const track of document.tracks) {
    const trackId = allocateId(used, factory, 'track', track.id)
    if (!trackId) return unchanged(project, 'id-generation-failed')
    track.id = trackId
  }
  const candidate = {
    ...project,
    sequences: [...project.sequences, document],
  }
  return sequenceProjectWithinEditBudget(candidate)
    ? accepted(candidate, sequenceId)
    : unchanged(project, 'project-budget')
}

export function duplicateProjectSequence(
  project: SequenceProject,
  sequenceId: string,
  name: string,
  factory: SequenceIdFactory,
): SequenceProjectEditResult {
  if (project.sequences.length >= SEQUENCE_PROJECT_LIMITS.maxSequences) {
    return unchanged(project, 'sequence-limit')
  }
  const source = sequenceById(project, sequenceId)
  if (!source) return unchanged(project, 'sequence-not-found')
  const normalizedName = boundedName(name)
  if (!normalizedName) return unchanged(project, 'invalid-name')
  const duplicate = remapDuplicateIds(source, collectUsedIds(project), factory)
  if (!duplicate) return unchanged(project, 'id-generation-failed')
  duplicate.name = normalizedName
  const candidate = {
    ...project,
    sequences: [...project.sequences, duplicate],
  }
  return sequenceProjectWithinEditBudget(candidate)
    ? accepted(candidate, duplicate.id)
    : unchanged(project, 'project-budget')
}

export function renameProjectSequence(
  project: SequenceProject,
  sequenceId: string,
  name: string,
): SequenceProjectEditResult {
  const index = project.sequences.findIndex((sequence) => sequence.id === sequenceId)
  if (index < 0) return unchanged(project, 'sequence-not-found')
  const normalizedName = boundedName(name)
  if (!normalizedName) return unchanged(project, 'invalid-name')
  if (project.sequences[index].name === normalizedName) {
    return accepted(project, sequenceId)
  }
  const sequences = [...project.sequences]
  sequences[index] = { ...sequences[index], name: normalizedName }
  return accepted({ ...project, sequences }, sequenceId)
}

export function deleteProjectSequence(
  project: SequenceProject,
  sequenceId: string,
): SequenceProjectEditResult {
  if (!sequenceById(project, sequenceId)) {
    return unchanged(project, 'sequence-not-found')
  }
  if (project.rootSequenceId === sequenceId) {
    return unchanged(project, 'root-sequence-protected')
  }
  if (project.sequences.some((sequence) => sequence.tracks.some((track) => (
    (track.sequenceInstances ?? []).some((instance) => (
      instance.sequenceId === sequenceId
    ))
  )))) return unchanged(project, 'sequence-referenced')
  return accepted({
    ...project,
    sequences: project.sequences.filter((sequence) => sequence.id !== sequenceId),
  }, sequenceId)
}

export function chooseProjectRootSequence(
  project: SequenceProject,
  sequenceId: string,
): SequenceProjectEditResult {
  if (!sequenceById(project, sequenceId)) {
    return unchanged(project, 'sequence-not-found')
  }
  if (project.rootSequenceId === sequenceId) return accepted(project, sequenceId)
  return accepted({ ...project, rootSequenceId: sequenceId }, sequenceId)
}

/** Replace only one definition while preserving project/root identity. */
export function replaceProjectSequence(
  project: SequenceProject,
  sequenceId: string,
  document: TimelineDoc,
): SequenceProject {
  const index = project.sequences.findIndex((sequence) => sequence.id === sequenceId)
  const candidate = {
    ...project,
    sequences: project.sequences.map((sequence, candidateIndex) => (
      candidateIndex === index ? document : sequence
    )),
  }
  if (
    index < 0
    || document.id !== sequenceId
    || !sequenceSettingsEqual(rootSequence(project), document)
    || project.sequences[index] === document
    || !sequenceProjectWithinEditBudget(candidate)
  ) return project
  return candidate
}

/** Project-wide durable media usage; procedural text owns no descriptor. */
export function projectMediaAssetIds(project: SequenceProject): ReadonlySet<string> {
  const assetIds = new Set<string>()
  for (const sequence of project.sequences) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (clip.text === undefined) assetIds.add(clip.assetId)
      }
    }
  }
  return assetIds
}
