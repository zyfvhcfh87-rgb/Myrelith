import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CaptionEditSession } from './captionEditingController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { captionIntentProject } from '../test/captionIntentFixtures'

const sessions: CaptionEditSession[] = []
function begin() { const session = new CaptionEditSession(); sessions.push(session); return session }
beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  const project = captionIntentProject()
  useDocumentStore.getState().setProject(project)
  useDocumentStore.setState({ past: [{ ...project, name: 'Past' }], future: [{ ...project, name: 'Redo' }] })
})
afterEach(() => { for (const session of sessions.splice(0)) session.dispose() })
function expectHistoryUnchanged(before: ReturnType<typeof useDocumentStore.getState>) {
  const after = useDocumentStore.getState()
  expect(after.project).toBe(before.project)
  expect(after.doc).toBe(before.doc)
  expect(after.past).toBe(before.past)
  expect(after.future).toBe(before.future)
}

describe('caption style review identity', () => {
  it('changes one field across mixed cue styles without replacing other fields', () => {
    const project = captionIntentProject(), track = project.sequences[0]!.captionTracks![0]!
    track.items[0]!.style = { version: 1, params: { italic: true, color: '#ff0000ff' } }
    track.items[1]!.style = { version: 1, params: { bold: false, color: '#0000ffff' } }
    useDocumentStore.getState().setProject(project)
    const before = useDocumentStore.getState(), session = begin()
    const review = session.prepareStyleField('captions', ['cue-a', 'cue-b'], 'color', '#00ff00ff')!
    expect(review.changedCueCount).toBe(2)
    expectHistoryUnchanged(before)
    expect(session.apply(review)).toBeNull()
    const after = useDocumentStore.getState()
    expect(after.doc.captionTracks![0]!.items.map((cue) => cue.style?.params)).toEqual([
      { italic: true, color: '#00ff00ff' }, { bold: false, color: '#00ff00ff' },
    ])
    expect(after.past.at(-1)).toBe(before.project)
    after.undo()
    expect(useDocumentStore.getState().project).toBe(before.project)
  })

  it('clears only the requested field and leaves explicit empty intent distinct', () => {
    const session = begin(), before = useDocumentStore.getState()
    const review = session.prepareStyleField('captions', null, 'color', null)!
    expect(session.apply(review)).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks![0]!.style?.params).toEqual({ shadowEnabled: false })
    const next = begin(), clear = next.prepareStyleField('captions', null, 'shadowEnabled', null)!
    expect(next.apply(clear)).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks![0]!.style).toEqual({ version: 1, params: {} })
    expect(before.doc.captionTracks![0]!.style?.params.color).toBe('#ffffffff')
  })

  it('counts only changed field intents and preserves no-op history and cue identities', () => {
    const session = begin(), before = useDocumentStore.getState()
    expect(session.prepareStyleField('captions', ['cue-a', 'cue-b'], 'italic', null)).toBeNull()
    expectHistoryUnchanged(before)
    expect(session.prepareStyleField('captions', null, 'color', '#ffffffff')).toBeNull()
    expectHistoryUnchanged(before)
  })

  it('rejects field changes to opaque styles without losing the previous review', () => {
    useDocumentStore.getState().switchSequence('dormant')
    const session = begin(), review = session.prepareStyle('dormant-captions', ['dormant-cue'], null)!
    const before = useDocumentStore.getState()
    expect(() => session.prepareStyleField('dormant-captions', ['dormant-cue'], 'italic', true)).toThrow(/Replace or remove/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(review.requiresLossAcceptance).toBe(true)
    expect(session.apply(review)).toMatch(/Accept the disclosed/)
    expectHistoryUnchanged(before)
    expect(session.apply(review, true)).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks![0]!.items[0]!.style).toBeUndefined()
  })

  it('validates field names and values even when no cues are selected', () => {
    const session = begin(), before = useDocumentStore.getState()
    expect(() => session.prepareStyleField('captions', [], 'future-field', null)).toThrow(/unavailable/)
    expect(() => session.prepareStyleField('captions', [], 'italic', 'yes')).toThrow(/italic/)
    expectHistoryUnchanged(before)
  })

  it('clears a prior review when the requested track descriptor is unchanged, regardless of key order', () => {
    const session = begin(), before = useDocumentStore.getState()
    const old = session.prepareStyle('captions', null, { version: 1, params: { italic: true } })!
    expect(session.prepareStyle('captions', null, { version: 1, params: { color: '#ffffffff', shadowEnabled: false } })).toBeNull()
    expect(session.apply(old)).toMatch(/replaced/)
    expectHistoryUnchanged(before)
    const retained = Object.values(useDocumentStore.getState().retainedCaptionOwners).flat()
    expect(retained.some((owner) => owner.style?.params.italic === true)).toBe(false)
  })
  it('treats removing absent cue styles and an empty selection as no-ops', () => {
    const session = begin(), before = useDocumentStore.getState()
    expect(session.prepareStyle('captions', ['cue-a', 'cue-b'], null)).toBeNull()
    expect(session.prepareStyle('captions', [], { version: 1, params: { bold: true } })).toBeNull()
    expectHistoryUnchanged(before)
  })
  it('preserves opaque future intent when an equivalent descriptor is requested', () => {
    useDocumentStore.getState().switchSequence('dormant')
    const session = begin(), before = useDocumentStore.getState()
    expect(session.prepareStyle('dormant-captions', ['dormant-cue'], {
      version: 99, params: { color: 'not-interpreted', future: true },
    })).toBeNull()
    expectHistoryUnchanged(before)
    expect(before.doc.captionTracks![0].items[0].style?.params.color).toBe('not-interpreted')
  })
  it('changes only distinct selected cue descriptors and preserves untouched cue identities', () => {
    const state = useDocumentStore.getState(), doc = state.doc
    const first = { ...doc.captionTracks![0].items[0], style: { version: 1, params: { italic: true } } }
    const track = { ...doc.captionTracks![0], items: [first, doc.captionTracks![0].items[1]] }
    state.setProject({ ...state.project, sequences: state.project.sequences.map((sequence) => sequence.id === doc.id
      ? { ...doc, captionTracks: [track] } : sequence) })
    const before = useDocumentStore.getState(), session = begin()
    const review = session.prepareStyle('captions', ['cue-a', 'cue-b'], { version: 1, params: { italic: true } })!
    expect(review.changedCueCount).toBe(1)
    expect(session.apply(review)).toBeNull()
    const after = useDocumentStore.getState()
    expect(after.doc.captionTracks![0].items[0]).toBe(before.doc.captionTracks![0].items[0])
    expect(after.doc.captionTracks![0].items[1]).not.toBe(before.doc.captionTracks![0].items[1])
    expect(after.past).toEqual([before.project])
    expect(after.retainedCaptionOwners).toEqual({})
  })
  it('keeps explicit empty intent distinct from inheritance and makes removal one edit', () => {
    const session = begin(), before = useDocumentStore.getState()
    const review = session.prepareStyle('captions', ['cue-a'], { version: 1, params: {} })!
    expect(session.apply(review)).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks![0].items[0].style).toEqual({ version: 1, params: {} })
    expect(useDocumentStore.getState().past.at(-1)).toBe(before.project)
    const removal = begin(), remove = removal.prepareStyle('captions', ['cue-a'], null)!
    expect(removal.apply(remove)).toBeNull()
    expect(useDocumentStore.getState().doc.captionTracks![0].items[0].style).toBeUndefined()
  })
  it.each([{ ids: ['cue-a', 'cue-a'] }, { ids: ['missing'] }])('rejects an invalid selection without replacing a valid review: $ids', ({ ids }) => {
    const session = begin(), review = session.prepareStyle('captions', null, { version: 1, params: { italic: true } })!
    const before = useDocumentStore.getState()
    expect(() => session.prepareStyle('captions', ids, null)).toThrow(/missing|duplicate/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(session.apply(review)).toBeNull()
  })
  it('validates requested styles even for an empty selection and retains the previous review on rejection', () => {
    const session = begin(), review = session.prepareStyle('captions', null, { version: 1, params: { italic: true } })!
    const before = useDocumentStore.getState()
    expect(() => session.prepareStyle('captions', [], { version: 1, params: { italic: 'invalid' } })).toThrow(/italic/)
    expect(useDocumentStore.getState()).toBe(before)
    expect(session.apply(review)).toBeNull()
  })
})
