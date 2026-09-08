/** Count every retained descriptor occurrence, including dormant sequences. */
import { CAPTION_INTENT_LIMITS, inspectCaptionIntent, type CaptionIntentDescriptor } from './captionIntent'
import type { SequenceProject } from './projectSequences'
import type { CaptionItem, CaptionTrack } from './schema'

export interface CaptionIntentOwner { readonly style?: CaptionIntentDescriptor; readonly origin?: CaptionIntentDescriptor }
export function captionIntentOwners(project: SequenceProject): readonly (CaptionItem | CaptionTrack)[] {
  return project.sequences.flatMap((sequence) => (sequence.captionTracks ?? []).flatMap((track) => [track, ...track.items]))
}
function bytes(owners: readonly CaptionIntentOwner[]): number {
  let total = 0
  for (const owner of owners) for (const descriptor of [owner.style, owner.origin]) {
    if (descriptor === undefined) continue
    const inspected = inspectCaptionIntent(descriptor)
    if (inspected.kind === 'invalid') throw new RangeError(inspected.reason)
    total += inspected.serializedUtf8Bytes
  }
  return total
}
export function captionProjectIntentError(project: SequenceProject): string | null {
  try { return bytes(captionIntentOwners(project)) > CAPTION_INTENT_LIMITS.maxProjectIntentBytes ? 'Caption style and origin exceed the 2 MiB project limit' : null }
  catch (cause) { return cause instanceof Error ? cause.message : 'Invalid caption intent' }
}
export interface CaptionRetentionState {
  readonly project: SequenceProject
  readonly past: readonly SequenceProject[]
  readonly future: readonly SequenceProject[]
  /** Each app owner registers every snapshot/preview/clipboard occurrence it holds. */
  readonly retainedCaptionOwners: Readonly<Record<string, readonly CaptionIntentOwner[]>>
}
export function captionRetentionError(state: CaptionRetentionState, candidate?: SequenceProject,
  additional: readonly CaptionIntentOwner[] = []): string | null {
  try {
    let retained = bytes(additional)
    for (const project of [...(candidate ? [candidate] : []), state.project, ...state.past, ...state.future]) {
      const owners = captionIntentOwners(project)
      const usage = bytes(owners)
      if (usage > CAPTION_INTENT_LIMITS.maxProjectIntentBytes) return 'Caption style and origin exceed the 2 MiB project limit'
      retained += usage
    }
    for (const owners of Object.values(state.retainedCaptionOwners)) retained += bytes(owners)
    return retained > CAPTION_INTENT_LIMITS.maxRetainedIntentBytes ? 'Caption style and origin exceed 32 MiB across the candidate, project, history and previews' : null
  } catch (cause) { return cause instanceof Error ? cause.message : 'Invalid retained caption intent' }
}
