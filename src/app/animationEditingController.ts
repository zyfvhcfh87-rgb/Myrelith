/** One app owner for animation clipboard, selection reconciliation, and cancellable previews. */
import { copyAnimationKeys, planAnimationPaste, type AnimationKeyClipboard, type AnimationPasteMapping } from '../domain/animationClipboard'
import { planAnimationBatch, planSetAnimationKey, reconcileAnimationKeys, nearestAnimationKey, type AnimationBatchCommand, type AnimationBatchResult } from '../domain/animationBatch'
import type { ClipAnimationEasing } from '../domain/schema'
import { animationKeyKey, type AnimationLaneAddress } from '../domain/animationAddresses'
import { animationRetentionError } from '../domain/animationProjectBudget'
import type { AnimationEditContext } from '../domain/animationOwners'
import type { SequenceProject } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { getTransportResetRevision, useTransportStore } from '../state/transportStore'
import { portableProjectEditError } from './portableProjectEdit'

let liveController: object | null = null

export interface AnimationGesture {
  preview(command: AnimationBatchCommand): void
  commit(command: AnimationBatchCommand): string | null
  cancel(): void
}
export interface AnimationEditingOptions {
  readonly readContext?: () => AnimationEditContext
  readonly subscribeContext?: (changed: () => void) => () => void
  readonly requestFrame?: (callback: () => void) => number
  readonly cancelFrame?: (handle: number) => void
  readonly report?: (message: string) => void
}
function clipboardPaths(clipboard: AnimationKeyClipboard | null) { return clipboard?.lanes.flatMap(({ track }) => 'valueType' in track ? [track] : []) ?? [] }
const titleClipboardRoots = new WeakMap<AnimationKeyClipboard, readonly object[]>()
function clipboardTitles(clipboard: AnimationKeyClipboard | null): readonly object[] {
  if (!clipboard) return []
  const cached = titleClipboardRoots.get(clipboard)
  if (cached) return cached
  const lanes = clipboard.lanes.filter(({ track }) => 'elementId' in track)
  const roots = Object.freeze(lanes.length ? [Object.freeze({ version: clipboard.version, frameRate: clipboard.frameRate, anchorGlobalFrame: clipboard.anchorGlobalFrame, lanes: Object.freeze(lanes) })] : [])
  titleClipboardRoots.set(clipboard, roots)
  return roots
}

export function createAnimationEditingController(options: AnimationEditingOptions = {}) {
  const readContext: () => AnimationEditContext = options.readContext ?? (() => ({}))
  const requestFrame = options.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle))
  let clipboard: { readonly generation: number; readonly value: AnimationKeyClipboard } | null = null
  let active: AnimationGesture | null = null
  let initialized = false
  let mountRevision = 0
  const ownerToken = {}
  let ownedCommit = false
  const report = (error: string | null) => { if (error) options.report?.(error); return error }
  const resetClipboard = () => {
    clipboard = null
    useDocumentStore.setState({ retainedKeyPathTracks: [], retainedTitleClipboardKeys: [] })
  }
  const clipboardError = (candidate: SequenceProject, next: AnimationKeyClipboard | null): string | null => {
    const state = useDocumentStore.getState()
    return animationRetentionError({ ...state,
      retainedKeyPathTracks: [...state.retainedKeyPathTracks, ...clipboardPaths(next)],
      retainedTitleClipboardKeys: [...state.retainedTitleClipboardKeys, ...clipboardTitles(next)],
    }, candidate)
  }
  function installClipboard(value: AnimationKeyClipboard) {
    const generation = useDocumentStore.getState().projectGeneration
    clipboard = { generation, value }
    useDocumentStore.setState({ retainedKeyPathTracks: clipboardPaths(value), retainedTitleClipboardKeys: clipboardTitles(value) })
  }
  function pin() {
    const context = readContext(), document = useDocumentStore.getState(), cursor = useTransportStore.getState(), media = useMediaStore.getState(), reset = getTransportResetRevision()
    return {
      context, document, cursor,
      current(expectedProject = document.project): boolean {
        const nextContext = readContext(), next = useDocumentStore.getState(), transport = useTransportStore.getState(), nextMedia = useMediaStore.getState()
        return initialized && liveController === ownerToken && next.project === expectedProject && next.projectGeneration === document.projectGeneration && next.activeSequenceId === document.activeSequenceId
          && nextContext.plugins === context.plugins && nextContext.titles === context.titles
          && reset === getTransportResetRevision() && transport.playheadFrame === cursor.playheadFrame
          && transport.animationSelection === cursor.animationSelection && transport.animationFocus === cursor.animationFocus
          && transport.selectedClipId === cursor.selectedClipId && transport.selectedAdjustmentId === cursor.selectedAdjustmentId
          && transport.selectedClipIds === cursor.selectedClipIds && transport.isPlaying === cursor.isPlaying && transport.isScrubbing === cursor.isScrubbing
          && nextMedia.descriptors === media.descriptors && nextMedia.collections === media.collections && nextMedia.assets === media.assets
      },
    }
  }
  type Pin = ReturnType<typeof pin>
  const stale = 'The project, selection, playhead, source or declaration changed. Start the animation edit again.'
  function commitResult(pinned: Pin, result: AnimationBatchResult, nextClipboard?: AnimationKeyClipboard): string | null {
    if (!result.ok) return report(result.reason)
    if (pinned.cursor.isPlaying || pinned.cursor.isScrubbing) return report('Pause playback before editing animation keys.')
    if (!pinned.current()) return report(stale)
    if (!result.changed && !nextClipboard) return null
    const error = clipboardError(result.project, nextClipboard ?? null) ?? portableProjectEditError(pinned.document.project, pinned.document.projectGeneration, result.project)
    if (error) return report(error)
    if (!pinned.current()) return report(stale)
    ownedCommit = true
    let committed: string | null
    try { committed = useDocumentStore.getState().commitAnimationEdit(pinned.document.project, pinned.document.projectGeneration, pinned.document.activeSequenceId, result.project) }
    finally { ownedCommit = false }
    if (committed) return report(committed)
    if (!pinned.current(result.project)) {
      // An external subscriber may edit, reset or unmount synchronously inside
      // the store notification. Never restore this operation's stale selection.
      if (initialized) {
        const state = useDocumentStore.getState(), transport = useTransportStore.getState()
        const sameSequence = state.projectGeneration === pinned.document.projectGeneration && state.activeSequenceId === pinned.document.activeSequenceId
        transport.setAnimationSelection(sameSequence ? reconcileAnimationKeys(state.doc, transport.animationSelection) : [],
          sameSequence ? nearestAnimationKey(state.doc, transport.animationFocus) : null)
      }
      return report(stale)
    }
    if (nextClipboard) {
      installClipboard(nextClipboard)
      if (!pinned.current(result.project)) return report(stale)
    }
    useTransportStore.getState().setAnimationSelection(result.selection, result.focus)
    return null
  }
  function begin(onEnd?: () => void): AnimationGesture {
    if (!initialized) throw new Error('Animation editing is not mounted.')
    active?.cancel()
    if (active) throw new Error('Another animation gesture started during cleanup.')
    const pinned = pin()
    if (!pinned.current()) throw new Error(stale)
    if (pinned.cursor.isPlaying || pinned.cursor.isScrubbing) throw new Error('Pause playback before editing animation keys.')
    let frame: number | null = null, queued: AnimationBatchCommand | null = null, ended = false
    let unsubscribeDocument = () => {}, unsubscribeTransport = () => {}, unsubscribeMedia = () => {}, unsubscribeContext = () => {}
    function cancel() {
      if (ended) return
      ended = true
      if (frame !== null) cancelFrame(frame)
      frame = null; queued = null
      unsubscribeDocument(); unsubscribeTransport(); unsubscribeMedia(); unsubscribeContext()
      if (active !== session) return
      active = null
      useTransportStore.getState().setAnimationPreview(null)
      onEnd?.()
    }
    const valid = () => active === session && !ended && pinned.current()
    const plan = (command: AnimationBatchCommand) => planAnimationBatch(pinned.document.project, pinned.document.activeSequenceId, pinned.cursor.animationSelection, command, pinned.context, pinned.cursor.animationFocus)
    const session: AnimationGesture = {
      cancel,
      preview(command) {
        if (!valid()) { cancel(); report(stale); return }
        // Copy the small command so caller mutation cannot change a queued edit.
        queued = command.kind === 'set-easing' ? { ...command, easing: { ...command.easing } } : { ...command }
        if (frame !== null) return
        frame = requestFrame(() => {
          frame = null
          if (!valid()) { cancel(); report(stale); return }
          const command = queued; queued = null
          if (!command) return
          // Release this owner's previous preview before admitting its replacement.
          useTransportStore.getState().setAnimationPreview(null)
          const result = plan(command)
          if (!result.ok) { report(result.reason); return }
          const error = clipboardError(result.project, null)
          if (error) { report(error); return }
          if (!valid()) { cancel(); report(stale); return }
          useTransportStore.getState().setAnimationPreview({ sequenceId: pinned.document.activeSequenceId, document: result.project.sequences.find((item) => item.id === pinned.document.activeSequenceId)! })
        })
      },
      commit(command) {
        if (!valid()) { cancel(); return report(stale) }
        cancel()
        if (active !== null || !pinned.current()) return report(stale)
        return commitResult(pinned, plan(command))
      },
    }
    active = session
    const changed = () => { if (!valid()) cancel() }
    unsubscribeDocument = useDocumentStore.subscribe(changed)
    unsubscribeTransport = useTransportStore.subscribe(changed)
    unsubscribeMedia = useMediaStore.subscribe(changed)
    unsubscribeContext = options.subscribeContext?.(changed) ?? (() => {})
    // A subscription provider may notify synchronously while registering.
    if (ended) unsubscribeContext()
    else if (!valid()) cancel()
    return session
  }
  return {
    begin,
    cancel: () => active?.cancel(),
    getClipboard: (): AnimationKeyClipboard | null => clipboard?.generation === useDocumentStore.getState().projectGeneration ? clipboard.value : null,
    copy(): string | null {
      if (!initialized) return report('Animation editing is not mounted.')
      const pinned = pin(), result = copyAnimationKeys(pinned.document.doc, pinned.cursor.animationSelection, pinned.context)
      if (!result.ok) return report(result.reason)
      const error = clipboardError(pinned.document.project, result.clipboard)
      if (error) return report(error)
      if (!pinned.current()) return report(stale)
      installClipboard(result.clipboard); return null
    },
    cut(): string | null {
      if (!initialized) return report('Animation editing is not mounted.')
      active?.cancel()
      if (active) return report('Another animation gesture started during cleanup.')
      const pinned = pin(), copied = copyAnimationKeys(pinned.document.doc, pinned.cursor.animationSelection, pinned.context)
      if (!copied.ok) return report(copied.reason)
      return commitResult(pinned, planAnimationBatch(pinned.document.project, pinned.document.activeSequenceId, pinned.cursor.animationSelection, { kind: 'delete' }, pinned.context, pinned.cursor.animationFocus), copied.clipboard)
    },
    edit(command: AnimationBatchCommand): string | null {
      try { return begin().commit(command) }
      catch (cause) { return report(cause instanceof Error ? cause.message : 'The keys cannot be edited.') }
    },
    setKey(lane: AnimationLaneAddress, frame: number, value: number | string, easing?: ClipAnimationEasing): string | null {
      if (!initialized) return report('Animation editing is not mounted.')
      active?.cancel()
      if (active) return report('Another animation gesture started during cleanup.')
      const pinned = pin()
      return commitResult(pinned, planSetAnimationKey(pinned.document.project, pinned.document.activeSequenceId, lane, frame, value, easing, pinned.context))
    },
    paste(mapping?: readonly AnimationPasteMapping[], originalTime = false): string | null {
      if (!initialized) return report('Animation editing is not mounted.')
      active?.cancel()
      if (active) return report('Another animation gesture started during cleanup.')
      const pinned = pin()
      if (!clipboard || clipboard.generation !== pinned.document.projectGeneration) return report('Copy animation keys in this project first.')
      return commitResult(pinned, planAnimationPaste(pinned.document.project, pinned.document.activeSequenceId, clipboard.value, pinned.cursor.playheadFrame, pinned.context, mapping, originalTime))
    },
    init(): () => void {
      if (initialized || liveController) throw new Error('Animation editing already has an owner.')
      initialized = true; liveController = ownerToken
      const revision = ++mountRevision
      const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') active?.cancel() }
      window.addEventListener('keydown', escape)
      const release = useDocumentStore.subscribe((state, previous) => {
        if (state.projectGeneration !== previous.projectGeneration) resetClipboard()
        if (ownedCommit) return
        if (state.activeSequenceId !== previous.activeSequenceId || state.projectGeneration !== previous.projectGeneration) {
          active?.cancel(); useTransportStore.getState().setAnimationSelection([]); return
        }
        if (state.doc !== previous.doc) {
          const transport = useTransportStore.getState()
          const keys = reconcileAnimationKeys(state.doc, transport.animationSelection), focus = nearestAnimationKey(state.doc, transport.animationFocus)
          if (keys.length !== transport.animationSelection.length || (focus ? animationKeyKey(focus) : null) !== (transport.animationFocus ? animationKeyKey(transport.animationFocus) : null)) transport.setAnimationSelection(keys, focus)
        }
      })
      return () => {
        if (!initialized || revision !== mountRevision) return
        release(); window.removeEventListener('keydown', escape); initialized = false
        try { active?.cancel() } finally {
          resetClipboard(); useTransportStore.getState().setAnimationSelection([])
          if (liveController === ownerToken) liveController = null
        }
      }
    },
  }
}
