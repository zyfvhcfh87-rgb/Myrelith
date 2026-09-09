import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionReviewController } from './captionReviewController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { captionIntentProject } from '../test/captionIntentFixtures'

const release: (() => void)[] = []
function begin(listener = () => {}) {
  const controller = new CaptionReviewController()
  const unsubscribe = controller.subscribe(listener)
  release.push(unsubscribe)
  return { controller, unsubscribe }
}
beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useDocumentStore.getState().setProject(captionIntentProject())
})
afterEach(() => { for (const dispose of release.splice(0)) dispose() })
const noOwners = () => expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})

describe('caption UI review ownership', () => {
  it('generates reviewed midpoint splits with reserved identities and one undoable Apply', () => {
    const { controller } = begin(), before = useDocumentStore.getState()
    controller.prepareMidpointSplits('captions', { kind: 'selected', ids: ['cue-a'] })
    const review = controller.getSnapshot()
    expect(review.preview[0]!.before).toEqual(['0–25: Hello world'])
    expect(review.preview[0]!.after).toEqual(['0–12: Hello', '12–25: world'])
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(controller.apply(review.revision)).toBeNull()
    const cues = useDocumentStore.getState().doc.captionTracks![0]!.items
    expect(cues).toHaveLength(3)
    expect(new Set(cues.map(cue => cue.id)).size).toBe(3)
    expect(cues[0]!.id).toBe('cue-a')
    expect(cues[1]!.origin).toEqual(before.doc.captionTracks![0]!.items[0]!.origin)
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(before.project)
    noOwners()
  })

  it('rejects a scope with no usable split boundary without replacing the pending review', () => {
    const { controller } = begin(), before = useDocumentStore.getState()
    controller.prepareStyleField('captions', ['cue-a'], 'italic', true)
    const review = controller.getSnapshot()
    expect(() => controller.prepareMidpointSplits('captions', { kind: 'all' })).toThrow(/two words/)
    expect(controller.getSnapshot()).toBe(review)
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(controller.prepareMidpointSplits('captions', { kind: 'selected', ids: [] })).toBe(false)
    noOwners()
  })

  it('shows proposed field values, distinct mixed before values and inherited track defaults', () => {
    const project = captionIntentProject(), track = project.sequences[0]!.captionTracks![0]!
    track.items[0]!.style = { version: 1, params: { color: '#ff0000ff', italic: true } }
    track.items[1]!.style = { version: 1, params: { color: '#0000ffff', bold: false } }
    useDocumentStore.getState().setProject(project)
    const { controller } = begin()
    controller.prepareStyleField('captions', ['cue-a', 'cue-b'], 'color', '#00ff00ff')
    const review = controller.getSnapshot()
    expect(review.label).toBe('Review Text color: #00ff00ff')
    expect(review.preview).toHaveLength(2)
    expect(review.preview[0]!.before[1]).toContain('Text color: #ff0000ff')
    expect(review.preview[1]!.before[1]).toContain('Text color: #0000ffff')
    expect(review.preview[0]!.after[1]).toContain('Text color: #00ff00ff; Italic: On')
    expect(review.preview[1]!.after[1]).toContain('Text color: #00ff00ff; Bold: Off')
    expect(review.preview[0]!.after[2]).toContain('Track defaults: Text color: #ffffffff; Shadow: Off')
    expect(review.preview[0]!.after[1]).toContain('Other fields inherit track defaults')
  })

  it('previews track defaults and field inheritance even when the track has no cues', () => {
    const project = captionIntentProject(); project.sequences[0]!.captionTracks![0]!.items = []
    useDocumentStore.getState().setProject(project)
    const { controller } = begin()
    controller.prepareStyleField('captions', null, 'color', null)
    const review = controller.getSnapshot()
    expect(review.label).toBe('Review Text color: Inherit')
    expect(review.preview[0]!.before[0]).toBe('Track defaults')
    expect(review.preview[0]!.before[1]).toContain('Text color: #ffffffff')
    expect(review.preview[0]!.after[1]).toBe('Shadow: Off. Other fields inherit the track preset.')
    expect(review.preview[0]!.after[2]).toContain('Cue overrides take precedence')
    controller.prepareStyleField('captions', null, 'fontSizePermille', 48)
    expect(controller.getSnapshot().label).toBe('Review Font size: 4.8% of canvas height')
  })

  it('distinguishes explicit empty styles from removing all overrides', () => {
    const { controller } = begin()
    controller.prepareStyle('captions', null, { version: 1, params: {} })
    expect(controller.getSnapshot().preview[0]!.after[1]).toBe('Explicit empty override; all fields inherit the track preset.')
    controller.prepareStyle('captions', null, null)
    expect(controller.getSnapshot().preview[0]!.after[1]).toBe('No override; all fields inherit the track preset.')
  })

  it('discloses unavailable override loss without revealing opaque fields and requires acceptance', () => {
    useDocumentStore.getState().switchSequence('dormant')
    const { controller } = begin(), before = useDocumentStore.getState()
    controller.prepareStyle('dormant-captions', ['dormant-cue'], { version: 1, params: { italic: true } })
    const review = controller.getSnapshot()
    expect(review.preview[0]!.before[1]).toMatch(/^Unavailable style override/)
    expect(review.preview[0]!.after[1]).toContain('Italic: On')
    expect(review.lossDisclosure).toContain('1 unavailable style override')
    expect(JSON.stringify(review)).not.toMatch(/not-interpreted|future|version|origin/)
    expect(controller.apply(review.revision)).toMatch(/Accept the disclosed/)
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(controller.getSnapshot()).toBe(review)
    expect(controller.apply(review.revision, true)).toBeNull()
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(before.project)
    noOwners()
  })

  it('bounds style previews and discloses omitted rows without changing the full edit', () => {
    const project = captionIntentProject(), track = project.sequences[0]!.captionTracks![0]!
    track.items = Array.from({ length: 105 }, (_, i) => ({ id: `caption-${i}`, text: 'Cue', range: { startFrame: i, durationFrames: 1 } }))
    useDocumentStore.getState().setProject(project)
    const { controller } = begin()
    controller.prepareStyleField('captions', track.items.map(cue => cue.id), 'italic', true)
    const review = controller.getSnapshot()
    expect(review.changedCueCount).toBe(105)
    expect(review.preview).toHaveLength(100)
    expect(review.omittedPreviewRows).toBe(5)
    expect(review.preview.every(row => [...row.before, ...row.after].every(text => text.length <= 2000))).toBe(true)
    expect(controller.apply(review.revision)).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks![0]!.items.every(cue => cue.style?.params.italic === true)).toBe(true)
    noOwners()
  })

  it('previews bounded text summaries and makes Apply one fresh undoable edit', () => {
    const { controller } = begin(), before = useDocumentStore.getState()
    expect(controller.prepareBatch('captions', { kind: 'all' }, { kind: 'case', value: 'upper' })).toBe(true)
    const review = controller.getSnapshot()
    expect(review.changedCueCount).toBe(2)
    expect(review.preview[0]).toEqual({ before: ['0–25: Hello world'], after: ['0–25: HELLO WORLD'],
      omittedBeforeItems: 0, omittedAfterItems: 0 })
    expect(JSON.stringify(review)).not.toMatch(/modelId|manifestDigest|shadowEnabled|runId/)
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(controller.apply(review.revision)).toBeNull()
    expect(useDocumentStore.getState().past.at(-1)).toBe(before.project)
    expect(controller.getSnapshot().label).toBeNull()
    noOwners()
    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().project).toBe(before.project)
  })

  it('replacing a review invalidates its old token and releases the old candidate', () => {
    const { controller } = begin()
    controller.prepareStyleField('captions', ['cue-a'], 'italic', true)
    const old = controller.getSnapshot().revision
    controller.prepareStyleField('captions', ['cue-b'], 'bold', false)
    expect(controller.apply(old)).toMatch(/replaced/)
    expect(Object.values(useDocumentStore.getState().retainedCaptionOwners).flat()
      .some((owner) => owner.style?.params.italic === true)).toBe(false)
    controller.cancel()
    noOwners()
  })

  it('invalid preparation retains a valid previous review; a no-op clears it', () => {
    const { controller } = begin()
    controller.prepareStyleField('captions', ['cue-a'], 'italic', true)
    const review = controller.getSnapshot()
    expect(() => controller.prepareStyleField('captions', [], 'italic', 'invalid')).toThrow(/italic/)
    expect(controller.getSnapshot()).toBe(review)
    expect(controller.prepareStyleField('captions', [], 'italic', true)).toBe(false)
    expect(controller.getSnapshot().label).toBeNull()
    noOwners()
  })

  it.each(['navigate', 'edit', 'replace'] as const)('drops pending owners when the project changes: %s', (action) => {
    const { controller } = begin()
    controller.prepareStyleField('captions', ['cue-a'], 'italic', true)
    const review = controller.getSnapshot()
    if (action === 'navigate') useDocumentStore.getState().switchSequence('dormant')
    else if (action === 'edit') useDocumentStore.getState().updateCaptionItem('captions', 'cue-a', { text: 'Changed' })
    else useDocumentStore.getState().setProject(captionIntentProject())
    expect(controller.getSnapshot().label).toBeNull()
    expect(controller.apply(review.revision)).toMatch(/cancelled/)
    noOwners()
  })

  it('last unsubscribe cancels immediately and a StrictMode-style resubscribe starts empty', () => {
    const { controller, unsubscribe } = begin()
    controller.prepareStyleField('captions', ['cue-a'], 'italic', true)
    unsubscribe()
    noOwners()
    expect(() => controller.prepareStyle('captions', null, null)).toThrow(/closed/)
    const again = controller.subscribe(() => {})
    release.push(again)
    expect(controller.getSnapshot().label).toBeNull()
    expect(controller.prepareStyleField('captions', ['cue-b'], 'italic', true)).toBe(true)
    again()
    noOwners()
  })

  it('cancel during owner admission cannot publish or retain a new review', () => {
    const { controller } = begin()
    let cancelled = false
    const stop = useDocumentStore.subscribe((state) => {
      if (!cancelled && Object.keys(state.retainedCaptionOwners).length) {
        cancelled = true; controller.cancel()
      }
    })
    try { expect(() => controller.prepareStyleField('captions', ['cue-a'], 'italic', true)).toThrow(/cancelled/) }
    finally { stop() }
    expect(controller.getSnapshot().label).toBeNull()
    noOwners()
  })

  it('cleans both old and new candidates if a snapshot subscriber throws', () => {
    const { controller } = begin()
    controller.prepareStyleField('captions', ['cue-a'], 'italic', true)
    const error = vi.fn(() => { throw new Error('Subscriber failed') })
    const stop = controller.subscribe(error)
    try { expect(() => controller.prepareStyleField('captions', ['cue-b'], 'bold', false)).toThrow(/Subscriber failed/) }
    finally { stop() }
    expect(controller.getSnapshot().label).toBeNull()
    noOwners()
  })
})
