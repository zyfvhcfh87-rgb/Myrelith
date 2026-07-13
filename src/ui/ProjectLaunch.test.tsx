import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import {
  INITIAL_PROJECT_LIBRARY_STATE,
  useProjectLibraryStore,
} from '../state/projectLibraryStore'
import ProjectLaunch from './ProjectLaunch'

const controller = vi.hoisted(() => ({
  activateResumedProject: vi.fn(async () => ({ status: 'activated' })),
  canRememberProjectFiles: vi.fn(() => false),
  canRememberProjectMedia: vi.fn(() => false),
  chooseProjectFile: vi.fn(async () => ({ status: 'ready' })),
  chooseProjectMedia: vi.fn(async () => ({ status: 'ready' })),
  connectProjectMedia: vi.fn(async () => ({ status: 'ready' })),
  createNewProject: vi.fn(async () => ({ status: 'activated' })),
  openProjectFile: vi.fn(async () => ({ status: 'ready' })),
  openRecentProject: vi.fn(async () => ({ status: 'ready' })),
  openRecoveryProject: vi.fn(async () => ({ status: 'ready' })),
  returnToProjectHome: vi.fn(),
  showNewProject: vi.fn(),
  showResumeProject: vi.fn(),
}))

vi.mock('../app/projectController', () => controller)

const libraryController = vi.hoisted(() => ({
  discardRecoveryJournal: vi.fn(async () => true),
  forgetRecentProject: vi.fn(async () => true),
  refreshProjectLibrary: vi.fn(async () => undefined),
}))

vi.mock('../app/projectLibraryController', () => libraryController)

beforeEach(() => {
  vi.restoreAllMocks()
  useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE })
  useProjectLibraryStore.setState({ ...INITIAL_PROJECT_LIBRARY_STATE })
  for (const mock of Object.values(controller)) mock.mockClear()
  for (const mock of Object.values(libraryController)) mock.mockClear()
  controller.canRememberProjectFiles.mockReturnValue(false)
  controller.canRememberProjectMedia.mockReturnValue(false)
})

describe('ProjectLaunch', () => {
  test('home exposes the two explicit entry points', () => {
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', { name: /create a new project/i }))
    fireEvent.click(screen.getByRole('button', { name: /resume previous work/i }))

    expect(controller.showNewProject).toHaveBeenCalledOnce()
    expect(controller.showResumeProject).toHaveBeenCalledOnce()
    expect(libraryController.refreshProjectLibrary).toHaveBeenCalledOnce()
  })

  test('home offers recovery and recent entries with removable shortcuts', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    useProjectLibraryStore.setState({
      phase: 'ready',
      recentProjectsSupported: true,
      recentProjects: [{
        documentId: 'doc-recent',
        projectName: 'Recent edit',
        fileName: 'Recent.webcut',
        lastOpenedAt: 1_000,
        permission: 'prompt',
      }],
      recoveries: [{
        journalId: 'journal-recovery',
        documentId: 'doc-recovery',
        projectName: 'Recovered edit',
        projectFileName: null,
        updatedAt: 2_000,
        generationCount: 3,
      }],
    })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', { name: 'Recover Recovered edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Recent edit' }))
    fireEvent.click(screen.getByRole('button', {
      name: 'Discard recovery for Recovered edit',
    }))
    fireEvent.click(screen.getByRole('button', {
      name: 'Remove Recent edit from Recent',
    }))

    expect(controller.openRecoveryProject).toHaveBeenCalledWith(
      'journal-recovery',
    )
    expect(controller.openRecentProject).toHaveBeenCalledWith('doc-recent')
    expect(libraryController.discardRecoveryJournal)
      .toHaveBeenCalledWith('journal-recovery')
    expect(libraryController.forgetRecentProject)
      .toHaveBeenCalledWith('doc-recent')
    expect(screen.getByText(/never opened automatically/i)).toBeInTheDocument()
  })

  test('discarding a recovery copy requires explicit confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    useProjectLibraryStore.setState({
      phase: 'ready',
      recoveries: [{
        journalId: 'journal-protected',
        documentId: 'doc-protected',
        projectName: 'Protected edit',
        projectFileName: null,
        updatedAt: 2_000,
        generationCount: 1,
      }],
    })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Discard recovery for Protected edit',
    }))

    expect(window.confirm).toHaveBeenCalledOnce()
    expect(libraryController.discardRecoveryJournal).not.toHaveBeenCalled()
  })

  test('new-project form passes the chosen exact profile to the controller', () => {
    useProjectSessionStore.setState({ screen: 'new-project' })
    render(<ProjectLaunch />)

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Fast cut' },
    })
    fireEvent.change(screen.getByLabelText('Resolution'), {
      target: { value: '1280x720' },
    })
    fireEvent.change(screen.getByLabelText('Frame rate'), {
      target: { value: '60/1' },
    })
    fireEvent.change(screen.getByLabelText('Audio quality'), {
      target: { value: '96000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(controller.createNewProject).toHaveBeenCalledWith('Fast cut', {
      width: 1280,
      height: 720,
      frameRate: { num: 60, den: 1 },
      audioSampleRate: 96_000,
    })
  })

  test('resume delegates project selection and source reconnection', () => {
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'edit.webcut',
        projectName: 'Saved edit',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        audioSampleRate: 48_000,
        assets: [{
          id: 'asset-1',
          fileName: 'source.mp4',
          kind: 'video',
          status: 'missing',
        }],
      },
    })
    render(<ProjectLaunch />)
    const project = new File(['{}'], 'other.webcut')
    const source = new File(['video'], 'source.mp4', { type: 'video/mp4' })

    fireEvent.change(screen.getByLabelText('Choose a WebCut project file'), {
      target: { files: [project] },
    })
    fireEvent.change(screen.getByLabelText('Reconnect project source media'), {
      target: { files: [source] },
    })

    expect(controller.openProjectFile).toHaveBeenCalledWith(project)
    expect(controller.connectProjectMedia).toHaveBeenCalledWith([source])
    expect(screen.getByRole('button', { name: 'Open project' })).toBeDisabled()
  })

  test('validated zero-media projects can be opened immediately', () => {
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'empty.webcut',
        projectName: 'Empty saved work',
        width: 2560,
        height: 1440,
        frameRate: { num: 24, den: 1 },
        audioSampleRate: 44_100,
        assets: [],
      },
    })
    render(<ProjectLaunch />)

    const open = screen.getByRole('button', { name: 'Open project' })
    expect(open).toBeEnabled()
    fireEvent.click(open)
    expect(controller.activateResumedProject).toHaveBeenCalledOnce()
  })

  test('recovery is explicit and never described as a saved project', () => {
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'recovery',
        projectFileName: 'Local recovery copy',
        projectName: 'Recovered work',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        audioSampleRate: 48_000,
        assets: [],
      },
    })
    render(<ProjectLaunch />)

    expect(screen.getByRole('heading', { name: 'Review recovered work' }))
      .toBeInTheDocument()
    const recover = screen.getByRole('button', { name: 'Recover project' })
    fireEvent.click(recover)
    expect(controller.activateResumedProject).toHaveBeenCalledOnce()
  })

  test('remembered media needs only the Open click to grant access', () => {
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'remembered.webcut',
        projectName: 'Remembered work',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        audioSampleRate: 48_000,
        assets: [{
          id: 'asset-1',
          fileName: 'source.mp4',
          kind: 'video',
          status: 'remembered',
        }],
      },
    })
    render(<ProjectLaunch />)

    expect(screen.getByText('Remembered')).toBeInTheDocument()
    const open = screen.getByRole('button', { name: 'Allow media & open' })
    expect(open).toBeEnabled()
    fireEvent.click(open)
    expect(controller.activateResumedProject).toHaveBeenCalledOnce()
  })

  test('supporting browsers reconnect through the reusable-handle picker', () => {
    controller.canRememberProjectMedia.mockReturnValue(true)
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'edit.webcut',
        projectName: 'Saved edit',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        audioSampleRate: 48_000,
        assets: [{
          id: 'asset-1',
          fileName: 'source.mp4',
          kind: 'video',
          status: 'missing',
        }],
      },
    })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect files' }))
    expect(controller.chooseProjectMedia).toHaveBeenCalledOnce()
    expect(screen.queryByLabelText('Reconnect project source media'))
      .not.toBeInTheDocument()
  })

  test('supporting browsers choose .webcut through a reusable project handle', () => {
    controller.canRememberProjectFiles.mockReturnValue(true)
    useProjectSessionStore.setState({ screen: 'resume' })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Choose a WebCut project file',
    }))

    expect(controller.chooseProjectFile).toHaveBeenCalledOnce()
    expect(screen.queryByLabelText('Choose a WebCut project file', {
      selector: 'input',
    })).not.toBeInTheDocument()
  })
})
