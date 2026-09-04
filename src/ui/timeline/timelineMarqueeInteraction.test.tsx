import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import {
  INITIAL_TRANSPORT_STATE,
  useTransportStore,
} from '../../state/transportStore'
import Timeline from './Timeline'

function clip(id: string, startFrame: number): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 20 },
    timelineRange: { startFrame, durationFrames: 20 },
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

function track(id: string, clips: Clip[]): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 20,
    id: 'marquee-doc',
    name: 'marquee fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [
      track('V1', [clip('A', 60)]),
      track('V2', [clip('B', 20)]),
    ],
  }
}

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  }
}

const nextFrame = () => act(() => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve())
}))

beforeEach(() => {
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  useDocumentStore.getState().setDoc(makeDoc())
})

describe('timeline marquee selection', () => {
  test('left-dragging empty lane space previews and commits intersecting clips across lanes', async () => {
    render(<Timeline />)
    const surface = screen.getByTestId('timeline-tracks')
    const v2 = screen.getByTestId('track-V2')
    const clipA = screen.getByTestId('clip-A')
    const clipB = screen.getByTestId('clip-B')
    const documentBefore = useDocumentStore.getState().doc
    const historyBefore = useDocumentStore.getState().past

    surface.getBoundingClientRect = () => rect(100, 100, 500, 300)
    v2.getBoundingClientRect = () => rect(100, 100, 500, 144)
    screen.getByTestId('track-V1').getBoundingClientRect = () => (
      rect(100, 144, 500, 188)
    )
    clipB.getBoundingClientRect = () => rect(120, 110, 150, 135)
    clipA.getBoundingClientRect = () => rect(160, 150, 190, 175)

    fireEvent.pointerDown(v2, {
      pointerId: 71,
      button: 0,
      clientX: 105,
      clientY: 105,
    })
    fireEvent.pointerMove(surface, {
      pointerId: 71,
      button: 0,
      clientX: 195,
      clientY: 180,
    })
    await nextFrame()

    expect(screen.getByTestId('timeline-selection-marquee')).toHaveStyle({
      transform: 'translate(5px, 5px)',
      width: '90px',
      height: '75px',
    })
    expect(screen.getByTestId('timeline-selection-marquee')).toHaveAttribute(
      'data-selection-count',
      '2',
    )
    expect(clipA).toHaveClass('selected')
    expect(clipB).toHaveClass('selected')
    expect(useDocumentStore.getState().doc).toBe(documentBefore)

    // Releasing over the sticky header gutter targets the window rather than
    // the bounded surface; the fallback still commits and clears exactly once.
    fireEvent.pointerUp(window, {
      pointerId: 71,
      button: 0,
      clientX: 195,
      clientY: 180,
    })

    expect(useTransportStore.getState()).toMatchObject({
      selectedClipIds: ['B', 'A'],
      selectedClipId: 'A',
      selectionMarquee: null,
    })
    expect(useDocumentStore.getState().doc).toBe(documentBefore)
    expect(useDocumentStore.getState().past).toBe(historyBefore)
  })

  test('secondary empty-lane dragging preserves the existing selection', () => {
    useTransportStore.getState().setSelectedClip('A')
    render(<Timeline />)
    const v2 = screen.getByTestId('track-V2')

    fireEvent.pointerDown(v2, {
      pointerId: 72,
      button: 2,
      buttons: 2,
      clientX: 105,
      clientY: 105,
    })

    expect(useTransportStore.getState()).toMatchObject({
      selectedClipIds: ['A'],
      selectedClipId: 'A',
      selectionMarquee: null,
    })
  })
})
