import { beforeEach, describe, expect, test } from 'vitest'
import type { TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useLoudnessStore } from '../state/loudnessStore'
import { resetDocumentStoreForTest } from '../test/storeFixtures'
import './loudnessController'

function doc(id: string): TimelineDoc {
  return {
    schemaVersion: 18,
    id,
    name: id,
    frameRate: { num: 30, den: 1 },
    width: 64,
    height: 48,
    audioSampleRate: 48_000,
    tracks: [],
  }
}

describe('loudness controller', () => {
  beforeEach(() => {
    resetDocumentStoreForTest(doc('loudness-a'))
    useLoudnessStore.getState().reset()
  })

  test('document edits discard a complete reading so Normalize cannot double-apply', () => {
    useLoudnessStore.getState().setRunning(1, { startFrame: 0, endFrame: 10 })
    useLoudnessStore.getState().setResult(1, {
      integratedLufs: -22,
      truePeakDbtp: -1,
      coverage: 'complete',
      measuredSamples: 100,
      expectedSamples: 100,
    })
    expect(useLoudnessStore.getState().status).toBe('complete')
    expect(useLoudnessStore.getState().measurement?.integratedLufs).toBe(-22)

    resetDocumentStoreForTest(doc('loudness-b'))
    expect(useLoudnessStore.getState().status).toBe('idle')
    expect(useLoudnessStore.getState().measurement).toBeNull()
    expect(useDocumentStore.getState().doc.id).toBe('loudness-b')
  })
})
