import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { useDocumentStore } from '../state/documentStore'
import SequenceControls from './SequenceControls'

describe('SequenceControls', () => {
  beforeEach(() => {
    useDocumentStore.getState().setDoc(createTimelineDoc(
      'Main edit',
      DEFAULT_PROJECT_SETTINGS,
      'sequence-main',
    ))
    vi.stubGlobal('confirm', vi.fn(() => true))
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
})
