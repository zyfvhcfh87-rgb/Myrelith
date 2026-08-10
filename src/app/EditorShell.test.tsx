import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import {
  INITIAL_WORKSPACE_LAYOUT,
  useWorkspaceLayoutStore,
} from '../state/workspaceLayoutStore'
import {
  resetDocumentStoreForTest,
  resetTransportStoreForTest,
} from '../test/storeFixtures'
import EditorShell from './EditorShell'

vi.mock('../app/previewController', () => ({
  disposePreview: vi.fn(),
  initPreview: vi.fn(),
  setPreviewViewport: vi.fn(),
}))

function makeClip(id: string, startFrame: number): Clip {
  return {
    id,
    assetId: 'asset-editor-shell-selection',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame, durationFrames: 30 },
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
}

function makeDocument(): TimelineDoc {
  return {
    schemaVersion: 10,
    id: 'doc-editor-shell-selection',
    name: 'Editor shell selection fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        name: 'V1',
        clips: [makeClip('clipA', 0), makeClip('clipB', 60)],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
  resetTransportStoreForTest()
  resetDocumentStoreForTest(makeDocument())
  useWorkspaceLayoutStore.setState({ ...INITIAL_WORKSPACE_LAYOUT })
})

describe('EditorShell', () => {
  test('renders every editor panel area', () => {
    const { container } = render(<EditorShell closing={false} />)

    expect(screen.getByText('Myrelith')).toBeInTheDocument()
    expect(container.querySelector('.media-pool')).not.toBeNull()
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument()
    expect(container.querySelector('.inspector-empty-title')).not.toBeNull()
    expect(screen.getByTestId('timeline-root')).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: 'Timeline zoom controls' }),
    ).toBeInTheDocument()

    const shell = container.querySelector('.app-shell')
    expect(shell).not.toBeNull()
    for (const area of [
      'area-toolbar',
      'area-workspace',
      'area-media-pool',
      'area-preview',
      'area-inspector',
      'area-timeline',
    ]) {
      expect(shell?.querySelector(`.${area}`)).not.toBeNull()
    }
    expect(
      shell?.querySelector('.area-transport > .timeline-zoom-controls'),
    ).not.toBeNull()
    expect(screen.getAllByRole('separator')).toHaveLength(3)
  })

  test('collapses and restores mounted panels without losing editor state', () => {
    useTransportStore.getState().setSelectedClip('clipA')
    const documentBefore = useDocumentStore.getState()
    const { container } = render(<EditorShell closing={false} />)
    const panels = [
      { name: 'Media', selector: '.area-media-pool', scrollTop: 72 },
      { name: 'Inspector', selector: '.area-inspector', scrollTop: 48 },
      { name: 'Timeline', selector: '.area-timeline', scrollTop: 31 },
    ] as const

    for (const panel of panels) {
      const area = container.querySelector<HTMLElement>(panel.selector)
      if (!area) throw new Error(`${panel.name} area missing`)
      area.scrollTop = panel.scrollTop
      const toggle = screen.getByRole('button', { name: panel.name })
      toggle.focus()
      fireEvent.click(toggle)

      expect(toggle).toHaveFocus()
      expect(area).toHaveAttribute('data-collapsed', 'true')
      expect(area).toHaveAttribute('inert')
      expect(area.scrollTop).toBe(panel.scrollTop)
      expect(useTransportStore.getState().selectedClipId).toBe('clipA')
      expect(useDocumentStore.getState().doc).toBe(documentBefore.doc)
      expect(useDocumentStore.getState().past).toBe(documentBefore.past)
      expect(useDocumentStore.getState().future).toBe(documentBefore.future)

      fireEvent.click(toggle)
      expect(toggle).toHaveFocus()
      expect(area).not.toHaveAttribute('data-collapsed')
      expect(area).not.toHaveAttribute('inert')
      expect(area.scrollTop).toBe(panel.scrollTop)
      expect(useTransportStore.getState().selectedClipId).toBe('clipA')
      expect(useDocumentStore.getState().doc).toBe(documentBefore.doc)
      expect(useDocumentStore.getState().past).toBe(documentBefore.past)
      expect(useDocumentStore.getState().future).toBe(documentBefore.future)
    }
  })

  test('applies presets and temporarily expands the focused Inspector', () => {
    const { container } = render(<EditorShell closing={false} />)
    const shell = container.querySelector<HTMLElement>('.app-shell')
    const mediaArea = container.querySelector('.area-media-pool')
    if (!shell || !mediaArea) throw new Error('Editor workspace missing')

    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace preset' }), {
      target: { value: 'media' },
    })
    expect(useWorkspaceLayoutStore.getState()).toMatchObject({
      preset: 'media',
      mediaWidth: 460,
      inspectorWidth: 240,
    })
    expect(container.querySelector('.workspace-status'))
      .toHaveTextContent('Media workspace applied.')

    const focusInspector = screen.getByRole('button', {
      name: 'Focus Inspector',
    })
    focusInspector.focus()
    fireEvent.click(focusInspector)
    expect(focusInspector).toHaveFocus()
    expect(focusInspector).toHaveAttribute('aria-pressed', 'true')
    expect(mediaArea).toHaveAttribute('data-collapsed', 'true')
    expect(shell.style.getPropertyValue('--workspace-inspector-width'))
      .toBe('520px')

    fireEvent.click(focusInspector)
    expect(mediaArea).not.toHaveAttribute('data-collapsed')
    expect(useWorkspaceLayoutStore.getState().inspectorWidth).toBe(240)
    expect(Number.parseInt(
      shell.style.getPropertyValue('--workspace-inspector-width'),
      10,
    )).toBeGreaterThanOrEqual(180)
  })

  test('keeps Add text with the timeline tools', async () => {
    const { container } = render(<EditorShell closing={false} />)

    const addText = screen.getByRole('button', { name: 'Add text' })
    expect(addText.closest('.transport-tools')).not.toBeNull()
    expect(container.querySelector('.toolbar-actions')?.contains(addText))
      .toBe(false)

    fireEvent.click(addText)
    expect(await screen.findByRole('heading', { name: 'Add text overlay' }))
      .toBeInTheDocument()
  })

  test('owns and releases document-to-selection reconciliation', () => {
    useTransportStore.getState().setSelectedClip('clipA')
    useTransportStore.getState().toggleClipSelection('clipB')
    const { unmount } = render(<EditorShell closing={false} />)

    act(() => useDocumentStore.getState().rippleDelete('clipB'))

    expect(useTransportStore.getState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })

    unmount()
    act(() => useDocumentStore.getState().removeTrack('V1'))
    expect(useTransportStore.getState()).toMatchObject({
      selectedClipIds: ['clipA'],
      selectedClipId: 'clipA',
    })
  })

  test('makes every editing surface inert while the project is closing', () => {
    const { container } = render(<EditorShell closing />)

    const shell = container.querySelector('.app-shell')
    expect(shell).toHaveAttribute('aria-busy', 'true')
    for (const area of [
      'area-media-pool',
      'area-workspace',
      'area-preview',
      'area-inspector',
      'area-transport',
      'area-timeline',
    ]) {
      expect(shell?.querySelector(`.${area}`)).toHaveAttribute('inert')
    }
    expect(shell?.querySelector('.area-toolbar')).not.toHaveAttribute('inert')
    for (const handle of screen.getAllByRole('separator')) {
      expect(handle).toHaveAttribute('aria-disabled', 'true')
      expect(handle).toHaveAttribute('tabindex', '-1')
    }
  })
})
