import { describe, expect, test } from 'vitest'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
} from '../domain/projectSettings'
import type {
  Clip,
  FrameRate,
  MediaAsset,
  TimelineDoc,
} from '../domain/schema'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import {
  createMediaImportPrompt,
  requiresMediaImportRateDecision,
  resolveMediaImportCommitRate,
  resolvePartialTrackImportDecision,
  validateMediaImportCommitDocument,
} from './mediaImportDecisions'

const F24: FrameRate = { num: 24, den: 1 }
const F30: FrameRate = { num: 30, den: 1 }
const F48: FrameRate = { num: 48, den: 1 }
const F60: FrameRate = { num: 60, den: 1 }

function makeDocument(): TimelineDoc {
  return createTimelineDoc(
    'Import decisions',
    DEFAULT_PROJECT_SETTINGS,
    'doc-import-decisions',
  )
}

function withAdjustment(document: TimelineDoc): TimelineDoc {
  return {
    ...document,
    tracks: document.tracks.map((track, index) => index === 0
      ? {
          ...track,
          adjustments: [{
            kind: 'adjustment' as const,
            id: 'adjustment-1',
            name: 'Grade',
            timelineRange: { startFrame: 0, durationFrames: 10 },
            enabled: true,
            opacity: 1,
            animation: { tracks: [], effectTracks: [] },
            effects: [],
          }],
        }
      : track),
  }
}

function withTimelineClip(document: TimelineDoc): TimelineDoc {
  const clip: Clip = {
    id: 'clip-1',
    assetId: 'asset-existing',
    name: 'Edited clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 0, durationFrames: 30 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
  return {
    ...document,
    tracks: document.tracks.map((track, index) => index === 0
      ? { ...track, clips: [clip] }
      : track),
  }
}

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-import',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 8,
    lastModified: 123,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 2_000_000,
    sourceBounds: {
      video: {
        status: 'exact',
        firstTimestampUs: 0,
        endTimestampUs: 2_000_000,
      },
      audio: {
        status: 'exact',
        firstTimestampUs: 0,
        endTimestampUs: 2_000_000,
      },
    },
    frameRate: F60,
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"avc1.64042a"}',
    ...overrides,
  }
}

function makeTrack(
  kind: MediaTrackCompatibility['kind'],
  decodable: boolean,
): MediaTrackCompatibility {
  return {
    kind,
    number: 1,
    primary: true,
    codec: kind === 'video' ? 'avc' : 'aac',
    codecParameter: kind === 'video' ? 'avc1.64042a' : 'mp4a.40.2',
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
    frameRate: kind === 'video' ? F60 : null,
    sampleRate: kind === 'audio' ? 48_000 : null,
    channels: kind === 'audio' ? 2 : null,
    durationMicroseconds: 2_000_000,
  }
}

function makeReport(
  status: MediaCompatibilityReport['status'],
  tracks: MediaTrackCompatibility[],
): MediaCompatibilityReport {
  return {
    status,
    container: {
      name: 'MPEG-4 Part 14',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.64042a, mp4a.40.2"',
    },
    durationMicroseconds: 2_000_000,
    tracks,
    reason: status === 'ready' ? null : 'unsupported-codec',
    detail: status === 'ready' ? null : 'One source track is unavailable.',
  }
}

function makeProbe(
  status: MediaProbeResult['status'],
  asset: MediaAsset | null,
  report: MediaCompatibilityReport,
): MediaProbeResult {
  if (status === 'ready') {
    if (!asset) throw new Error('Ready probe fixtures require an asset')
    return { status, asset, compatibility: report }
  }
  if (status === 'limited') {
    return { status, asset, compatibility: report }
  }
  return { status, asset: null, compatibility: report }
}

function makeCompatibilityItem(
  report: MediaCompatibilityReport,
): MediaCompatibilityItem {
  return {
    id: 'asset-import',
    requestId: 'request-old',
    fileName: 'source.mp4',
    declaredMimeType: 'video/mp4',
    size: 8,
    lastModified: 123,
    status: report.status,
    report,
  }
}

describe('media import frame-rate decisions', () => {
  test.each([
    { sourceRate: null, expected: false },
    { sourceRate: F30, expected: false },
    { sourceRate: { num: 60, den: 2 }, expected: false },
    { sourceRate: F60, expected: true },
  ])('classifies whether $sourceRate needs a user decision', ({
    sourceRate,
    expected,
  }) => {
    expect(requiresMediaImportRateDecision(F30, sourceRate)).toBe(expected)
  })

  test('creates a detached prompt for an allowed empty-project match', () => {
    const document = makeDocument()
    const prompt = createMediaImportPrompt('source.mp4', document, F60)

    expect(prompt).toEqual({
      fileName: 'source.mp4',
      projectRate: F30,
      sourceRate: F60,
      canMatchSource: true,
      matchUnavailableReason: null,
    })
    expect(prompt.projectRate).not.toBe(document.frameRate)
    expect(prompt.sourceRate).not.toBe(F60)
  })

  test.each([
    {
      name: 'unsupported source rate',
      document: makeDocument(),
      sourceRate: F48,
      reason: 'This source rate is not one of the supported project presets.',
    },
    {
      name: 'edited timeline',
      document: withTimelineClip(makeDocument()),
      sourceRate: F60,
      reason: 'Matching is unavailable after timed content has been added to any sequence.',
    },
    {
      name: 'adjustment-only timeline',
      document: withAdjustment(makeDocument()),
      sourceRate: F60,
      reason: 'Matching is unavailable after timed content has been added to any sequence.',
    },
  ])('keeps Match visible but unavailable for $name', ({
    document,
    sourceRate,
    reason,
  }) => {
    expect(createMediaImportPrompt('source.mp4', document, sourceRate)).toMatchObject({
      canMatchSource: false,
      matchUnavailableReason: reason,
    })
  })

  test('disables matching when a dormant sequence contains timed content', () => {
    const active = makeDocument()
    const dormant = withTimelineClip({ ...makeDocument(), id: 'dormant' })
    expect(createMediaImportPrompt(
      'source.mp4',
      active,
      F60,
      [active, dormant],
    )).toMatchObject({
      canMatchSource: false,
      matchUnavailableReason:
        'Matching is unavailable after timed content has been added to any sequence.',
    })
  })

  test.each([
    {
      name: 'same project and rate',
      document: makeDocument(),
      expectedDocumentId: 'doc-import-decisions',
      expectedRate: F30,
      expected: 'current',
    },
    {
      name: 'equivalent rational rate',
      document: makeDocument(),
      expectedDocumentId: 'doc-import-decisions',
      expectedRate: { num: 60, den: 2 },
      expected: 'current',
    },
    {
      name: 'replacement project',
      document: { ...makeDocument(), id: 'doc-replacement' },
      expectedDocumentId: 'doc-import-decisions',
      expectedRate: F30,
      expected: 'stale-project-settings',
    },
    {
      name: 'sequence switch in the same project',
      document: { ...makeDocument(), id: 'seq-alt' },
      expectedDocumentId: 'project-import',
      expectedRate: F30,
      currentProjectId: 'project-import',
      expected: 'current',
    },
    {
      name: 'changed project rate',
      document: { ...makeDocument(), frameRate: F24 },
      expectedDocumentId: 'doc-import-decisions',
      expectedRate: F30,
      expected: 'stale-project-settings',
    },
  ])('classifies the commit document for $name', ({
    document,
    expectedDocumentId,
    expectedRate,
    currentProjectId,
    expected,
  }) => {
    expect(validateMediaImportCommitDocument(
      document,
      expectedDocumentId,
      expectedRate,
      currentProjectId,
    ).kind).toBe(expected)
  })

  test('keeps the current project rate without requiring a video rate', () => {
    const document = makeDocument()
    expect(resolveMediaImportCommitRate(
      'audio.m4a',
      document,
      null,
      'keep-project-rate',
    )).toEqual({ kind: 'accepted', finalRate: document.frameRate })
  })

  test.each([
    {
      name: 'available source preset',
      document: makeDocument(),
      sourceRate: F60,
      expected: { kind: 'accepted', finalRate: F60 },
    },
    {
      name: 'missing video rate',
      document: makeDocument(),
      sourceRate: null,
      expected: {
        kind: 'rejected',
        reason: 'missing-source-rate',
        message: 'this source has no video frame rate to match',
      },
    },
    {
      name: 'unsupported source preset',
      document: makeDocument(),
      sourceRate: F48,
      expected: {
        kind: 'rejected',
        reason: 'source-rate-unavailable',
        message: 'This source rate is not one of the supported project presets.',
      },
    },
    {
      name: 'edited timeline',
      document: withTimelineClip(makeDocument()),
      sourceRate: F60,
      expected: {
        kind: 'rejected',
        reason: 'source-rate-unavailable',
        message: 'Matching is unavailable after timed content has been added to any sequence.',
      },
    },
    {
      name: 'adjustment-only timeline',
      document: withAdjustment(makeDocument()),
      sourceRate: F60,
      expected: {
        kind: 'rejected',
        reason: 'source-rate-unavailable',
        message: 'Matching is unavailable after timed content has been added to any sequence.',
      },
    },
  ])('revalidates Match for an $name', ({ document, sourceRate, expected }) => {
    expect(resolveMediaImportCommitRate(
      'source.mp4',
      document,
      sourceRate,
      'match-source-rate',
    )).toEqual(expected)
  })
})

describe('partial-track import decisions', () => {
  const asset = makeAsset()
  const limitedReport = makeReport('limited', [
    makeTrack('video', true),
    makeTrack('audio', false),
  ])
  const fallback = makeCompatibilityItem(limitedReport)

  test('does nothing when no partial choice was requested', () => {
    const inspection = makeProbe('limited', asset, limitedReport)
    expect(resolvePartialTrackImportDecision(
      inspection,
      undefined,
      null,
    )).toEqual({ kind: 'not-requested' })
  })

  test('accepts the selected safe track from a fresh Limited probe', () => {
    const decision = resolvePartialTrackImportDecision(
      makeProbe('limited', asset, limitedReport),
      'video-only',
      fallback,
    )

    expect(decision.kind).toBe('accepted')
    if (decision.kind !== 'accepted') return
    expect(decision.asset).toMatchObject({
      kind: 'video',
      partialTrackSelection: 'video-only',
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    })
    expect(decision.compatibility).toMatchObject({
      status: 'ready',
      partialImport: { selection: 'video-only' },
    })
  })

  test('reapplies the saved choice even when both tracks are now Ready', () => {
    const readyReport = makeReport('ready', [
      makeTrack('video', true),
      makeTrack('audio', true),
    ])
    const decision = resolvePartialTrackImportDecision(
      makeProbe('ready', asset, readyReport),
      'video-only',
      fallback,
    )

    expect(decision.kind).toBe('accepted')
    if (decision.kind !== 'accepted') return
    expect(decision.asset.partialTrackSelection).toBe('video-only')
    expect(decision.asset.hasAudio).toBe(false)
  })

  test('restores the prior Limited row when a choice disappears from Ready', () => {
    const changedReport = makeReport('ready', [makeTrack('audio', true)])
    const decision = resolvePartialTrackImportDecision(
      makeProbe('ready', asset, changedReport),
      'video-only',
      fallback,
    )

    expect(decision).toEqual({
      kind: 'unavailable',
      fallbackStatus: 'limited',
      fallbackReport: limitedReport,
      message: 'The confirmed video-only choice is no longer available after rechecking the file. Review the updated compatibility details.',
    })
  })

  test('publishes the fresh non-Ready result instead of a stale fallback', () => {
    const unsupportedReport = makeReport('unsupported', [
      makeTrack('video', false),
      makeTrack('audio', false),
    ])
    const decision = resolvePartialTrackImportDecision(
      makeProbe('unsupported', null, unsupportedReport),
      'video-only',
      fallback,
    )

    expect(decision).toMatchObject({
      kind: 'unavailable',
      fallbackStatus: 'unsupported',
      fallbackReport: unsupportedReport,
    })
  })
})
