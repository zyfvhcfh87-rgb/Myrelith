import type { CaptionOriginDescriptor } from './captionOrigin'
import { describe, expect, it } from 'vitest'
import { captionOriginRelationshipError, inspectCaptionCueOrigin, inspectCaptionTrackOrigin, mergeCaptionOrigins } from './captionOrigin'
import { captionCueOrigin, captionTrackOrigin } from '../test/captionIntentFixtures'

describe('historical caption origin', () => {
  it('validates and freezes complete known run and cue intent without requiring an existing asset', () => {
    const source = captionTrackOrigin()
    const inspected = inspectCaptionTrackOrigin(source)
    expect(inspected.kind).toBe('supported')
    if (inspected.kind !== 'supported') return
    expect(inspected.descriptor).toEqual(source)
    expect(inspected.descriptor).not.toBe(source)
    expect(Object.isFrozen(inspected.params)).toBe(true)
    expect(captionOriginRelationshipError(source, captionCueOrigin())).toBeNull()
  })
  it('binds a transparent composite revision to its whole manifest', () => {
    const source = captionTrackOrigin()
    expect(inspectCaptionTrackOrigin({ ...source, params: { ...source.params, modelRevision: `composite:${'b'.repeat(64)}` } }).kind).toBe('supported')
    expect(inspectCaptionTrackOrigin({ ...source, params: { ...source.params, modelRevision: `composite:${'a'.repeat(64)}` } }).kind).toBe('invalid')
  })
  it.each([
    ['sourceSampleRate', 0], ['sourceStartSample', -1], ['sourceSampleCount', 0], ['sourceStartSample', Number.MAX_SAFE_INTEGER],
    ['targetFrameOffset', 0.5], ['manifestDigest', 'not-a-digest'], ['modelRevision', 'main'], ['modelId', 'https://example.test/model'],
    ['sourceFingerprintAlgorithm', 'filename'], ['language', 'en<script>'], ['sourceAssetId', 'blob:some/resource'],
  ])('rejects invalid known %s=%s', (key, value) => {
    const source = captionTrackOrigin()
    expect(inspectCaptionTrackOrigin({ ...source, params: { ...source.params, [key]: value } }).kind).toBe('invalid')
  })
  it('requires all known fields but bypasses an entire bounded future version or key set', () => {
    expect(inspectCaptionTrackOrigin({ version: 1, params: {} }).kind).toBe('invalid')
    for (const value of [{ version: 2, params: { sourceSampleRate: 'future' } }, { version: 1, params: { future: true } }] as CaptionOriginDescriptor[]) {
      const inspected = inspectCaptionTrackOrigin(value)
      expect(inspected.kind).toBe('unavailable')
      if (inspected.kind === 'unavailable') expect(inspected.descriptor).toEqual(value)
      expect(captionOriginRelationshipError(value, captionCueOrigin())).toBeNull()
    }
    expect(inspectCaptionCueOrigin({ version: 2, params: { pcm: new Float32Array(1) } }).kind).toBe('invalid')
  })
  it('rejects mismatched known runs, source ranges and missing run owners', () => {
    const source = captionTrackOrigin()
    expect(captionOriginRelationshipError(undefined, captionCueOrigin())).toMatch(/requires/)
    expect(captionOriginRelationshipError(source, captionCueOrigin(0))).toMatch(/range/)
    expect(captionOriginRelationshipError(source, captionCueOrigin(40_000))).toMatch(/range/)
    expect(captionOriginRelationshipError(source, { version: 1, params: { ...captionCueOrigin().params, runId: 'other' } })).toMatch(/run/)
  })
  it('preserves source coverage on compatible merge and rejects known/mixed/opaque losses', () => {
    expect(mergeCaptionOrigins(captionCueOrigin(), captionCueOrigin(32_000))).toEqual(captionCueOrigin(16_000, 32_000))
    expect(() => mergeCaptionOrigins(undefined, captionCueOrigin())).toThrow(/provenance/)
    expect(() => mergeCaptionOrigins(captionCueOrigin(), { version: 99, params: { runId: 'run-1' } })).toThrow(/provenance/)
    const a = { version: 99, params: { x: true, y: 'opaque' } }
    expect(mergeCaptionOrigins(a, { version: 99, params: { y: 'opaque', x: true } })).toBe(a)
    expect(() => mergeCaptionOrigins(a, { version: 99, params: { x: false, y: 'opaque' } })).toThrow(/provenance/)
  })
})
