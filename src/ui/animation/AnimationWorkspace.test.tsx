import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { useMediaStore } from '../../state/mediaStore'
import { usePreferencesStore } from '../../state/preferencesStore'
import { animationEditorController } from '../../app/animationEditorController'
import { legacyTitleProject, expandedTitleProject } from '../../test/titleOwnerFixtures'
import { foundationProject, scalarKey } from '../../test/animationFoundationFixtures'
import { clipWithAnimationKeyframeCount } from '../../test/animationBudgetFixtures'
import * as laneIndex from '../../domain/animationLaneIndex'
import AnimationWorkspace from './AnimationWorkspace'
import AnimationEntry from './AnimationEntry'

vi.mock('../../app/pluginAppController', () => ({ getPluginAppController: () => ({ getContributionSnapshot: () => undefined, subscribe: () => () => {} }) }))
let release: (() => void) | undefined
let frames = new Map<number, FrameRequestCallback>(), handle = 0
const store = useDocumentStore.getState, transport = useTransportStore.getState
const keys = () => store().doc.tracks[0].clips[0].animation?.tracks.find((track) => track.property === 'opacity')?.keyframes ?? []
const grid = () => screen.getByRole('grid', { name: 'Animation keys' })
const keyDown = (key: string, options: Record<string, unknown> = {}) => fireEvent.keyDown(grid(), { key, ...options })
function install(animated = true) {
  const project = legacyTitleProject()
  if (animated) project.sequences[0].tracks[0].clips[0].animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, .2), scalarKey(10, .8)] }] }
  store().setProject(project)
}
beforeEach(() => {
  transport().resetTransport(); useMediaStore.setState({ descriptors: new Map(), collections: [], assets: new Map() })
  usePreferencesStore.setState({ snappingEnabled: false })
  frames = new Map(); handle = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++handle, callback); return handle })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  install(); release = animationEditorController.init(); transport().setAnimationWorkspaceOpen(true)
})
afterEach(() => { cleanup(); release?.(); release = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
function flushFrames() { act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)) }) }

describe('unified animation workspace', () => {
  test('sets, edits, navigates, moves, copies and pastes through the actual app facade with one undo per edit', async () => {
    install(false)
    const user = userEvent.setup()
    render(<AnimationWorkspace />)
    keyDown('k')
    expect(keys()).toHaveLength(1); expect(store().past).toHaveLength(1)
    await user.clear(screen.getByTestId('animation-key-value'))
    await user.type(screen.getByTestId('animation-key-value'), '0.4{Enter}')
    expect(keys()[0].value).toBe(.4); expect(store().past).toHaveLength(2)
    act(() => transport().setPlayheadFrame(10)); keyDown('k')
    keyDown('Home'); keyDown('End', { shiftKey: true })
    expect(transport().animationSelection.map((key) => key.frame)).toEqual([0, 10])
    keyDown('ArrowRight', { ctrlKey: true })
    expect(keys().map((key) => key.frame)).toEqual([1, 11]); expect(store().past).toHaveLength(4)
    keyDown('c', { ctrlKey: true }); act(() => transport().setPlayheadFrame(30)); keyDown('v', { ctrlKey: true })
    expect(keys().map((key) => key.frame)).toEqual([1, 11, 30, 40]); expect(store().past).toHaveLength(5)
    keyDown('z', { ctrlKey: true }); expect(keys().map((key) => key.frame)).toEqual([1, 11])
    keyDown('z', { ctrlKey: true, shiftKey: true }); expect(keys()).toHaveLength(4)
    const before = store()
    keyDown('v', { ctrlKey: true, shiftKey: true })
    expect(store()).toBe(before); expect(screen.getByRole('status').textContent).toMatch(/collision|occupied|overwrite/i)
  })

  test('keyboard commands stay inside the workspace and native input/IME editing wins', () => {
    const listener = vi.fn(); window.addEventListener('keydown', listener)
    render(<AnimationWorkspace />); keyDown('Home')
    expect(listener).not.toHaveBeenCalled()
    const before = store()
    fireEvent.keyDown(screen.getByLabelText('Filter animation lanes'), { key: 'Delete' })
    fireEvent.keyDown(grid(), { key: 'Delete', isComposing: true })
    expect(store()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener('keydown', listener)
    keyDown('Delete'); expect(keys()).toHaveLength(1)
  })

  test('unsupported stored lanes expose the reason and exact timing/copy/delete while disabling numeric authoring', () => {
    const project = legacyTitleProject()
    project.sequences[0].tracks[0].clips[0].animation = { tracks: [{ property: 'future-property', propertyVersion: 4, keyframes: [scalarKey(-20, .4), scalarKey(300, .8)] }] }
    act(() => store().setProject(project))
    render(<AnimationWorkspace />)
    fireEvent.change(screen.getByLabelText('Filter animation lanes'), { target: { value: 'future-property' } })
    keyDown('Home')
    expect(screen.getByTestId('animation-key-frame')).toHaveValue(-20)
    expect(screen.getByTestId('animation-key-value')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Set key at playhead' })).toBeDisabled()
    keyDown('c', { ctrlKey: true }); expect(animationEditorController.getClipboard()?.lanes[0].track).toMatchObject({ propertyVersion: 4 })
    keyDown('ArrowRight', { ctrlKey: true, shiftKey: true })
    expect(store().doc.tracks[0].clips[0].animation?.tracks[0].keyframes[0].frame).toBe(-10)
    keyDown('End'); expect(screen.getByTestId('animation-key-frame')).toHaveValue(300)
    keyDown('Delete'); expect(store().doc.tracks[0].clips[0].animation?.tracks[0].keyframes).toHaveLength(1)
  })

  test('filters the full sequence by selected owners, animated state, text and kind; locks reject edits', () => {
    const project = expandedTitleProject(); project.sequences[0].tracks[0].locked = true
    act(() => store().setProject(project))
    render(<AnimationWorkspace />)
    fireEvent.change(screen.getByLabelText('Animation lane kind'), { target: { value: 'title' } })
    expect(screen.getAllByRole('rowheader').some((row) => row.textContent?.includes('Opacity'))).toBe(true)
    fireEvent.click(screen.getByLabelText('Animated only')); expect(screen.queryAllByRole('rowheader')).toHaveLength(0)
    fireEvent.click(screen.getByLabelText('Animated only')); fireEvent.click(screen.getByLabelText('Selected items'))
    expect(screen.queryAllByRole('rowheader')).toHaveLength(0)
    act(() => transport().setSelectedClip('root-text'))
    expect(screen.getAllByRole('rowheader').length).toBeGreaterThan(0)
    const before = store(); keyDown('k'); expect(store()).toBe(before)
    expect(screen.getByRole('button', { name: 'Set key at playhead' })).toBeDisabled()
  })

  test('100,000 keys remain within row/glyph limits and exact keyboard selection survives dense buckets and playhead ticks', () => {
    const project = foundationProject(); project.sequences[0].tracks[0].clips[0] = clipWithAnimationKeyframeCount(project.sequences[0].tracks[0].clips[0])
    act(() => store().setProject(project)); const spy = vi.spyOn(laneIndex, 'buildAnimationLaneIndex')
    const { container } = render(<AnimationWorkspace />)
    expect(container.querySelectorAll('[data-animation-lane]').length).toBeLessThanOrEqual(40)
    expect(container.querySelectorAll('[data-animation-glyph]').length).toBeLessThanOrEqual(512)
    const firstCount = spy.mock.calls.length
    for (let frame = 0; frame < 5; frame++) act(() => transport().setPlayheadFrame(frame))
    expect(spy).toHaveBeenCalledTimes(firstCount)
    fireEvent.click(screen.getByLabelText('Animated only')); keyDown('Home'); keyDown('End')
    const focus = transport().animationFocus!
    expect(focus.frame).toBe(1023)
    expect(document.getElementById(grid().getAttribute('aria-activedescendant')!)).toHaveTextContent('local frame 1023')
    keyDown('a', { ctrlKey: true }); expect(transport().animationSelection).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toMatch(/4,096/)
  })

  test('a click makes no edit; captured drag is data-only until release and lost capture/Escape cancel it', () => {
    const { container } = render(<AnimationWorkspace />)
    const glyph = () => container.querySelector('[data-animation-glyph]')!
    fireEvent.pointerDown(glyph(), { button: 0, pointerId: 1, clientX: 0 }); fireEvent.pointerUp(glyph(), { pointerId: 1, clientX: 0 })
    expect(store().past).toHaveLength(0)
    fireEvent.pointerDown(glyph(), { button: 0, pointerId: 2, clientX: 0 }); fireEvent.pointerMove(glyph(), { pointerId: 2, clientX: 12 })
    flushFrames(); expect(transport().animationPreview).not.toBeNull(); expect(store().past).toHaveLength(0)
    fireEvent.lostPointerCapture(glyph(), { pointerId: 2 }); expect(transport().animationPreview).toBeNull()
    fireEvent.pointerDown(glyph(), { button: 0, pointerId: 3, clientX: 0 }); fireEvent.pointerMove(glyph(), { pointerId: 3, clientX: 12 }); flushFrames(); keyDown('Escape')
    expect(transport().animationPreview).toBeNull(); expect(store().past).toHaveLength(0)
    fireEvent.pointerDown(glyph(), { button: 0, pointerId: 4, clientX: 0 }); fireEvent.pointerMove(glyph(), { pointerId: 4, clientX: 12 }); fireEvent.pointerUp(glyph(), { pointerId: 4, clientX: 12 })
    expect(store().past).toHaveLength(1); expect(transport().animationPreview).toBeNull()
  })

  test('curve and easing use bounded samples and reject invalid numeric handles without a stale UI draft', async () => {
    const user = userEvent.setup(); const { container } = render(<AnimationWorkspace />); keyDown('Home')
    fireEvent.change(screen.getByLabelText('Key easing'), { target: { value: 'Ease in/out' } })
    expect(keys()[0].easing).toMatchObject({ type: 'cubic-bezier', x1: .42 })
    fireEvent.click(screen.getByRole('button', { name: 'Curve' }))
    expect(Number(container.querySelector('[data-curve-samples]')?.getAttribute('data-curve-samples'))).toBeLessThanOrEqual(256)
    const before = store(); await user.clear(screen.getByTestId('animation-bezier-x1')); await user.type(screen.getByTestId('animation-bezier-x1'), '2{Enter}')
    expect(store()).toBe(before); expect(screen.getByRole('status').textContent).toMatch(/easing|Bezier|Bézier|0.*1/i)
    expect(screen.getByTestId('animation-bezier-x1')).toHaveValue(0.42)
  })

  test('explicit paste mapping can assign every copied lane and commits only after complete domain validation', () => {
    const project = expandedTitleProject(), clip = project.sequences[0].tracks[0].clips[0]
    clip.animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, .2)] }], titleTracks: [{ elementId: 'root-element', property: 'opacity', propertyVersion: 1, keyframes: [scalarKey(5, .7)] }] }
    act(() => store().setProject(project)); render(<AnimationWorkspace />)
    fireEvent.click(screen.getByLabelText('Animated only')); keyDown('a', { ctrlKey: true }); keyDown('c', { ctrlKey: true })
    expect(animationEditorController.getClipboard()?.lanes).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Map paste…' }))
    const rows = screen.getAllByRole('rowheader')
    fireEvent.click(rows[0]); fireEvent.click(screen.getByRole('button', { name: 'Assign focused property' }))
    expect(screen.getByRole('button', { name: /Paste mapped lanes/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next copied lane' })); fireEvent.click(rows[1]); fireEvent.click(screen.getByRole('button', { name: 'Assign focused property' }))
    act(() => transport().setPlayheadFrame(30)); fireEvent.click(screen.getByRole('button', { name: /Paste mapped lanes/ }))
    expect(store().past).toHaveLength(1)
    expect(store().doc.tracks[0].clips[0].animation?.titleTracks?.[0].keyframes.at(-1)?.frame).toBe(35)
  })

  test.each(['1', '2'])('Bézier pointer handle %s shows only admitted rAF previews and commits once on release', (which) => {
    render(<AnimationWorkspace />); keyDown('Home')
    fireEvent.change(screen.getByLabelText('Key easing'), { target: { value: 'Ease in/out' } })
    fireEvent.click(screen.getByRole('button', { name: 'Curve' }))
    const handle = screen.getByRole('button', { name: `Drag Bézier handle ${which}; numeric alternatives in key controls` })
    const before = store()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 80 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 90, clientY: 50 })
    expect(transport().animationPreview).toBeNull(); expect(store()).toBe(before)
    flushFrames(); expect(transport().animationPreview?.easing).toMatchObject({ type: 'cubic-bezier' }); expect(store()).toBe(before)
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 90, clientY: 50 })
    expect(store().past).toHaveLength(before.past.length + 1); expect(transport().animationPreview).toBeNull()
    expect(keys()[0].easing).toMatchObject({ type: 'cubic-bezier', [`x${which}`]: 1 })
  })

  test.each(['1', '2'].flatMap((handle) => [0, 2, -2].map((offset) => ({ handle, offset }))))('a no-motion click on Bézier handle $handle at hit offset $offset preserves exact state and redo', ({ handle: which, offset }) => {
    render(<AnimationWorkspace />); keyDown('Home')
    fireEvent.change(screen.getByLabelText('Key easing'), { target: { value: 'Ease in/out' } })
    keyDown('ArrowRight', { ctrlKey: true }); keyDown('z', { ctrlKey: true }); keyDown('Home'); keyDown('c', { ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Curve' }))
    const handle = screen.getByRole('button', { name: `Drag Bézier handle ${which}; numeric alternatives in key controls` })
    const clientX = Number(handle.getAttribute('cx')) + offset, clientY = Number(handle.getAttribute('cy')) + offset
    const before = store(), easing = keys()[0].easing, clipboard = animationEditorController.getClipboard()
    expect(before.future).toHaveLength(1)
    fireEvent.pointerDown(handle, { button: 0, pointerId: 42, clientX, clientY })
    fireEvent.pointerUp(handle, { pointerId: 42, clientX, clientY })
    expect(store()).toBe(before); expect(keys()[0].easing).toBe(easing); expect(animationEditorController.getClipboard()).toBe(clipboard)
    expect(transport().animationPreview).toBeNull(); expect(frames.size).toBe(0)
  })

  test.each(['1', '2'])('Bézier handle %s ignores sub-threshold jitter and cancels real previews on lost capture and Escape', (which) => {
    render(<AnimationWorkspace />); keyDown('Home')
    fireEvent.change(screen.getByLabelText('Key easing'), { target: { value: 'Ease in/out' } })
    fireEvent.click(screen.getByRole('button', { name: 'Curve' }))
    const handle = screen.getByRole('button', { name: `Drag Bézier handle ${which}; numeric alternatives in key controls` })
    const clientX = Number(handle.getAttribute('cx')) + 2, clientY = Number(handle.getAttribute('cy')) + 2, before = store()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX, clientY })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: clientX + 1, clientY: clientY + 1 }); flushFrames()
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: clientX + 1, clientY: clientY + 1 })
    expect(store()).toBe(before); expect(transport().animationPreview).toBeNull()
    for (const cancel of ['capture', 'escape']) {
      fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX, clientY })
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: clientX + 20, clientY: clientY + 20 }); flushFrames()
      expect(transport().animationPreview).not.toBeNull(); expect(store()).toBe(before)
      if (cancel === 'capture') fireEvent.lostPointerCapture(handle, { pointerId: 2 })
      else keyDown('Escape')
      fireEvent.pointerUp(handle, { pointerId: 2, clientX: clientX + 20, clientY: clientY + 20 })
      expect(store()).toBe(before); expect(transport().animationPreview).toBeNull(); expect(frames.size).toBe(0)
    }
    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX, clientY })
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: clientX + 20, clientY: clientY + 20 }); flushFrames()
    fireEvent.pointerMove(handle, { pointerId: 3, clientX, clientY }); flushFrames()
    fireEvent.pointerUp(handle, { pointerId: 3, clientX, clientY })
    expect(store()).toBe(before); expect(transport().animationPreview).toBeNull(); expect(frames.size).toBe(0)
  })

  test('Inspector entry and close retain document identity and cancel a live preview', () => {
    transport().setAnimationSelection([{ lane: { owner: { kind: 'clip', id: 'root-text' }, kind: 'scalar', property: 'opacity', propertyVersion: 1 }, frame: 10 }])
    const before = store(); render(<AnimationEntry lane={{ owner: { kind: 'clip', id: 'root-text' }, kind: 'scalar', property: 'opacity', propertyVersion: 1 }} />)
    fireEvent.click(screen.getByRole('button')); expect(transport().animationWorkspaceOpen).toBe(true); expect(store()).toBe(before)
    expect(transport().animationSelection).toEqual([])
    cleanup(); render(<AnimationWorkspace />); keyDown('Home')
    act(() => animationEditorController.begin().preview({ kind: 'move', deltaFrames: 1 })); flushFrames()
    expect(transport().animationPreview).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Timeline' })); expect(transport().animationPreview).toBeNull(); expect(transport().animationWorkspaceOpen).toBe(false); expect(store()).toBe(before)
  })

  test('explicit unavailable entries and future stored versions never fall back to a different editable property', () => {
    act(() => transport().setAnimationFocusedLane({ owner: { kind: 'clip', id: 'root-text' }, kind: 'effect', effectId: 'unknown', parameter: 'strength' }))
    render(<AnimationWorkspace />)
    expect(screen.getByRole('button', { name: 'Set key at playhead' })).toBeDisabled()
    expect(screen.getByText('This title effect does not support animation.')).toBeInTheDocument()
    const before = store(); keyDown('k'); expect(store()).toBe(before)
    const project = legacyTitleProject()
    project.sequences[0].tracks[0].clips[0].animation = { tracks: [{ property: 'opacity', propertyVersion: 9, keyframes: [scalarKey(0, .4)] }] }
    act(() => { store().setProject(project); transport().setAnimationFocusedLane({ owner: { kind: 'clip', id: 'root-text' }, kind: 'scalar', property: 'opacity', propertyVersion: 1 }) })
    keyDown('Home')
    expect(transport().animationFocus?.lane).toMatchObject({ propertyVersion: 9 })
    expect(screen.getByTestId('animation-key-value')).toBeDisabled()
  })

  test('toolbar keyboard delete still targets keys, and playback or a viewport change cancels an in-flight drag', () => {
    const { container } = render(<AnimationWorkspace />); keyDown('Home')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Copy' }), { key: 'Delete' })
    expect(keys()).toHaveLength(1)
    const glyph = container.querySelector('[data-animation-glyph]')!
    fireEvent.pointerDown(glyph, { button: 0, pointerId: 1, clientX: 0 }); fireEvent.pointerMove(glyph, { pointerId: 1, clientX: 12 }); flushFrames()
    expect(transport().animationPreview).not.toBeNull()
    act(() => transport().setZoom(transport().zoom * 2))
    expect(transport().animationPreview).toBeNull()
    const before = store(); act(() => useTransportStore.setState({ isPlaying: true })); keyDown('Delete')
    expect(store()).toBe(before)
  })
})
