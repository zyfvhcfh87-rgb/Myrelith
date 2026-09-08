import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CaptionEditSession } from './captionEditingController'
import { useDocumentStore, type DocumentState } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { captionIntentProject } from '../test/captionIntentFixtures'

const sessions: CaptionEditSession[] = []
beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useMediaStore.setState({ descriptors: new Map(), collections: [] })
  useDocumentStore.getState().setProject(captionIntentProject())
})
afterEach(() => { for (const session of sessions.splice(0)) session.dispose() })
function begin() { const session = new CaptionEditSession(); sessions.push(session); return session }
function expectReleased(session: CaptionEditSession) {
  expect(Reflect.get(session, 'expected')).toBeNull()
  expect(Reflect.get(session, 'candidate')).toBeNull()
  expect(Reflect.get(session, 'review')).toBeNull()
  expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
}

describe('caption owner registration with synchronous subscribers', () => {
  it.each(['project', 'generation', 'sequence', 'dispose'] as const)('releases the real old review and new ledger after reentrant %s invalidation', (kind) => {
    const session = begin()
    const old = session.prepareStyle('captions', null, { version: 9, params: { large: 'x'.repeat(128) } })!
    const before = useDocumentStore.getState()
    let fired = false, external: DocumentState | null = null
    const unsubscribe = useDocumentStore.subscribe((state) => {
      if (fired || state.retainedCaptionOwners === before.retainedCaptionOwners) return
      fired = true
      if (kind === 'project') state.setProject({ ...state.project, name: 'Replacement during owner admission' })
      else if (kind === 'generation') state.setProject(state.project)
      else if (kind === 'sequence') state.switchSequence('dormant')
      else session.dispose()
      external = useDocumentStore.getState()
    })
    try { expect(() => session.prepareStyle('captions', null, { version: 1, params: { italic: true } })).toThrow(/project changed/) }
    finally { unsubscribe() }
    expect(fired).toBe(true)
    expectReleased(session)
    const state = useDocumentStore.getState()
    expect(state.project).toBe(external!.project)
    expect(state.past).toBe(external!.past)
    expect(state.future).toBe(external!.future)
    expect(session.apply(old)).toMatch(/project changed/)
    expect(useDocumentStore.getState()).toBe(state)
  })
  it.each(['project', 'generation', 'sequence'] as const)('releases a constructor capture invalidated by a synchronous %s subscriber', (kind) => {
    const before = useDocumentStore.getState()
    let fired = false
    const unsubscribe = useDocumentStore.subscribe((state) => {
      if (fired || state.retainedCaptionOwners === before.retainedCaptionOwners) return
      fired = true
      if (kind === 'project') state.setProject({ ...state.project, name: 'Replacement during capture' })
      else if (kind === 'generation') state.setProject(state.project)
      else state.switchSequence('dormant')
    })
    try { expect(() => new CaptionEditSession()).toThrow(/project changed/) }
    finally { unsubscribe() }
    expect(useDocumentStore.getState().retainedCaptionOwners).toEqual({})
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })
  it('cleans up if a subscriber throws after ledger publication', () => {
    const session = begin()
    session.prepareStyle('captions', null, { version: 9, params: { large: 'x'.repeat(128) } })
    const before = useDocumentStore.getState()
    let fired = false
    const unsubscribe = useDocumentStore.subscribe((state) => {
      if (fired || state.retainedCaptionOwners === before.retainedCaptionOwners) return
      fired = true
      throw new Error('Subscriber failed after registration')
    })
    try { expect(() => session.prepareStyle('captions', null, { version: 1, params: { italic: true } })).toThrow(/Subscriber failed/) }
    finally { unsubscribe() }
    expectReleased(session)
    expect(useDocumentStore.getState().project).toBe(before.project)
    expect(useDocumentStore.getState().past).toBe(before.past)
    expect(useDocumentStore.getState().future).toBe(before.future)
  })
  it.each(['style', 'noop', 'apply'] as const)('prevents nested %s from replacing the admitted owner under the outer review', (kind) => {
    const session = begin()
    const old = session.prepareStyle('captions', null, { version: 9, params: { old: true } })!
    const before = useDocumentStore.getState()
    let fired = false
    const unsubscribe = useDocumentStore.subscribe((state) => {
      if (fired || state.retainedCaptionOwners === before.retainedCaptionOwners) return
      fired = true
      if (kind === 'style') expect(() => session.prepareStyle('captions', null, { version: 9, params: { nested: true } })).toThrow(/admission is already/)
      else if (kind === 'noop') expect(() => session.prepareBatch('captions', { kind: 'all' }, { kind: 'shift', deltaFrames: 0 })).toThrow(/admission is already/)
      else expect(session.apply(old)).toMatch(/admission is already/)
    })
    try {
      const review = session.prepareStyle('captions', null, { version: 1, params: { italic: true } })!
      const owners = Object.values(useDocumentStore.getState().retainedCaptionOwners).flat()
      expect(owners.some((owner) => owner.style?.params.italic === true)).toBe(true)
      expect(owners.some((owner) => owner.style?.params.nested === true)).toBe(false)
      expect(session.apply(review)).toBeNull()
      expect(useDocumentStore.getState().past).toEqual([before.project])
    } finally { unsubscribe() }
  })
  it.each((['batch', 'style'] as const).flatMap((operation) =>
    (['project', 'dispose', 'throw', 'nested'] as const).map((kind) => ({ operation, kind })),
  ))('keeps $operation no-op owner reduction consistent under a $kind subscriber', ({ operation, kind }) => {
    const session = begin()
    session.prepareStyle('captions', null, { version: 9, params: { old: true } })
    const before = useDocumentStore.getState()
    let fired = false
    const unsubscribe = useDocumentStore.subscribe((state) => {
      if (fired || state.retainedCaptionOwners === before.retainedCaptionOwners) return
      fired = true
      if (kind === 'project') state.setProject({ ...state.project, name: 'Replacement during reduction' })
      else if (kind === 'dispose') session.dispose()
      else if (kind === 'throw') throw new Error('Reduction subscriber failed')
      else expect(() => session.prepareStyle('captions', null, { version: 9, params: { nested: true } })).toThrow(/admission is already/)
    })
    const clear = () => operation === 'batch'
      ? session.prepareBatch('captions', { kind: 'all' }, { kind: 'shift', deltaFrames: 0 })
      : session.prepareStyle('captions', ['cue-a'], null)
    try {
      if (kind === 'nested') {
        expect(clear()).toBeNull()
        expect(Reflect.get(session, 'candidate')).toBeNull()
        expect(Reflect.get(session, 'review')).toBeNull()
        const owners = Object.values(useDocumentStore.getState().retainedCaptionOwners).flat()
        expect(owners.some((owner) => owner.style?.params.nested === true || owner.style?.params.old === true)).toBe(false)
        expect(session.document()).toBe(before.doc)
      } else {
        expect(clear).toThrow(kind === 'throw' ? /Reduction subscriber failed/ : /project changed/)
        expectReleased(session)
      }
    } finally { unsubscribe() }
  })
})
