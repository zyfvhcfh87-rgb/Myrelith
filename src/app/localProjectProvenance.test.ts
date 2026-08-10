import { afterEach, describe, expect, test } from 'vitest'
import {
  clearActiveLocalProjectBindingId,
  createLocalProjectBindingId,
  getActiveLocalProjectBindingId,
  legacyDocumentIdForBinding,
  legacyLocalProjectBindingId,
  setActiveLocalProjectBindingId,
} from './localProjectProvenance'

afterEach(clearActiveLocalProjectBindingId)

describe('local project provenance', () => {
  test('mints a non-portable namespace and keeps it outside project state', () => {
    const bindingId = createLocalProjectBindingId(() => 'uuid-a')
    expect(bindingId).toBe('local-project:uuid-a')
    setActiveLocalProjectBindingId(bindingId)
    expect(getActiveLocalProjectBindingId()).toBe(bindingId)
    expect(() => createLocalProjectBindingId(() => '../private'))
      .toThrow('Could not create a valid local project binding')
  })

  test('recognizes only the explicit legacy migration namespace', () => {
    const bindingId = legacyLocalProjectBindingId('doc-a')
    expect(legacyDocumentIdForBinding(bindingId)).toBe('doc-a')
    expect(legacyDocumentIdForBinding('local-project:doc-a')).toBeNull()
  })
})
