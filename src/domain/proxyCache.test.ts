import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PROXY_PARAMETERS,
  MAX_PROXY_CACHE_ENTRIES,
  PROXY_CACHE_SCHEMA_VERSION,
  PROXY_GENERATOR_VERSION,
  estimateProxyBytes,
  parseProxyCacheManifest,
  proxyDescriptorCouldMatch,
  proxyFingerprintMatches,
  proxyOutputDimensions,
  selectMediaRepresentation,
  type ProxyCacheEntry,
} from './proxyCache'

function entry(): ProxyCacheEntry {
  const cacheKey = 'a'.repeat(64)
  return {
    cacheKey,
    assetId: 'asset-1',
    original: {
      algorithm: 'sha256-sampled-v1',
      digest: 'b'.repeat(64),
      fileName: 'source.mov',
      size: 10_000,
      lastModified: 123,
    },
    parameters: DEFAULT_PROXY_PARAMETERS,
    generatorVersion: PROXY_GENERATOR_VERSION,
    fileName: `${cacheKey}.${'1'.repeat(32)}.mp4`,
    mimeType: 'video/mp4',
    byteSize: 1_000,
    width: 1_280,
    height: 720,
    frameRate: { num: 30_000, den: 1_001 },
    durationMicroseconds: 2_000_000,
    createdAt: 10,
    lastUsedAt: 20,
  }
}

describe('proxy cache contract', () => {
  test('keeps final export on the original while preview may use only a fresh proxy', () => {
    expect(selectMediaRepresentation({
      purpose: 'preview',
      originalAvailable: true,
      proxy: 'fresh',
    }).representation).toBe('proxy')
    expect(selectMediaRepresentation({
      purpose: 'preview',
      originalAvailable: true,
      proxy: 'stale',
    }).representation).toBe('original')
    expect(selectMediaRepresentation({
      purpose: 'export',
      originalAvailable: false,
      proxy: 'fresh',
    })).toEqual(expect.objectContaining({
      representation: 'unavailable',
      reason: expect.stringContaining('original source is offline'),
    }))
  })

  test('validates a versioned manifest and rejects ambiguous or future entries', () => {
    expect(parseProxyCacheManifest({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      entries: [entry()],
    }).entries).toHaveLength(1)
    expect(() => parseProxyCacheManifest({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION + 1,
      entries: [],
    }))
      .toThrow('Unsupported')
    expect(() => parseProxyCacheManifest({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      entries: [entry(), entry()],
    })).toThrow('duplicate')
  })

  test('rejects hostile manifests with unknown keys or unbounded facts', () => {
    const valid = entry()
    const hostile: unknown[] = [
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [], extra: true },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{ ...valid, extra: true }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        assetId: 'x'.repeat(257),
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        original: { ...valid.original, fileName: 'x'.repeat(4_097) },
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        parameters: { ...valid.parameters, bitrate: 200_000_001 },
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        width: 65_536,
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        durationMicroseconds: Number.POSITIVE_INFINITY,
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        createdAt: 21,
        lastUsedAt: 20,
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        frameRate: { num: 60, den: 2 },
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        frameRate: { num: 1_000_000, den: 999 },
      }] },
      { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [{
        ...valid,
        frameRate: { num: 1_000_001, den: 1_001 },
      }] },
    ]
    for (const candidate of hostile) {
      expect(() => parseProxyCacheManifest(candidate)).toThrow()
    }
  })

  test('rejects aggregate byte totals that cannot be represented exactly', () => {
    const huge = {
      ...entry(),
      byteSize: Number.MAX_SAFE_INTEGER,
    }
    const entries = Array.from({ length: 2 }, (_, index) => ({
      ...huge,
      assetId: `asset-${index}`,
      cacheKey: String(index + 1).repeat(64),
      fileName: `${String(index + 1).repeat(64)}.${String(index + 1).repeat(32)}.mp4`,
    }))
    expect(entries).toHaveLength(2)
    expect(entries.length).toBeLessThan(MAX_PROXY_CACHE_ENTRIES)
    expect(() => parseProxyCacheManifest({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      entries,
    })).toThrow('byte total')
  })

  test('matches provenance and produces bounded even output geometry', () => {
    const current = entry()
    expect(proxyFingerprintMatches(current, {
      digest: 'b'.repeat(64),
      size: 10_000,
      lastModified: 123,
    })).toBe(true)
    expect(proxyDescriptorCouldMatch(current, {
      fileName: 'source.mov',
      size: 10_000,
      lastModified: 123,
    })).toBe(true)
    expect(proxyOutputDimensions(3_841, 2_161)).toEqual({ width: 1_278, height: 720 })
    expect(proxyOutputDimensions(640, 360)).toEqual({ width: 640, height: 360 })
    expect(estimateProxyBytes(1_000_000)).toBeGreaterThan(250_000)
  })
})
