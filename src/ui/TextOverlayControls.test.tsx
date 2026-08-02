import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useRef } from 'react'
import { createTextClip, insertClip } from '../domain/operations'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { findClip } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import TextOverlayControls from './TextOverlayControls'

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

function textFixture() {
  const empty = createTimelineDoc('Canvas controls', DEFAULT_PROJECT_SETTINGS, 'doc-controls')
  const clip = createTextClip(empty, 0, 90, 'Move me')
  return { clip, doc: insertClip(empty, 'V1', clip) }
}

function Harness() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  return (
    <div className="preview-panel" ref={panelRef}>
      <canvas className="preview-canvas" ref={canvasRef} />
      <TextOverlayControls canvasRef={canvasRef} panelRef={panelRef} />
    </div>
  )
}

beforeEach(() => {
  const { clip, doc } = textFixture()
  useDocumentStore.setState({ doc, past: [], future: [] })
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

describe('TextOverlayControls', () => {
  test('selects an overlay through the button activation contract', async () => {
    useTransportStore.getState().setSelectedClip(null)
    render(<Harness />)
    const move = await screen.findByRole('button', { name: /^text overlay: move me$/i })

    fireEvent.click(move)

    expect(useTransportStore.getState().selectedClipId).not.toBeNull()
    expect(move).toHaveAttribute('aria-pressed', 'true')
  })

  test('keyboard move and resize are accessible undoable edits', async () => {
    render(<Harness />)
    const move = await screen.findByRole('button', { name: /selected text overlay: move me/i })
    const resize = await screen.findByRole('button', { name: /resize text overlay: move me/i })
    const clipId = useTransportStore.getState().selectedClipId!
    const originalHeight = findClip(useDocumentStore.getState().doc, clipId)!.text!.boxHeightPx

    fireEvent.keyDown(move, { key: 'ArrowRight', shiftKey: true })
    expect(findClip(useDocumentStore.getState().doc, clipId)?.transform.x).toBe(10)
    fireEvent.keyDown(resize, { key: 'ArrowDown' })
    expect(findClip(useDocumentStore.getState().doc, clipId)?.text?.boxHeightPx).toBe(originalHeight + 1)
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })

  test('pointer movement previews ephemerally and commits once on pointer-up', async () => {
    render(<Harness />)
    const move = await screen.findByRole('button', { name: /selected text overlay: move me/i })
    const clipId = useTransportStore.getState().selectedClipId!

    fireEvent.pointerDown(move, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(move, { pointerId: 1, clientX: 200, clientY: 150 })
    expect(findClip(useDocumentStore.getState().doc, clipId)?.transform.x).toBe(0)
    fireEvent.pointerUp(move, { pointerId: 1, clientX: 200, clientY: 150 })

    expect(findClip(useDocumentStore.getState().doc, clipId)?.transform).toMatchObject({
      x: 200,
      y: 100,
    })
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useTransportStore.getState().textOverlayPreview).toBeNull()
  })

  test('cancels a stale pointer commit when the document changes mid-gesture', async () => {
    render(<Harness />)
    const move = await screen.findByRole('button', { name: /selected text overlay: move me/i })
    const clipId = useTransportStore.getState().selectedClipId!

    fireEvent.pointerDown(move, { pointerId: 2, clientX: 100, clientY: 100 })
    useDocumentStore.getState().updateClipTransform(clipId, { opacity: 0.5 })
    fireEvent.pointerMove(move, { pointerId: 2, clientX: 300, clientY: 100 })
    fireEvent.pointerUp(move, { pointerId: 2, clientX: 300, clientY: 100 })

    expect(findClip(useDocumentStore.getState().doc, clipId)?.transform.x).toBe(0)
    expect(findClip(useDocumentStore.getState().doc, clipId)?.opacity).toBe(0.5)
    expect(useDocumentStore.getState().past).toHaveLength(1)
  })
})
