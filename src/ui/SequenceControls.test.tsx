import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { Clip, TimelineDoc } from '../domain/schema'
import { defaultSourceTimeMap } from '../domain/sourceTimeMap'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useSequenceInstanceSelectionStore } from '../state/sequenceInstanceSelectionStore'
import SequenceControls from './SequenceControls'

describe('SequenceControls', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(createTimelineDoc(
      'Main edit',
      DEFAULT_PROJECT_SETTINGS,
      'sequence-main',
    ))
    vi.stubGlobal('confirm', vi.fn(() => true))
    useTransportStore.getState().setSelectedClip(null)
    useSequenceInstanceSelectionStore.getState().setSelectedInstanceId(null)
  })

  test('creates, navigates, renames, duplicates, roots, and deletes definitions', () => {
    render(<SequenceControls />)

    const picker = screen.getByRole('combobox', { name: 'Active sequence' })
    expect(picker).toHaveValue('sequence-main')
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    fireEvent.change(screen.getByLabelText('Create sequence'), {
      target: { value: 'Scene two' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    const createdId = useDocumentStore.getState().activeSequenceId
    expect(createdId).not.toBe('sequence-main')
    expect(picker).toHaveValue(createdId)
    expect(screen.getByRole('option', { name: 'Scene two' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Rename sequence'), {
      target: { value: 'Scene two final' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('option', { name: 'Scene two final' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    fireEvent.change(screen.getByLabelText('Duplicate sequence'), {
      target: { value: 'Scene two copy' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const duplicateId = useDocumentStore.getState().activeSequenceId
    expect(duplicateId).not.toBe(createdId)

    fireEvent.click(screen.getByRole('button', { name: 'Make root' }))
    expect(useDocumentStore.getState().project.rootSequenceId).toBe(duplicateId)
    expect(screen.getByText('Root: Scene two copy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()

    fireEvent.change(picker, { target: { value: createdId } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(useDocumentStore.getState().project.sequences.some(
      (sequence) => sequence.id === createdId,
    )).toBe(false)
    expect(useDocumentStore.getState().activeSequenceId).toBe(duplicateId)
  })

  test('rejects blank names without changing history', () => {
    render(<SequenceControls />)
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    fireEvent.change(screen.getByLabelText('Create sequence'), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(useDocumentStore.getState().project.sequences).toHaveLength(1)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('cannot be empty')
  })

  test('creates a compound from selection and navigates into it and back', () => {
    const clip: Clip = {
      id: 'scene-clip',
      assetId: 'asset-scene',
      name: 'Scene clip',
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 12 },
      sourceTimeMap: defaultSourceTimeMap(0, 12),
      timelineRange: { startFrame: 8, durationFrames: 12 },
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
      },
      opacity: 1,
      volume: 1,
      effects: [],
    }
    const base = createTimelineDoc('Main edit', DEFAULT_PROJECT_SETTINGS, 'sequence-main')
    const doc: TimelineDoc = {
      ...base,
      tracks: [{ ...base.tracks[0], clips: [clip] }],
    }
    useDocumentStore.getState().setDoc(doc)
    useTransportStore.getState().setClipSelection(['scene-clip'], 'scene-clip')
    render(<SequenceControls />)

    fireEvent.click(screen.getByRole('button', { name: 'Create compound' }))
    fireEvent.change(screen.getByLabelText('Create compound'), {
      target: { value: 'Opening scene' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    const state = useDocumentStore.getState()
    expect(state.project.sequences).toHaveLength(2)
    const instance = state.doc.tracks[0].sequenceInstances?.[0]
    expect(instance).toMatchObject({
      name: 'Opening scene',
      timelineRange: { startFrame: 8, durationFrames: 12 },
    })
    expect(state.past).toHaveLength(1)
    expect(useSequenceInstanceSelectionStore.getState().selectedInstanceId)
      .toBe(instance?.id)

    act(() => useTransportStore.getState().setPlayheadFrame(13))
    fireEvent.click(screen.getByRole('button', { name: 'Open compound' }))
    expect(useDocumentStore.getState().activeSequenceId).toBe(instance?.sequenceId)
    expect(useTransportStore.getState().playheadFrame).toBe(5)
    expect(screen.getByRole('button', { name: 'Back to parent' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }))
    expect(useDocumentStore.getState().activeSequenceId).toBe('sequence-main')
    expect(useTransportStore.getState().playheadFrame).toBe(13)

    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project.sequences).toHaveLength(1)
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(1)
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().project.sequences).toHaveLength(2)
    expect(useDocumentStore.getState().doc.tracks[0].sequenceInstances).toHaveLength(1)
  })
})
