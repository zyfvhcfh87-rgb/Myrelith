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
import {
  createDefaultTimelineMarker,
  createTimelineMarkerId,
  findTimelineMarker,
  MAX_TIMELINE_MARKERS,
  nextTimelineMarker,
  previousTimelineMarker,
  timelineMarkers,
} from '../domain/timelineMarkers'
import { rangeEnd } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaImportStore } from '../state/mediaImportStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore, type TimelineTool } from '../state/transportStore'
import {
  openSelectedSource,
  sourceOpenDisabledReason,
} from './sourceMonitorController'
import {
  closeSource,
  jumpToEnd,
  jumpToStart,
  resetSession,
  stepShuttle,
} from './sourceMonitorPlaybackController'
import { stepFrame, togglePlayback } from './transportController'
import {
  executeFocusedClearIn,
  executeFocusedClearOut,
  executeFocusedMarkIn,
  executeFocusedMarkOut,
  executeSequenceEdit,
  sequenceEditDisabledReason,
} from './sequenceEditController'

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
  | 'timeline.insert'
  | 'timeline.overwrite'
  | 'timeline.lift'
  | 'timeline.extract'
  | 'timeline.replace'
  | 'timeline.roll-left'
  | 'timeline.roll-right'
  | 'marks.mark-in'
  | 'marks.mark-out'
  | 'marks.clear-in'
  | 'marks.clear-out'
  | 'marker.add'
  | 'marker.previous'
  | 'marker.next'
  | 'marker.edit'
  | 'marker.duplicate'
  | 'marker.delete'
  | 'transport.previous-frame'
  | 'transport.toggle-playback'
  | 'transport.next-frame'
  | 'source.open'
  | 'source.close'
  | 'source.reset'
  | 'source.shuttle-j'
  | 'source.shuttle-k'
  | 'source.shuttle-l'
  | 'source.mark-in'
  | 'source.mark-out'
  | 'source.clear-in'
  | 'source.clear-out'
  | 'source.jump-start'
  | 'source.jump-end'

export type EditorCommandScope = 'edit' | 'history'
export type EditorCommandCategory =
  | 'History'
  | 'Tools'
  | 'Timeline'
  | 'Markers'
  | 'Transport'
  | 'Source'

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
    id: 'timeline.insert',
    category: 'Timeline',
    label: 'Insert edit',
    description: 'Insert the Source Monitor range at the playhead and ripple later clips.',
    keywords: ['three-point', 'source', 'ripple'],
    shortcut: { label: ',', ariaKeyShortcuts: 'Comma' },
  },
  {
    id: 'timeline.overwrite',
    category: 'Timeline',
    label: 'Overwrite edit',
    description: 'Overwrite the targeted tracks with the Source Monitor range.',
    keywords: ['three-point', 'source'],
    shortcut: { label: '.', ariaKeyShortcuts: 'Period' },
  },
  {
    id: 'timeline.lift',
    category: 'Timeline',
    label: 'Lift',
    description: 'Remove the timeline In/Out range and leave a gap.',
    keywords: ['in', 'out', 'remove'],
    shortcut: { label: ';', ariaKeyShortcuts: 'Semicolon' },
  },
  {
    id: 'timeline.extract',
    category: 'Timeline',
    label: 'Extract',
    description: 'Remove the timeline In/Out range and close the gap.',
    keywords: ['in', 'out', 'ripple'],
    shortcut: { label: '\'', ariaKeyShortcuts: "'" },
  },
  {
    id: 'timeline.replace',
    category: 'Timeline',
    label: 'Replace edit',
    description: 'Replace the selected clip from the Source Monitor without retiming.',
    keywords: ['source', 'swap'],
    shortcut: { label: 'R', ariaKeyShortcuts: 'R' },
  },
  {
    id: 'timeline.roll-left',
    category: 'Timeline',
    label: 'Roll seam left',
    description: 'Move the touching seam at the playhead one frame earlier.',
    keywords: ['roll', 'seam', 'trim'],
    shortcut: { label: '[', ariaKeyShortcuts: '[' },
  },
  {
    id: 'timeline.roll-right',
    category: 'Timeline',
    label: 'Roll seam right',
    description: 'Move the touching seam at the playhead one frame later.',
    keywords: ['roll', 'seam', 'trim'],
    shortcut: { label: ']', ariaKeyShortcuts: ']' },
  },
  {
    id: 'marks.mark-in',
    category: 'Timeline',
    label: 'Mark In',
    description: 'Set In on the focused Source or Program monitor.',
    keywords: ['in', 'mark', 'source', 'timeline'],
    shortcut: { label: 'I', ariaKeyShortcuts: 'I' },
  },
  {
    id: 'marks.mark-out',
    category: 'Timeline',
    label: 'Mark Out',
    description: 'Set Out on the focused Source or Program monitor.',
    keywords: ['mark', 'out', 'source', 'timeline'],
    shortcut: { label: 'O', ariaKeyShortcuts: 'O' },
  },
  {
    id: 'marks.clear-in',
    category: 'Timeline',
    label: 'Clear In',
    description: 'Clear In on the focused Source or Program monitor.',
    keywords: ['clear', 'in', 'source', 'timeline'],
    shortcut: { label: 'Shift+I', ariaKeyShortcuts: 'Shift+I' },
  },
  {
    id: 'marks.clear-out',
    category: 'Timeline',
    label: 'Clear Out',
    description: 'Clear Out on the focused Source or Program monitor.',
    keywords: ['clear', 'out', 'source', 'timeline'],
    shortcut: { label: 'Shift+O', ariaKeyShortcuts: 'Shift+O' },
  },
  {
    id: 'marker.add',
    category: 'Markers',
    label: 'Add marker',
    description: 'Add a sequence marker at the current playhead frame.',
    keywords: ['cue', 'note', 'beat', 'flag'],
    shortcut: { label: 'M', ariaKeyShortcuts: 'M' },
  },
  {
    id: 'marker.previous',
    category: 'Markers',
    label: 'Previous marker',
    description: 'Move the playhead and selection to the previous marker.',
    keywords: ['back', 'navigate', 'cue'],
    shortcut: {
      label: 'Ctrl/⌘+Shift+M',
      ariaKeyShortcuts: 'Control+Shift+M Meta+Shift+M',
    },
  },
  {
    id: 'marker.next',
    category: 'Markers',
    label: 'Next marker',
    description: 'Move the playhead and selection to the next marker.',
    keywords: ['forward', 'navigate', 'cue'],
    shortcut: { label: 'Shift+M', ariaKeyShortcuts: 'Shift+M' },
  },
  {
    id: 'marker.edit',
    category: 'Markers',
    label: 'Edit selected marker',
    description: 'Edit the selected marker label, frame, color, and note.',
    keywords: ['rename', 'move', 'color', 'note'],
  },
  {
    id: 'marker.duplicate',
    category: 'Markers',
    label: 'Duplicate selected marker',
    description: 'Create a new marker with the selected marker’s details.',
    keywords: ['copy', 'clone', 'cue'],
  },
  {
    id: 'marker.delete',
    category: 'Markers',
    label: 'Delete selected marker',
    description: 'Remove the selected sequence marker.',
    keywords: ['remove', 'clear', 'cue'],
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
  {
    id: 'source.open',
    category: 'Source',
    label: 'Open in Source Monitor',
    description: 'Open the selected Media Pool asset for source review.',
    keywords: ['clip', 'monitor', 'review', 'source'],
    shortcut: {
      label: 'Shift+Enter',
      ariaKeyShortcuts: 'Shift+Enter',
    },
  },
  {
    id: 'source.close',
    category: 'Source',
    label: 'Close Source Monitor',
    description: 'Close the Source Monitor session without changing the timeline.',
    keywords: ['monitor', 'review', 'source'],
  },
  {
    id: 'source.reset',
    category: 'Source',
    label: 'Reset Source Monitor',
    description: 'Clear In/Out marks and return the source playhead to the first frame.',
    keywords: ['clear', 'marks', 'source'],
  },
  {
    id: 'source.shuttle-j',
    category: 'Source',
    label: 'Source shuttle reverse',
    description: 'Step Source Monitor shuttle toward reverse 1-2-4-8.',
    keywords: ['jkl', 'shuttle', 'source'],
    shortcut: { label: 'J', ariaKeyShortcuts: 'J' },
  },
  {
    id: 'source.shuttle-k',
    category: 'Source',
    label: 'Source shuttle pause',
    description: 'Stop Source Monitor shuttle.',
    keywords: ['jkl', 'pause', 'source'],
    shortcut: { label: 'K', ariaKeyShortcuts: 'K' },
  },
  {
    id: 'source.shuttle-l',
    category: 'Source',
    label: 'Source shuttle forward',
    description: 'Step Source Monitor shuttle toward forward 1-2-4-8.',
    keywords: ['jkl', 'shuttle', 'source'],
    shortcut: { label: 'L', ariaKeyShortcuts: 'L' },
  },
  {
    id: 'source.mark-in',
    category: 'Source',
    label: 'Mark source In',
    description: 'Set the Source Monitor In at the current source frame.',
    keywords: ['in', 'mark', 'source'],
  },
  {
    id: 'source.mark-out',
    category: 'Source',
    label: 'Mark source Out',
    description: 'Set the Source Monitor Out to include the current source frame.',
    keywords: ['mark', 'out', 'source'],
  },
  {
    id: 'source.clear-in',
    category: 'Source',
    label: 'Clear source In',
    description: 'Clear the Source Monitor In mark.',
    keywords: ['clear', 'in', 'source'],
  },
  {
    id: 'source.clear-out',
    category: 'Source',
    label: 'Clear source Out',
    description: 'Clear the Source Monitor Out mark.',
    keywords: ['clear', 'out', 'source'],
  },
  {
    id: 'source.jump-start',
    category: 'Source',
    label: 'Jump to source start',
    description: 'Move the Source Monitor playhead to the first source frame.',
    keywords: ['begin', 'home', 'source', 'start'],
    shortcut: { label: 'Home', ariaKeyShortcuts: 'Home' },
  },
  {
    id: 'source.jump-end',
    category: 'Source',
    label: 'Jump to source end',
    description: 'Move the Source Monitor playhead to the last source frame.',
    keywords: ['end', 'last', 'source'],
    shortcut: { label: 'End', ariaKeyShortcuts: 'End' },
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
  { commandId: 'timeline.insert', scope: 'edit', key: ',', primary: false },
  { commandId: 'timeline.overwrite', scope: 'edit', key: '.', primary: false },
  { commandId: 'timeline.lift', scope: 'edit', key: ';', primary: false },
  { commandId: 'timeline.extract', scope: 'edit', key: '\'', primary: false },
  { commandId: 'timeline.replace', scope: 'edit', key: 'r', primary: false },
  { commandId: 'timeline.roll-left', scope: 'edit', key: '[', primary: false },
  { commandId: 'timeline.roll-right', scope: 'edit', key: ']', primary: false },
  { commandId: 'marks.mark-in', scope: 'edit', key: 'i', primary: false, shift: false },
  { commandId: 'marks.mark-out', scope: 'edit', key: 'o', primary: false, shift: false },
  { commandId: 'marks.clear-in', scope: 'edit', key: 'i', primary: false, shift: true },
  { commandId: 'marks.clear-out', scope: 'edit', key: 'o', primary: false, shift: true },
  { commandId: 'marker.add', scope: 'edit', key: 'm', primary: false, shift: false },
  { commandId: 'marker.next', scope: 'edit', key: 'm', primary: false, shift: true },
  { commandId: 'marker.previous', scope: 'edit', key: 'm', primary: true, shift: true },
  { commandId: 'transport.previous-frame', scope: 'edit', key: 'arrowleft', primary: false },
  { commandId: 'transport.next-frame', scope: 'edit', key: 'arrowright', primary: false },
  { commandId: 'source.open', scope: 'edit', key: 'enter', primary: false, shift: true },
  { commandId: 'source.shuttle-j', scope: 'edit', key: 'j', primary: false, shift: false },
  { commandId: 'source.shuttle-k', scope: 'edit', key: 'k', primary: false, shift: false },
  { commandId: 'source.shuttle-l', scope: 'edit', key: 'l', primary: false, shift: false },
  { commandId: 'source.jump-start', scope: 'edit', key: 'home', primary: false, shift: false },
  { commandId: 'source.jump-end', scope: 'edit', key: 'end', primary: false, shift: false },
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
  if (useMediaImportStore.getState().phase !== 'idle') {
    return 'Finish or cancel the media import first.'
  }

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
    case 'timeline.insert':
      return sequenceEditDisabledReason('insert')
    case 'timeline.overwrite':
      return sequenceEditDisabledReason('overwrite')
    case 'timeline.lift':
      return sequenceEditDisabledReason('lift')
    case 'timeline.extract':
      return sequenceEditDisabledReason('extract')
    case 'timeline.replace':
      return sequenceEditDisabledReason('replace')
    case 'timeline.roll-left':
      return sequenceEditDisabledReason('roll', { rollDeltaFrames: -1 })
    case 'timeline.roll-right':
      return sequenceEditDisabledReason('roll', { rollDeltaFrames: 1 })
    case 'marks.mark-in':
    case 'marks.mark-out':
    case 'marks.clear-in':
    case 'marks.clear-out':
      return null
    case 'marker.add':
      return timelineMarkers(document.doc).length >= MAX_TIMELINE_MARKERS
        ? `This project already has ${MAX_TIMELINE_MARKERS} markers.`
        : null
    case 'marker.previous':
      return previousTimelineMarker(
        document.doc,
        transport.playheadFrame,
        transport.selectedMarkerId,
      ) ? null : 'There is no previous marker.'
    case 'marker.next':
      return nextTimelineMarker(
        document.doc,
        transport.playheadFrame,
        transport.selectedMarkerId,
      ) ? null : 'There is no next marker.'
    case 'marker.edit':
    case 'marker.duplicate':
    case 'marker.delete':
      return transport.selectedMarkerId
        && findTimelineMarker(document.doc, transport.selectedMarkerId)
        ? null : 'Select a marker first.'
    case 'transport.toggle-playback':
      return duration === 0
        ? 'Add a clip to the timeline before starting playback.'
        : null
    case 'source.open':
      return sourceOpenDisabledReason()
    case 'source.close':
      return useSourceMonitorStore.getState().session
        || useSourceMonitorStore.getState().lastOpenRejection
        ? null
        : 'Open a source in the Source Monitor first.'
    case 'source.reset':
    case 'source.shuttle-j':
    case 'source.shuttle-k':
    case 'source.shuttle-l':
    case 'source.mark-in':
    case 'source.mark-out':
    case 'source.clear-in':
    case 'source.clear-out':
    case 'source.jump-start':
    case 'source.jump-end':
      return useSourceMonitorStore.getState().session
        ? null
        : 'Open a source in the Source Monitor first.'
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
    case 'timeline.insert':
      return executeSequenceEdit('insert')
    case 'timeline.overwrite':
      return executeSequenceEdit('overwrite')
    case 'timeline.lift':
      return executeSequenceEdit('lift')
    case 'timeline.extract':
      return executeSequenceEdit('extract')
    case 'timeline.replace':
      return executeSequenceEdit('replace')
    case 'timeline.roll-left':
      return executeSequenceEdit('roll', { rollDeltaFrames: -1 })
    case 'timeline.roll-right':
      return executeSequenceEdit('roll', { rollDeltaFrames: 1 })
    case 'marks.mark-in':
      executeFocusedMarkIn()
      break
    case 'marks.mark-out':
      executeFocusedMarkOut()
      break
    case 'marks.clear-in':
      executeFocusedClearIn()
      break
    case 'marks.clear-out':
      executeFocusedClearOut()
      break
    case 'marker.add': {
      const marker = createDefaultTimelineMarker(document.doc, transport.playheadFrame)
      document.addTimelineMarker(marker)
      transport.setSelectedMarker(marker.id)
      break
    }
    case 'marker.previous': {
      const marker = previousTimelineMarker(
        document.doc,
        transport.playheadFrame,
        transport.selectedMarkerId,
      )!
      transport.setSelectedMarker(marker.id)
      transport.setPlayheadFrame(marker.frame)
      break
    }
    case 'marker.next': {
      const marker = nextTimelineMarker(
        document.doc,
        transport.playheadFrame,
        transport.selectedMarkerId,
      )!
      transport.setSelectedMarker(marker.id)
      transport.setPlayheadFrame(marker.frame)
      break
    }
    case 'marker.edit':
      transport.setEditingMarker(transport.selectedMarkerId)
      break
    case 'marker.duplicate': {
      const duplicateId = createTimelineMarkerId(document.doc)
      document.duplicateTimelineMarker(transport.selectedMarkerId!, duplicateId)
      transport.setSelectedMarker(duplicateId)
      transport.setEditingMarker(duplicateId)
      break
    }
    case 'marker.delete':
      document.deleteTimelineMarker(transport.selectedMarkerId!)
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
    case 'source.open':
      openSelectedSource()
      break
    case 'source.close':
      closeSource()
      break
    case 'source.reset':
      resetSession()
      break
    case 'source.shuttle-j':
      stepShuttle('j')
      break
    case 'source.shuttle-k':
      stepShuttle('k')
      break
    case 'source.shuttle-l':
      stepShuttle('l')
      break
    case 'source.mark-in':
      useSourceMonitorStore.getState().setIn()
      break
    case 'source.mark-out':
      useSourceMonitorStore.getState().setOut()
      break
    case 'source.clear-in':
      useSourceMonitorStore.getState().clearIn()
      break
    case 'source.clear-out':
      useSourceMonitorStore.getState().clearOut()
      break
    case 'source.jump-start':
      jumpToStart()
      break
    case 'source.jump-end':
      jumpToEnd()
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
