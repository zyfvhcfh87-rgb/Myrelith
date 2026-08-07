import { describe, expect, test } from 'vitest'
import { estimateDocumentMemory, utf8ByteLength } from './documentMemory'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'

describe('document memory estimate', () => {
  test('counts UTF-8 without a browser TextEncoder', () => {
    expect(utf8ByteLength('WebCut')).toBe(6)
    expect(utf8ByteLength('\u00b5')).toBe(2)
    expect(utf8ByteLength('\ud83c\udfac')).toBe(4)
  })

  test('separates authored JSON, history serialization, and shared retention', () => {
    const doc = createTimelineDoc(
      'Memory test',
      DEFAULT_PROJECT_SETTINGS,
      'memory-test',
    )
    const first = {
      ...doc,
      tracks: doc.tracks.map((track, index) => (
        index === 0 ? { ...track, hidden: true } : track
      )),
    }
    const second = {
      ...doc,
      tracks: doc.tracks.map((track, index) => (
        index === 0 ? { ...track, name: 'Picture' } : track
      )),
    }

    const estimate = estimateDocumentMemory(doc, [first, second], [first])

    expect(estimate.history).toMatchObject({
      pastDepth: 2,
      futureDepth: 1,
      snapshotCount: 3,
    })
    expect(estimate.authoredDocument.serializedUtf8Bytes).toBeGreaterThan(0)
    expect(estimate.history.serializedUtf8Bytes).toBeGreaterThan(
      estimate.authoredDocument.serializedUtf8Bytes * 2,
    )
    expect(estimate.history.estimatedAdditionalRetainedBytes).toBeGreaterThan(0)
    expect(estimate.history.estimatedStructuralSharingSavingsBytes).toBeGreaterThan(0)
    expect(estimate.totals.estimatedRetainedBytes).toBe(
      estimate.authoredDocument.retainedGraph.estimatedBytes
      + estimate.history.estimatedAdditionalRetainedBytes,
    )
    expect(estimate.assumptions.join(' ')).toMatch(/decoded media.*caches/i)
  })

  test('reports an empty history without fabricating cost', () => {
    const doc = createTimelineDoc(
      'No history',
      DEFAULT_PROJECT_SETTINGS,
      'no-history',
    )
    const estimate = estimateDocumentMemory(doc, [], [])

    expect(estimate.history).toEqual({
      pastDepth: 0,
      futureDepth: 0,
      snapshotCount: 0,
      serializedUtf8Bytes: 0,
      estimatedAdditionalRetainedBytes: 0,
      estimatedStructuralSharingSavingsBytes: 0,
    })
  })
})
