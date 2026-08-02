import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  saveActiveProject,
  saveActiveProjectAs,
} from '../app/projectPersistenceController'
import { leaveActiveProject } from '../app/projectController'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import Toolbar from './Toolbar'

vi.mock('../app/projectPersistenceController', () => ({
  saveActiveProject: vi.fn(async () => ({ status: 'saved' })),
  saveActiveProjectAs: vi.fn(async () => ({ status: 'saved' })),
}))

vi.mock('../app/projectController', () => ({
  leaveActiveProject: vi.fn(async () => ({ status: 'ready' })),
}))

vi.mock('./ExportDialog', () => ({
  default: () => <div role="dialog" aria-label="Export project" />,
}))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.mocked(leaveActiveProject).mockResolvedValue({ status: 'ready' })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
    activeProjectName: 'Toolbar edit',
    hasUnsavedChanges: true,
  })
})

describe('Toolbar project persistence', () => {
  test('shows project state and routes Save, Save As, and Export', () => {
    render(<Toolbar />)

    expect(screen.getByText('Toolbar edit')).toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    act(() => {
      useProjectSessionStore.setState({ lastSavedAt: 123 })
    })
    expect(screen.getByText(
      'Copy downloaded · unsaved changes',
    )).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save As' }))
    expect(saveActiveProject).toHaveBeenCalledOnce()
    expect(saveActiveProjectAs).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(screen.getByRole('dialog', { name: 'Export project' })).toBeInTheDocument()
  })

  test('guards dirty work before returning to Projects', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    render(<Toolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    expect(leaveActiveProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    expect(leaveActiveProject).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(2)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Projects' })).toBeEnabled()
    })
  })

  test('clean projects leave directly and explain the first Save grants write access', async () => {
    useProjectSessionStore.setState({
      activeProjectFileName: 'Opened.webcut',
      hasUnsavedChanges: false,
    })
    const confirm = vi.spyOn(window, 'confirm')
    render(<Toolbar />)

    expect(screen.getByText(
      'Opened · Save to enable live save',
    )).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(leaveActiveProject).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Projects' })).toBeEnabled()
    })
  })

  test('disables replacement and save controls during a write, then reports live save', () => {
    render(<Toolbar />)
    act(() => {
      useProjectSessionStore.setState({
        savePhase: 'saving',
        liveSaveEnabled: true,
      })
    })

    expect(screen.getByText('Saving…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Projects' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save As' })).toBeDisabled()

    act(() => {
      useProjectSessionStore.setState({
        savePhase: 'idle',
        hasUnsavedChanges: false,
        lastSavedAt: 123,
      })
    })
    expect(screen.getByText('Saved · live save on')).toBeInTheDocument()
  })

  test('locks project actions while editor cleanup is still running', async () => {
    useProjectSessionStore.setState({ hasUnsavedChanges: false })
    let finish!: () => void
    vi.mocked(leaveActiveProject).mockImplementationOnce(() => new Promise(
      (resolve) => {
        finish = () => resolve({ status: 'ready' })
      },
    ))
    render(<Toolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    expect(screen.getByText('Returning to Projects…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Projects' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save As' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()

    await act(async () => {
      finish()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Projects' })).toBeEnabled()
  })

  test('surfaces save failures without hiding the detailed cause', () => {
    useProjectSessionStore.setState({
      savePhase: 'error',
      saveError: 'Could not save the project: disk full',
    })
    render(<Toolbar />)

    expect(screen.getByRole('alert')).toHaveTextContent('Save failed')
    expect(screen.getByRole('alert')).toHaveAttribute(
      'title',
      'Could not save the project: disk full',
    )
  })

  test('reports recovery separately without claiming the project was saved', () => {
    render(<Toolbar />)

    act(() => {
      useProjectSessionStore.setState({ recoveryPhase: 'saving' })
    })
    expect(screen.getByText('Updating recovery copy…')).toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    act(() => {
      useProjectSessionStore.setState({
        recoveryPhase: 'idle',
        lastRecoveryAt: 123,
      })
    })
    expect(screen.getByText('Recovery copy updated')).toBeInTheDocument()
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument()
  })

  test('surfaces a recovery failure without turning it into a save failure', () => {
    useProjectSessionStore.setState({
      recoveryPhase: 'error',
      recoveryError: 'IndexedDB is unavailable',
    })
    render(<Toolbar />)

    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('Recovery copy failed')
    expect(alerts[0]).toHaveAttribute('title', 'IndexedDB is unavailable')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })
})
