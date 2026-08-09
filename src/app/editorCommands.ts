/**
 * app/editorCommands.ts — the editor's discoverable command catalog.
 *
 * The catalog intentionally contains only capabilities that already have a
 * real controller/store path. Global shortcut hooks and the command palette
 * both execute through this module, so a discovered command cannot drift from
 * its keyboard behavior. Reads use getState() and never subscribe a surface
 * to playback, scrubbing, or timeline render loops.
 */

import type { Clip, TimelineDoc } from '../domain/schema'
import { docDurationFrames, findClip, trackOfClip } from '../domain/selectors'
import { rangeEnd } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useTransportStore, type TimelineTool } from '../state/transportStore'
import { stepFrame, togglePlayback } from './transportController'

export type EditorCommandId =
  | 'history.undo'
  | 'history.redo'
  | 'tool.select'
  | 'tool.razor'
  | 'tool.trim'
  | 'tool.slip'
  | 'tool.slide'
  | 'timeline.split'
  | 'timeline.ripple-delete'
  | 'transport.previous-frame'
  | 'transport.toggle-playback'
  | 'transport.next-frame'

export type EditorCommandScope = 'edit' | 'history'
export type EditorCommandCategory = 'History' | 'Tools' | 'Timeline' | 'Transport'

export interface EditorCommandShortcut {
  readonly label: string
  readonly ariaKeyShortcuts: string
}

export interface EditorCommandDefinition {
  readonly id: EditorCommandId
  readonly category: EditorCommandCategory
  readonly label: string
  readonly description: string
  readonly keywords: readonly string[]
  readonly shortcut?: EditorCommandShortcut
}

export interface ResolvedEditorCommand extends EditorCommandDefinition {
  readonly enabled: boolean
  readonly disabledReason: string | null
}

export interface EditorCommandExecution {
  readonly executed: boolean
  readonly reason: string | null
}

export interface EditorShortcutBinding {
  readonly commandId: EditorCommandId
  readonly scope: EditorCommandScope
  readonly key: string
  readonly primary: boolean
  /** Undefined means either shifted or unshifted resolves to the same key. */
  readonly shift?: boolean
}

export const EDITOR_COMMAND_DEFINITIONS: readonly EditorCommandDefinition[] = [
  {
    id: 'history.undo',
    category: 'History',
    label: 'Undo',
    description: 'Undo the most recent document edit.',
    keywords: ['back', 'history', 'revert'],
    shortcut: {
      label: 'Ctrl/⌘+Z',
      ariaKeyShortcuts: 'Control+Z Meta+Z',
    },
  },
  {
    id: 'history.redo',
    category: 'History',
    label: 'Redo',
    description: 'Restore the next undone document edit.',
    keywords: ['forward', 'history', 'restore'],
    shortcut: {
      label: 'Ctrl/⌘+Shift+Z or Ctrl/⌘+Y',
      ariaKeyShortcuts: 'Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y',
    },
  },
  {
    id: 'tool.select',
    category: 'Tools',
    label: 'Select tool',
    description: 'Move clips and drag clip edges to trim.',
    keywords: ['cursor', 'move', 'trim'],
    shortcut: { label: 'A', ariaKeyShortcuts: 'A' },
  },
  {
    id: 'tool.razor',
    category: 'Tools',
    label: 'Razor tool',
    description: 'Cut one clip where you click it.',
    keywords: ['blade', 'cut', 'split'],
    shortcut: { label: 'B', ariaKeyShortcuts: 'B' },
  },
  {
    id: 'tool.trim',
    category: 'Tools',
    label: 'Ripple trim tool',
    description: 'Trim an edge and move later clips with it.',
    keywords: ['edge', 'ripple'],
    shortcut: { label: 'T', ariaKeyShortcuts: 'T' },
  },
  {
    id: 'tool.slip',
    category: 'Tools',
    label: 'Slip tool',
    description: 'Change which source material plays without moving the clip.',
    keywords: ['source', 'material'],
    shortcut: { label: 'Y', ariaKeyShortcuts: 'Y' },
  },
  {
    id: 'tool.slide',
    category: 'Tools',
    label: 'Slide tool',
    description: 'Move a clip while its neighboring clips absorb the change.',
    keywords: ['neighbors', 'move'],
    shortcut: { label: 'U', ariaKeyShortcuts: 'U' },
  },
  {
    id: 'timeline.split',
    category: 'Timeline',
    label: 'Split at playhead',
    description: 'Split every editable clip crossed by the playhead.',
    keywords: ['cut', 'razor', 'playhead'],
    shortcut: { label: 'S', ariaKeyShortcuts: 'S' },
  },
  {
    id: 'timeline.ripple-delete',
    category: 'Timeline',
    label: 'Ripple delete selected clip',
    description: 'Delete the primary selected clip and close the resulting gap.',
    keywords: ['remove', 'selection', 'close gap'],
    shortcut: {
      label: 'Delete or Backspace',
      ariaKeyShortcuts: 'Delete Backspace',
    },
  },
  {
    id: 'transport.previous-frame',
    category: 'Transport',
    label: 'Previous frame',
    description: 'Pause and move the playhead back by exactly one frame.',
    keywords: ['back', 'step', 'playhead'],
    shortcut: { label: '←', ariaKeyShortcuts: 'ArrowLeft' },
  },
  {
    id: 'transport.toggle-playback',
    category: 'Transport',
    label: 'Play/Pause',
    description: 'Toggle timeline playback from the current frame.',
    keywords: ['pause', 'preview', 'transport'],
  },
  {
    id: 'transport.next-frame',
    category: 'Transport',
    label: 'Next frame',
    description: 'Pause and move the playhead forward by exactly one frame.',
    keywords: ['forward', 'step', 'playhead'],
    shortcut: { label: '→', ariaKeyShortcuts: 'ArrowRight' },
  },
]

export const EDITOR_SHORTCUT_BINDINGS: readonly EditorShortcutBinding[] = [
  { commandId: 'history.undo', scope: 'history', key: 'z', primary: true, shift: false },
  { commandId: 'history.redo', scope: 'history', key: 'z', primary: true, shift: true },
  { commandId: 'history.redo', scope: 'history', key: 'y', primary: true, shift: false },
  { commandId: 'tool.select', scope: 'edit', key: 'a', primary: false },
  { commandId: 'tool.razor', scope: 'edit', key: 'b', primary: false },
  { commandId: 'tool.trim', scope: 'edit', key: 't', primary: false },
  { commandId: 'tool.slip', scope: 'edit', key: 'y', primary: false },
  { commandId: 'tool.slide', scope: 'edit', key: 'u', primary: false },
  { commandId: 'timeline.split', scope: 'edit', key: 's', primary: false },
  { commandId: 'timeline.ripple-delete', scope: 'edit', key: 'delete', primary: false },
  { commandId: 'timeline.ripple-delete', scope: 'edit', key: 'backspace', primary: false },
  { commandId: 'transport.previous-frame', scope: 'edit', key: 'arrowleft', primary: false },
  { commandId: 'transport.next-frame', scope: 'edit', key: 'arrowright', primary: false },
]

const TOOL_BY_COMMAND: Readonly<Partial<Record<EditorCommandId, TimelineTool>>> = {
  'tool.select': 'select',
  'tool.razor': 'razor',
  'tool.trim': 'trim',
  'tool.slip': 'slip',
  'tool.slide': 'slide',
}

function strictRangeContains(clip: Clip, frame: number): boolean {
  return frame > clip.timelineRange.startFrame
    && frame < rangeEnd(clip.timelineRange)
}

function linkedMembersAreEditable(
  doc: TimelineDoc,
  clip: Clip,
  frame?: number,
): boolean {
  if (!clip.linkGroupId) return true
  return doc.tracks.every((track) => {
    if (!track.locked) return true
    return track.clips.every((member) => (
      member.linkGroupId !== clip.linkGroupId
      || (frame !== undefined && !strictRangeContains(member, frame))
    ))
  })
}

function canSplitAtPlayhead(doc: TimelineDoc, frame: number): boolean {
  return doc.tracks.some((track) => (
    !track.locked
    && track.clips.some((clip) => (
      strictRangeContains(clip, frame)
      && linkedMembersAreEditable(doc, clip, frame)
    ))
  ))
}

function rippleDeleteDisabledReason(doc: TimelineDoc, clipId: string | null): string | null {
  if (!clipId) return 'Select a clip before ripple deleting.'
  const clip = findClip(doc, clipId)
  if (!clip) return 'The selected clip is no longer in the timeline.'
  const track = trackOfClip(doc, clipId)
  if (!track || track.locked) return 'Unlock the selected clip’s track first.'
  if (!linkedMembersAreEditable(doc, clip)) {
    return 'Unlock every track containing a linked clip first.'
  }
  return null
}

function commandDisabledReason(id: EditorCommandId): string | null {
  const session = useProjectSessionStore.getState()
  if (session.phase === 'closing') return 'Wait until the project finishes closing.'

  const document = useDocumentStore.getState()
  const transport = useTransportStore.getState()
  const duration = docDurationFrames(document.doc)
  const tool = TOOL_BY_COMMAND[id]

  if (tool) {
    return transport.tool === tool ? `${definitionFor(id).label} is already active.` : null
  }

  switch (id) {
    case 'history.undo':
      return document.past.length === 0 ? 'There is no document edit to undo.' : null
    case 'history.redo':
      return document.future.length === 0 ? 'There is no document edit to redo.' : null
    case 'timeline.split':
      return canSplitAtPlayhead(document.doc, transport.playheadFrame)
        ? null
        : 'Move the playhead inside an unlocked clip first.'
    case 'timeline.ripple-delete':
      return rippleDeleteDisabledReason(document.doc, transport.selectedClipId)
    case 'transport.toggle-playback':
      return duration === 0
        ? 'Add a clip to the timeline before starting playback.'
        : null
  }
  return null
}

function definitionFor(id: EditorCommandId): EditorCommandDefinition {
  const definition = EDITOR_COMMAND_DEFINITIONS.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`Unknown editor command: ${id}`)
  return definition
}

export function resolveEditorCommand(id: EditorCommandId): ResolvedEditorCommand {
  const definition = definitionFor(id)
  const disabledReason = commandDisabledReason(id)
  return { ...definition, enabled: disabledReason === null, disabledReason }
}

export function resolveEditorCommands(): readonly ResolvedEditorCommand[] {
  return EDITOR_COMMAND_DEFINITIONS.map(({ id }) => resolveEditorCommand(id))
}

export function executeEditorCommand(id: EditorCommandId): EditorCommandExecution {
  const resolved = resolveEditorCommand(id)
  if (!resolved.enabled) return { executed: false, reason: resolved.disabledReason }

  const document = useDocumentStore.getState()
  const transport = useTransportStore.getState()
  const tool = TOOL_BY_COMMAND[id]
  if (tool) {
    transport.setTool(tool)
    return { executed: true, reason: null }
  }

  switch (id) {
    case 'history.undo':
      document.undo()
      break
    case 'history.redo':
      document.redo()
      break
    case 'timeline.split':
      document.splitClipAtPlayhead(transport.playheadFrame)
      break
    case 'timeline.ripple-delete':
      document.rippleDelete(transport.selectedClipId!)
      break
    case 'transport.previous-frame':
      stepFrame(-1)
      break
    case 'transport.toggle-playback':
      togglePlayback()
      break
    case 'transport.next-frame':
      stepFrame(1)
      break
  }
  return { executed: true, reason: null }
}

function matchesBinding(event: KeyboardEvent, binding: EditorShortcutBinding): boolean {
  const hasPrimary = event.ctrlKey || event.metaKey
  return event.key.toLowerCase() === binding.key
    && hasPrimary === binding.primary
    && (binding.shift === undefined || event.shiftKey === binding.shift)
}

export function matchEditorCommandShortcut(
  event: KeyboardEvent,
  scope: EditorCommandScope,
): EditorCommandId | null {
  if (event.altKey || event.isComposing) return null
  return EDITOR_SHORTCUT_BINDINGS.find((binding) => (
    binding.scope === scope && matchesBinding(event, binding)
  ))?.commandId ?? null
}

export function shortcutBindingSignature(binding: EditorShortcutBinding): string {
  const shift = binding.shift === undefined ? 'either-shift' : binding.shift ? 'shift' : 'no-shift'
  return `${binding.primary ? 'primary' : 'bare'}:${shift}:${binding.key}`
}

export function shortcutForCommand(id: EditorCommandId): EditorCommandShortcut | undefined {
  return definitionFor(id).shortcut
}
