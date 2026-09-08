import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionExportController } from './captionExportController'
import { CaptionFileController } from './captionFileController'
import { parseCaptionAss } from '../domain/captionAss'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { captionIntentProject } from '../test/captionIntentFixtures'

const cleanups: (() => void)[] = []
function setup() {
  const download = vi.fn()
  const files = new CaptionFileController({ createId: prefix => prefix, download })
  const controller = new CaptionExportController(files)
  const close = controller.subscribe(() => {})
  cleanups.push(close)
  return { controller, download, files, close }
}
beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useDocumentStore.getState().setProject(captionIntentProject())
})
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('reviewed caption downloads', () => {
  it.each(['srt', 'vtt'] as const)('requires %s loss acceptance and leaves project/history unchanged', format => {
    const { controller, download } = setup(), before = useDocumentStore.getState()
    controller.begin('captions', format)
    const review = controller.getSnapshot()
    expect(review.phase, review.error ?? undefined).toBe('review')
    expect(review.diagnostics.join(' ')).toMatch(/style overrides are omitted/)
    expect(download).not.toHaveBeenCalled()
    expect(controller.download(review.revision, false)).toMatch(/Accept/)
    expect(controller.download(review.revision, true)).toBeNull()
    expect(download).toHaveBeenCalledOnce()
    expect(download.mock.calls[0]![2]).toContain('Hello world')
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(useDocumentStore.getState().past).toBe(before.past)
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('resolves preset and cue styles for ASS and discloses rendering and shadow losses', () => {
    const project = structuredClone(captionIntentProject())
    project.sequences[0]!.captionTracks![0]!.style = { version: 1, params: { shadowEnabled: true } }
    project.sequences[0]!.captionTracks![0]!.items[1]!.style = { version: 1, params: { italic: true } }
    useDocumentStore.getState().setProject(project)
    const { controller, download } = setup()
    controller.begin('captions', 'ass')
    const review = controller.getSnapshot()
    expect(review.phase, review.error ?? undefined).toBe('review')
    expect(review.diagnostics.join(' ')).toMatch(/anchors glyph lines/)
    expect(review.diagnostics.join(' ')).toMatch(/shadowEnabled/)
    expect(controller.download(review.revision, true)).toBeNull()
    const parsed = parseCaptionAss(download.mock.calls[0]![2], useDocumentStore.getState().doc.frameRate, i => `ass-${i}`)
    expect(parsed.kind).toBe('ready')
    if (parsed.kind !== 'ready') throw new Error('Expected supported ASS reimport')
    expect(parsed.proposal.items.map(cue => cue.text)).toEqual(['Hello world', 'Again'])
    expect(parsed.proposal.style.params.bold).toBe(true)
    expect(parsed.proposal.items[1]!.style?.params.italic).toBe(true)
  })

  it.each(['project', 'close', 'cancel'] as const)('rejects the old download after %s and releases its owner', reason => {
    const { controller, download, close } = setup()
    controller.begin('captions', 'srt')
    const revision = controller.getSnapshot().revision
    if (reason === 'project') useDocumentStore.getState().setProject(captionIntentProject())
    else if (reason === 'close') close()
    else controller.cancel()
    expect(controller.download(revision, true)).toMatch(/cancelled/)
    expect(download).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('refuses to silently discard unavailable ASS appearance', () => {
    const project = structuredClone(captionIntentProject())
    project.sequences[0]!.captionTracks![0]!.style = { version: 2, params: { future: true } }
    useDocumentStore.getState().setProject(project)
    const { controller, download } = setup()
    controller.begin('captions', 'ass')
    expect(controller.getSnapshot().phase).toBe('error')
    expect(controller.getSnapshot().error).toMatch(/unavailable caption style/)
    expect(download).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('keeps a newer review created during old download cleanup', () => {
    const { controller, download } = setup()
    controller.begin('captions', 'srt')
    const old = controller.getSnapshot().revision
    download.mockImplementation(() => controller.begin('captions', 'vtt'))
    expect(controller.download(old, true)).toBeNull()
    expect(controller.getSnapshot().phase).toBe('review')
    expect(controller.getSnapshot().fileName).toMatch(/\.vtt$/)
    controller.cancel()
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
  })

  it('revokes its object URL even when the browser download click throws', async () => {
    setup()
    const createObjectURL = vi.fn(() => 'blob:caption-test'), revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('download unavailable') })
    const files = new CaptionFileController()
    const plan = files.planDownload(useDocumentStore.getState().doc, 'captions', 'srt')
    expect(() => files.saveDownload(plan)).toThrow('download unavailable')
    await Promise.resolve()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:caption-test')
  })
})
