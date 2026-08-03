import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clipFromAsset, insertClip } from '../domain/operations'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { findClip } from '../domain/selectors'
import type { MediaAsset } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import VisualOverlayControls from './VisualOverlayControls'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

function imageAsset(): MediaAsset {
  return {
    id: 'image-direct-controls',
    fileName: 'Direct controls.png',
    mimeType: 'image/png',
    size: 1024,
    lastModified: 1,
    objectUrl: 'blob:direct-controls',
    kind: 'image',
    durationFrames: 90,
    durationMicroseconds: 3_000_000,
    sourceBounds: { video: null, audio: null },
    frameRate: null,
    width: 640,
    height: 360,
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
    <div className="preview-panel" ref={panelRef}>
      <canvas className="preview-canvas" ref={canvasRef} />
      <VisualOverlayControls canvasRef={canvasRef} panelRef={panelRef} />
    </div>
  )
}

beforeEach(() => {
  const asset = imageAsset()
  const empty = createTimelineDoc('Visual controls', DEFAULT_PROJECT_SETTINGS, 'doc-visual-controls')
  const clip = clipFromAsset(asset, 0)
  const doc = insertClip(empty, 'V1', clip)
  useDocumentStore.setState({ doc, past: [], future: [] })
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  expect(useMediaStore.getState().addAsset(asset)).toBe(true)
  useTransportStore.setState({
    ...INITIAL_TRANSPORT_STATE,
    selectedClipIds: [clip.id],
    selectedClipId: clip.id,
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this instanceof HTMLCanvasElement
      ? rect(100, 50, 960, 540)
      : rect(0, 0, 1200, 700)
  })
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
  })
})

afterEach(() => vi.restoreAllMocks())

function selectedClip() {
  return findClip(
    useDocumentStore.getState().doc,
    useTransportStore.getState().selectedClipId!,
  )!
}

describe('VisualOverlayControls', () => {
  test('selects a visible media clip and exposes every direct control', async () => {
    useTransportStore.getState().setSelectedClip(null)
    render(<Harness />)
    const body = await screen.findByRole('button', { name: /visual clip: direct controls.png/i })

    fireEvent.click(body)

    expect(body).toHaveAttribute('aria-pressed', 'true')
    const scaleHandles = screen.getAllByRole('button', { name: /scale visual clip from .* corner/i })
    expect(scaleHandles).toHaveLength(4)
    for (const corner of ['top left', 'top right', 'bottom left', 'bottom right']) {
      expect(screen.getByRole('button', { name: new RegExp(`scale visual clip from ${corner} corner`, 'i') })).toBeVisible()
    }
    expect(screen.getByRole('button', { name: /rotate visual clip/i })).toBeVisible()
    expect(screen.getByRole('button', { name: /move anchor/i })).toBeVisible()
    expect(screen.getAllByRole('button', { name: /crop .* edge/i })).toHaveLength(4)
    expect(screen.getByRole('button', { name: /flip .* horizontally/i })).toBeVisible()
  })

  test('counter-scales fixed-size handles against clip scale and explicit flips', async () => {
    const clip = selectedClip()
    useDocumentStore.getState().updateClipVisual(clip.id, {
      transform: { scaleX: 0.25, scaleY: 0.25 },
      visual: { flipHorizontal: true },
    })
    useDocumentStore.setState({ past: [], future: [] })
    render(<Harness />)
    const body = await screen.findByRole('button', { name: /selected visual clip/i })
    const control = body.parentElement as HTMLElement

    expect(control.style.getPropertyValue('--visual-counter-scale-x')).toBe('-4')
    expect(control.style.getPropertyValue('--visual-counter-scale-y')).toBe('4')
    expect(control.style.getPropertyValue('--visual-rotate-offset')).toBe('-128px')
    expect(control.style.getPropertyValue('--visual-border-width')).toBe('4px')
    expect(control.style.getPropertyValue('--visual-focus-width')).toBe('12px')
  })

  test('move stays ephemeral until pointer-up and then commits exactly once', async () => {
    render(<Harness />)
    const body = await screen.findByRole('button', { name: /selected visual clip/i })

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 200, clientY: 150 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 300, clientY: 200 })

    expect(selectedClip().transform).toMatchObject({ x: 0, y: 0 })
    await waitFor(() => {
      expect(useTransportStore.getState().clipVisualPreview?.transform).toMatchObject({
        x: 200,
        y: 100,
      })
    })

    fireEvent.pointerUp(body, { pointerId: 1, clientX: 300, clientY: 200 })

    expect(selectedClip().transform).toMatchObject({ x: 200, y: 100 })
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useTransportStore.getState().clipVisualPreview).toBeNull()
  })

  test('pointer scale, rotate, crop, and anchor each produce one atomic edit', async () => {
    render(<Harness />)
    const scale = await screen.findByRole('button', { name: /scale visual clip from bottom right corner/i })
    const rotate = screen.getByRole('button', { name: /rotate visual clip/i })
    const cropLeft = screen.getByRole('button', { name: /crop left edge/i })
    const anchor = screen.getByRole('button', { name: /move anchor/i })

    fireEvent.pointerDown(scale, { pointerId: 2, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(scale, { pointerId: 2, clientX: 64, clientY: 36 })
    fireEvent.pointerUp(scale, { pointerId: 2, clientX: 64, clientY: 36 })
    expect(selectedClip().transform.scaleX).toBeCloseTo(1.4)
    expect(selectedClip().transform.scaleY).toBeCloseTo(1.4)

    fireEvent.pointerDown(rotate, { pointerId: 3, clientX: 680, clientY: 320 })
    fireEvent.pointerMove(rotate, { pointerId: 3, clientX: 580, clientY: 420 })
    fireEvent.pointerUp(rotate, { pointerId: 3, clientX: 580, clientY: 420 })
    expect(selectedClip().transform.rotation).toBeCloseTo(90)

    fireEvent.pointerDown(cropLeft, { pointerId: 4, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(cropLeft, { pointerId: 4, clientX: 32, clientY: 0 })
    fireEvent.pointerUp(cropLeft, { pointerId: 4, clientX: 32, clientY: 0 })
    expect(selectedClip().visual?.crop.left).toBeGreaterThan(0)

    const beforeAnchor = selectedClip().transform
    fireEvent.pointerDown(anchor, { pointerId: 5, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(anchor, { pointerId: 5, clientX: 32, clientY: 0 })
    fireEvent.pointerUp(anchor, { pointerId: 5, clientX: 32, clientY: 0 })
    expect(selectedClip().transform.anchorY).not.toBe(beforeAnchor.anchorY)
    expect(useDocumentStore.getState().past).toHaveLength(4)
  })

  test('each corner handle scales outward from its own corner', async () => {
    render(<Harness />)
    const corners = [
      { name: 'top left', x: -64, y: -36 },
      { name: 'top right', x: 64, y: -36 },
      { name: 'bottom left', x: -64, y: 36 },
      { name: 'bottom right', x: 64, y: 36 },
    ]

    for (const [index, corner] of corners.entries()) {
      const handle = await screen.findByRole('button', {
        name: new RegExp(`scale visual clip from ${corner.name} corner`, 'i'),
      })
      const pointerId = 20 + index
      fireEvent.pointerDown(handle, { pointerId, clientX: 0, clientY: 0 })
      fireEvent.pointerMove(handle, {
        pointerId,
        clientX: corner.x,
        clientY: corner.y,
      })
      fireEvent.pointerUp(handle, {
        pointerId,
        clientX: corner.x,
        clientY: corner.y,
      })
    }

    expect(selectedClip().transform.scaleX).toBeCloseTo(2.6)
    expect(selectedClip().transform.scaleY).toBeCloseTo(2.6)
    expect(useDocumentStore.getState().past).toHaveLength(4)
  })

  test('keyboard alternatives adjust move, scale, rotation, crop, anchor, and flips', async () => {
    render(<Harness />)
    const body = await screen.findByRole('button', { name: /selected visual clip/i })
    const scale = screen.getByRole('button', { name: /scale visual clip from bottom right corner/i })
    const rotate = screen.getByRole('button', { name: /rotate visual clip/i })
    const cropLeft = screen.getByRole('button', { name: /crop left edge/i })
    const anchor = screen.getByRole('button', { name: /move anchor/i })
    const flipHorizontal = screen.getByRole('button', { name: /flip .* horizontally/i })

    fireEvent.keyDown(body, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(scale, { key: 'ArrowUp', shiftKey: true })
    fireEvent.keyDown(rotate, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(cropLeft, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(anchor, { key: 'ArrowRight' })
    fireEvent.click(flipHorizontal)

    expect(selectedClip().transform).toMatchObject({
      scaleX: 1.1,
      scaleY: 1.1,
      rotation: 15,
      anchorX: 0.51,
    })
    expect(selectedClip().transform.x).toBeCloseTo(16.8001)
    expect(selectedClip().visual).toMatchObject({
      crop: { left: 0.05 },
      flipHorizontal: true,
    })
    expect(useDocumentStore.getState().past).toHaveLength(6)
  })

  test('pointer cancel and stale-document release never commit the draft', async () => {
    render(<Harness />)
    const body = await screen.findByRole('button', { name: /selected visual clip/i })

    fireEvent.pointerDown(body, { pointerId: 6, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(body, { pointerId: 6, clientX: 100, clientY: 0 })
    fireEvent.pointerCancel(body, { pointerId: 6, clientX: 100, clientY: 0 })
    expect(selectedClip().transform.x).toBe(0)
    expect(useDocumentStore.getState().past).toHaveLength(0)

    fireEvent.pointerDown(body, { pointerId: 7, clientX: 0, clientY: 0 })
    useDocumentStore.getState().updateClipVisual(selectedClip().id, { opacity: 0.5 })
    fireEvent.pointerMove(body, { pointerId: 7, clientX: 100, clientY: 0 })
    fireEvent.pointerUp(body, { pointerId: 7, clientX: 100, clientY: 0 })

    expect(selectedClip().transform.x).toBe(0)
    expect(selectedClip().opacity).toBe(0.5)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useTransportStore.getState().clipVisualPreview).toBeNull()
  })

  test('locked clips remain selectable but reject pointer, keyboard, and flip edits', async () => {
    const current = useDocumentStore.getState().doc
    useDocumentStore.setState({
      doc: {
        ...current,
        tracks: current.tracks.map((track) => track.kind === 'video'
          ? { ...track, locked: true }
          : track),
      },
    })
    render(<Harness />)
    const body = await screen.findByRole('button', { name: /selected visual clip/i })
    const flip = screen.getByRole('button', { name: /flip .* horizontally/i })

    fireEvent.pointerDown(body, { pointerId: 8, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(body, { pointerId: 8, clientX: 100, clientY: 0 })
    fireEvent.pointerUp(body, { pointerId: 8, clientX: 100, clientY: 0 })
    fireEvent.keyDown(body, { key: 'ArrowRight' })
    fireEvent.click(flip)

    expect(selectedClip().transform.x).toBe(0)
    expect(selectedClip().visual?.flipHorizontal).toBe(false)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    expect(body).toHaveAttribute('aria-disabled', 'true')
  })
})
