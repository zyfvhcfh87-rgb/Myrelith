import { describe, expect, test } from 'vitest'
import {
  ANALYSIS_CACHE_SCHEMA_VERSION,
  analysisCacheFreshness,
  parseAnalysisCacheManifest,
  type AnalysisCacheEntry,
} from './analysisCache'
import { MOTION_ANALYSIS_ALGORITHM_VERSION } from './motionAnalysis'

function entry(): AnalysisCacheEntry {
  return {
    cacheKind: 'motion',
    cacheKey: 'a'.repeat(64),
    projectBindingId: 'local-project:issue-44',
    assetId: 'asset-1',
    source: {
      fingerprint: {
        algorithm: 'sha256-sampled-v1',
        digest: 'b'.repeat(64),
        fileName: 'fixture.mp4',
        size: 123_456,
        lastModified: 100,
      },
      videoStreamIndex: 0,
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sourceStartMicroseconds: 0,
      sourceEndMicroseconds: 5_000_000,
      samplingIntervalFrames: 1,
    },
    attachment: {
      clipId: 'clip-1',
      sourceMappingDigest: 'c'.repeat(64),
      projectionDigest: 'd'.repeat(64),
    },
    algorithm: {
      kind: 'stabilization',
      algorithmId: 'global-similarity',
      algorithmVersion: MOTION_ANALYSIS_ALGORITHM_VERSION,
      parametersDigest: 'e'.repeat(64),
    },
    resultFileName: `${'a'.repeat(64)}.${'f'.repeat(32)}.bin`,
    resultBytes: 4096,
    sampleCount: 150,
    createdAt: 1_000,
    lastUsedAt: 2_000,
  }
}

const LEGACY_ANALYSIS_CACHE_SCHEMA_VERSION = 1

describe('analysis cache provenance', () => {
  test('migrates legacy motion entries explicitly without changing their bytes or identity', () => {
    const { cacheKind: _kind, ...legacy } = entry()
    const migrated = parseAnalysisCacheManifest({ schemaVersion: LEGACY_ANALYSIS_CACHE_SCHEMA_VERSION, entries: [legacy] })
    expect(migrated).toEqual({ schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries: [entry()] })
    expect(() => parseAnalysisCacheManifest({ schemaVersion: LEGACY_ANALYSIS_CACHE_SCHEMA_VERSION, entries: [entry()] })).toThrow(/legacy/)
    expect(() => parseAnalysisCacheManifest({ schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries: [legacy] })).toThrow(/invalid entry/)
  })
  test('strictly parses and clones a current manifest', () => {
    const original = entry()
    const parsed = parseAnalysisCacheManifest({
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      entries: [original],
    })
    expect(parsed.entries).toEqual([original])
    expect(parsed.entries[0]).not.toBe(original)
    expect(parsed.entries[0]?.cacheKind).toBe('motion')
    if (parsed.entries[0]?.cacheKind === 'motion') expect(parsed.entries[0].source).not.toBe(original.source)
  })

  test('rejects future/hostile manifest fields and duplicate result identities', () => {
    const futureSchemaVersion = ANALYSIS_CACHE_SCHEMA_VERSION + 1
    expect(() => parseAnalysisCacheManifest({
      schemaVersion: futureSchemaVersion,
      entries: [],
    })).toThrow(/Unsupported/)
    expect(() => parseAnalysisCacheManifest({
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      entries: [{ ...entry(), surprise: true }],
    })).toThrow(/invalid entry/)
    expect(() => parseAnalysisCacheManifest({
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      entries: [entry(), entry()],
    })).toThrow(/duplicate/)
  })

  test('accepts exact provenance and names every stale dimension', () => {
    const cached = entry()
    expect(analysisCacheFreshness(cached, cached)).toEqual({ state: 'fresh' })
    expect(analysisCacheFreshness(cached, {
      ...cached,
      source: {
        ...cached.source,
        fingerprint: { ...cached.source.fingerprint, digest: '0'.repeat(64) },
        samplingIntervalFrames: 2,
      },
      attachment: { ...cached.attachment, sourceMappingDigest: '1'.repeat(64) },
      algorithm: { ...cached.algorithm, algorithmVersion: 'similarity-block-ransac-v2' },
    })).toEqual({
      state: 'stale',
      reasons: [
        'source-fingerprint',
        'sampling',
        'source-mapping',
        'algorithm-version',
      ],
    })
  })

  test('rejects cached v2 motion results under the v3 pair schedule', () => {
    const current = entry()
    const cachedV2 = {
      ...current,
      algorithm: {
        ...current.algorithm,
        algorithmVersion: 'similarity-block-ransac-v2',
      },
    }

    expect(analysisCacheFreshness(cachedV2, current)).toEqual({
      state: 'stale',
      reasons: ['algorithm-version'],
    })
  })
})
