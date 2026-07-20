import { describe, expect, test } from 'vitest'
import type { MediaAsset } from './schema'
import {
  acceptPartialTrackImport,
  MediaAssetRuntimeError,
  partialTrackImportOption,
  withMediaRuntimeFailure,
  type MediaCompatibilityReport,
  type MediaTrackCompatibility,
} from './mediaCompatibility'

interface TrackOptions {
  number?: number
  decodable?: boolean
  durationMicroseconds?: number
}

function track(
  kind: 'video' | 'audio',
  primary: boolean,
  options: TrackOptions = {},
): MediaTrackCompatibility {
  const decodable = options.decodable ?? true
  return {
    kind,
    number: options.number ?? 1,
    primary,
    codec: kind === 'video' ? 'avc' : 'aac',
    codecParameter: kind === 'video' ? 'avc1.640028' : 'mp4a.40.2',
    internalCodecId: null,
    decoderConfig: null,
    decoderPath: decodable ? 'native' : null,
    decodable,
    reason: decodable ? null : 'unsupported-codec',
    detail: decodable ? null : `${kind} decoder unavailable`,
    width: kind === 'video' ? 1920 : null,
    height: kind === 'video' ? 1080 : null,
    codedWidth: kind === 'video' ? 1920 : null,
    codedHeight: kind === 'video' ? 1080 : null,
    frameRate: kind === 'video' ? { num: 60, den: 1 } : null,
    sampleRate: kind === 'audio' ? 48_000 : null,
    channels: kind === 'audio' ? 2 : null,
    durationMicroseconds: options.durationMicroseconds,
  }
}

function probedAsset(): MediaAsset {
  return {
    id: 'asset-av',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 123_456,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 600,
    durationMicroseconds: 10_000_000,
    frameRate: { num: 60, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: 'video-decoder-config',
  }
}

function readyReport(): MediaCompatibilityReport {
  return {
    status: 'ready',
    container: {
      name: 'MPEG-4',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    },
    durationMicroseconds: 10_000_000,
    tracks: [track('video', true), track('audio', true)],
    reason: null,
    detail: null,
  }
}

describe('runtime media compatibility', () => {
  test('preserves probe facts and marks only the implicated primary track', () => {
    const report = withMediaRuntimeFailure(readyReport(), {
      surface: 'preview',
      trackKind: 'video',
      reason: 'decode-failed',
      detail: 'hardware decoder stopped',
    })

    expect(report).toMatchObject({
      status: 'error',
      container: { name: 'MPEG-4' },
      durationMicroseconds: 10_000_000,
      reason: 'decode-failed',
      detail: 'Preview failed: hardware decoder stopped',
      runtimeFailures: [{
        surface: 'preview',
        trackKind: 'video',
        reason: 'decode-failed',
        detail: 'hardware decoder stopped',
      }],
    })
    expect(report.tracks[0]).toMatchObject({
      kind: 'video',
      decodable: false,
      reason: 'decode-failed',
      detail: 'hardware decoder stopped',
    })
    expect(report.tracks[1]).toMatchObject({
      kind: 'audio',
      decodable: true,
      reason: null,
    })
    expect(() => JSON.stringify(report)).not.toThrow()
  })

  test('keeps a runtime resource limit distinct from a decode failure', () => {
    const report = withMediaRuntimeFailure(readyReport(), {
      surface: 'export',
      trackKind: 'video',
      reason: 'resource-limit',
      detail: 'Local ProRes safety budget is incomplete.',
    })

    expect(report).toMatchObject({
      status: 'error',
      reason: 'resource-limit',
      detail: 'Export failed: Local ProRes safety budget is incomplete.',
      tracks: [
        expect.objectContaining({
          kind: 'video',
          decodable: false,
          reason: 'resource-limit',
        }),
        expect.objectContaining({
          kind: 'audio',
          decodable: true,
          reason: null,
        }),
      ],
      runtimeFailures: [{
        surface: 'export',
        trackKind: 'video',
        reason: 'resource-limit',
        detail: 'Local ProRes safety budget is incomplete.',
      }],
    })
  })

  test('typed runtime errors retain exact asset identity without message parsing', () => {
    const cause = new DOMException('decoder reset', 'EncodingError')
    const failure = {
      surface: 'export' as const,
      trackKind: 'audio' as const,
      reason: 'resource-unavailable' as const,
      detail: 'the retained Blob could not be read',
    }
    const error = new MediaAssetRuntimeError('asset-audio', failure, cause)

    expect(error).toBeInstanceOf(Error)
    expect(error.assetId).toBe('asset-audio')
    expect(error.failure).toBe(failure)
    expect(error.message).toBe(failure.detail)
    expect(error.cause).toBe(cause)
  })
})

describe('explicit partial-track import', () => {
  test('offers and accepts video-only while preserving only video capabilities', () => {
    const asset = probedAsset()
    const report: MediaCompatibilityReport = {
      ...readyReport(),
      status: 'limited',
      durationMicroseconds: 10_000_000,
      tracks: [
        track('video', true, { durationMicroseconds: 8_000_000 }),
        track('audio', true, {
          decodable: false,
          durationMicroseconds: 10_000_000,
        }),
      ],
      reason: 'unsupported-codec',
      detail: 'The primary audio track cannot be decoded.',
    }

    expect(partialTrackImportOption(report)).toBe('video-only')
    const accepted = acceptPartialTrackImport(asset, report, 'video-only')

    expect(accepted).not.toBeNull()
    expect(accepted?.asset).toMatchObject({
      id: asset.id,
      kind: 'video',
      partialTrackSelection: 'video-only',
      durationMicroseconds: 8_000_000,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
      decoderConfigB64: 'video-decoder-config',
    })
    expect(accepted?.compatibility).toMatchObject({
      status: 'ready',
      reason: null,
      partialImport: { selection: 'video-only' },
    })
    expect(accepted?.compatibility.detail).toContain(
      'Audio track 1 (primary) is omitted.',
    )
    expect(asset).toMatchObject({ hasAudio: true, durationMicroseconds: 10_000_000 })
  })

  test('offers and accepts audio-only while removing every video capability', () => {
    const asset = probedAsset()
    const report: MediaCompatibilityReport = {
      ...readyReport(),
      status: 'limited',
      tracks: [
        track('video', true, {
          decodable: false,
          durationMicroseconds: 10_000_000,
        }),
        track('audio', true, { durationMicroseconds: 7_000_000 }),
      ],
      reason: 'unsupported-codec',
      detail: 'The primary video track cannot be decoded.',
    }

    expect(partialTrackImportOption(report)).toBe('audio-only')
    const accepted = acceptPartialTrackImport(asset, report, 'audio-only')

    expect(accepted).not.toBeNull()
    expect(accepted?.asset).toMatchObject({
      id: asset.id,
      kind: 'audio',
      partialTrackSelection: 'audio-only',
      durationMicroseconds: 7_000_000,
      frameRate: null,
      width: null,
      height: null,
      hasAudio: true,
      audioSampleRate: 48_000,
      audioChannels: 2,
      decoderConfigB64: null,
    })
    expect(accepted?.compatibility).toMatchObject({
      status: 'ready',
      reason: null,
      partialImport: { selection: 'audio-only' },
    })
    expect(accepted?.compatibility.detail).toContain(
      'Video track 1 (primary) is omitted.',
    )
  })

  test('does not guess or accept when the report has no single safe choice', () => {
    const asset = probedAsset()
    const ambiguous: MediaCompatibilityReport = {
      ...readyReport(),
      status: 'limited',
      reason: 'unsupported-codec',
      detail: 'The report does not identify a failing track kind.',
    }
    expect(partialTrackImportOption(ambiguous)).toBeNull()
    expect(acceptPartialTrackImport(asset, ambiguous, 'video-only')).toBeNull()
    expect(acceptPartialTrackImport(asset, ambiguous, 'audio-only')).toBeNull()

    const unsafe: MediaCompatibilityReport = {
      ...ambiguous,
      tracks: [
        track('video', true),
        track('video', false, { number: 2, decodable: false }),
        track('audio', true, { decodable: false }),
      ],
    }
    expect(partialTrackImportOption(unsafe)).toBeNull()
    expect(acceptPartialTrackImport(asset, unsafe, 'video-only')).toBeNull()
    expect(acceptPartialTrackImport(asset, unsafe, 'audio-only')).toBeNull()

    expect(partialTrackImportOption(readyReport())).toBeNull()
    expect(
      acceptPartialTrackImport(asset, readyReport(), 'video-only'),
    ).toBeNull()
  })
})
