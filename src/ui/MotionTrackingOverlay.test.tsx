import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clipFromAsset, insertClip } from '../domain/operations'
import { DEFAULT_MANUAL_LENS_CORRECTION } from '../domain/lensCorrection'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { MediaAsset } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import MotionTrackingOverlay from './MotionTrackingOverlay'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

function videoAsset(): MediaAsset {
  return {
    id: 'tracking-source',
    fileName: 'Tracking source.mp4',
    mimeType: 'video/mp4',
    size: 4_096,
    lastModified: 1,
    objectUrl: 'blob:tracking-source',
    kind: 'video',
    durationFrames: 90,
    durationMicroseconds: 3_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 3_000_000 },
      audio: null,
    },
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    hasAudio: false,
    audioSampleRate: null,
    audioChannels: null,
    decoderConfigB64: null,
  }
}

function Harness() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={panelRef}>
      <canvas ref={canvasRef} />
      <MotionTrackingOverlay canvasRef={canvasRef} panelRef={panelRef} />
    </div>
  )
}

beforeEach(() => {
  const asset = videoAsset()
  const empty = createTimelineDoc('Tracking overlay', DEFAULT_PROJECT_SETTINGS, 'tracking-overlay')
  const clip = clipFromAsset(asset, 0)
  useDocumentStore.getState().setDoc(insertClip(empty, 'V1', clip))
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  expect(useMediaStore.getState().addAsset(asset)).toBe(true)
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE, playheadFrame: 12 })
  useMotionTrackingSelectionStore.getState().clear()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this instanceof HTMLCanvasElement
      ? rect(100, 50, 960, 540)
      : rect(0, 0, 1_200, 700)
  })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => vi.restoreAllMocks())

describe('MotionTrackingOverlay', () => {
  test('does not expose decoded-source picks over lens-corrected preview pixels', () => {
    const clipId = useDocumentStore.getState().doc.tracks[0]!.clips[0]!.id
    useDocumentStore.getState().setManualLensCorrection(clipId, {
      ...DEFAULT_MANUAL_LENS_CORRECTION,
      k1: 0.1,
    })
    useMotionTrackingSelectionStore.getState().beginPicking(clipId, 'point')

    render(<Harness />)

    expect(screen.queryByRole('button', { name: /choose a point/i }))
      .not.toBeInTheDocument()
  })

  test('picks a normalized point and pins it to the exact displayed frame', () => {
    const clipId = useDocumentStore.getState().doc.tracks[0]!.clips[0]!.id
    useMotionTrackingSelectionStore.getState().beginPicking(clipId, 'point')
    render(<Harness />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /choose a point/i }), {
      pointerId: 1,
      clientX: 580,
      clientY: 320,
    })

    expect(useMotionTrackingSelectionStore.getState()).toMatchObject({
      sourceClipId: clipId,
      pickingKind: null,
      selectionGlobalFrame: 12,
      selection: { kind: 'point', point: { x: 0.5, y: 0.5 } },
    })
  })

  test('cancels a box drag across frames and commits a same-frame box exactly', () => {
    const clipId = useDocumentStore.getState().doc.tracks[0]!.clips[0]!.id
    useMotionTrackingSelectionStore.getState().beginPicking(clipId, 'box')
    render(<Harness />)
    const surface = screen.getByRole('button', { name: /drag a box/i })

    fireEvent.pointerDown(surface, {
      pointerId: 2,
      clientX: 340,
      clientY: 185,
    })
    act(() => useTransportStore.getState().setPlayheadFrame(15))
    fireEvent.pointerUp(screen.getByRole('button', { name: /drag a box/i }), {
      pointerId: 2,
      clientX: 820,
      clientY: 455,
    })
    expect(useMotionTrackingSelectionStore.getState().selection).toBeNull()

    const currentSurface = screen.getByRole('button', { name: /drag a box/i })
    fireEvent.pointerDown(currentSurface, {
      pointerId: 3,
      clientX: 340,
      clientY: 185,
    })
    fireEvent.pointerUp(currentSurface, {
      pointerId: 3,
      clientX: 820,
      clientY: 455,
    })

    expect(useMotionTrackingSelectionStore.getState()).toMatchObject({
      selectionGlobalFrame: 15,
      selection: {
        kind: 'box',
        box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      },
    })
  })

  test('completes a point pick from the keyboard without pointer events', () => {
    const clipId = useDocumentStore.getState().doc.tracks[0]!.clips[0]!.id
    useMotionTrackingSelectionStore.getState().beginPicking(clipId, 'point')
    render(<Harness />)
    const surface = screen.getByRole('button', { name: /choose a point/i })
    surface.focus()
    expect(surface).toHaveFocus()

    fireEvent.keyDown(surface, { key: 'ArrowRight' })
    fireEvent.keyDown(surface, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(surface, { key: 'Enter' })

    expect(useMotionTrackingSelectionStore.getState()).toMatchObject({
      sourceClipId: clipId,
      pickingKind: null,
      selectionGlobalFrame: 12,
      selection: { kind: 'point', point: { x: 0.52, y: 0.6 } },
    })
  })

  test('moves and resizes a box from the keyboard, then cancels without a selection', () => {
    const clipId = useDocumentStore.getState().doc.tracks[0]!.clips[0]!.id
    useMotionTrackingSelectionStore.getState().beginPicking(clipId, 'box')
    render(<Harness />)
    const surface = screen.getByRole('button', { name: /drag a box/i })
    surface.focus()

    fireEvent.keyDown(surface, { key: 'ArrowRight' })
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    fireEvent.keyDown(surface, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(surface, { key: 'Enter' })

    const selection = useMotionTrackingSelectionStore.getState().selection
    expect(selection?.kind).toBe('box')
    if (selection?.kind !== 'box') throw new Error('expected a box selection')
    expect(selection.box.x).toBeCloseTo(0.42)
    expect(selection.box.y).toBeCloseTo(0.42)
    expect(selection.box.width).toBeCloseTo(0.22)
    expect(selection.box.height).toBeCloseTo(0.2)
    expect(useMotionTrackingSelectionStore.getState()).toMatchObject({
      pickingKind: null,
      selectionGlobalFrame: 12,
    })

    act(() => useMotionTrackingSelectionStore.getState().beginPicking(clipId, 'box'))
    fireEvent.keyDown(screen.getByRole('button', { name: /drag a box/i }), {
      key: 'Escape',
    })
    expect(useMotionTrackingSelectionStore.getState()).toMatchObject({
      sourceClipId: clipId,
      pickingKind: null,
      selection: null,
    })
  })

  test('renders the selected box in the source clip rotation instead of its axis-aligned bounds', () => {
    const clipId = useDocumentStore.getState().doc.tracks[0]!.clips[0]!.id
    useDocumentStore.getState().updateClipVisual(clipId, {
      transform: { rotation: 90 },
    })
    useMotionTrackingSelectionStore.getState().setSelection(
      clipId,
      { kind: 'box', box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
      12,
    )
    const { container } = render(<Harness />)

    const points = container.querySelector('polygon')!.getAttribute('points')!
      .split(' ')
      .map((pair) => pair.split(',').map(Number))
    expect(points[0]?.[0]).toBeCloseTo(points[1]?.[0] ?? 0)
    expect(points[0]?.[1]).not.toBeCloseTo(points[1]?.[1] ?? 0)
    expect(points[0]?.[1]).toBeCloseTo(points[3]?.[1] ?? 0)
  })
})
