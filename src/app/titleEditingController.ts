/** Cancellable title drafts share the transport's named document-preview arbiter. */
import { planTitleEdit, titleEditOwner, type TitleEditCommand, type TitleEditTarget } from '../domain/titleEditing'
import { animationRetentionError } from './projectAnimationRetention'
import { resolveTitleElementAnimation } from '../domain/animationPropertyCatalog'
import { readTitleElement } from '../domain/titleElements'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore, getTransportResetRevision } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { useTitleEditorStore } from '../state/titleEditorStore'
import { portableProjectEditError } from './portableProjectEdit'

export interface TitleEditSession {
  preview(command: TitleEditCommand, sampleFrame?: number): string | null
  commit(command: TitleEditCommand): string | null
  cancel(): void
}
let active: TitleEditSession | null = null
const stale = 'The project, selection or playhead changed. Reopen the title controls.'
export function beginTitleEdit(target: TitleEditTarget, onEnd?: () => void, factory: () => string = () => crypto.randomUUID()): TitleEditSession {
  active?.cancel()
  if (active !== null) throw new Error('Another title edit started during cleanup.')
  function capture() {
    const state = useDocumentStore.getState(), transport = useTransportStore.getState(), media = useMediaStore.getState(), title = useTitleEditorStore.getState()
    if (state.activeSequenceId !== target.sequenceId || transport.selectedClipId !== target.clipId) throw new Error('Select this title before editing.')
    if (transport.isPlaying || transport.isScrubbing) throw new Error('Pause playback before editing a title.')
    titleEditOwner(state.project, target)
    return { project: state.project, generation: state.projectGeneration, frame: transport.playheadFrame, ids: transport.selectedClipIds,
      adjustment: transport.selectedAdjustmentId, titleIds: title.ids, titleClip: title.clipId, reset: getTransportResetRevision(), descriptors: media.descriptors, collections: media.collections }
  }
  let pinned: ReturnType<typeof capture> | null = capture()
  let unsubscribers: (() => void)[] = [], busy = false
  function current() {
    if (!pinned) return false
    const state = useDocumentStore.getState(), transport = useTransportStore.getState(), media = useMediaStore.getState(), title = useTitleEditorStore.getState()
    return state.project === pinned.project && state.projectGeneration === pinned.generation && state.activeSequenceId === target.sequenceId
      && transport.playheadFrame === pinned.frame && !transport.isPlaying && !transport.isScrubbing && transport.selectedClipId === target.clipId
      && transport.selectedClipIds === pinned.ids && transport.selectedAdjustmentId === pinned.adjustment && getTransportResetRevision() === pinned.reset
      && title.ids === pinned.titleIds && title.clipId === pinned.titleClip && media.descriptors === pinned.descriptors && media.collections === pinned.collections
  }
  function cancel() {
    pinned = null
    const subscriptions = unsubscribers; unsubscribers = []; subscriptions.forEach((unsubscribe) => unsubscribe())
    if (active !== session) return
    active = null
    try { useTransportStore.getState().setTitleDocumentPreview(null) } finally { onEnd?.() }
  }
  function edit(command: TitleEditCommand, commit: boolean, sampleFrame?: number): string | null {
    if (busy) return 'A title edit is already being admitted.'
    if (active !== session || !current() || !pinned) { cancel(); return stale }
    busy = true
    try {
      const pin = pinned
      // Release this disposable draft before allocating its replacement. Reentrant callbacks cannot reuse this session.
      useTransportStore.getState().setTitleDocumentPreview(null, true)
      if (active !== session || !current()) { cancel(); return stale }
      const candidate = planTitleEdit(pin.project, target, command, factory)
      const error = animationRetentionError(useDocumentStore.getState(), candidate) ?? portableProjectEditError(pin.project, pin.generation, candidate)
      if (error) return error
      if (active !== session || !current()) { cancel(); return stale }
      if (commit) {
        // Release subscriptions before store notification; retain only this call's local candidate until return.
        const sequenceId = useDocumentStore.getState().activeSequenceId
        cancel()
        const state = useDocumentStore.getState(), cursor = useTransportStore.getState(), title = useTitleEditorStore.getState(), media = useMediaStore.getState()
        if (active !== null || state.project !== pin.project || state.projectGeneration !== pin.generation || state.activeSequenceId !== sequenceId
          || cursor.selectedClipId !== target.clipId || cursor.selectedClipIds !== pin.ids || cursor.selectedAdjustmentId !== pin.adjustment
          || cursor.playheadFrame !== pin.frame || cursor.isPlaying || cursor.isScrubbing || pin.reset !== getTransportResetRevision()
          || title.ids !== pin.titleIds || title.clipId !== pin.titleClip || media.descriptors !== pin.descriptors || media.collections !== pin.collections) return stale
        return state.commitProjectEdit(pin.project, pin.generation, candidate)
      }
      let document = candidate.sequences.find((item) => item.id === target.sequenceId)!
      if (sampleFrame !== undefined) {
        const { clip } = titleEditOwner(candidate, target)
        if (!Number.isSafeInteger(sampleFrame) || sampleFrame < 0 || sampleFrame >= clip.timelineRange.durationFrames) return 'Choose an integer local preview frame within the title.'
        if (pin.frame < clip.timelineRange.startFrame || pin.frame >= clip.timelineRange.startFrame + clip.timelineRange.durationFrames) return 'Move the playhead inside the title before previewing movement.'
        const { elements } = titleEditOwner(candidate, target)
        const sampled = new Set<string>()
        const resolved = elements.map((element) => {
          const parsed = readTitleElement(element)
          if (parsed.status !== 'supported') return element
          const result = resolveTitleElementAnimation(parsed.element, clip.animation?.titleTracks ?? [], sampleFrame)
          // Unavailable/dangling lanes must retain their status in the sampled preview.
          if (result.unavailable.length) return element
          sampled.add(element.id)
          return result.element
        })
        const retainedLanes = clip.animation?.titleTracks?.filter((lane) => !sampled.has(lane.elementId)) ?? []
        document = { ...document, tracks: document.tracks.map((track) => ({ ...track, clips: track.clips.map((item) => item === clip ? { ...clip, title: { version: 1, elements: resolved }, animation: { ...clip.animation!, titleTracks: retainedLanes } } : item) })) }
      }
      const previewBudget = animationRetentionError(useDocumentStore.getState(), { ...candidate, sequences: candidate.sequences.map((item) => item.id === target.sequenceId ? document : item) })
      if (previewBudget) return previewBudget
      if (active !== session || !current()) { cancel(); return stale }
      useTransportStore.getState().setTitleDocumentPreview({ sequenceId: target.sequenceId, document })
      if (active !== session || !current()) { cancel(); return stale }
      return null
    } catch (cause) { cancel(); return cause instanceof Error ? cause.message : 'Could not edit the title.' }
    finally { busy = false }
  }
  const session: TitleEditSession = { preview: (command, sampleFrame) => edit(command, false, sampleFrame), commit: (command) => edit(command, true), cancel }
  active = session
  const changed = () => { if (!current()) cancel() }
  unsubscribers = [useDocumentStore.subscribe(changed), useTransportStore.subscribe(changed), useMediaStore.subscribe(changed), useTitleEditorStore.subscribe(changed)]
  return session
}
export function commitTitleEdit(target: TitleEditTarget, command: TitleEditCommand): string | null {
  try { return beginTitleEdit(target).commit(command) } catch (cause) { return cause instanceof Error ? cause.message : 'Could not edit the title.' }
}
