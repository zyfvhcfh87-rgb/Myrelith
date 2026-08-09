/**
 * Pure Media Pool collection operations.
 *
 * Collections are durable project organization only: they reference stable
 * asset ids and never own, duplicate, move, or delete media resources.
 */

export interface MediaCollection {
  readonly id: string
  readonly name: string
  readonly assetIds: readonly string[]
}

export const MEDIA_COLLECTION_LIMITS = Object.freeze({
  maxCollections: 2_048,
  maxNameCharacters: 120,
  maxMembershipsPerCollection: 50_000,
  maxTotalMemberships: 500_000,
  historyEntries: 100,
})

export function normalizeMediaCollectionName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

export function mediaCollectionNameKey(value: string): string {
  return normalizeMediaCollectionName(value).toLowerCase()
}

function validCollectionName(
  collections: readonly MediaCollection[],
  name: string,
  ignoredId: string | null = null,
): string | null {
  const normalized = normalizeMediaCollectionName(name)
  if (
    normalized.length === 0
    || normalized.length > MEDIA_COLLECTION_LIMITS.maxNameCharacters
  ) return null
  const key = mediaCollectionNameKey(normalized)
  return collections.some((collection) => (
    collection.id !== ignoredId && mediaCollectionNameKey(collection.name) === key
  ))
    ? null
    : normalized
}

export function cloneMediaCollections(
  collections: readonly MediaCollection[],
): MediaCollection[] {
  return collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    assetIds: [...collection.assetIds],
  }))
}

export function createMediaCollection(
  collections: readonly MediaCollection[],
  id: string,
  name: string,
): readonly MediaCollection[] {
  const normalized = validCollectionName(collections, name)
  if (
    collections.length >= MEDIA_COLLECTION_LIMITS.maxCollections
    || id.trim().length === 0
    || collections.some((collection) => collection.id === id)
    || normalized === null
  ) return collections
  return [...collections, { id, name: normalized, assetIds: [] }]
}

export function renameMediaCollection(
  collections: readonly MediaCollection[],
  id: string,
  name: string,
): readonly MediaCollection[] {
  const index = collections.findIndex((collection) => collection.id === id)
  if (index < 0) return collections
  const normalized = validCollectionName(collections, name, id)
  if (normalized === null || collections[index].name === normalized) {
    return collections
  }
  return collections.map((collection, collectionIndex) => (
    collectionIndex === index ? { ...collection, name: normalized } : collection
  ))
}

export function reorderMediaCollection(
  collections: readonly MediaCollection[],
  id: string,
  toIndex: number,
): readonly MediaCollection[] {
  const fromIndex = collections.findIndex((collection) => collection.id === id)
  if (
    fromIndex < 0
    || !Number.isSafeInteger(toIndex)
    || toIndex < 0
    || toIndex >= collections.length
    || toIndex === fromIndex
  ) return collections
  const next = [...collections]
  const [collection] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, collection)
  return next
}

export function deleteMediaCollection(
  collections: readonly MediaCollection[],
  id: string,
): readonly MediaCollection[] {
  const index = collections.findIndex((collection) => collection.id === id)
  if (index < 0) return collections
  return collections.filter((_, collectionIndex) => collectionIndex !== index)
}

export function setMediaCollectionMembership(
  collections: readonly MediaCollection[],
  collectionId: string,
  assetId: string,
  included: boolean,
): readonly MediaCollection[] {
  const index = collections.findIndex((collection) => collection.id === collectionId)
  if (index < 0 || assetId.length === 0) return collections
  const collection = collections[index]
  const alreadyIncluded = collection.assetIds.includes(assetId)
  if (alreadyIncluded === included) return collections
  if (
    included
    && (
      collection.assetIds.length >= MEDIA_COLLECTION_LIMITS.maxMembershipsPerCollection
      || collections.reduce(
          (total, candidate) => total + candidate.assetIds.length,
          0,
        ) >= MEDIA_COLLECTION_LIMITS.maxTotalMemberships
    )
  ) return collections
  const assetIds = included
    ? [...collection.assetIds, assetId]
    : collection.assetIds.filter((candidate) => candidate !== assetId)
  return collections.map((candidate, collectionIndex) => (
    collectionIndex === index ? { ...candidate, assetIds } : candidate
  ))
}

/** Remove one deleted source from current/history snapshots without touching bins. */
export function removeAssetFromMediaCollections(
  collections: readonly MediaCollection[],
  assetId: string,
): readonly MediaCollection[] {
  let changed = false
  const next = collections.map((collection) => {
    if (!collection.assetIds.includes(assetId)) return collection
    changed = true
    return {
      ...collection,
      assetIds: collection.assetIds.filter((candidate) => candidate !== assetId),
    }
  })
  return changed ? next : collections
}

export function mediaCollectionsMatchCatalog(
  collections: readonly MediaCollection[],
  assetIds: ReadonlySet<string>,
): boolean {
  if (collections.length > MEDIA_COLLECTION_LIMITS.maxCollections) return false
  const ids = new Set<string>()
  const names = new Set<string>()
  let totalMemberships = 0
  for (const collection of collections) {
    const normalizedName = normalizeMediaCollectionName(collection.name)
    const nameKey = mediaCollectionNameKey(collection.name)
    if (
      collection.id.trim().length === 0
      || ids.has(collection.id)
      || normalizedName !== collection.name
      || normalizedName.length === 0
      || normalizedName.length > MEDIA_COLLECTION_LIMITS.maxNameCharacters
      || names.has(nameKey)
      || collection.assetIds.length > MEDIA_COLLECTION_LIMITS.maxMembershipsPerCollection
    ) return false
    ids.add(collection.id)
    names.add(nameKey)
    const memberships = new Set<string>()
    for (const assetId of collection.assetIds) {
      if (memberships.has(assetId) || !assetIds.has(assetId)) return false
      memberships.add(assetId)
    }
    totalMemberships += collection.assetIds.length
    if (totalMemberships > MEDIA_COLLECTION_LIMITS.maxTotalMemberships) {
      return false
    }
  }
  return true
}
