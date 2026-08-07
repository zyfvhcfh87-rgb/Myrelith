import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const editorModule = vi.hoisted(() => ({
  loadEditorShell: vi.fn(async () => ({ default: () => null })),
}))

vi.mock('../app/editorModuleLoader', () => editorModule)

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
  editorModule.loadEditorShell.mockClear()
  controller.canRememberProjectFiles.mockReturnValue(false)
  controller.canRememberProjectMedia.mockReturnValue(false)
  editorModule.loadEditorShell.mockResolvedValue({ default: () => null })
})

describe('ProjectLaunch', () => {
  test('home exposes the two explicit entry points', () => {
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', { name: /start a new project/i }))
    fireEvent.click(screen.getByRole('button', { name: /open a project/i }))

    expect(controller.showNewProject).toHaveBeenCalledOnce()
    expect(controller.showResumeProject).toHaveBeenCalledOnce()
    expect(libraryController.refreshProjectLibrary).toHaveBeenCalledOnce()
    expect(screen.getByRole('link', { name: 'Privacy' }))
      .toHaveAttribute('href', '/privacy/')
    expect(screen.getByRole('link', { name: 'Licenses' }))
      .toHaveAttribute('href', '/licenses/')
    expect(screen.getByText('Your media stays on this device.'))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /your footage/i }))
      .toBeInTheDocument()
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

  test('new-project form passes the chosen exact profile to the controller', async () => {
    useProjectSessionStore.setState({ screen: 'new-project' })
    render(<ProjectLaunch />)

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Fast cut' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Vertical 9:16' }))
    fireEvent.change(screen.getByLabelText('Resolution'), {
      target: { value: '720' },
    })
    fireEvent.change(screen.getByLabelText('Frame rate'), {
      target: { value: '60/1' },
    })
    fireEvent.change(screen.getByLabelText('Audio quality'), {
      target: { value: '96000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => {
      expect(controller.createNewProject).toHaveBeenCalledWith('Fast cut', {
        width: 720,
        height: 1280,
        frameRate: { num: 60, den: 1 },
        audioSampleRate: 96_000,
      })
    })
  })

  test('offers every requested ratio and preserves the size tier between them', async () => {
    useProjectSessionStore.setState({ screen: 'new-project' })
    render(<ProjectLaunch />)

    const resolution = screen.getByLabelText('Resolution')
    expect(screen.getByRole('radio', { name: 'Horizontal 16:9' }))
      .toBeChecked()
    expect(resolution).toHaveValue('1080')
    expect(screen.getByRole('radio', { name: 'Vertical 9:16' }))
      .toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Square 1:1' }))
      .toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Social portrait 4:5' }))
      .toBeInTheDocument()

    fireEvent.change(resolution, { target: { value: '1440' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Square 1:1' }))
    expect(resolution).toHaveValue('1440')
    expect(screen.getByRole('option', { name: '1440 × 1440' }))
      .toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Social portrait 4:5' }))
    expect(resolution).toHaveValue('1440')
    expect(screen.getByRole('option', { name: '1440 × 1800' }))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => {
      expect(controller.createNewProject).toHaveBeenCalledWith(
        'Untitled project',
        expect.objectContaining({ width: 1440, height: 1800 }),
      )
    })
  })

  test('resume delegates project selection and source reconnection', async () => {
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
    expect(screen.getByText('Horizontal 16:9 · 1920 × 1080'))
      .toBeInTheDocument()
    const openOffline = screen.getByRole('button', {
      name: 'Open with 1 offline',
    })
    await waitFor(() => expect(openOffline).toBeEnabled())
    expect(screen.getByText(/will open offline/i)).toBeInTheDocument()
    fireEvent.click(openOffline)
    await waitFor(() => {
      expect(controller.activateResumedProject).toHaveBeenCalledOnce()
    })
  })

  test('validated zero-media projects can be opened immediately', async () => {
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
    await waitFor(() => expect(open).toBeEnabled())
    fireEvent.click(open)
    await waitFor(() => {
      expect(controller.activateResumedProject).toHaveBeenCalledOnce()
    })
  })

  test('derives the saved project canvas label from exact dimensions', () => {
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'portrait.webcut',
        projectName: 'Portrait cut',
        width: 1080,
        height: 1920,
        frameRate: { num: 30, den: 1 },
        audioSampleRate: 48_000,
        assets: [],
      },
    })
    render(<ProjectLaunch />)

    expect(screen.getByText('Vertical 9:16 · 1080 × 1920'))
      .toBeInTheDocument()
  })

  test('names durable partial-track choices on the Resume screen', () => {
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'partial.webcut',
        projectName: 'Partial imports',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        audioSampleRate: 48_000,
        assets: [
          {
            id: 'video-only',
            fileName: 'silent-source.mkv',
            kind: 'video',
            partialTrackSelection: 'video-only',
            status: 'missing',
          },
          {
            id: 'audio-only',
            fileName: 'sound-source.mkv',
            kind: 'audio',
            partialTrackSelection: 'audio-only',
            status: 'ready',
          },
        ],
      },
    })
    render(<ProjectLaunch />)

    expect(screen.getByText('video only')).toBeInTheDocument()
    expect(screen.getByText('audio only')).toBeInTheDocument()
  })

  test('recovery is explicit and never described as a saved project', async () => {
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
    await waitFor(() => expect(recover).toBeEnabled())
    fireEvent.click(recover)
    await waitFor(() => {
      expect(controller.activateResumedProject).toHaveBeenCalledOnce()
    })
  })

  test('remembered media needs only the Open click to grant access', async () => {
    let openClickActive = false
    controller.activateResumedProject.mockImplementationOnce(async () => {
      expect(openClickActive).toBe(true)
      return { status: 'activated' }
    })
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
    await waitFor(() => expect(open).toBeEnabled())
    expect(editorModule.loadEditorShell).toHaveBeenCalledOnce()
    openClickActive = true
    fireEvent.click(open)
    openClickActive = false
    expect(controller.activateResumedProject).toHaveBeenCalledOnce()
  })

  test('keeps a resume candidate unchanged when editor preloading fails', async () => {
    editorModule.loadEditorShell.mockRejectedValueOnce(new Error('offline'))
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

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your project has not been changed',
    )
    expect(controller.activateResumedProject).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState().screen).toBe('resume')
    expect(screen.getByRole('button', { name: 'Allow media & open' }))
      .toBeDisabled()
  })

  test('keeps project truth unchanged and offers reload when the editor chunk fails', async () => {
    editorModule.loadEditorShell.mockRejectedValueOnce(new Error('offline'))
    useProjectSessionStore.setState({ screen: 'new-project' })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your project has not been changed',
    )
    expect(controller.createNewProject).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState().screen).toBe('new-project')
    expect(screen.getByRole('button', { name: 'Reload WebCut' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled()
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

  test('supporting browsers offer remembered and quick project-open paths', () => {
    controller.canRememberProjectFiles.mockReturnValue(true)
    useProjectSessionStore.setState({ screen: 'resume' })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Choose & remember a WebCut project file',
    }))

    expect(controller.chooseProjectFile).toHaveBeenCalledOnce()
    const project = new File(['{}'], 'quick-open.webcut')
    fireEvent.change(screen.getByLabelText('Quick open a WebCut project file'), {
      target: { files: [project] },
    })
    expect(controller.openProjectFile).toHaveBeenCalledWith(project)
  })
})
