import { describe, expect, test } from 'vitest'
import {
  cloneMediaCollections,
  createMediaCollection,
  deleteMediaCollection,
  mediaCollectionsMatchCatalog,
  removeAssetFromMediaCollections,
  renameMediaCollection,
  reorderMediaCollection,
  setMediaCollectionMembership,
  type MediaCollection,
} from './mediaCollections'

const START: readonly MediaCollection[] = [
  { id: 'interviews', name: 'Interviews', assetIds: ['asset-a'] },
  { id: 'b-roll', name: 'B-roll', assetIds: ['asset-a', 'asset-b'] },
]

describe('mediaCollections', () => {
  test('creates, renames, reorders, and deletes organization without asset data', () => {
    const created = createMediaCollection(START, 'music', '  Music  ')
    expect(created.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'interviews', name: 'Interviews' },
      { id: 'b-roll', name: 'B-roll' },
      { id: 'music', name: 'Music' },
    ])
    const renamed = renameMediaCollection(created, 'music', 'Score')
    const reordered = reorderMediaCollection(renamed, 'music', 0)
    expect(reordered.map((collection) => collection.name)).toEqual([
      'Score',
      'Interviews',
      'B-roll',
    ])
    expect(deleteMediaCollection(reordered, 'interviews')).toEqual([
      { id: 'music', name: 'Score', assetIds: [] },
      { id: 'b-roll', name: 'B-roll', assetIds: ['asset-a', 'asset-b'] },
    ])
    expect(START).toEqual([
      { id: 'interviews', name: 'Interviews', assetIds: ['asset-a'] },
      { id: 'b-roll', name: 'B-roll', assetIds: ['asset-a', 'asset-b'] },
    ])
  })

  test('allows one stable asset in several collections without duplication', () => {
    const withSecondMembership = setMediaCollectionMembership(
      START,
      'interviews',
      'asset-b',
      true,
    )
    expect(withSecondMembership[0].assetIds).toEqual(['asset-a', 'asset-b'])
    expect(withSecondMembership[1].assetIds).toEqual(['asset-a', 'asset-b'])
    expect(setMediaCollectionMembership(
      withSecondMembership,
      'interviews',
      'asset-b',
      true,
    )).toBe(withSecondMembership)
    expect(setMediaCollectionMembership(
      withSecondMembership,
      'interviews',
      'asset-a',
      false,
    )[0].assetIds).toEqual(['asset-b'])
  })

  test('rejects ambiguous names and invalid edits by reference', () => {
    expect(createMediaCollection(START, 'other', ' interviews ')).toBe(START)
    expect(renameMediaCollection(START, 'b-roll', 'INTERVIEWS')).toBe(START)
    expect(renameMediaCollection(START, 'missing', 'Other')).toBe(START)
    expect(reorderMediaCollection(START, 'b-roll', 1)).toBe(START)
    expect(reorderMediaCollection(START, 'b-roll', 4)).toBe(START)
    expect(deleteMediaCollection(START, 'missing')).toBe(START)
    expect(setMediaCollectionMembership(START, 'missing', 'asset-a', true)).toBe(START)
  })

  test('prunes a deleted asset from every collection and validates catalog identity', () => {
    const pruned = removeAssetFromMediaCollections(START, 'asset-a')
    expect(pruned).toEqual([
      { id: 'interviews', name: 'Interviews', assetIds: [] },
      { id: 'b-roll', name: 'B-roll', assetIds: ['asset-b'] },
    ])
    expect(removeAssetFromMediaCollections(pruned, 'missing')).toBe(pruned)
    expect(mediaCollectionsMatchCatalog(
      pruned,
      new Set(['asset-a', 'asset-b']),
    )).toBe(true)
    expect(mediaCollectionsMatchCatalog(
      START,
      new Set(['asset-b']),
    )).toBe(false)
    expect(mediaCollectionsMatchCatalog([
      ...START,
      { id: 'duplicate-name', name: ' interviews ', assetIds: [] },
    ], new Set(['asset-a', 'asset-b']))).toBe(false)
  })

  test('clones collection and membership arrays for portable snapshots', () => {
    const clone = cloneMediaCollections(START)
    expect(clone).toEqual(START)
    expect(clone).not.toBe(START)
    expect(clone[0]).not.toBe(START[0])
    expect(clone[0].assetIds).not.toBe(START[0].assetIds)
  })
})
