import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { expandedTitleProject, legacyTitleProject } from '../test/titleOwnerFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { useTitleEditorStore } from '../state/titleEditorStore'
import { useTitleTemplateStore } from '../state/titleTemplateStore'
import { readTitleElement } from '../domain/titleElements'
import { planTitleEdit } from '../domain/titleEditing'
import { builtInTitleTemplates } from '../domain/titleTemplates'
import { beginTitleEdit } from '../app/titleEditingController'
import { titleTemplateController } from '../app/titleTemplateController'
import TitleInspector from './TitleInspector'
import TitleMotionDialog from './TitleMotionDialog'
import TitleTemplateDialog from './TitleTemplateDialog'
const target = { sequenceId: 'root', clipId: 'root-text' }
function Inspector() { const clip = useDocumentStore((s) => s.doc.tracks[0].clips[0]); return <TitleInspector clip={clip} locked={false} /> }
function currentElement() {
  const parsed = readTitleElement((useDocumentStore.getState().doc.tracks[0].clips[0].title!.elements as unknown[])[0])
  if (parsed.status !== 'supported') throw new Error(parsed.reason); return parsed.element
}
beforeEach(() => {
  useDocumentStore.getState().setProject(expandedTitleProject())
  useTransportStore.getState().resetTransport(); useTransportStore.getState().setSelectedClip('root-text')
  useTitleEditorStore.getState().select('root-text', ['root-element'])
  useMediaStore.setState({ descriptors: new Map(), collections: [], assets: new Map() })
  useTitleTemplateStore.setState({ templates: [], unavailable: [], readOnlyReason: null, busy: false, error: null, loaded: false })
  vi.spyOn(titleTemplateController, 'load').mockResolvedValue(true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('title authoring surfaces', () => {
  test('compact editing requires the explicit Upgrade action; one undo restores compact wire data', () => {
    const project = legacyTitleProject(); useDocumentStore.getState().setProject(project)
    render(<Inspector />)
    expect(screen.queryByLabelText('Text content')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to title' }))
    expect(screen.getByLabelText('Text content')).toBeInTheDocument()
    expect(useDocumentStore.getState().past).toHaveLength(1)
    act(() => useDocumentStore.getState().undo())
    expect(useDocumentStore.getState().project).toBe(project)
    expect(screen.getByRole('button', { name: 'Upgrade to title' })).toBeInTheDocument()
  })
  test('content and atomic scale edit work through real store history', () => {
    render(<Inspector />)
    fireEvent.change(screen.getByLabelText('Text content'), { target: { value: 'Edited title' } }); fireEvent.blur(screen.getByLabelText('Text content'))
    expect(currentElement()).toMatchObject({ text: { content: 'Edited title' } })
    fireEvent.change(screen.getByTestId('title-scale-y'), { target: { value: '2' } }); fireEvent.blur(screen.getByTestId('title-scale-y'))
    expect(currentElement().transform).toMatchObject({ scaleX: 2, scaleY: 2 })
    expect(useDocumentStore.getState().past).toHaveLength(2)
  })
  test('explicit fallback persists the unknown font name and stays after undo/redo', () => {
    const project = planTitleEdit(expandedTitleProject(), target, { kind: 'patch', ids: ['root-element'], patch: { font: { family: 'Missing Face', fallbackFamily: null } } }, () => 'unused')
    useDocumentStore.getState().setProject(project); render(<Inspector />)
    expect(screen.getByRole('status')).toHaveTextContent('Missing Face is unavailable')
    fireEvent.change(screen.getByLabelText('Explicit font fallback'), { target: { value: 'serif' } })
    expect(currentElement()).toMatchObject({ font: { family: 'Missing Face', fallbackFamily: 'serif' } })
    act(() => useDocumentStore.getState().undo()); expect(screen.getByRole('status')).toHaveTextContent('unavailable')
    act(() => useDocumentStore.getState().redo()); expect(screen.getByRole('status')).toHaveTextContent('serif')
  })
  test('multi selection edits both elements, reorders stable IDs, and safe guides never add history', () => {
    render(<Inspector />)
    fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Rectangle rectangle/ }))
    expect(screen.getByText(/applies to 2 elements/)).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('title-opacity'), { target: { value: '.4' } }); fireEvent.blur(screen.getByTestId('title-opacity'))
    const elements = useDocumentStore.getState().doc.tracks[0].clips[0].title!.elements as { id: string; opacity: number }[]
    expect(elements.map((e) => e.opacity)).toEqual([.4, .4])
    fireEvent.click(screen.getByRole('button', { name: 'Move Rectangle backward' }))
    expect((useDocumentStore.getState().doc.tracks[0].clips[0].title!.elements as { id: string }[]).map((e) => e.id)).toEqual([...elements].reverse().map((e) => e.id))
    const before = useDocumentStore.getState()
    fireEvent.click(screen.getByRole('checkbox', { name: /Safe guides/ }))
    expect(useDocumentStore.getState()).toBe(before)
  })
  test('undo reconciles a partially surviving multi-element selection by stable identity', () => {
    render(<Inspector />)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate elements' }))
    const elements = useDocumentStore.getState().doc.tracks[0].clips[0].title!.elements as { id: string }[]
    act(() => useTitleEditorStore.getState().select('root-text', elements.map((element) => element.id)))
    act(() => useDocumentStore.getState().undo())
    expect(useTitleEditorStore.getState().ids).toEqual(['root-element'])
  })
  test.each(['motion', 'save', 'library'] as const)('%s dialog wraps Tab without editing the project', (kind) => {
    // jsdom has no layout; expose the rendered controls to the visibility filter.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList)
    const close = vi.fn(), before = useDocumentStore.getState()
    const mounted = render(kind === 'motion'
      ? <TitleMotionDialog target={target} ids={['root-element']} clip={before.doc.tracks[0].clips[0]} onClose={close} />
      : <TitleTemplateDialog captureTarget={kind === 'save' ? target : undefined} onClose={close} />)
    const first = kind === 'motion' ? screen.getByRole('combobox', { name: 'Direction' })
      : kind === 'save' ? screen.getByRole('textbox', { name: 'Template name' }) : screen.getByRole('button', { name: builtInTitleTemplates()[0].name })
    const last = screen.getByRole('button', { name: 'Cancel' })
    first.focus(); expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false); expect(last).toHaveFocus()
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false); expect(first).toHaveFocus()
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(first, { key: 'Escape' })).toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(useDocumentStore.getState().past).toBe(before.past); expect(useDocumentStore.getState().future).toBe(before.future)
    mounted.unmount()
  })
  test('StrictMode motion preview cancels without history; Apply records two ordinary keys once', () => {
    const before = useDocumentStore.getState().project
    const clip = useDocumentStore.getState().doc.tracks[0].clips[0], close = vi.fn()
    const rendered = render(<StrictMode><TitleMotionDialog target={target} ids={['root-element']} clip={clip} onClose={close} /></StrictMode>)
    expect(screen.getByRole('button', { name: 'Preview motion' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview motion' }))
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    expect(useDocumentStore.getState().past).toHaveLength(0)
    rendered.unmount(); expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
    render(<StrictMode><TitleMotionDialog target={target} ids={['root-element']} clip={clip} onClose={close} /></StrictMode>)
    expect(screen.getByRole('button', { name: 'Apply motion' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply motion' }))
    expect(close).toHaveBeenCalledOnce()
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useDocumentStore.getState().doc.tracks[0].clips[0].animation!.titleTracks![0].keyframes.map((key) => key.frame)).toEqual([0, 99])
    act(() => useDocumentStore.getState().undo())
    expect(useDocumentStore.getState().project).toBe(before)
  })
  test('StrictMode motion Reapply displays the complete replacement list and requires its checkbox', () => {
    const project = planTitleEdit(expandedTitleProject(), target, { kind: 'motion', ids: ['root-element'], direction: 'up', start: 0, end: 99, replace: false }, () => 'unused')
    useDocumentStore.getState().setProject(project)
    render(<StrictMode><TitleMotionDialog target={target} ids={['root-element']} clip={useDocumentStore.getState().doc.tracks[0].clips[0]} onClose={vi.fn()} /></StrictMode>)
    expect(screen.getByText(/root-element · position-y · 2 keys/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reapply motion' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Replace all listed movement tracks' }))
    expect(screen.getByRole('button', { name: 'Reapply motion' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reapply motion' }))
    expect(useDocumentStore.getState().past).toHaveLength(1)
  })
  test.each(['selection', 'project', 'playhead'] as const)('StrictMode keeps real %s invalidation terminal', (change) => {
    render(<StrictMode><TitleMotionDialog target={target} ids={['root-element']} clip={useDocumentStore.getState().doc.tracks[0].clips[0]} onClose={vi.fn()} /></StrictMode>)
    expect(screen.getByRole('button', { name: 'Preview motion' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview motion' }))
    expect(useTransportStore.getState().effectDocumentPreview?.owner).toBe('title-authoring')
    act(() => {
      if (change === 'selection') useTitleEditorStore.getState().select('root-text', [])
      if (change === 'project') useDocumentStore.getState().setProject(expandedTitleProject())
      if (change === 'playhead') useTransportStore.getState().setPlayheadFrame(1)
    })
    expect(screen.getByRole('status')).toHaveTextContent('This review has ended')
    expect(screen.getByRole('button', { name: 'Preview motion' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apply motion' })).toBeDisabled()
    expect(useTransportStore.getState().effectDocumentPreview).toBeNull()
    const afterChange = useDocumentStore.getState()
    // Returning a cursor/selection to its prior value cannot revive this review.
    act(() => { useTransportStore.getState().setPlayheadFrame(0); useTitleEditorStore.getState().select('root-text', ['root-element']) })
    fireEvent.click(screen.getByRole('button', { name: 'Apply motion' }))
    expect(useDocumentStore.getState()).toBe(afterChange)
    expect(screen.getByRole('button', { name: 'Apply motion' })).toBeDisabled()
  })
  test('StrictMode dialog teardown releases only its own session after another title editor takes over', () => {
    const mounted = render(<StrictMode><TitleMotionDialog target={target} ids={['root-element']} clip={useDocumentStore.getState().doc.tracks[0].clips[0]} onClose={vi.fn()} /></StrictMode>)
    expect(screen.getByRole('button', { name: 'Preview motion' })).toBeEnabled()
    let replacement!: ReturnType<typeof beginTitleEdit>
    act(() => { replacement = beginTitleEdit(target); expect(replacement.preview({ kind: 'values', ids: ['root-element'], values: { opacity: 0.5 } })).toBeNull() })
    const preview = useTransportStore.getState().effectDocumentPreview
    expect(preview?.owner).toBe('title-authoring')
    mounted.unmount()
    expect(useTransportStore.getState().effectDocumentPreview).toBe(preview)
    expect(useDocumentStore.getState().past).toHaveLength(0)
    act(() => replacement.cancel())
  })
  test('StrictMode template dialog remains usable and commits one independent copy', () => {
    useTransportStore.getState().setPlayheadFrame(200)
    const before = useDocumentStore.getState().project
    render(<StrictMode><TitleTemplateDialog onClose={vi.fn()} /></StrictMode>)
    expect(screen.getByRole('button', { name: 'Apply template' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply template' }))
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(2)
    act(() => useDocumentStore.getState().undo())
    expect(useDocumentStore.getState().project).toBe(before)
  })
  test('template conversion is reviewed before insertion and a changed project rejects Apply', () => {
    useTransportStore.getState().setPlayheadFrame(200)
    render(<StrictMode><TitleTemplateDialog onClose={vi.fn()} /></StrictMode>)
    expect(screen.getByText(/Same canvas; geometry is preserved/)).toBeInTheDocument()
    expect(screen.getByText(/Insert at frame 200/)).toBeInTheDocument()
    act(() => useDocumentStore.getState().setProject(expandedTitleProject()))
    const before = useDocumentStore.getState()
    fireEvent.click(screen.getByRole('button', { name: 'Apply template' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/changed/)
    expect(useDocumentStore.getState()).toBe(before)
  })
  test('late local template read cannot overwrite a newer built-in selection', async () => {
    let resolve!: (template: ReturnType<typeof builtInTitleTemplates>[number]) => void
    vi.spyOn(titleTemplateController, 'read').mockImplementation(() => new Promise((done) => { resolve = done }))
    useTitleTemplateStore.setState({ templates: [{ id: 'local', name: 'Local title', elements: 1, canvasWidth: 1920, canvasHeight: 1080, durationFrames: 50, frameRate: { num: 30, den: 1 } }] })
    render(<TitleTemplateDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Local title' }))
    fireEvent.click(screen.getByRole('button', { name: 'Lower third' }))
    await act(async () => resolve({ ...builtInTitleTemplates()[0], id: 'local', name: 'Late local result' }))
    await waitFor(() => expect(screen.queryByText('Late local result')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Lower third' })).toHaveAttribute('aria-pressed', 'true')
  })
})
