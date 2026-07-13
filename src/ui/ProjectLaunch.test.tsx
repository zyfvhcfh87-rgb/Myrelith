import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import ProjectLaunch from './ProjectLaunch'

const controller = vi.hoisted(() => ({
  activateResumedProject: vi.fn(async () => ({ status: 'activated' })),
  canRememberProjectMedia: vi.fn(() => false),
  chooseProjectMedia: vi.fn(async () => ({ status: 'ready' })),
  connectProjectMedia: vi.fn(async () => ({ status: 'ready' })),
  createNewProject: vi.fn(async () => ({ status: 'activated' })),
  openProjectFile: vi.fn(async () => ({ status: 'ready' })),
  returnToProjectHome: vi.fn(),
  showNewProject: vi.fn(),
  showResumeProject: vi.fn(),
}))

vi.mock('../app/projectController', () => controller)

beforeEach(() => {
  useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE })
  for (const mock of Object.values(controller)) mock.mockClear()
  controller.canRememberProjectMedia.mockReturnValue(false)
})

describe('ProjectLaunch', () => {
  test('home exposes the two explicit entry points', () => {
    render(<ProjectLaunch />)

    fireEvent.click(screen.getByRole('button', { name: /create a new project/i }))
    fireEvent.click(screen.getByRole('button', { name: /resume previous work/i }))

    expect(controller.showNewProject).toHaveBeenCalledOnce()
    expect(controller.showResumeProject).toHaveBeenCalledOnce()
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

  test('remembered media needs only the Open click to grant access', () => {
    useProjectSessionStore.setState({
      screen: 'resume',
      candidate: {
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
})
