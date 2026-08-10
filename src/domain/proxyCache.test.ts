import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PROXY_PARAMETERS,
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
