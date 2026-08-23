import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  clearDisposableLocalData: vi.fn(async () => true),
  discardRecoveryJournal: vi.fn(async () => true),
  discardRecoveryJournals: vi.fn(async () => true),
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
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy/')
    expect(screen.getByRole('link', { name: 'Privacy' }))
      .toHaveClass('project-button', 'project-button-secondary')
    expect(screen.getByRole('link', { name: 'Licenses' }))
      .toHaveAttribute('href', '/licenses/')
    expect(screen.getByRole('link', { name: 'Licenses' }))
      .toHaveClass('project-button', 'project-button-secondary')
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/zyfvhcfh87-rgb/Myrelith',
    )
    expect(screen.getByRole('link', { name: 'GitHub' }))
      .toHaveClass('project-button', 'project-button-secondary')
    expect(screen.getByRole('heading', { name: /your footage/i }))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Back to your projects' }))
      .toBeInTheDocument()
    expect(screen.queryByText('Pick up where you left off.')).not.toBeInTheDocument()
    expect(screen.queryByText('Portable .myrelith projects')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Myrelith capabilities')).not.toBeInTheDocument()
  })

  test('home keeps text motion accessible and tracks the primary-button light without rerendering', () => {
    const { container } = render(<ProjectLaunch />)

    const heading = screen.getByRole('heading', {
      name: 'Your footage. Your space. Your cut.',
    })
    expect(heading).toHaveClass('project-launch-split-text')
    expect(heading.querySelectorAll('.project-launch-headline-line')).toHaveLength(3)
    expect(heading.querySelectorAll('.project-launch-split-char').length).toBeGreaterThan(20)
    expect(heading.querySelector('.project-launch-split-visual'))
      .toHaveAttribute('aria-hidden', 'true')

    const brand = container.querySelector<HTMLElement>('.project-launch-fold-title')!
    expect(brand.querySelector('.project-launch-text-sr-only'))
      .toHaveTextContent('Myrelith')
    expect(brand.querySelectorAll('.project-launch-fold-piece')).toHaveLength(8)
    expect(brand.querySelector('.project-launch-fold-visual'))
      .toHaveAttribute('aria-hidden', 'true')

    const startButton = screen.getByRole('button', { name: 'Start a new project' })
    expect(startButton).toHaveClass('project-launch-card-specular')
    vi.spyOn(startButton, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 60,
      width: 200,
      height: 60,
      toJSON: () => ({}),
    })

    fireEvent.pointerMove(startButton, { clientX: 150, clientY: 15 })
    expect(startButton.style.getPropertyValue('--project-launch-specular-x')).toBe('75%')
    expect(startButton.style.getPropertyValue('--project-launch-specular-y')).toBe('25%')
    expect(startButton.style.getPropertyValue('--project-launch-specular-angle')).not.toBe('')

    fireEvent.pointerLeave(startButton)
    expect(startButton.style.getPropertyValue('--project-launch-specular-x')).toBe('')
    expect(startButton.style.getPropertyValue('--project-launch-specular-y')).toBe('')
    expect(startButton.style.getPropertyValue('--project-launch-specular-angle')).toBe('')
  })

  test('recovery search, age groups, and confirmed stale cleanup stay narrowly scoped', () => {
    const now = Date.now()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    useProjectLibraryStore.setState({
      phase: 'ready',
      recoveries: [{
        journalId: 'journal-today',
        documentId: 'doc-today',
        projectName: 'Today edit',
        projectFileName: null,
        updatedAt: now,
        generationCount: 1,
      }, {
        journalId: 'journal-old',
        documentId: 'doc-old',
        projectName: 'Archive edit',
        projectFileName: 'mountains.myrelith',
        updatedAt: now - 31 * 86_400_000,
        generationCount: 2,
      }],
    })
    render(<ProjectLaunch />)

    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Older' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'mountains' },
    })
    expect(screen.queryByText('Today edit')).not.toBeInTheDocument()
    expect(screen.getByText('Archive edit')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', {
      name: 'Clean up 1 older than 30 days',
    }))
    expect(libraryController.discardRecoveryJournals)
      .toHaveBeenCalledWith(['journal-old'])
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('does not delete .myrelith files'),
    )
  })

  test('local storage explains project truth, protected recovery, and empty disposable data', () => {
    useProjectLibraryStore.setState({
      phase: 'ready',
      storage: {
        browserUsageBytes: 4_096,
        browserQuotaBytes: 8_192,
        recoveryBytes: 1_024,
        disposableBytes: 0,
        disposableItemCount: 0,
        error: null,
      },
    })
    render(<ProjectLaunch />)

    expect(screen.getByText('Project files')).toBeInTheDocument()
    expect(screen.getByText(/1\.0 KB protected/)).toBeInTheDocument()
    expect(screen.getByText(/0 B · empty/)).toBeInTheDocument()
    expect(screen.getByText(/Projects and source media stay on your device/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear disposable data' }))
      .toBeDisabled()
  })

  test('still offers disposable cleanup when a corrupt cache prevents an estimate', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    useProjectLibraryStore.setState({
      phase: 'ready',
      storage: {
        browserUsageBytes: 4_096,
        browserQuotaBytes: 8_192,
        recoveryBytes: 0,
        disposableBytes: 0,
        disposableItemCount: 0,
        error: 'Disposable storage usage is unavailable.',
      },
    })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear disposable data' }))

    await waitFor(() => {
      expect(libraryController.clearDisposableLocalData).toHaveBeenCalledOnce()
    })
  })

  test('home offers recovery and recent entries with removable shortcuts', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    useProjectLibraryStore.setState({
      phase: 'ready',
      recentProjectsSupported: true,
      recentProjects: [{
        documentId: 'doc-recent',
        projectName: 'Recent edit',
        fileName: 'Recent.myrelith',
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

    const recentTab = screen.getByRole('tab', { name: 'Recent projects' })
    const recoveryTab = screen.getByRole('tab', { name: 'Recovery copies, 1' })
    expect(recoveryTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: 'Open Recent edit' }))
      .not.toBeInTheDocument()

    fireEvent.keyDown(recoveryTab, { key: 'ArrowLeft' })
    expect(recentTab).toHaveAttribute('aria-selected', 'true')
    expect(recentTab).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Open Recent edit' }))
    fireEvent.click(screen.getByRole('button', {
      name: 'Remove Recent edit from Recent',
    }))

    fireEvent.click(screen.getByRole('link', {
      name: 'Show recovery copies — local unsaved work',
    }))
    expect(recoveryTab).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Recover Recovered edit' }))
    fireEvent.click(screen.getByRole('button', {
      name: 'Discard recovery for Recovered edit',
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
    const { container } = render(<ProjectLaunch />)

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
    expect(screen.queryByText('Browser video editor')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.project-ratio-preview')).toHaveLength(4)
    expect(container.querySelectorAll('.project-ratio-shape')).toHaveLength(4)
    expect(container.querySelector('.project-ratio-preview img')).toBeNull()

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
        projectFileName: 'edit.myrelith',
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
    const project = new File(['{}'], 'other.myrelith')
    const source = new File(['video'], 'source.mp4', { type: 'video/mp4' })

    fireEvent.change(screen.getByLabelText('Choose a Myrelith project file'), {
      target: { files: [project] },
    })
    fireEvent.change(screen.getByLabelText('Relink project source media'), {
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
        projectFileName: 'empty.myrelith',
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
        projectFileName: 'portrait.myrelith',
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
        projectFileName: 'partial.myrelith',
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
        projectFileName: 'remembered.myrelith',
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

    expect(screen.getByText('Permission needed')).toBeInTheDocument()
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
        projectFileName: 'remembered.myrelith',
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

  test('clears pending resume preloading before starting a new project', async () => {
    let finishEditorLoad: ((value: { default: () => null }) => void) | null = null
    editorModule.loadEditorShell.mockImplementationOnce(() => new Promise(
      (resolve) => {
        finishEditorLoad = resolve
      },
    ))
    controller.returnToProjectHome.mockImplementationOnce(() => {
      useProjectSessionStore.setState({ screen: 'home' })
    })
    controller.showNewProject.mockImplementationOnce(() => {
      useProjectSessionStore.setState({ screen: 'new-project' })
    })
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'remembered.myrelith',
        projectName: 'Remembered work',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        audioSampleRate: 48_000,
        assets: [],
      },
    })
    render(<ProjectLaunch />)

    await waitFor(() => expect(editorModule.loadEditorShell).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('button', {
      name: 'Start a new project',
    }))

    expect(await screen.findByRole('button', { name: 'Create project' }))
      .toBeEnabled()

    await act(async () => {
      finishEditorLoad?.({ default: () => null })
      await Promise.resolve()
    })
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
    expect(screen.getByRole('button', { name: 'Reload Myrelith' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled()
  })

  test('supporting browsers reconnect through the reusable-handle picker', () => {
    controller.canRememberProjectMedia.mockReturnValue(true)
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
        origin: 'file',
        projectFileName: 'edit.myrelith',
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

    fireEvent.click(screen.getByRole('button', { name: 'Relink & remember' }))
    expect(controller.chooseProjectMedia).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Relink project source media once'))
      .toBeInTheDocument()
  })

  test('supporting browsers offer remembered and quick project-open paths', () => {
    controller.canRememberProjectFiles.mockReturnValue(true)
    useProjectSessionStore.setState({ screen: 'resume' })
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Open and remember a Myrelith project file',
    }))

    expect(controller.chooseProjectFile).toHaveBeenCalledOnce()
    const project = new File(['{}'], 'quick-open.myrelith')
    fireEvent.change(screen.getByLabelText('Open a Myrelith project file once'), {
      target: { files: [project] },
    })
    expect(controller.openProjectFile).toHaveBeenCalledWith(project)
  })

  test('summarizes the complete local setup before project creation', () => {
    useProjectSessionStore.setState({ screen: 'new-project' })
    render(<ProjectLaunch />)

    const summary = screen.getByRole('region', { name: 'Ready to create' })
    expect(summary).toHaveTextContent('Untitled project')
    expect(summary).toHaveTextContent('Horizontal 16:9 · 1920 × 1080')
    expect(summary).toHaveTextContent('30 fps')
    expect(summary).toHaveTextContent('48 kHz')
    expect(summary).toHaveTextContent('4 video + 4 audio tracks')
    expect(summary).toHaveTextContent('Starts locally and unsaved')
  })

  test('keeps audio settings and Create inside a scrollable setup frame', () => {
    useProjectSessionStore.setState({ screen: 'new-project' })
    const { container } = render(<ProjectLaunch />)
    const frame = container.querySelector('.project-launch-frame-setup')

    expect(container.querySelector('.project-launch-setup')).not.toBeNull()
    expect(frame).not.toBeNull()
    expect(frame).toContainElement(screen.getByLabelText('Audio quality'))
    expect(frame).toContainElement(screen.getByRole('button', { name: 'Create project' }))
    expect(frame).toContainElement(screen.getByRole('button', { name: 'Back' }))

    const css = readFileSync(resolve('src/app/styles/project-launch.css'), 'utf8')
    const frameRule = css.slice(
      css.indexOf('.project-launch-frame-setup {'),
      css.indexOf('.project-launch-setup .project-launch-footer {'),
    )
    const layoutRule = css.slice(
      css.indexOf('.project-setup-layout {'),
      css.indexOf('.project-setup-intro {'),
    )

    expect(frameRule).toContain('overflow-y: auto')
    expect(frameRule).not.toMatch(/overflow:\s*hidden/)
    expect(layoutRule).toContain('flex: 1 0 auto')
    expect(layoutRule).not.toMatch(/min-height:\s*0/)
    expect(layoutRule).not.toMatch(/flex:\s*1 1 auto/)
  })
})
