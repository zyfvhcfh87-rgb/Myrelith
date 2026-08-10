/**
 * Non-portable project identity for origin-local capabilities and derived data.
 * It never enters TimelineDoc, Zustand, or a `.myrelith` file.
 */

import {
  isLocalProjectBindingId,
} from '../domain/localProjectBinding'

const LEGACY_BINDING_PREFIX = 'legacy-document:'
const CURRENT_BINDING_PREFIX = 'local-project:'

let activeBindingId: string | null = null

export function createLocalProjectBindingId(
  createUuid: () => string = () => crypto.randomUUID(),
): string {
  const value = `${CURRENT_BINDING_PREFIX}${createUuid()}`
  if (!isLocalProjectBindingId(value)) {
    throw new Error('Could not create a valid local project binding')
  }
  return value
}

/** Upgrade namespace used only after a locally stored v1 record is opened. */
export function legacyLocalProjectBindingId(documentId: string): string {
  const value = `${LEGACY_BINDING_PREFIX}${documentId}`
  if (!isLocalProjectBindingId(value)) {
    throw new Error('Legacy project identity is too long to migrate safely')
  }
  return value
}

export function legacyDocumentIdForBinding(bindingId: string): string | null {
  return bindingId.startsWith(LEGACY_BINDING_PREFIX)
    ? bindingId.slice(LEGACY_BINDING_PREFIX.length)
    : null
}

export function setActiveLocalProjectBindingId(bindingId: string): void {
  if (!isLocalProjectBindingId(bindingId)) {
    throw new TypeError('Active local project binding is invalid')
  }
  activeBindingId = bindingId
}

export function getActiveLocalProjectBindingId(): string | null {
  return activeBindingId
}

export function clearActiveLocalProjectBindingId(): void {
  activeBindingId = null
}
