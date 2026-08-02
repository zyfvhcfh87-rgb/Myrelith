import { describe, expect, test } from 'vitest'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_ASPECT_RATIO_ID,
  DEFAULT_PROJECT_RESOLUTION_TIER,
  DEFAULT_PROJECT_SETTINGS,
  formatProjectCanvas,
  isProjectFrameRatePreset,
  projectAspectRatioForDimensions,
  projectAspectRatioPresetById,
  projectResolutionPresetFor,
  PROJECT_ASPECT_RATIO_PRESETS,
  PROJECT_AUDIO_SAMPLE_RATE_PRESETS,
  PROJECT_FRAME_RATE_PRESETS,
  PROJECT_RESOLUTION_PRESETS,
  PROJECT_RESOLUTION_TIERS,
  validateProjectSettings,
} from './projectSettings'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'

function expectedEmptyTrack(id: string, kind: 'video' | 'audio') {
  return {
    id,
    kind,
    name: id,
    clips: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function expectedInitialTracks() {
  return [
    expectedEmptyTrack('V1', 'video'),
    expectedEmptyTrack('V2', 'video'),
    expectedEmptyTrack('V3', 'video'),
    expectedEmptyTrack('V4', 'video'),
    expectedEmptyTrack('A1', 'audio'),
    expectedEmptyTrack('A2', 'audio'),
    expectedEmptyTrack('A3', 'audio'),
    expectedEmptyTrack('A4', 'audio'),
  ]
}

describe('project setting presets', () => {
  test('expose the complete authoritative allow-lists in display order', () => {
    expect(PROJECT_ASPECT_RATIO_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      ratioLabel: preset.ratioLabel,
      resolutions: preset.resolutions,
    }))).toEqual([
      {
        id: 'horizontal-16-9',
        label: 'Horizontal',
        ratioLabel: '16:9',
        resolutions: [
          { tier: 720, width: 1280, height: 720 },
          { tier: 1080, width: 1920, height: 1080 },
          { tier: 1440, width: 2560, height: 1440 },
          { tier: 2160, width: 3840, height: 2160 },
        ],
      },
      {
        id: 'vertical-9-16',
        label: 'Vertical',
        ratioLabel: '9:16',
        resolutions: [
          { tier: 720, width: 720, height: 1280 },
          { tier: 1080, width: 1080, height: 1920 },
          { tier: 1440, width: 1440, height: 2560 },
          { tier: 2160, width: 2160, height: 3840 },
        ],
      },
      {
        id: 'square-1-1',
        label: 'Square',
        ratioLabel: '1:1',
        resolutions: [
          { tier: 720, width: 720, height: 720 },
          { tier: 1080, width: 1080, height: 1080 },
          { tier: 1440, width: 1440, height: 1440 },
          { tier: 2160, width: 2160, height: 2160 },
        ],
      },
      {
        id: 'social-4-5',
        label: 'Social portrait',
        ratioLabel: '4:5',
        resolutions: [
          { tier: 720, width: 720, height: 900 },
          { tier: 1080, width: 1080, height: 1350 },
          { tier: 1440, width: 1440, height: 1800 },
          { tier: 2160, width: 2160, height: 2700 },
        ],
      },
    ])
    expect(PROJECT_RESOLUTION_TIERS).toEqual([720, 1080, 1440, 2160])
    expect(PROJECT_RESOLUTION_PRESETS).toEqual([
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 3840, height: 2160 },
      { width: 720, height: 1280 },
      { width: 1080, height: 1920 },
      { width: 1440, height: 2560 },
      { width: 2160, height: 3840 },
      { width: 720, height: 720 },
      { width: 1080, height: 1080 },
      { width: 1440, height: 1440 },
      { width: 2160, height: 2160 },
      { width: 720, height: 900 },
      { width: 1080, height: 1350 },
      { width: 1440, height: 1800 },
      { width: 2160, height: 2700 },
    ])
    expect(PROJECT_FRAME_RATE_PRESETS).toEqual([
      { num: 24_000, den: 1_001 },
      { num: 24, den: 1 },
      { num: 25, den: 1 },
      { num: 30_000, den: 1_001 },
      { num: 30, den: 1 },
      { num: 50, den: 1 },
      { num: 60_000, den: 1_001 },
      { num: 60, den: 1 },
    ])
    expect(PROJECT_AUDIO_SAMPLE_RATE_PRESETS).toEqual([44_100, 48_000, 96_000])
    expect(DEFAULT_PROJECT_SETTINGS).toEqual({
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      audioSampleRate: 48_000,
    })
    expect(DEFAULT_PROJECT_ASPECT_RATIO_ID).toBe('horizontal-16-9')
    expect(DEFAULT_PROJECT_RESOLUTION_TIER).toBe(1080)
  })

  test('preset collections and nested values are immutable', () => {
    expect(Object.isFrozen(PROJECT_ASPECT_RATIO_PRESETS)).toBe(true)
    expect(PROJECT_ASPECT_RATIO_PRESETS.every((preset) => (
      Object.isFrozen(preset)
      && Object.isFrozen(preset.resolutions)
      && preset.resolutions.every(Object.isFrozen)
    ))).toBe(true)
    expect(Object.isFrozen(PROJECT_RESOLUTION_TIERS)).toBe(true)
    expect(Object.isFrozen(PROJECT_RESOLUTION_PRESETS)).toBe(true)
    expect(PROJECT_RESOLUTION_PRESETS.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(PROJECT_FRAME_RATE_PRESETS)).toBe(true)
    expect(PROJECT_FRAME_RATE_PRESETS.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(PROJECT_AUDIO_SAMPLE_RATE_PRESETS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_PROJECT_SETTINGS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_PROJECT_SETTINGS.frameRate)).toBe(true)
  })

  test('catalog ids, dimensions, tiers, ratios, and allocation bounds are exact', () => {
    const ids = new Set<string>()
    const dimensions = new Set<string>()
    const maximumPixels = 3840 * 2160

    for (const aspectRatio of PROJECT_ASPECT_RATIO_PRESETS) {
      expect(ids.has(aspectRatio.id)).toBe(false)
      ids.add(aspectRatio.id)
      expect(aspectRatio.resolutions.map(({ tier }) => tier))
        .toEqual(PROJECT_RESOLUTION_TIERS)

      for (const resolution of aspectRatio.resolutions) {
        const key = `${resolution.width}x${resolution.height}`
        expect(dimensions.has(key)).toBe(false)
        dimensions.add(key)
        expect(Number.isSafeInteger(resolution.width)).toBe(true)
        expect(Number.isSafeInteger(resolution.height)).toBe(true)
        expect(resolution.width % 2).toBe(0)
        expect(resolution.height % 2).toBe(0)
        expect(resolution.width * aspectRatio.ratioHeight)
          .toBe(resolution.height * aspectRatio.ratioWidth)
        expect(resolution.width * resolution.height).toBeLessThanOrEqual(
          maximumPixels,
        )
      }
    }

    expect(dimensions.size).toBe(16)
    expect(projectResolutionPresetFor(
      DEFAULT_PROJECT_ASPECT_RATIO_ID,
      DEFAULT_PROJECT_RESOLUTION_TIER,
    )).toMatchObject({
      width: DEFAULT_PROJECT_SETTINGS.width,
      height: DEFAULT_PROJECT_SETTINGS.height,
    })
  })

  test('looks up exact presets and derives labels without duplicate state', () => {
    expect(projectAspectRatioPresetById('vertical-9-16')).toMatchObject({
      label: 'Vertical',
      ratioLabel: '9:16',
    })
    expect(projectAspectRatioPresetById('unknown')).toBeNull()
    expect(projectResolutionPresetFor('social-4-5', 1440)).toEqual({
      tier: 1440,
      width: 1440,
      height: 1800,
    })
    expect(projectResolutionPresetFor('social-4-5', 480)).toBeNull()
    expect(projectResolutionPresetFor('unknown', 1080)).toBeNull()

    expect(projectAspectRatioForDimensions(1080, 1920)?.id)
      .toBe('vertical-9-16')
    expect(projectAspectRatioForDimensions(1600, 900)?.id)
      .toBe('horizontal-16-9')
    expect(projectAspectRatioForDimensions(1200, 1200)?.id)
      .toBe('square-1-1')
    expect(projectAspectRatioForDimensions(800, 1000)?.id)
      .toBe('social-4-5')
    expect(projectAspectRatioForDimensions(1000, 800)).toBeNull()
    expect(projectAspectRatioForDimensions(Number.MAX_SAFE_INTEGER, 1))
      .toBeNull()
    expect(projectAspectRatioForDimensions(0, 0)).toBeNull()
    expect(formatProjectCanvas(1080, 1920))
      .toBe('Vertical 9:16 · 1080 × 1920')
    expect(formatProjectCanvas(1000, 800)).toBe('Custom · 1000 × 800')
  })

  test('recognizes only exact canonical frame-rate presets', () => {
    expect(isProjectFrameRatePreset({ num: 60, den: 1 })).toBe(true)
    expect(isProjectFrameRatePreset({ num: 60_000, den: 1_001 })).toBe(true)
    expect(isProjectFrameRatePreset({ num: 120, den: 1 })).toBe(false)
    expect(isProjectFrameRatePreset({ num: 120, den: 2 })).toBe(false)
  })
})

describe('validateProjectSettings', () => {
  test('accepts every supported combination and returns detached immutable data', () => {
    for (const resolution of PROJECT_RESOLUTION_PRESETS) {
      for (const frameRate of PROJECT_FRAME_RATE_PRESETS) {
        for (const audioSampleRate of PROJECT_AUDIO_SAMPLE_RATE_PRESETS) {
          const input = {
            ...resolution,
            frameRate: { ...frameRate },
            audioSampleRate,
          }
          const validated = validateProjectSettings(input)
          expect(validated).toEqual(input)
          expect(validated).not.toBe(input)
          expect(validated.frameRate).not.toBe(input.frameRate)
          expect(Object.isFrozen(validated)).toBe(true)
          expect(Object.isFrozen(validated.frameRate)).toBe(true)
        }
      }
    }
  })

  test.each([
    null,
    [],
    {},
    { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } },
    {
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      audioSampleRate: 48_000,
      extra: true,
    },
  ])('rejects malformed or non-exact settings: %o', (value) => {
    expect(() => validateProjectSettings(value)).toThrow(TypeError)
  })

  test.each([
    { width: 900, height: 720, frameRate: { num: 30, den: 1 }, audioSampleRate: 48_000 },
    { width: 721, height: 1280, frameRate: { num: 30, den: 1 }, audioSampleRate: 48_000 },
    { width: 4320, height: 7680, frameRate: { num: 30, den: 1 }, audioSampleRate: 48_000 },
    { width: 1920.5, height: 1080, frameRate: { num: 30, den: 1 }, audioSampleRate: 48_000 },
    { width: 1920, height: 1080, frameRate: { num: 48_000, den: 2_002 }, audioSampleRate: 48_000 },
    { width: 1920, height: 1080, frameRate: { num: 29.97, den: 1 }, audioSampleRate: 48_000 },
    { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, audioSampleRate: 32_000 },
  ])('rejects unsupported project settings: %o', (value) => {
    expect(() => validateProjectSettings(value)).toThrow()
  })
})

describe('createTimelineDoc', () => {
  test('creates a fresh empty document with exact settings and an injected id', () => {
    const settings = {
      width: 2160,
      height: 3840,
      frameRate: { num: 60_000, den: 1_001 },
      audioSampleRate: 96_000,
    }
    const doc = createTimelineDoc('  Demo project  ', settings, 'project-123')

    expect(doc).toEqual({
      schemaVersion: 4,
      id: 'project-123',
      name: 'Demo project',
      frameRate: { num: 60_000, den: 1_001 },
      width: 2160,
      height: 3840,
      audioSampleRate: 96_000,
      tracks: expectedInitialTracks(),
    })
    expect(Object.isFrozen(doc)).toBe(true)
    expect(Object.isFrozen(doc.frameRate)).toBe(true)
    expect(Object.isFrozen(doc.tracks)).toBe(true)
    expect(doc.tracks.every(Object.isFrozen)).toBe(true)
    expect(doc.tracks.every((track) => (
      Object.isFrozen(track.clips) && Object.isFrozen(track.transitions)
    ))).toBe(true)
  })

  test('never shares mutable document structures between calls or settings', () => {
    const settings = {
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      audioSampleRate: 48_000,
    }
    const first = createTimelineDoc('First', settings, 'first')
    const second = createTimelineDoc('Second', settings, 'second')

    expect(first).not.toBe(second)
    expect(first.frameRate).not.toBe(second.frameRate)
    expect(first.frameRate).not.toBe(settings.frameRate)
    expect(first.tracks).not.toBe(second.tracks)
    expect(first.tracks).toHaveLength(8)
    expect(new Set(first.tracks.map((track) => track.id)).size).toBe(8)
    for (let index = 0; index < first.tracks.length; index++) {
      expect(first.tracks[index]).not.toBe(second.tracks[index])
      expect(first.tracks[index].clips).not.toBe(second.tracks[index].clips)
      expect(first.tracks[index].transitions)
        .not.toBe(second.tracks[index].transitions)
      expect(first.tracks[index].clips)
        .not.toBe(first.tracks[index].transitions)
    }
    expect(new Set(first.tracks.map((track) => track.clips)).size).toBe(8)
    expect(new Set(first.tracks.map((track) => track.transitions)).size).toBe(8)

    settings.frameRate.num = 60
    expect(first.frameRate).toEqual({ num: 30, den: 1 })
    expect(second.frameRate).toEqual({ num: 30, den: 1 })
  })

  test('keeps the default document deterministic at the current schema', () => {
    const doc = createTimelineDoc(
      'Untitled',
      DEFAULT_PROJECT_SETTINGS,
      'doc_default',
    )

    expect(JSON.stringify(doc)).toBe(JSON.stringify({
      schemaVersion: 4,
      id: 'doc_default',
      name: 'Untitled',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      tracks: expectedInitialTracks(),
    }))
  })

  test.each([
    ['', 'valid-id'],
    ['   ', 'valid-id'],
    ['Project', ''],
    ['Project', '   '],
  ])('rejects empty names or ids', (name, id) => {
    expect(() => createTimelineDoc(name, DEFAULT_PROJECT_SETTINGS, id)).toThrow(RangeError)
  })

  test('shares the portable name and id bounds at project creation', () => {
    const boundary = createTimelineDoc(
      'n'.repeat(MAX_PROJECT_NAME_CHARACTERS),
      DEFAULT_PROJECT_SETTINGS,
      'i'.repeat(MAX_DOCUMENT_ID_CHARACTERS),
    )
    expect(boundary.name).toHaveLength(MAX_PROJECT_NAME_CHARACTERS)
    expect(boundary.id).toHaveLength(MAX_DOCUMENT_ID_CHARACTERS)

    expect(() => createTimelineDoc(
      'n'.repeat(MAX_PROJECT_NAME_CHARACTERS + 1),
      DEFAULT_PROJECT_SETTINGS,
      'valid-id',
    )).toThrow(/must not exceed/)
    expect(() => createTimelineDoc(
      'Project',
      DEFAULT_PROJECT_SETTINGS,
      'i'.repeat(MAX_DOCUMENT_ID_CHARACTERS + 1),
    )).toThrow(/must not exceed/)
  })
})
