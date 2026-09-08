import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import TitleOverlayControls from './TitleOverlayControls'
import { expandedTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { useTitleEditorStore } from '../state/titleEditorStore'
import { readTitleElement } from '../domain/titleElements'
let rect: DOMRect
function current() { const parsed = readTitleElement((useDocumentStore.getState().doc.tracks[0].clips[0].title!.elements as unknown[])[0]); if (parsed.status !== 'supported') throw new Error(parsed.reason); return parsed.element }
function mount() {
  const canvas = document.createElement('canvas'), panel = document.createElement('div')
  canvas.getBoundingClientRect = () => rect; panel.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540)
  const canvasRef = createRef<HTMLCanvasElement>(), panelRef = createRef<HTMLDivElement>(); canvasRef.current = canvas; panelRef.current = panel
  return render(<TitleOverlayControls canvasRef={canvasRef} panelRef={panelRef} />)
}
function pointer(target: Element | Window, type: string, x: number, y: number, pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: pointerId }); fireEvent(target, event)
}
function animated(mode: 'Move' | 'Resize') {
  const properties = mode === 'Move' ? ['position-x', 'position-y'] : ['box-width', 'box-height']
  const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { tracks: [], titleTracks: properties.map((property) => ({
    elementId: 'root-element', property, propertyVersion: 1,
    keyframes: [{ frame: 0, value: 100, easing: { type: 'linear' as const } }, { frame: 99, value: 200, easing: { type: 'linear' as const } }],
  })) } }))
  useDocumentStore.getState().setProject(project)
  useTransportStore.getState().setPlayheadFrame(50)
}
beforeEach(() => {
  rect = new DOMRect(0, 0, 960, 540)
  useTransportStore.getState().resetTransport(); useDocumentStore.getState().setProject(expandedTitleProject())
  useTransportStore.getState().setSelectedClip('root-text'); useTitleEditorStore.getState().select('root-text', ['root-element'])
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => window.setTimeout(() => callback(0), 0))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id))
  vi.useFakeTimers()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
describe('title monitor input', () => {
  test('pointer movement previews then commits one project-pixel displacement', () => {
    mount(); const handle = screen.getByRole('button', { name: 'Move title element Text' })
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 130, 115)
    act(() => vi.runOnlyPendingTimers())
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    expect(current().transform.x).toBe(0)
    pointer(window, 'pointerup', 130, 115)
    expect(current().transform).toMatchObject({ x: 60, y: 30 }); expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  })
  test.each(['escape', 'blur', 'pointercancel', 'resize', 'unmount'] as const)('%s releases the draft and listeners without history', (kind) => {
    const mounted = mount(), handle = screen.getByRole('button', { name: 'Move title element Text' })
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 130, 115); act(() => vi.runOnlyPendingTimers())
    if (kind === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    else if (kind === 'blur') fireEvent.blur(window)
    else if (kind === 'pointercancel') pointer(window, 'pointercancel', 130, 115)
    else if (kind === 'resize') { rect = new DOMRect(0, 0, 480, 270); fireEvent(window, new Event('resize')) }
    else mounted.unmount()
    pointer(window, 'pointerup', 130, 115)
    expect(useDocumentStore.getState().past).toHaveLength(0); expect(current().transform.x).toBe(0)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  })
  test.each(['Move', 'Resize'] as const)('%s capture loss cancels matching gesture and a late pointer-up cannot commit', (mode) => {
    mount(); const handle = screen.getByRole('button', { name: `${mode} title element Text` })
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 130, 115); act(() => vi.runOnlyPendingTimers())
    expect(handle.hasPointerCapture(7)).toBe(true)
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    handle.releasePointerCapture(7); pointer(handle, 'lostpointercapture', 130, 115)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
    pointer(window, 'pointerup', 140, 125); act(() => vi.runOnlyPendingTimers())
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })
  test.each(['Move', 'Resize'] as const)('%s ignores another pointer capture-loss event and normal release cannot cancel its committed drag', (mode) => {
    mount(); const handle = screen.getByRole('button', { name: `${mode} title element Text` })
    const release = handle.releasePointerCapture.bind(handle)
    vi.spyOn(handle, 'releasePointerCapture').mockImplementation((id) => { release(id); pointer(handle, 'lostpointercapture', 130, 115, id) })
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 130, 115); act(() => vi.runOnlyPendingTimers())
    pointer(handle, 'lostpointercapture', 130, 115, 8)
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    pointer(window, 'pointerup', 130, 115)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(handle.hasPointerCapture(7)).toBe(false)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  })
  test.each(['Move', 'Resize'] as const)('%s click at an interpolated frame changes neither keys, project, history nor redo', (mode) => {
    animated(mode)
    const future = [expandedTitleProject()]; useDocumentStore.setState({ future })
    const before = useDocumentStore.getState()
    mount(); const handle = screen.getByRole('button', { name: `${mode} title element Text` })
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 100, 100); act(() => vi.runOnlyPendingTimers()); pointer(window, 'pointerup', 100, 100)
    expect(useDocumentStore.getState()).toBe(before)
    expect(useDocumentStore.getState().future).toBe(future)
    expect(handle.hasPointerCapture(7)).toBe(false)
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
  })
  test.each(['Move', 'Resize'] as const)('%s drag returning to its origin has no edit, while genuine animated drags and arrows author keys once', (mode) => {
    animated(mode); const before = useDocumentStore.getState()
    mount(); const handle = screen.getByRole('button', { name: `${mode} title element Text` })
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 130, 115); act(() => vi.runOnlyPendingTimers())
    pointer(window, 'pointermove', 100, 100); act(() => vi.runOnlyPendingTimers()); pointer(window, 'pointerup', 100, 100)
    expect(useDocumentStore.getState()).toBe(before)
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointerup', 110, 105)
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].animation!.titleTracks!.every((lane) => lane.keyframes.some((key) => key.frame === 50))).toBe(true)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })
  test('a click still selects an unselected animated element without creating keys', () => {
    animated('Move'); useTitleEditorStore.getState().select('root-text', [])
    const before = useDocumentStore.getState()
    mount(); const handle = screen.getByRole('button', { name: 'Move title element Text' })
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointerup', 100, 100); fireEvent.click(handle)
    expect(useTitleEditorStore.getState().ids).toEqual(['root-element'])
    expect(useDocumentStore.getState()).toBe(before)
  })
  test('arrow movement and resize use the same real commit facade', () => {
    mount(); fireEvent.keyDown(screen.getByRole('button', { name: 'Move title element Text' }), { key: 'ArrowRight', shiftKey: true })
    expect(current().transform.x).toBe(10)
    const before = current(); if (before.kind !== 'text') throw new Error('Expected text')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize title element Text' }), { key: 'ArrowRight' })
    const after = current(); if (after.kind !== 'text') throw new Error('Expected text')
    expect(after.text.boxWidthPx).toBe(before.text.boxWidthPx + 2)
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })
})
