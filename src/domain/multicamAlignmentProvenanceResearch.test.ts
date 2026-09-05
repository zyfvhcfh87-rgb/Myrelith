import { describe, expect, test } from 'vitest'
import {
  researchAudioFeatureKeyPreimage as featureKey,
  researchAudioPairKeyPreimage as pairKey,
  type ResearchAudioFeatureIdentity,
  type ResearchAudioPairIdentity,
} from './multicamAlignmentProvenanceResearch'

const identity = (): ResearchAudioFeatureIdentity => ({
  projectBindingId: 'local-project:issue-194', assetId: 'camera-1',
  sourceFingerprint: {
    algorithm: 'sha256-sampled-v1', digest: 'a'.repeat(64),
    fileName: 'camera-1.mp4', size: 100_000, lastModified: 123_456,
  },
  audioStreamIndex: 0, audioTrackId: '2', decodePolicyDigest: 'b'.repeat(64),
  timestampOrigin: 'source-presentation-zero-continuous-v1',
  inputSampleRate: 48_000, channels: 2, startSample: 48_000, sourceSampleCount: 480_000, binCount: 2_000,
})
const pair = (): ResearchAudioPairIdentity => ({
  referenceFeatureKey: 'a'.repeat(64), targetFeatureKey: 'b'.repeat(64),
  projectRate: { num: 30, den: 1 }, maxLagBins: 1_000, definitionDigest: 'c'.repeat(64),
})

describe('Issue 194 audio provenance proposal', () => {
  test('frames a stable canonical tuple independent of object property order', () => {
    const source = identity()
    const reordered = Object.fromEntries(Object.entries(source).reverse())
    expect(featureKey(reordered)).toBe(featureKey(source))
    expect(JSON.parse(featureKey(source))[0]).toBe('myrelith-audio-feature-research-v1')
    expect(JSON.parse(pairKey(pair()))[0]).toBe('myrelith-audio-pair-research-v1')
  })

  test('invalidates features across every source, decode, project and window dimension', () => {
    const original = identity()
    const mutations: Partial<ResearchAudioFeatureIdentity>[] = [
      { projectBindingId: 'local-project:copied-project' }, { assetId: 'camera-2' },
      { audioStreamIndex: 1 }, { audioTrackId: '3' }, { decodePolicyDigest: 'e'.repeat(64) },
      { inputSampleRate: 44_100, sourceSampleCount: 441_000 }, { channels: 1 },
      { startSample: 48_001 }, { binCount: 2_001, sourceSampleCount: 480_240 },
      ...[
        { digest: 'd'.repeat(64) }, { fileName: 'replacement.mp4' },
        { size: 100_001 }, { lastModified: 123_457 },
      ].map((patch) => ({ sourceFingerprint: { ...original.sourceFingerprint, ...patch } })),
    ]
    const keys = mutations.map((patch) => featureKey({ ...original, ...patch }))
    expect(keys).not.toContain(featureKey(original))
    expect(new Set(keys).size).toBe(mutations.length)
  })

  test('invalidates pair results on order, input, rate, search or definition changes', () => {
    const original = pair()
    const mutations: Partial<ResearchAudioPairIdentity>[] = [
      { referenceFeatureKey: 'd'.repeat(64) }, { targetFeatureKey: 'd'.repeat(64) },
      { referenceFeatureKey: original.targetFeatureKey, targetFeatureKey: original.referenceFeatureKey },
      { projectRate: { num: 30_000, den: 1_001 } }, { maxLagBins: 999 },
      { definitionDigest: 'd'.repeat(64) },
    ]
    const keys = mutations.map((patch) => pairKey({ ...original, ...patch }))
    expect(keys).not.toContain(pairKey(original))
    expect(new Set(keys).size).toBe(mutations.length)
  })

  test.each([
    null, {}, { ...identity(), videoStreamIndex: 0 }, { ...identity(), clipId: 'fake' },
    { ...identity(), projectBindingId: 'invalid binding with spaces' },
    { ...identity(), timestampOrigin: 'unknown' }, { ...identity(), timestampOrigin: 'first-decoded-sample' },
    { ...identity(), sourceSampleCount: 480_001 }, { ...identity(), binCount: 6_001 },
    { ...identity(), inputSampleRate: 96_001 }, { ...identity(), channels: 3 },
    { ...identity(), startSample: 86_400 * 48_000 }, { ...identity(), audioStreamIndex: 256 },
    { ...identity(), audioTrackId: '' }, { ...identity(), decodePolicyDigest: 'B'.repeat(64) },
    { ...identity(), sourceFingerprint: { ...identity().sourceFingerprint, fullFile: true } },
  ])('rejects unknown semantics or inconsistent coverage: %j', (value) => {
    expect(() => featureKey(value)).toThrow(TypeError)
  })

  test.each([
    { ...pair(), maxLagBins: 0 }, { ...pair(), maxLagBins: 1_001 },
    { ...pair(), referenceFeatureKey: '' }, { ...pair(), definitionDigest: undefined },
    { ...pair(), projectRate: { num: 60, den: 2 } }, { ...pair(), approximate: true },
  ])('rejects an unbounded or unbound pair: %j', (value) => {
    expect(() => pairKey(value)).toThrow(TypeError)
  })
})
