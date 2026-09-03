import { describe, expect, test } from 'vitest'
import { validateProjectFile } from '../../domain/projectFile'
import { docDurationFrames } from '../../domain/selectors'
import { isProceduralTextAssetId } from '../../domain/textOverlay'
import {
  PERFORMANCE_FIXTURE_DURATION_FRAMES,
  PERFORMANCE_FIXTURE_VERSION,
  createPerformanceFixture,
  expectedFixtureDrawnClipIds,
  fingerprintPerformanceFixture,
  type PerformanceFixtureRuntimeMedia,
} from './fixture'

function runtimeMedia(
  overrides: Partial<Pick<PerformanceFixtureRuntimeMedia, 'video' | 'png' | 'wav'>> = {},
  bitrate = 12_000_000,
  sampleDurationSeconds = 1 / 30,
): PerformanceFixtureRuntimeMedia {
  return {
    video: overrides.video ?? new Blob(['video'], { type: 'video/mp4' }),
    png: overrides.png ?? new Blob(['png'], { type: 'image/png' }),
    wav: overrides.wav ?? new Blob(['wav'], { type: 'audio/wav' }),
    generation: {
      version: 'test-generation-v1',
      video: {
        width: 3_840,
        height: 2_160,
        codec: 'avc',
        bitrate,
        keyFrameInterval: 1,
        frameRate: { num: 30, den: 1 },
        samplePlan: [{
          index: 0,
          timestampSeconds: 0,
          durationSeconds: sampleDurationSeconds,
        }],
      },
      png: { width: 3_840, height: 2_160, mimeType: 'image/png' },
      wav: {
        durationSeconds: 47,
        sampleRate: 48_000,
        channels: 2,
        bytesPerSample: 2,
        frequenciesHz: [220, 330],
        amplitude: 0.12,
        mimeType: 'audio/wav',
      },
    },
  }
}

describe('performance stress fixture', () => {
  test('is deterministic, portable, and accepted by the canonical project validator', () => {
    const first = createPerformanceFixture()
    const second = createPerformanceFixture()

    expect(JSON.stringify(first.project)).toBe(JSON.stringify(second.project))
    expect(validateProjectFile(first.project)).toEqual(first.project)
    expect(JSON.stringify(first.project)).not.toContain('objectUrl')
  })

  test('covers the exact issue-54 stress shape', () => {
    const fixture = createPerformanceFixture()

    expect(fixture.version).toBe(PERFORMANCE_FIXTURE_VERSION)
    expect(fixture.summary).toMatchObject({
      assetCount: 100,
      assetKinds: { video: 45, audio: 25, image: 30 },
      representative4kAssetCount: 25,
      trackCount: 8,
      videoTrackCount: 4,
      audioTrackCount: 4,
      clipCount: 320,
      transitionCount: 39,
      textClipCount: 20,
      durationFrames: PERFORMANCE_FIXTURE_DURATION_FRAMES,
      durationSeconds: 1_800,
      width: 3_840,
      height: 2_160,
      frameRate: '30/1',
    })
    expect(docDurationFrames(fixture.project.sequences[0]))
      .toBe(PERFORMANCE_FIXTURE_DURATION_FRAMES)
    expect(fixture.project.sequences[0].tracks.map((track) => track.kind))
      .toEqual(['video', 'video', 'video', 'video', 'audio', 'audio', 'audio', 'audio'])
  })

  test('uses every catalog asset and keeps generated runtime sources bounded', () => {
    const fixture = createPerformanceFixture()
    const referenced = new Set(
      fixture.project.sequences[0].tracks.flatMap((track) => (
        track.clips
          .map((clip) => clip.assetId)
          .filter((assetId) => !isProceduralTextAssetId(assetId))
      )),
    )
    expect(referenced).toEqual(new Set(fixture.project.assets.map((asset) => asset.id)))
    expect(fixture.connectedVideoAssetIds).toHaveLength(1)
    expect(fixture.connectedImageAssetIds).toHaveLength(6)
    expect(fixture.connectedAudioAssetIds).toHaveLength(4)
    expect(fixture.scrubFrames).toHaveLength(5)
    for (const assetId of fixture.connectedVideoAssetIds) {
      expect(fixture.project.assets.find((asset) => asset.id === assetId))
        .toMatchObject({ kind: 'video', width: 3_840, height: 2_160 })
    }
    for (const assetId of fixture.connectedImageAssetIds) {
      expect(fixture.project.assets.find((asset) => asset.id === assetId))
        .toMatchObject({ kind: 'image', width: 3_840, height: 2_160 })
    }
    for (const frame of fixture.scrubFrames) {
      const expectedClipIds = expectedFixtureDrawnClipIds(fixture, frame)
      const expectedClips = fixture.project.sequences[0].tracks.flatMap((track) => (
        track.clips.filter((clip) => expectedClipIds.includes(clip.id))
      ))
      expect(expectedClips.filter((clip) => clip.text !== undefined)).toHaveLength(1)
      expect(expectedClips.filter((clip) => (
        fixture.connectedImageAssetIds.includes(clip.assetId)
      ))).toHaveLength(1)
    }
  })

  test('fingerprints the portable fixture and logical media plan deterministically', async () => {
    const first = createPerformanceFixture()
    const second = createPerformanceFixture()
    const firstFingerprint = await fingerprintPerformanceFixture(first, runtimeMedia())

    expect(firstFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    await expect(fingerprintPerformanceFixture(second, runtimeMedia()))
      .resolves.toBe(firstFingerprint)

    second.project.sequences[0].name = 'Changed fixture identity'
    await expect(fingerprintPerformanceFixture(second, runtimeMedia()))
      .resolves.not.toBe(firstFingerprint)
  })

  test('ignores runtime bytes but changes identity for generation or logical media changes', async () => {
    const fixture = createPerformanceFixture()
    const fingerprint = await fingerprintPerformanceFixture(fixture, runtimeMedia())
    const changedRuntimeBytes = [
      runtimeMedia({ video: new Blob(['video-changed'], { type: 'video/mp4' }) }),
      runtimeMedia({ png: new Blob(['png-changed'], { type: 'image/png' }) }),
      runtimeMedia({ wav: new Blob(['wav-changed'], { type: 'audio/wav' }) }),
    ]
    const runtimeByteFingerprints = await Promise.all(changedRuntimeBytes.map(
      (media) => fingerprintPerformanceFixture(fixture, media),
    ))
    expect(runtimeByteFingerprints).toEqual([fingerprint, fingerprint, fingerprint])

    await expect(fingerprintPerformanceFixture(fixture, runtimeMedia({}, 8_000_000)))
      .resolves.not.toBe(fingerprint)
    await expect(fingerprintPerformanceFixture(fixture, runtimeMedia({}, 12_000_000, 1 / 24)))
      .resolves.not.toBe(fingerprint)
    await expect(fingerprintPerformanceFixture({
      ...fixture,
      scrubFrames: fixture.scrubFrames.slice(0, -1),
    }, runtimeMedia())).resolves.not.toBe(fingerprint)
  })
})
