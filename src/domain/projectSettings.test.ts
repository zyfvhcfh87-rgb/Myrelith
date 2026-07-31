import { describe, expect, test } from 'vitest'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
  isProjectFrameRatePreset,
  PROJECT_AUDIO_SAMPLE_RATE_PRESETS,
  PROJECT_FRAME_RATE_PRESETS,
  PROJECT_RESOLUTION_PRESETS,
  validateProjectSettings,
} from './projectSettings'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'

describe('project setting presets', () => {
  test('expose the complete authoritative allow-lists in display order', () => {
    expect(PROJECT_RESOLUTION_PRESETS).toEqual([
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 3840, height: 2160 },
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
  })

  test('preset collections and nested values are immutable', () => {
    expect(Object.isFrozen(PROJECT_RESOLUTION_PRESETS)).toBe(true)
    expect(PROJECT_RESOLUTION_PRESETS.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(PROJECT_FRAME_RATE_PRESETS)).toBe(true)
    expect(PROJECT_FRAME_RATE_PRESETS.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(PROJECT_AUDIO_SAMPLE_RATE_PRESETS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_PROJECT_SETTINGS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_PROJECT_SETTINGS.frameRate)).toBe(true)
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
    { width: 720, height: 1280, frameRate: { num: 30, den: 1 }, audioSampleRate: 48_000 },
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
      width: 3840,
      height: 2160,
      frameRate: { num: 60_000, den: 1_001 },
      audioSampleRate: 96_000,
    }
    const doc = createTimelineDoc('  Demo project  ', settings, 'project-123')

    expect(doc).toEqual({
      schemaVersion: 3,
      id: 'project-123',
      name: 'Demo project',
      frameRate: { num: 60_000, den: 1_001 },
      width: 3840,
      height: 2160,
      audioSampleRate: 96_000,
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          name: 'V1',
          clips: [],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
        {
          id: 'A1',
          kind: 'audio',
          name: 'A1',
          clips: [],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
      ],
    })
    expect(Object.isFrozen(doc)).toBe(true)
    expect(Object.isFrozen(doc.frameRate)).toBe(true)
    expect(Object.isFrozen(doc.tracks)).toBe(true)
    expect(doc.tracks.every(Object.isFrozen)).toBe(true)
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
    expect(first.tracks[0]).not.toBe(second.tracks[0])
    expect(first.tracks[0].clips).not.toBe(second.tracks[0].clips)

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
      schemaVersion: 3,
      id: 'doc_default',
      name: 'Untitled',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          name: 'V1',
          clips: [],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
        {
          id: 'A1',
          kind: 'audio',
          name: 'A1',
          clips: [],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
      ],
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
