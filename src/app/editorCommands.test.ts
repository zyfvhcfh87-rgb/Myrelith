import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_MEDIA_IMPORT_STATE,
  useMediaImportStore,
} from '../state/mediaImportStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import { COMMAND_PALETTE_SHORTCUT } from './useCommandPaletteShortcut'
import {
  EDITOR_COMMAND_DEFINITIONS,
  EDITOR_SHORTCUT_BINDINGS,
  executeEditorCommand,
  matchEditorCommandShortcut,
  resolveEditorCommand,
  shortcutBindingSignature,
} from './editorCommands'

function clip(id: string, startFrame: number, durationFrames: number, linkGroupId?: string): Clip {
  return {
    id,
    assetId: 'asset-command',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame, durationFrames },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
    linkGroupId,
  }
}

function track(id: string, clips: Clip[], locked = false): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function documentFixture(tracks: Track[] = [track('V1', [clip('clip-1', 0, 60)])]): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'doc-commands',
    name: 'Command fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks,
    markers: [],
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  useDocumentStore.getState().setDoc(documentFixture())
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE, playheadFrame: 10 })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
})

describe('editor command catalog', () => {
  test('every command id and every global key signature is unique', () => {
    const ids = EDITOR_COMMAND_DEFINITIONS.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)

    const signatures = EDITOR_SHORTCUT_BINDINGS.map(shortcutBindingSignature)
    expect(new Set(signatures).size).toBe(signatures.length)
    expect(signatures).not.toContain(COMMAND_PALETTE_SHORTCUT.signature)
    expect(EDITOR_SHORTCUT_BINDINGS.every(({ commandId }) => ids.includes(commandId)))
      .toBe(true)
  })

  test('history and editing hooks resolve disjoint shortcuts', () => {
    const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })
    const razor = new KeyboardEvent('keydown', { key: 'b' })
    expect(matchEditorCommandShortcut(undo, 'history')).toBe('history.undo')
    expect(matchEditorCommandShortcut(undo, 'edit')).toBeNull()
    expect(matchEditorCommandShortcut(razor, 'edit')).toBe('tool.razor')
    expect(matchEditorCommandShortcut(razor, 'history')).toBeNull()
  })

  test('resolves distinct add/next/previous marker shortcuts', () => {
    expect(matchEditorCommandShortcut(
      new KeyboardEvent('keydown', { key: 'm' }),
      'edit',
    )).toBe('marker.add')
    expect(matchEditorCommandShortcut(
      new KeyboardEvent('keydown', { key: 'M', shiftKey: true }),
      'edit',
    )).toBe('marker.next')
    expect(matchEditorCommandShortcut(
      new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, shiftKey: true }),
      'edit',
    )).toBe('marker.previous')
  })

  test('reports live reasons and refuses unavailable commands', () => {
    useTransportStore.getState().setPlayheadFrame(60)
    useTransportStore.getState().setSelectedClip(null)

    expect(resolveEditorCommand('timeline.split')).toMatchObject({
      enabled: false,
      disabledReason: 'Move the playhead inside an unlocked clip first.',
    })
    expect(resolveEditorCommand('timeline.ripple-delete')).toMatchObject({
      enabled: false,
      disabledReason: 'Select a clip before ripple deleting.',
    })
    const before = useDocumentStore.getState().doc
    expect(executeEditorCommand('timeline.split').executed).toBe(false)
    expect(useDocumentStore.getState().doc).toBe(before)
  })

  test('keeps transport discovery truthful while playback and playhead advance', () => {
    useTransportStore.setState({ playheadFrame: 0, isPlaying: false })
    expect(resolveEditorCommand('transport.previous-frame')).toMatchObject({ enabled: true })
    expect(resolveEditorCommand('transport.toggle-playback')).toMatchObject({
      enabled: true,
      label: 'Play/Pause',
      description: 'Toggle timeline playback from the current frame.',
    })

    useTransportStore.setState({ playheadFrame: 59, isPlaying: true })
    expect(resolveEditorCommand('transport.next-frame')).toMatchObject({ enabled: true })
    expect(resolveEditorCommand('transport.toggle-playback')).toMatchObject({
      enabled: true,
      label: 'Play/Pause',
    })

    useDocumentStore.getState().setDoc(documentFixture([]))
    expect(resolveEditorCommand('transport.toggle-playback')).toMatchObject({
      enabled: false,
      disabledReason: 'Add a clip to the timeline before starting playback.',
    })
  })

  test('executes the same real tool, split, delete, undo, and redo paths', () => {
    expect(executeEditorCommand('tool.razor').executed).toBe(true)
    expect(useTransportStore.getState().tool).toBe('razor')

    expect(executeEditorCommand('timeline.split').executed).toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(2)
    expect(resolveEditorCommand('history.undo').enabled).toBe(true)

    expect(executeEditorCommand('history.undo').executed).toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(1)
    expect(executeEditorCommand('history.redo').executed).toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(2)

    useTransportStore.getState().setSelectedClip('clip-1')
    expect(executeEditorCommand('timeline.ripple-delete').executed).toBe(true)
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(1)
  })

  test('executes marker create, edit, duplicate, navigation, and delete paths', () => {
    expect(executeEditorCommand('marker.add').executed).toBe(true)
    const first = useDocumentStore.getState().doc.markers?.[0]
    expect(first).toMatchObject({ frame: 10, label: 'Marker 1', color: 'yellow' })
    expect(useTransportStore.getState().selectedMarkerId).toBe(first?.id)

    expect(executeEditorCommand('marker.edit').executed).toBe(true)
    expect(useTransportStore.getState().editingMarkerId).toBe(first?.id)
    expect(executeEditorCommand('marker.duplicate').executed).toBe(true)
    const markers = useDocumentStore.getState().doc.markers ?? []
    expect(markers).toHaveLength(2)
    expect(markers[0].frame).toBe(10)
    expect(markers[1].frame).toBe(10)
    expect(new Set(markers.map(({ id }) => id)).size).toBe(2)

    useTransportStore.getState().setSelectedMarker(markers[1].id)
    expect(executeEditorCommand('marker.previous').executed).toBe(true)
    expect(useTransportStore.getState().selectedMarkerId).toBe(markers[0].id)
    expect(executeEditorCommand('marker.next').executed).toBe(true)
    expect(useTransportStore.getState().selectedMarkerId).toBe(markers[1].id)

    expect(executeEditorCommand('marker.delete').executed).toBe(true)
    expect(useDocumentStore.getState().doc.markers).toHaveLength(1)
  })

  test('linked edits explain locked partner blockers without invoking a rejected operation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useDocumentStore.getState().setDoc(documentFixture([
      track('V1', [clip('video', 0, 60, 'linked')]),
      track('V2', [clip('partner', 0, 60, 'linked')], true),
    ]))
    useTransportStore.getState().setSelectedClip('video')

    expect(resolveEditorCommand('timeline.split')).toMatchObject({ enabled: false })
    expect(resolveEditorCommand('timeline.ripple-delete')).toMatchObject({
      enabled: false,
      disabledReason: 'Unlock every track containing a linked clip first.',
    })
    expect(executeEditorCommand('timeline.ripple-delete').executed).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  test('refuses every command while a media import dialog is open', () => {
    useMediaImportStore.setState({
      phase: 'error',
      fileName: 'broken.mp4',
      prompt: null,
      error: 'unsupported container',
    })
    useTransportStore.getState().setSelectedClip('clip-1')

    expect(resolveEditorCommand('tool.trim')).toMatchObject({
      enabled: false,
      disabledReason: 'Finish or cancel the media import first.',
    })
    expect(executeEditorCommand('timeline.ripple-delete').executed).toBe(false)
    expect(useDocumentStore.getState().doc.tracks[0]?.clips).toHaveLength(1)
  })
})
