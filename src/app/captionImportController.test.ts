import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionImportController, readCaptionFile, type CaptionImportPort } from './captionImportController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { captionIntentProject } from '../test/captionIntentFixtures'

const metadata = { name: 'Imported', language: 'en', role: 'captions', stylePreset: 'classic' } as const
const srt = '1\n00:00:00,000 --> 00:00:01,000\nImported words\n'
const file = (source = srt) => ({ name: 'captions.srt', size: source.length }) as File
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 2000
PlayResY: 1000
WrapStyle: 1
ScaledBorderAndShadow: yes
YCbCr Matrix: None
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Example Sans,50,&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,40,40,20,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Imported words`
const release: (() => void)[] = []
function harness(read: CaptionImportPort['read'] = async () => srt) {
  let next = 0
  const port = { read: vi.fn(read), createId: (prefix: string) => `${prefix}-import-${++next}` }
  const controller = new CaptionImportController(port)
  const unsubscribe = controller.subscribe(() => {})
  release.push(unsubscribe)
  return { controller, port, unsubscribe }
}
beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useDocumentStore.getState().setProject(captionIntentProject())
})
afterEach(() => { for (const stop of release.splice(0)) stop(); vi.unstubAllGlobals() })
const noOwners = () => expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})

describe('editor-owned caption import', () => {
  it('reviews before adding a new track and applies as one fresh undoable edit', async () => {
    const { controller } = harness(), before = useDocumentStore.getState()
    await controller.begin(file(), 'srt', null, metadata)
    const snapshot = controller.getSnapshot()
    expect(snapshot.phase).toBe('review')
    expect(snapshot.review?.preview[0]?.after).toEqual(['0–30: Imported words'])
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(controller.apply(snapshot.revision, false)).toEqual({ error: null, trackId: 'caption_track-import-2' })
    expect(useDocumentStore.getState().doc.captionTracks).toHaveLength(2)
    expect(useDocumentStore.getState().past).toHaveLength(before.past.length + 1)
    noOwners()
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(before.project)
  })

  it('discloses replacing existing cues and refuses Apply until the loss is accepted', async () => {
    const { controller } = harness(), before = useDocumentStore.getState().project
    await controller.begin(file(), 'srt', 'captions', metadata)
    const snapshot = controller.getSnapshot()
    expect(snapshot.review?.lossDisclosure).toContain('replaces 2 existing cues')
    expect(snapshot.review?.preview[0]?.before).toEqual(['0–25: Hello world'])
    expect(controller.apply(snapshot.revision, false).error).toMatch(/Accept the disclosed/)
    expect(useDocumentStore.getState().project).toBe(before)
    expect(controller.apply(snapshot.revision, true).error).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks![0]!.items).toHaveLength(1)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(before)
  })

  it.each(['cancel', 'close', 'project'] as const)('aborts a pending read and ignores late completion after %s', async reason => {
    let resolve: (text: string) => void = () => {}
    const { controller, port, unsubscribe } = harness(() => new Promise(done => { resolve = done }))
    const before = useDocumentStore.getState().project
    const pending = controller.begin(file(), 'srt', null, metadata)
    const signal = port.read.mock.calls[0]![1]
    expect(controller.getSnapshot().phase).toBe('reading')
    if (reason === 'close') unsubscribe()
    else if (reason === 'project') useDocumentStore.getState().setProject(captionIntentProject())
    else controller.cancel()
    const current = useDocumentStore.getState().project
    expect(signal.aborted).toBe(true)
    resolve(srt); await pending
    expect(controller.getSnapshot().phase).toBe('idle')
    expect(useDocumentStore.getState().project).toBe(current)
    if (reason !== 'project') expect(current).toBe(before)
    noOwners()
  })

  it('allows a new import after cancellation without an old read replacing its review', async () => {
    let resolve: (text: string) => void = () => {}
    let calls = 0
    const { controller } = harness(() => ++calls === 1 ? new Promise(done => { resolve = done }) : Promise.resolve(srt))
    const old = controller.begin(file(), 'srt', null, metadata)
    await controller.begin(file(), 'srt', null, metadata)
    const review = controller.getSnapshot()
    resolve('bad late source'); await old
    expect(controller.getSnapshot()).toBe(review)
    expect(controller.apply(review.revision, false).error).toBeNull()
    noOwners()
  })

  it('holds ASS font decisions in the app, reads once, and requires substitution-loss acceptance', async () => {
    const { controller, port } = harness(async () => ass), before = useDocumentStore.getState().project
    await controller.begin(file(ass), 'ass', 'captions', metadata)
    const fonts = controller.getSnapshot()
    expect(fonts.phase).toBe('fonts')
    expect(fonts.fonts).toEqual(['Example Sans'])
    controller.chooseFonts(fonts.revision - 1, { 'Example Sans': 'serif' })
    expect(controller.getSnapshot()).toBe(fonts)
    controller.chooseFonts(fonts.revision, { 'Example Sans': 'serif' })
    const review = controller.getSnapshot()
    expect(review.phase).toBe('review')
    expect(review.diagnostics.some(text => /Example Sans/.test(text))).toBe(true)
    expect(port.read).toHaveBeenCalledOnce()
    expect(controller.apply(review.revision, false).error).toMatch(/Accept/)
    expect(useDocumentStore.getState().project).toBe(before)
    expect(controller.apply(review.revision, true).error).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks).toHaveLength(2)
    expect(useDocumentStore.getState().doc.captionTracks![1]!.style?.params.fontFamily).toBe('serif')
    noOwners()
  })

  it('clears malformed and oversized imports without applying or leaking owners', async () => {
    const { controller, port } = harness(async () => 'bad srt')
    const before = useDocumentStore.getState().project
    await controller.begin(file(), 'srt', null, metadata)
    expect(controller.getSnapshot().phase).toBe('error')
    noOwners()
    await controller.begin({ size: 4_000_001 } as File, 'srt', null, metadata)
    expect(controller.getSnapshot().message).toMatch(/exceeds/)
    expect(port.read).toHaveBeenCalledOnce()
    expect(useDocumentStore.getState().project).toBe(before)
    noOwners()
  })

  it('cancels a published import review when the captured document changes', async () => {
    const { controller } = harness()
    await controller.begin(file(), 'srt', null, metadata)
    const revision = controller.getSnapshot().revision
    useDocumentStore.getState().updateCaptionItem('captions', 'cue-a', { text: 'Changed elsewhere' })
    expect(controller.apply(revision, false).error).toMatch(/cancelled/)
    expect(controller.getSnapshot().phase).toBe('idle')
    noOwners()
  })

  it('cannot publish an import after cancellation during session admission', async () => {
    const { controller, port } = harness()
    let cancelled = false
    const stop = useDocumentStore.subscribe(state => {
      if (!cancelled && Object.keys(state.retainedCaptionOwners).length) { cancelled = true; controller.cancel() }
    })
    try { await controller.begin(file(), 'srt', null, metadata) } finally { stop() }
    expect(controller.getSnapshot().phase).toBe('idle')
    expect(port.read).not.toHaveBeenCalled()
    noOwners()
  })

  it('preserves a newer import started by an idle listener during an outer begin', async () => {
    const { controller, port } = harness()
    await controller.begin(file(), 'srt', null, metadata)
    let nested: Promise<void> | null = null
    const stop = controller.subscribe(() => {
      if (controller.getSnapshot().phase === 'idle' && nested === null) {
        nested = Promise.resolve()
        nested = controller.begin(file(), 'srt', null, { ...metadata, name: 'Newest' })
      }
    })
    await controller.begin(file(), 'srt', null, { ...metadata, name: 'Obsolete' })
    await nested
    stop()
    expect(port.read).toHaveBeenCalledTimes(2)
    const review = controller.getSnapshot()
    expect(controller.apply(review.revision, true).error).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks!.at(-1)!.name).toBe('Newest')
    noOwners()
  })

  it.each(['failure', 'apply'] as const)('does not replace a newer import during old %s cleanup', async action => {
    let calls = 0
    const { controller } = harness(async () => ++calls === 1 && action === 'failure' ? 'bad srt' : srt)
    if (action === 'apply') await controller.begin(file(), 'srt', null, metadata)
    let nested: Promise<void> | null = null
    const stop = controller.subscribe(() => {
      if (controller.getSnapshot().phase === 'idle' && nested === null) {
        nested = Promise.resolve()
        nested = controller.begin(file(), 'srt', null, { ...metadata, name: 'Newest' })
      }
    })
    if (action === 'failure') await controller.begin(file(), 'srt', null, metadata)
    else expect(controller.apply(controller.getSnapshot().revision, true).error).toBeNull()
    await nested
    stop()
    expect(controller.getSnapshot().phase).toBe('review')
    expect(controller.apply(controller.getSnapshot().revision, true).error).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks!.at(-1)!.name).toBe('Newest')
    noOwners()
  })
})

it('aborts the actual FileReader port and clears every callback on cancellation', async () => {
  let reader: FakeReader
  class FakeReader {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    result: string | null = null
    abort = vi.fn(() => this.onabort?.())
    readAsText = vi.fn()
    constructor() { reader = this }
  }
  vi.stubGlobal('FileReader', FakeReader)
  const abort = new AbortController(), pending = readCaptionFile(file(), abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow(/cancelled/)
  expect(reader!.abort).toHaveBeenCalledOnce()
  expect(reader!.onload).toBeNull(); expect(reader!.onerror).toBeNull(); expect(reader!.onabort).toBeNull()
})
