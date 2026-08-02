import { describe, expect, test } from 'vitest'
import type {
  MediaCompatibilityReport,
  MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import {
  compatibilityReportMatchesDescriptor,
  descriptorMatches,
  inspectionCandidateForDescriptor,
  narrowedFolderCandidateIds,
  relinkedAsset,
  selectDescriptor,
  selectDescriptorByCompatibilityReport,
  selectDescriptorByFileIdentity,
} from './projectMediaMatching'

const EXACT_BOUNDS = {
  status: 'exact' as const,
  firstTimestampUs: 0,
  endTimestampUs: 2_000_000,
}

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'analyzed',
    fileName: 'analyzed.mp4',
    mimeType: 'video/mp4',
    size: 8,
    lastModified: 111,
    objectUrl: 'blob:analyzed',
    kind: 'video',
    durationFrames: 60,
    durationMicroseconds: 2_000_000,
    sourceBounds: { video: EXACT_BOUNDS, audio: EXACT_BOUNDS },
    frameRate: { num: 60, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"avc1.64042a"}',
    ...overrides,
  }
}

function descriptorFrom(
  asset: MediaAsset,
  overrides: Partial<PortableAssetDescriptor> = {},
): PortableAssetDescriptor {
  return {
    id: 'saved',
    fileName: 'saved.mp4',
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    ...(asset.partialTrackSelection === undefined
      ? {}
      : { partialTrackSelection: asset.partialTrackSelection }),
    durationMicroseconds: asset.durationMicroseconds,
    sourceBounds: asset.sourceBounds,
    nativeFrameRate: asset.frameRate,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
    ...overrides,
  }
}

function track(
  kind: 'video' | 'audio',
  decodable = true,
): MediaTrackCompatibility {
  return {
    kind,
    number: 1,
    primary: true,
    codec: kind === 'video' ? 'avc' : 'aac',
    codecParameter: kind === 'video' ? 'avc1.64042a' : 'mp4a.40.2',
    internalCodecId: kind === 'video' ? 'avc1' : 'mp4a',
    decoderConfig: null,
    decoderPath: decodable ? 'native' : null,
    decodable,
    reason: decodable ? null : 'unsupported-codec',
    detail: decodable ? null : `The ${kind} track cannot decode.`,
    width: kind === 'video' ? 1920 : null,
    height: kind === 'video' ? 1080 : null,
    codedWidth: kind === 'video' ? 1920 : null,
    codedHeight: kind === 'video' ? 1080 : null,
    frameRate: kind === 'video' ? { num: 60, den: 1 } : null,
    sampleRate: kind === 'audio' ? 48_000 : null,
    channels: kind === 'audio' ? 2 : null,
    durationMicroseconds: 2_000_000,
    sourceBounds: EXACT_BOUNDS,
  }
}

function report(
  overrides: Partial<MediaCompatibilityReport> = {},
): MediaCompatibilityReport {
  return {
    status: 'ready',
    container: {
      name: 'MP4',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.64042a, mp4a.40.2"',
    },
    durationMicroseconds: 2_000_000,
    tracks: [track('video'), track('audio')],
    reason: null,
    detail: null,
    ...overrides,
  }
}

function inspection(
  asset = makeAsset(),
  compatibility = report(),
): MediaProbeResult {
  if (compatibility.status === 'ready') {
    return { status: 'ready', asset, compatibility }
  }
  if (compatibility.status === 'limited') {
    return { status: 'limited', asset, compatibility }
  }
  throw new Error('The inspection fixture requires a Ready or Limited report')
}

function file(
  name = 'saved.mp4',
  options: { type?: string; lastModified?: number } = {},
): File {
  return new File([new Uint8Array(8)], name, {
    type: options.type ?? 'video/mp4',
    lastModified: options.lastModified ?? 111,
  })
}

describe('project media matching', () => {
  test('requires every durable timed-media fact while ignoring runtime identity', () => {
    const asset = makeAsset()
    const descriptor = descriptorFrom(asset)

    expect(descriptorMatches(descriptor, asset)).toBe(true)
    expect(descriptorMatches(descriptor, {
      ...asset,
      id: 'different-runtime-id',
      fileName: 'different-name.mp4',
      mimeType: 'application/octet-stream',
      lastModified: 999,
      objectUrl: 'blob:different',
      decoderConfigB64: '{"codec":"different"}',
    })).toBe(true)

    const mismatches: MediaAsset[] = [
      { ...asset, size: 9 },
      { ...asset, durationMicroseconds: 2_000_001 },
      { ...asset, sourceBounds: { video: null, audio: EXACT_BOUNDS } },
      { ...asset, frameRate: { num: 30, den: 1 } },
      { ...asset, width: 1280 },
      { ...asset, height: 720 },
      { ...asset, hasAudio: false },
      { ...asset, audioSampleRate: 44_100 },
      { ...asset, audioChannels: 1 },
    ]
    for (const mismatch of mismatches) {
      expect(descriptorMatches(descriptor, mismatch)).toBe(false)
    }
  })

  test('keeps saved image duration authoritative across a fresh decode', () => {
    const image = makeAsset({
      kind: 'image',
      mimeType: 'image/png',
      durationMicroseconds: 5_000_000,
      durationFrames: 150,
      sourceBounds: { video: null, audio: null },
      frameRate: null,
      width: 320,
      height: 180,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
      decoderConfigB64: null,
    })
    const descriptor = descriptorFrom(image)

    expect(descriptorMatches(descriptor, {
      ...image,
      durationMicroseconds: 9_000_000,
      durationFrames: 270,
    })).toBe(true)
  })

  test('accepts ordinary sources only from Ready inspection results', () => {
    const asset = makeAsset()
    const descriptor = descriptorFrom(asset)
    const limited = report({
      status: 'limited',
      reason: 'unsupported-codec',
      detail: 'One track is unavailable.',
    })

    expect(inspectionCandidateForDescriptor(
      descriptor,
      inspection(asset, limited),
    )).toBeNull()
    expect(inspectionCandidateForDescriptor(
      descriptor,
      inspection(asset),
    )?.asset).toBe(asset)
  })

  test('reapplies a saved partial-track choice before matching', () => {
    const asset = makeAsset()
    const descriptor = descriptorFrom(asset, {
      partialTrackSelection: 'video-only',
      sourceBounds: { video: EXACT_BOUNDS, audio: null },
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    })
    const limited = report({
      status: 'limited',
      tracks: [track('video'), track('audio', false)],
      reason: 'unsupported-codec',
      detail: 'Audio is unavailable.',
    })

    const candidate = inspectionCandidateForDescriptor(
      descriptor,
      inspection(asset, limited),
    )

    expect(candidate?.asset).toMatchObject({
      partialTrackSelection: 'video-only',
      kind: 'video',
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
      sourceBounds: { video: EXACT_BOUNDS, audio: null },
    })
    expect(candidate?.compatibility).toMatchObject({
      status: 'ready',
      partialImport: { selection: 'video-only' },
    })
  })

  test('matches a settled non-Ready report without accepting it as connected', () => {
    const descriptor = descriptorFrom(makeAsset())
    const unsupported = report({
      status: 'unsupported',
      reason: 'unsupported-codec',
      detail: 'Video is unavailable.',
      tracks: [track('video', false), track('audio')],
    })

    expect(compatibilityReportMatchesDescriptor(
      descriptor,
      file(),
      unsupported,
    )).toBe(true)
    expect(compatibilityReportMatchesDescriptor(
      descriptor,
      file('saved.mp4', { type: 'video/mp4', lastModified: 111 }),
      { ...unsupported, durationMicroseconds: 3_000_000 },
    )).toBe(false)
  })

  test('selects only missing descriptors, then uses name and timestamp tie-breaks', () => {
    const asset = makeAsset()
    const first = descriptorFrom(asset, {
      id: 'first',
      fileName: 'other.mp4',
      lastModified: 222,
    })
    const byName = descriptorFrom(asset, {
      id: 'by-name',
      fileName: 'chosen.mp4',
      lastModified: 222,
    })
    const byTimestamp = descriptorFrom(asset, {
      id: 'by-timestamp',
      fileName: 'duplicate.mp4',
      lastModified: 333,
    })

    expect(selectDescriptor(
      [first, byName],
      new Set<string>(),
      file('chosen.mp4', { lastModified: 111 }),
      inspection(asset),
    ).descriptor.id).toBe('by-name')
    expect(selectDescriptor(
      [first, byTimestamp],
      new Set<string>(),
      file('unknown.mp4', { lastModified: 333 }),
      inspection(asset),
    ).descriptor.id).toBe('by-timestamp')
    expect(selectDescriptor(
      [first, byName],
      new Set(['by-name']),
      file('chosen.mp4'),
      inspection(asset),
    ).descriptor.id).toBe('first')
  })

  test('preserves exact no-match and ambiguity diagnostics', () => {
    const asset = makeAsset()
    const descriptor = descriptorFrom(asset)
    expect(() => selectDescriptor(
      [descriptor],
      new Set<string>(),
      file('wrong.mp4'),
      inspection({ ...asset, size: 9 }),
    )).toThrow('"wrong.mp4" does not match any missing project source')

    expect(() => selectDescriptor(
      [
        { ...descriptor, id: 'one', fileName: 'same.mp4' },
        { ...descriptor, id: 'two', fileName: 'same.mp4' },
      ],
      new Set<string>(),
      file('same.mp4'),
      inspection(asset),
    )).toThrow(
      '"same.mp4" matches more than one missing source; reconnect those files individually',
    )
  })

  test('uses MIME for exact file identity only when the browser declares one', () => {
    const descriptor = descriptorFrom(makeAsset())
    expect(selectDescriptorByFileIdentity(
      [descriptor],
      new Set<string>(),
      file('saved.mp4', { type: '' }),
    )).toBe(descriptor)
    expect(selectDescriptorByFileIdentity(
      [descriptor],
      new Set<string>(),
      file('saved.mp4', { type: 'video/quicktime' }),
    )).toBeNull()
    expect(selectDescriptorByFileIdentity(
      [descriptor],
      new Set(['saved']),
      file(),
    )).toBeNull()
  })

  test('uses the same tie-breaks for settled compatibility reports', () => {
    const asset = makeAsset()
    const first = descriptorFrom(asset, { id: 'one', fileName: 'one.mp4' })
    const selected = descriptorFrom(asset, {
      id: 'selected',
      fileName: 'selected.mp4',
    })
    expect(selectDescriptorByCompatibilityReport(
      [first, selected],
      new Set<string>(),
      file('selected.mp4'),
      report(),
    )).toBe(selected)
    expect(selectDescriptorByCompatibilityReport(
      [{ ...first, fileName: 'same.mp4' }, { ...selected, fileName: 'same.mp4' }],
      new Set<string>(),
      file('same.mp4'),
      report(),
    )).toBeNull()
  })

  test('narrows folder matches conservatively by name, timestamp, then MIME', () => {
    const asset = makeAsset()
    const descriptors = [
      descriptorFrom(asset, {
        id: 'name-only',
        fileName: 'chosen.mp4',
        lastModified: 222,
        mimeType: 'video/quicktime',
      }),
      descriptorFrom(asset, {
        id: 'timestamp',
        fileName: 'chosen.mp4',
        lastModified: 111,
        mimeType: 'video/quicktime',
      }),
      descriptorFrom(asset, {
        id: 'mime',
        fileName: 'chosen.mp4',
        lastModified: 111,
        mimeType: 'video/mp4',
      }),
      descriptorFrom(asset, {
        id: 'wrong-name',
        fileName: 'other.mp4',
        lastModified: 111,
        mimeType: 'video/mp4',
      }),
    ]

    expect([...narrowedFolderCandidateIds(
      descriptors,
      new Set<string>(),
      file('chosen.mp4'),
      inspection(asset),
    )]).toEqual(['mime'])
    expect([...narrowedFolderCandidateIds(
      descriptors,
      new Set(['mime']),
      file('chosen.mp4'),
      inspection(asset),
    )]).toEqual(['timestamp'])
  })

  test('rebuilds stable identity and duration while retaining runtime resources', () => {
    const analyzed = makeAsset({
      id: 'temporary',
      fileName: 'picked.mp4',
      durationFrames: 999,
      decoderConfigB64: '{"codec":"fresh"}',
    })
    const descriptor = descriptorFrom(analyzed, {
      id: 'stable',
      fileName: 'saved.mp4',
      lastModified: 444,
      durationMicroseconds: 2_000_000,
    })

    expect(relinkedAsset(
      descriptor,
      analyzed,
      { num: 30, den: 1 },
    )).toMatchObject({
      id: 'stable',
      fileName: 'saved.mp4',
      lastModified: 444,
      objectUrl: 'blob:analyzed',
      durationFrames: 60,
      durationMicroseconds: 2_000_000,
      decoderConfigB64: '{"codec":"fresh"}',
    })
  })
})
