import { describe, expect, test } from 'vitest'
import {
  MediaAssetRuntimeError,
  withMediaRuntimeFailure,
  type MediaCompatibilityReport,
  type MediaTrackCompatibility,
} from './mediaCompatibility'

function track(
  kind: 'video' | 'audio',
  primary: boolean,
): MediaTrackCompatibility {
  return {
    kind,
    number: 1,
    primary,
    codec: kind === 'video' ? 'avc' : 'aac',
    codecParameter: kind === 'video' ? 'avc1.640028' : 'mp4a.40.2',
    internalCodecId: null,
    decoderConfig: null,
    decoderPath: 'native',
    decodable: true,
    reason: null,
    detail: null,
    width: kind === 'video' ? 1920 : null,
    height: kind === 'video' ? 1080 : null,
    codedWidth: kind === 'video' ? 1920 : null,
    codedHeight: kind === 'video' ? 1080 : null,
    frameRate: kind === 'video' ? { num: 60, den: 1 } : null,
    sampleRate: kind === 'audio' ? 48_000 : null,
    channels: kind === 'audio' ? 2 : null,
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
