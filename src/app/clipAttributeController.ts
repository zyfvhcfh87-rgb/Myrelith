import {
  captureClipAttributes, supportedClipAttributeGroups, CLIP_ATTRIBUTE_LABELS,
  type AttributePasteOptions, type ClipAttributeGroup, type ClipAttributeTemplate,
} from '../domain/clipAttributes'
import type { SequenceProject } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useClipAttributeStore } from '../state/clipAttributeStore'

interface Clipboard {
  generation: number
  template: ClipAttributeTemplate
}
let clipboard: Clipboard | null = null

function report(message: string): void { useClipAttributeStore.setState({ message }) }
function clear(): void {
  clipboard = null
  useClipAttributeStore.setState({ sourceName: null, groups: [], message: '' })
}

export function initClipAttributeClipboard(): () => void {
  const unsubscribe = useDocumentStore.subscribe((state, previous) => {
    if (state.projectGeneration !== previous.projectGeneration) clear()
  })
  return () => { unsubscribe(); clear() }
}

export function copyClipAttributes(clipId: string, effectIds?: readonly string[]): void {
  const state = useDocumentStore.getState()
  const track = state.doc.tracks.find((track) => track.clips.some((clip) => clip.id === clipId))
  const clip = track?.clips.find((clip) => clip.id === clipId)
  if (!track || !clip) { report('The source clip no longer exists.'); return }
  const groups = effectIds === undefined ? supportedClipAttributeGroups(track.kind) : ['effects'] as const
  const result = captureClipAttributes(clip, track.kind, groups, effectIds)
  if (!result.ok) { report(result.reason); return }
  clipboard = { generation: state.projectGeneration, template: result.template }
  useClipAttributeStore.setState({ sourceName: clip.name, groups, message: `Copied ${effectIds === undefined ? 'attributes' : 'effects'} from ${clip.name}.` })
}

/** Complete-stack copy preserves orphan tracks; checked-effects copy excludes them. */
export function copyClipEffectStack(clipId: string): void {
  const state = useDocumentStore.getState()
  const track = state.doc.tracks.find((track) => track.clips.some((clip) => clip.id === clipId))
  const clip = track?.clips.find((clip) => clip.id === clipId)
  if (!track || !clip) { report('The source clip no longer exists.'); return }
  const result = captureClipAttributes(clip, track.kind, ['effects'])
  if (!result.ok) { report(result.reason); return }
  clipboard = { generation: state.projectGeneration, template: result.template }
  useClipAttributeStore.setState({ sourceName: clip.name, groups: ['effects'], message: `Copied the effect stack from ${clip.name}.` })
}

export interface AttributeEditSession {
  readonly project: SequenceProject
  readonly generation: number
  readonly sequenceId: string
  readonly targetIds: readonly string[]
  readonly targetNames: readonly string[]
  readonly groups: readonly ClipAttributeGroup[]
  readonly template: ClipAttributeTemplate | null
}

export function openAttributeEdit(mode: 'paste' | 'reset'): AttributeEditSession {
  const state = useDocumentStore.getState()
  const targetIds = [...useTransportStore.getState().selectedClipIds]
  const targets = state.doc.tracks.flatMap((track) => track.clips
    .filter((clip) => targetIds.includes(clip.id)).map((clip) => ({ clip, kind: track.kind })))
  const validClipboard = clipboard?.generation === state.projectGeneration ? clipboard : null
  const groups = mode === 'paste'
    ? validClipboard?.template.attributes.map((attribute) => attribute.kind) ?? []
    : Object.keys(CLIP_ATTRIBUTE_LABELS) as ClipAttributeGroup[]
  return {
    project: state.project, generation: state.projectGeneration, sequenceId: state.activeSequenceId,
    targetIds, targetNames: targets.map(({ clip }) => clip.name),
    groups: groups.filter((group) => targets.every(({ kind }) => supportedClipAttributeGroups(kind).includes(group))),
    template: validClipboard?.template ?? null,
  }
}

export function applyAttributeEdit(
  session: AttributeEditSession,
  mode: 'paste' | 'reset',
  options: AttributePasteOptions,
): string | null {
  const state = useDocumentStore.getState()
  const selected = useTransportStore.getState().selectedClipIds
  if (state.projectGeneration !== session.generation || state.project !== session.project
    || state.activeSequenceId !== session.sequenceId
    || selected.length !== session.targetIds.length
    || selected.some((id, index) => id !== session.targetIds[index])) {
    return 'The project or selection changed. Reopen the attribute dialog.'
  }
  if (mode === 'paste' && !session.template) return 'Copy attributes or effects first.'
  const error = state.applyClipAttributes(session.project, session.sequenceId,
    mode === 'paste' && session.template
      ? { kind: 'paste', targetIds: session.targetIds, template: session.template, options }
      : { kind: 'reset', targetIds: session.targetIds, groups: options.groups })
  if (!error) report(`${mode === 'paste' ? 'Pasted' : 'Reset'} attributes on ${session.targetIds.length} clip${session.targetIds.length === 1 ? '' : 's'}.`)
  return error
}
