import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import MaskOverlayControls from './MaskOverlayControls'
import MaskEditorToggle from './MaskEditorToggle'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { createMaskEffect } from '../domain/effectStack'
import { editMaskBezierPath } from '../domain/maskPathEdit'
import { parseMaskBezierPath } from '../domain/maskPath'
import { attributeClip } from '../test/clipAttributeFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

const target = { sequenceId: 'mask-ui', clipId: 'clip', effectId: 'mask' }
let canvasWidth = 960
let nextFrame = 1
const frames = new Map<number, FrameRequestCallback>()
function flush() { act(() => { const queued = [...frames.values()]; frames.clear(); queued.forEach((callback) => callback(0)) }) }
function Harness() {
  const canvasRef = useRef<HTMLCanvasElement>(null), panelRef = useRef<HTMLDivElement>(null)
  return <><MaskEditorToggle clipId="clip" effectId="mask" /><div ref={panelRef}><canvas ref={canvasRef} /><MaskOverlayControls canvasRef={canvasRef} panelRef={panelRef} /></div></>
}
const params = () => useDocumentStore.getState().doc.tracks[0].clips[0].effects[0].params
const pointer = (x: number, y: number, pointerId = 1) => ({ button: 0, pointerId, clientX: x, clientY: y })
function start(name = 'Move mask') {
  const handle = screen.getByRole('button', { name })
  fireEvent.pointerDown(handle, pointer(340, 185))
  return handle
}
beforeEach(() => {
  useTransportStore.getState().resetTransport()
  const doc = structuredClone(createTimelineDoc('Mask UI', DEFAULT_PROJECT_SETTINGS, target.sequenceId))
  const clip = attributeClip('clip'); clip.effects = [createMaskEffect('mask', 'rectangle')]
  clip.effects[0].params = { ...clip.effects[0].params, x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
  doc.tracks[0].clips = [clip]
  useDocumentStore.getState().setDoc(doc)
  useTransportStore.getState().setSelectedClip('clip')
  useTransportStore.getState().setMaskEditorTarget(target)
  canvasWidth = 960; frames.clear(); nextFrame = 1
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return DOMRect.fromRect(this instanceof HTMLCanvasElement ? { x: 100, y: 50, width: canvasWidth, height: 540 } : { x: 0, y: 0, width: 1200, height: 700 })
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
})
afterEach(() => { cleanup(); useTransportStore.getState().resetTransport(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

test('pointer moves coalesce into one preview, then release uses its fresh position and commits once', () => {
  render(<Harness />)
  const before = useDocumentStore.getState().project
  start()
  for (let i = 1; i <= 10; i++) fireEvent.pointerMove(window, pointer(340 + i * 4, 185 + i * 2))
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  expect(useTransportStore.getState().maskPreview).toBeNull()
  flush()
  expect(useTransportStore.getState().maskPreview?.params.x).toBeCloseTo(0.1 + 40 / 960)
  expect(useDocumentStore.getState().project).toBe(before)
  fireEvent.pointerUp(window, pointer(400, 215))
  expect(params().x).toBeCloseTo(0.1 + 60 / 960)
  expect(params().y).toBeCloseTo(0.1 + 30 / 540)
  expect(useDocumentStore.getState().past).toEqual([before])
  expect(useTransportStore.getState().maskPreview).toBeNull()
})

test('resize preserves the opposite corner; keyboard and no-op clicks have exact history behavior', () => {
  render(<Harness />)
  start('Resize mask top-left'); fireEvent.pointerUp(window, pointer(388, 212))
  for (const [key, value] of Object.entries({ x: 0.15, y: 0.15, width: 0.45, height: 0.45 })) expect(params()[key]).toBeCloseTo(value)
  const before = useDocumentStore.getState().past.length
  start(); fireEvent.pointerUp(window, pointer(340, 185))
  expect(useDocumentStore.getState().past).toHaveLength(before)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move mask' }), { key: 'ArrowRight', shiftKey: true })
  expect(params().x).toBeCloseTo(0.15 + 10 / 1920)
  expect(useDocumentStore.getState().past).toHaveLength(before + 1)
})

test.each(['escape', 'pointercancel', 'lostcapture', 'blur', 'unmount', 'resize', 'frame', 'selection'] as const)('%s discards even a queued movement and late release', (kind) => {
  const rendered = render(<Harness />), before = useDocumentStore.getState().project
  const handle = start(); fireEvent.pointerMove(window, pointer(400, 210)); flush()
  fireEvent.pointerMove(window, pointer(420, 220))
  if (kind === 'escape') fireEvent.keyDown(handle, { key: 'Escape' })
  if (kind === 'pointercancel') fireEvent.pointerCancel(window, pointer(420, 220))
  if (kind === 'lostcapture') fireEvent.lostPointerCapture(handle, { pointerId: 1 })
  if (kind === 'blur') fireEvent.blur(window)
  if (kind === 'unmount') rendered.unmount()
  if (kind === 'resize') { canvasWidth = 800; fireEvent.resize(window) }
  if (kind === 'frame') act(() => useTransportStore.getState().setPlayheadFrame(2))
  if (kind === 'selection') act(() => useTransportStore.getState().setSelectedClip(null))
  flush(); fireEvent.pointerUp(window, pointer(430, 230))
  expect(useTransportStore.getState().maskPreview).toBeNull()
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [] })
})

test('capture failure still finishes outside the handle, and unrelated pointers cannot cancel it', () => {
  vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => { throw new Error('capture unavailable') })
  render(<Harness />)
  const handle = start()
  fireEvent.pointerCancel(window, pointer(420, 220, 9)); fireEvent.lostPointerCapture(handle, { pointerId: 9 })
  fireEvent.pointerMove(window, pointer(388, 185)); flush()
  fireEvent.pointerUp(window, pointer(388, 185))
  expect(params().x).toBeCloseTo(0.15)
  expect(useDocumentStore.getState().past).toHaveLength(1)
})

test('Bezier controls share point commands with numeric and keyboard input, and support topology edits', () => {
  const doc = structuredClone(useDocumentStore.getState().doc); doc.tracks[0].clips[0].effects[0].params.shape = 'bezier'
  useDocumentStore.getState().setDoc(doc)
  render(<Harness />)
  const before = params().path as string, control = screen.getByRole('button', { name: 'Mask control 1.1' })
  fireEvent.focus(control); fireEvent.keyDown(control, { key: 'ArrowDown' })
  const expected = editMaskBezierPath(before, { kind: 'move-point', part: { kind: 'control', segment: 0, control: 1 }, delta: { x: 0, y: 1 / (0.5 * 1080) } })
  expect(expected.ok && params().path).toBe(expected.ok && expected.path)
  fireEvent.change(screen.getByLabelText('Point X (%)'), { target: { value: '25' } })
  fireEvent.change(screen.getByLabelText('Point Y (%)'), { target: { value: '30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set point' }))
  expect(parseMaskBezierPath(params().path as string)?.segments[0]).toMatchObject({ control1: { x: 0.25, y: 0.3 } })
  const count = parseMaskBezierPath(params().path as string)!.segments.length
  fireEvent.click(screen.getByRole('button', { name: 'Add point' }))
  expect(parseMaskBezierPath(params().path as string)!.segments).toHaveLength(count + 1)
  fireEvent.click(screen.getByRole('button', { name: 'Delete point' }))
  expect(parseMaskBezierPath(params().path as string)!.segments).toHaveLength(count)
})

test('close restores toggle focus and unavailable targets explain why editing cannot open', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Close mask editor' }))
  const toggle = screen.getByRole('button', { name: 'Edit mask in Program' })
  expect(toggle).toHaveFocus()
  act(() => useTransportStore.getState().setPlayheadFrame(60))
  expect(toggle).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByText(/Move the playhead inside/)).toBeVisible()
  fireEvent.click(toggle)
  expect(useTransportStore.getState().maskEditorTarget).toBeNull()
})

function drawPoint(x: number, y: number) {
  fireEvent.click(screen.getByRole('button', { name: 'Add mask path point in Program' }), { clientX: 100 + (0.1 + 0.5 * x) * canvasWidth, clientY: 50 + (0.1 + 0.5 * y) * 540, detail: 1 })
}
function beginDrawing() { fireEvent.click(screen.getByRole('button', { name: 'Draw new path' })) }
function numericDraftPoint(x: number, y: number) {
  fireEvent.change(screen.getByLabelText('Next point X (%)'), { target: { value: String(x) } })
  fireEvent.change(screen.getByLabelText('Next point Y (%)'), { target: { value: String(y) } })
  fireEvent.click(screen.getByRole('button', { name: 'Add draft point' }))
}

test('open points and remove remain temporary; Close creates one valid path with exact undo/redo', () => {
  render(<Harness />)
  const before = useDocumentStore.getState().project
  useDocumentStore.setState({ future: [before] })
  beginDrawing()
  expect(screen.getByRole('button', { name: 'Close path' })).toBeDisabled()
  drawPoint(0.2, 0.2); drawPoint(0.8, 0.2); drawPoint(0.8, 0.8)
  fireEvent.click(screen.getByRole('button', { name: 'Remove last draft point' }))
  expect(screen.getByRole('button', { name: 'Close path' })).toBeDisabled()
  numericDraftPoint(20, 80)
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [], future: [before] })
  expect(useTransportStore.getState().maskPreview).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close path' }))
  expect(params().shape).toBe('bezier')
  const path = parseMaskBezierPath(params().path as string)!
  expect(path.segments).toHaveLength(3)
  expect(path.start).toEqual({ x: 0.2, y: 0.2 })
  expect(path.segments.at(-1)!.end).toEqual(path.start)
  expect(useDocumentStore.getState().past).toEqual([before])
  expect(screen.getByRole('button', { name: 'Draw new path' })).toHaveFocus()
  act(() => useDocumentStore.getState().undo()); expect(useDocumentStore.getState().project).toBe(before)
  act(() => useDocumentStore.getState().redo()); expect(params().path).toBeTruthy()
})

test.each(['escape', 'cancel', 'blur', 'pointercancel', 'resize', 'canvas-hidden', 'selection', 'generation', 'frame', 'unmount'] as const)('open draft %s leaves no preview or history, including late Close', (kind) => {
  const rendered = render(<Harness />), before = useDocumentStore.getState().project
  beginDrawing(); drawPoint(0.2, 0.2); drawPoint(0.8, 0.2); drawPoint(0.8, 0.8)
  const close = screen.getByRole('button', { name: 'Close path' })
  if (kind === 'escape') fireEvent.keyDown(close, { key: 'Escape' })
  if (kind === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel new path' }))
  if (kind === 'blur') fireEvent.blur(window)
  if (kind === 'pointercancel') fireEvent.pointerCancel(screen.getByRole('button', { name: 'Add mask path point in Program' }))
  if (kind === 'resize') { canvasWidth = 800; fireEvent.resize(window) }
  if (kind === 'canvas-hidden') { canvasWidth = 0; fireEvent.resize(window); canvasWidth = 960; fireEvent.resize(window) }
  if (kind === 'selection') act(() => useTransportStore.getState().setClipSelection(['other', 'clip'], 'clip'))
  if (kind === 'generation') act(() => useDocumentStore.setState({ projectGeneration: useDocumentStore.getState().projectGeneration + 1 }))
  if (kind === 'frame') act(() => useTransportStore.getState().setPlayheadFrame(2))
  if (kind === 'unmount') rendered.unmount()
  expect(screen.queryByRole('button', { name: 'Close path' })).toBeNull()
  fireEvent.click(close)
  expect(useDocumentStore.getState()).toMatchObject({ project: before, past: [] })
  expect(useTransportStore.getState().maskPreview).toBeNull()
})

test('opening layout may settle before the first point; later resizing cancels the pinned draft', () => {
  render(<Harness />); beginDrawing()
  canvasWidth = 800; fireEvent.resize(window)
  expect(screen.getByRole('button', { name: 'Close path' })).toBeDisabled()
  drawPoint(0.2, 0.2)
  expect(screen.getByRole('status')).toHaveTextContent('1/8 points')
  canvasWidth = 900; fireEvent.resize(window)
  expect(screen.queryByRole('button', { name: 'Close path' })).toBeNull()
  expect(useDocumentStore.getState().past).toEqual([])
})

test('open authoring bounds points and exposes validation without changing saved state', () => {
  render(<Harness />); beginDrawing()
  drawPoint(-0.1, 0.2)
  expect(screen.getByRole('alert')).toHaveTextContent(/inside the mask box/)
  expect(screen.getByRole('status')).toHaveTextContent('0/8 points')
  for (let i = 0; i < 8; i++) numericDraftPoint(i * 10, i % 2 * 50)
  expect(screen.getByRole('button', { name: 'Add draft point' })).toBeDisabled()
  drawPoint(0.9, 0.9)
  expect(screen.getByRole('alert')).toHaveTextContent(/at most eight/)
  expect(useDocumentStore.getState().past).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Close path' }))
  expect(parseMaskBezierPath(params().path as string)!.segments).toHaveLength(8)
  expect(useDocumentStore.getState().past).toHaveLength(1)
})
