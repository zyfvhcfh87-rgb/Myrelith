/**
 * app/App.test.tsx — Phase 3.1: the shell mounts and every grid area
 * renders its panel. Layout geometry is verified visually (jsdom does not
 * do real layout); this guards wiring, not pixels.
 */

import { beforeEach, describe, expect, test } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import App from './App'
import type { Clip, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import {
  INITIAL_TRANSPORT_STATE,
  useTransportStore,
} from '../state/transportStore'

function makeClip(id: string, startFrame: number): Clip {
  return {
    id,
    assetId: 'asset-app-selection',
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
    schemaVersion: 2,
    id: 'doc-app-selection',
    name: 'App selection fixture',
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
  useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE })
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  useDocumentStore.setState({ doc: makeDocument(), past: [], future: [] })
})

describe('App shell', () => {
  test('opens on the project home instead of mounting editor controllers', () => {
    const { container } = render(<App />)

    expect(screen.getByRole('heading', { name: 'WebCut' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create a new project/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /resume previous work/i })).toBeInTheDocument()
    expect(container.querySelector('.app-shell')).toBeNull()
  })

  test('renders all five panel areas', () => {
    useProjectSessionStore.setState({ screen: 'editor' })
    const { container } = render(<App />)

    expect(screen.getByText('WebCut')).toBeInTheDocument()
    // Real panels (3.2–3.4), not placeholders:
    expect(container.querySelector('.media-pool')).not.toBeNull()
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument()
    expect(screen.getByText('Inspector')).toBeInTheDocument() // Phase 4
    expect(screen.getByTestId('timeline-root')).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: 'Timeline zoom controls' }),
    ).toBeInTheDocument()

    const shell = container.querySelector('.app-shell')
    expect(shell).not.toBeNull()
    for (const area of [
      'area-toolbar',
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
  })

  test('owns and releases document-to-selection reconciliation', () => {
    useProjectSessionStore.setState({ screen: 'editor' })
    useTransportStore.getState().setSelectedClip('clipA')
    useTransportStore.getState().toggleClipSelection('clipB')
    const { unmount } = render(<App />)

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
    useProjectSessionStore.setState({ screen: 'editor', phase: 'closing' })
    const { container } = render(<App />)

    const shell = container.querySelector('.app-shell')
    expect(shell).toHaveAttribute('aria-busy', 'true')
    for (const area of [
      'area-media-pool',
      'area-preview',
      'area-inspector',
      'area-transport',
      'area-timeline',
    ]) {
      expect(shell?.querySelector(`.${area}`)).toHaveAttribute('inert')
    }
    expect(shell?.querySelector('.area-toolbar')).not.toHaveAttribute('inert')
  })
})
