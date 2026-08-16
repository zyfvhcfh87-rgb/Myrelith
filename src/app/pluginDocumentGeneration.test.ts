import { describe, expect, test, vi } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { TimelineDoc } from '../domain/schema'
import type { DocumentState } from '../state/documentStore'
import {
  createPluginDocumentGenerationController,
  type PluginDocumentStoreAdapter,
} from './pluginDocumentGeneration'

function doc(id: string): TimelineDoc {
  return createTimelineDoc(id, DEFAULT_PROJECT_SETTINGS, id)
}

function storeHarness(initial = doc('a')) {
  let state = {
    doc: initial,
    setDocWithHistory: (next: TimelineDoc) => replace(next),
  } as Pick<DocumentState, 'doc' | 'setDocWithHistory'>
  const listeners = new Set<(state: DocumentState, previous: DocumentState) => void>()
  const commits: TimelineDoc[] = []
  const replace = (next: TimelineDoc) => {
    const previous = state
    state = { ...state, doc: next }
    commits.push(next)
    for (const listener of listeners) {
      listener(state as DocumentState, previous as DocumentState)
    }
  }
  const notifySameReference = () => {
    const previous = state
    state = { ...state }
    for (const listener of listeners) {
      listener(state as DocumentState, previous as DocumentState)
    }
  }
  const store: PluginDocumentStoreAdapter = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return { store, replace, notifySameReference, commits, current: () => state.doc, listeners }
}

describe('plugin document generation', () => {
  test('commits one exact generation/reference through history', () => {
    const harness = storeHarness()
    const controller = createPluginDocumentGenerationController(harness.store)
    const starting = controller.getDocumentSnapshot()
    const next = doc('next')
    expect(controller.commitDocument(starting.generation, starting.document, next)).toBe(true)
    expect(harness.commits).toEqual([next])
    expect(controller.getDocumentSnapshot()).toEqual({ generation: 1, document: next })
  })

  test('rejects edit-undo ABA even when the original reference returns', () => {
    const harness = storeHarness()
    const controller = createPluginDocumentGenerationController(harness.store)
    const starting = controller.getDocumentSnapshot()
    harness.replace(doc('b'))
    harness.replace(starting.document)
    expect(harness.current()).toBe(starting.document)
    expect(controller.commitDocument(starting.generation, starting.document, doc('next')))
      .toBe(false)
    expect(harness.commits).toHaveLength(2)
  })

  test('rejects a notified in-place mutation that retains the document reference', () => {
    const harness = storeHarness({ ...doc('a') })
    const controller = createPluginDocumentGenerationController(harness.store)
    const starting = controller.getDocumentSnapshot()
    starting.document.name = 'mutated in place'
    harness.notifySameReference()
    expect(harness.current()).toBe(starting.document)
    expect(controller.commitDocument(starting.generation, starting.document, doc('next')))
      .toBe(false)
    expect(harness.commits).toHaveLength(0)
  })

  test('rejects same-value replacement, wrong reference, no-op, and stale project replacement', () => {
    const original = doc('a')
    const harness = storeHarness(original)
    const controller = createPluginDocumentGenerationController(harness.store)
    const starting = controller.getDocumentSnapshot()
    harness.replace({ ...original })
    expect(controller.commitDocument(starting.generation, original, doc('next'))).toBe(false)
    expect(controller.commitDocument(1, original, doc('next'))).toBe(false)
    expect(controller.commitDocument(1, harness.current(), harness.current())).toBe(false)

    const project = doc('project-b')
    harness.replace(project)
    expect(controller.commitDocument(1, harness.current(), doc('next'))).toBe(false)
  })

  test('dispose is idempotent and prevents later commits', () => {
    const harness = storeHarness()
    const controller = createPluginDocumentGenerationController(harness.store)
    const starting = controller.getDocumentSnapshot()
    controller.dispose()
    controller.dispose()
    expect(harness.listeners.size).toBe(0)
    expect(controller.commitDocument(starting.generation, starting.document, doc('next')))
      .toBe(false)
    expect(harness.commits).toHaveLength(0)
  })

  test('failed store commit is reported without claiming success', () => {
    const initial = doc('a')
    const setDocWithHistory = vi.fn()
    const store: PluginDocumentStoreAdapter = {
      getState: () => ({ doc: initial, setDocWithHistory }),
      subscribe: () => () => {},
    }
    const controller = createPluginDocumentGenerationController(store)
    expect(controller.commitDocument(0, initial, doc('next'))).toBe(false)
    expect(setDocWithHistory).toHaveBeenCalledOnce()
  })
})
