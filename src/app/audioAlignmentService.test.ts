import { createHash } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { AudioAlignmentService, type AudioAlignmentRequest, type AudioAlignmentServiceDeps } from './audioAlignmentService'
import { MediaJobScheduler } from './mediaJobScheduler'
import type { AudioFeatureCacheEntry } from '../domain/analysisCache'
import { createResearchAudioFixture } from '../domain/multicamAlignmentResearchFixtures'
import { alignmentAsset } from '../test/fixtures/alignmentAssets'

const owners: AudioAlignmentService[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.dispose() })
function fixture() {
  const entries = new Map<string, AudioFeatureCacheEntry>()
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>()
  const scheduler = new MediaJobScheduler({ budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 }, yieldControl: async () => {} })
  const deps: AudioAlignmentServiceDeps = {
    scheduler, now: () => 1, yieldControl: async () => {}, fetchBlob: async () => new Blob(['bytes']),
    fingerprint: async (_blob, asset) => ({ algorithm: 'sha256-sampled-v1', digest: 'a'.repeat(64), fileName: asset.fileName, size: asset.size, lastModified: asset.lastModified }),
    hash: async (value) => createHash('sha256').update(ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value)).digest('hex'),
    worker: vi.fn((_signal, count) => {
      let id = ''
      return { open: async (_blob: Blob, sourceId: string) => { id = sourceId; return {
        inputSampleRate: 8000, channels: 1, audioStreamIndex: 0, audioTrackId: '2',
        firstTimestamp: 0, endTimestamp: 30, decodePolicy: 'fixture-v1',
      } },
      decode: vi.fn(async (window) => {
        count(1)
        const result = createResearchAudioFixture({ inputSampleRate: 8000, durationSeconds: window.binCount / 200,
          startSeconds: window.startSample / 8000, recordingStartSeconds: id === 'target' ? 0.75 : 0 })
        count(0)
        return result
      }), close: vi.fn(() => count(0)) }
    }),
    storage: {
      findAudioFeature: vi.fn(async (key) => entries.get(key) ?? null),
      readResult: vi.fn(async (entry) => bytes.get(entry.resultFileName)!), touch: vi.fn(async () => {}),
      stageResult: vi.fn(async (key, value) => {
        const fileName = `${key}.${String(bytes.size + 1).padStart(32, '0')}.bin`
        bytes.set(fileName, value)
        return { fileName, discard: vi.fn(async () => { bytes.delete(fileName) }) }
      }),
      commitEntry: vi.fn(async (entry) => {
        if (entry.cacheKind !== 'audio-feature') throw new Error('Wrong cache kind')
        entries.set(entry.cacheKey, entry)
        return { finalize: vi.fn(async () => {}), rollback: vi.fn(async () => { entries.delete(entry.cacheKey) }) }
      }),
    },
  }
  const owner = new AudioAlignmentService(deps)
  owners.push(owner)
  const request: AudioAlignmentRequest = { projectBindingId: 'local-project:test',
    sources: ['reference', 'target'].map((angleId) => ({ angleId, asset: alignmentAsset(angleId), startBin: 0 })),
    binCount: 2000, maxLagBins: 1000, rate: { num: 30, den: 1 }, definitionDigest: 'b'.repeat(64), current: () => true, progress: vi.fn() }
  return { owner, deps, entries, bytes, request }
}
test('runs sequentially, uses exact-provenance cache hits, rejects corrupt bytes and misses changed windows', async () => {
  const f = fixture()
  const first = await f.owner.run(f.request)
  await f.deps.scheduler.whenIdle()
  expect(first.comparisons[0].result).toMatchObject({ state: 'aligned', offsetFrames: 23 })
  expect(first.cacheHits).toBe(0)
  expect(f.owner.snapshot().maxActiveDecoderCount).toBe(1)
  expect(f.owner.snapshot().activeDecoderCount).toBe(0)
  const second = await f.owner.run(f.request)
  await f.deps.scheduler.whenIdle()
  expect(second.cacheHits).toBe(2)
  expect(second.comparisons[0].fromCache).toBe(true)
  for (const value of f.bytes.values()) new DataView(value.buffer).setFloat32(0, NaN, true)
  const corrupted = await f.owner.run(f.request)
  await f.deps.scheduler.whenIdle()
  expect(corrupted.cacheHits).toBe(0)
  expect(corrupted.cacheWarnings).toHaveLength(2)
  const changed = await f.owner.run({ ...f.request, sources: f.request.sources.map((source) => ({ ...source, startBin: 200 })) })
  expect(changed.cacheHits).toBe(0)
})
test('cancellation retains scheduler admission until a late manifest commit is rolled back', async () => {
  const f = fixture()
  let commit!: (transaction: { finalize: () => Promise<void>; rollback: () => Promise<void> }) => void
  vi.mocked(f.deps.storage.commitEntry).mockImplementation(() => new Promise((resolve) => { commit = resolve }))
  const pending = f.owner.run(f.request)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(commit).toBeTypeOf('function'))
  const drain = f.owner.cancelAndDrain()
  expect(f.owner.snapshot().activeJobCount).toBe(1)
  await expect(f.owner.run(f.request)).rejects.toThrow(/busy/)
  const rollback = vi.fn(async () => {})
  commit({ finalize: vi.fn(async () => {}), rollback })
  await rejected; await drain
  expect(rollback).toHaveBeenCalledOnce()
  expect(f.bytes.size).toBe(0)
  expect(f.owner.snapshot().activeJobCount).toBe(0)
})
test('stale source publication rolls back and quota failure still returns an uncached proposal', async () => {
  const f = fixture()
  let current = true
  vi.mocked(f.deps.storage.commitEntry).mockImplementation(async () => {
    current = false
    return { finalize: vi.fn(async () => {}), rollback: vi.fn(async () => {}) }
  })
  await expect(f.owner.run({ ...f.request, current: () => current })).rejects.toThrow(/changed/)
  await f.deps.scheduler.whenIdle()
  expect(f.bytes.size).toBe(0)
  vi.mocked(f.deps.storage.stageResult).mockRejectedValue(new Error('quota'))
  const result = await f.owner.run(f.request)
  expect(result.cacheWarnings).toHaveLength(2)
  expect(result.comparisons[0].result.state).toBe('aligned')
})
