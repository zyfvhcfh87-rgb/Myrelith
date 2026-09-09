/** All-sequence path projections for the shared history/clipboard admission boundary. */
import type { TimelineDoc } from './schema'
import { retainedTitleDataBudget, titlePayloadBudget, TITLE_BUDGET_LIMITS, type TitleBudgetOwner } from './titleBudgets'
import type { TitleElementIntent } from './titleElements'
import type { SequenceProject } from './projectSequences'
import { maskPathAnimationRetentionError, MASK_PATH_ANIMATION_LIMITS, type EffectPathAnimationTrack, type MaskPathAnimationSnapshot } from './maskPathAnimation'

export function projectPathAnimationSnapshot(project: SequenceProject): MaskPathAnimationSnapshot {
  const tracks: EffectPathAnimationTrack[] = []
  for (const sequence of project.sequences) for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      for (const lane of clip.animation?.effectPathTracks ?? []) {
        tracks.push(lane)
        if (tracks.length > MASK_PATH_ANIMATION_LIMITS.projectKeys) return { tracks }
      }
    }
    for (const adjustment of track.adjustments ?? []) for (const lane of adjustment.animation.effectPathTracks ?? []) {
      tracks.push(lane)
      if (tracks.length > MASK_PATH_ANIMATION_LIMITS.projectKeys) return { tracks }
    }
  }
  return { tracks }
}

export interface AnimationRetentionState {
  readonly retainedTitlePreviewDocuments?: readonly TimelineDoc[]
  readonly project: SequenceProject
  readonly past: readonly SequenceProject[]
  readonly future: readonly SequenceProject[]
  readonly retainedAttributePathTracks: readonly EffectPathAnimationTrack[]
  readonly retainedKeyPathTracks: readonly EffectPathAnimationTrack[]
  readonly retainedTitleClipboardOwners: readonly TitleBudgetOwner[]
  readonly retainedTitleClipboardElements: readonly TitleElementIntent[]
  readonly retainedTitleClipboardKeys: readonly object[]
}

export function animationRetentionError(
  state: AnimationRetentionState,
  candidate: SequenceProject | MaskPathAnimationSnapshot,
): string | null {
  const pathError = maskPathAnimationRetentionError({
    candidate: 'sequences' in candidate ? projectPathAnimationSnapshot(candidate) : candidate,
    current: projectPathAnimationSnapshot(state.project),
    past: state.past.map(projectPathAnimationSnapshot),
    future: state.future.map(projectPathAnimationSnapshot),
    attributeClipboard: { tracks: state.retainedAttributePathTracks },
    keyClipboard: { tracks: state.retainedKeyPathTracks },
  })
  if (pathError) return pathError
  const result = retainedTitleDataBudget({
    previews: state.retainedTitlePreviewDocuments?.map((document) => projectTitleAnimationOwners({ sequences: [document] })),
    candidate: projectTitleAnimationOwners('sequences' in candidate ? candidate : state.project),
    current: projectTitleAnimationOwners(state.project),
    past: state.past.map(projectTitleAnimationOwners), future: state.future.map(projectTitleAnimationOwners),
    clipboards: { titles: state.retainedTitleClipboardOwners, elements: state.retainedTitleClipboardElements, keys: state.retainedTitleClipboardKeys },
  })
  return result.ok ? null : result.reason
}

/** Pair real title payloads with their lanes; retain tracks-only orphan owners. */
export function projectTitleAnimationOwners(project: Pick<SequenceProject, 'sequences'>): TitleBudgetOwner[] {
  const owners: TitleBudgetOwner[] = []
  for (const sequence of project.sequences) for (const track of sequence.tracks) for (const clip of track.clips) {
    if (clip.title !== undefined) owners.push({ title: clip.title, titleTracks: clip.animation?.titleTracks })
    else if (clip.animation?.titleTracks?.length) owners.push({ titleTracks: clip.animation.titleTracks })
    if (owners.length > TITLE_BUDGET_LIMITS.ownersPerSnapshot) return owners
  }
  return owners
}

export function projectTitleAnimationError(project: SequenceProject): string | null {
  const owners = projectTitleAnimationOwners(project)
  if (owners.length > TITLE_BUDGET_LIMITS.ownersPerSnapshot) return 'Too many title animation owners.'
  for (const owner of owners) {
    const result = titlePayloadBudget(owner)
    if (!result.ok) return result.reason
  }
  return null
}
