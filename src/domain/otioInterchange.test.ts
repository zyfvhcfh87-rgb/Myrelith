import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  framesFromOtioRational,
  isOtioIncompleteMediaIdentity,
  otioRelinkBaseName,
  OtioInterchangeError,
  planOtioImport,
  serializeOtioExport,
  type OtioIdFactory,
  type OtioIdKind,
} from './otioInterchange'
import { createTimelineDoc, type ProjectSettings } from './projectSettings'
import { sequenceProjectFromTimeline } from './projectSequences'
import { microsecondsDurationToFrames } from './time'
import type { Clip, FrameRate } from './schema'
import type { PortableAssetDescriptor } from './projectFile/projectTypes'
import { createProjectFileSnapshot } from './projectFile'
import { defaultClipAnimation } from './clipAnimation'
import { defaultClipAudioSettings, defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { DEFAULT_BLEND_MODE } from './blendModes'
import { defaultSourceTimeMap } from './sourceTimeMap'

const SETTINGS_24: ProjectSettings = {
  width: 1920,
  height: 1080,
  frameRate: { num: 24, den: 1 },
  audioSampleRate: 48_000,
}

const SETTINGS_30: ProjectSettings = {
  ...SETTINGS_24,
  frameRate: { num: 30, den: 1 },
}

const SETTINGS_NTSC: ProjectSettings = {
  ...SETTINGS_24,
  frameRate: { num: 30_000, den: 1_001 },
}

function fixture(name: string): string {
  return readFileSync(resolve('tests/fixtures/otio', name), 'utf8')
}

function ids(): OtioIdFactory {
  const counts = new Map<OtioIdKind, number>()
  return (kind) => {
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    return `${kind}-${next}`
  }
}

function videoClips(plan: ReturnType<typeof planOtioImport>) {
  return plan.sequences[0]?.tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips) ?? []
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OTIO timing', () => {
  test('round-trips integer frames at 24, 30, and NTSC without drift', () => {
    const rates: FrameRate[] = [
      { num: 24, den: 1 },
      { num: 30, den: 1 },
      { num: 30_000, den: 1_001 },
    ]
    for (const rate of rates) {
      for (const frames of [0, 1, 24, 100, 30_000]) {
        const value = frames
        const otioRate = rate.num / rate.den
        expect(framesFromOtioRational(value, otioRate, rate)).toBe(frames)
      }
    }
  })

  test('converts exact 24-frame counts into 30 fps by integer rescale', () => {
    expect(framesFromOtioRational(3, 24, SETTINGS_30.frameRate)).toBe(4)
    expect(framesFromOtioRational(6, 24, SETTINGS_30.frameRate)).toBe(8)
  })
})

describe('OTIO import guards', () => {
  test('rejects malformed, oversized, adapter, and empty documents before any mapping', () => {
    expect(() => planOtioImport('{', SETTINGS_24, ids())).toThrow(OtioInterchangeError)
    expect(() => planOtioImport('{', SETTINGS_24, ids())).toThrow(/not valid JSON/u)
    expect(() => planOtioImport('{"OTIO_SCHEMA":"Adapter.1"}', SETTINGS_24, ids())).toThrow(/adapters or scripts/u)
    expect(() => planOtioImport('{"OTIO_SCHEMA":"Clip.1"}', SETTINGS_24, ids())).toThrow(/not a Timeline/u)
    expect(() => planOtioImport(
      '{"OTIO_SCHEMA":"SerializableCollection.1","children":[]}',
      SETTINGS_24,
      ids(),
    )).toThrow(/no Timeline/u)
    expect(() => planOtioImport('x'.repeat(8_000_001), SETTINGS_24, ids())).toThrow(/exceeds/u)
    let nested: unknown = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'deep',
      tracks: { OTIO_SCHEMA: 'Stack.1', children: [] },
    }
    for (let depth = 0; depth < 20; depth += 1) nested = { wrap: nested }
    expect(() => planOtioImport(JSON.stringify(nested), SETTINGS_24, ids())).toThrow(/nests compositions/u)
  })

  test('rejects executable media URLs without fetching them', () => {
    const payload = JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      name: 'bad',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [{
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          children: [{
            OTIO_SCHEMA: 'Clip.1',
            name: 'boom',
            source_range: {
              OTIO_SCHEMA: 'TimeRange.1',
              start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 },
              duration: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 10 },
            },
            media_reference: {
              OTIO_SCHEMA: 'ExternalReference.1',
              target_url: 'javascript:alert(1)',
            },
          }],
        }],
      },
    })
    expect(() => planOtioImport(payload, SETTINGS_24, ids())).toThrow(/executable media URL/u)
  })
})

describe('official OTIO fixtures', () => {
  test('imports simple_cut without frame drift at 24 fps', () => {
    const plan = planOtioImport(fixture('simple_cut.otio'), SETTINGS_24, ids())
    const clips = videoClips(plan)
    expect(clips.map((clip) => [
      clip.name,
      clip.timelineRange.startFrame,
      clip.timelineRange.durationFrames,
      clip.sourceRange.startFrame,
    ])).toEqual([
      ['Clip-001', 0, 3, 3],
      ['Clip-002', 3, 6, 2],
      ['Clip-003', 9, 4, 0],
      ['Clip-004', 13, 6, 100],
    ])
    expect(plan.descriptors).toHaveLength(4)
    expect(plan.descriptors.every(isOtioIncompleteMediaIdentity)).toBe(true)
    expect(plan.descriptors.map((descriptor) => descriptor.fileName)).toEqual([
      'titles.mov',
      'wind-up.mov',
      'punchline.mov',
      'credits.mov',
    ])
  })

  test('imported source ranges stay within offline asset duration after 30 fps conform', () => {
    const plan = planOtioImport(fixture('simple_cut.otio'), SETTINGS_30, ids())
    const document = plan.sequences[0]!
    expect(() => createProjectFileSnapshot(
      {
        id: 'project',
        name: 'Imported',
        rootSequenceId: document.id,
        sequences: [document],
      },
      plan.descriptors,
    )).not.toThrow()
    const windUp = plan.descriptors.find((descriptor) => descriptor.fileName === 'wind-up.mov')
    const clip = videoClips(plan).find((item) => item.name === 'Clip-002')
    expect(windUp).toBeDefined()
    expect(clip).toBeDefined()
    expect(clip!.sourceRange.startFrame + clip!.sourceRange.durationFrames)
      .toBeLessThanOrEqual(microsecondsDurationToFrames(windUp!.durationMicroseconds, SETTINGS_30.frameRate))
  })

  test('imports transition.otio dissolve onto touching video clips', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plan = planOtioImport(fixture('transition.otio'), SETTINGS_24, ids())
    const track = plan.sequences[0]?.tracks.find((candidate) => candidate.kind === 'video')
    expect(track?.clips).toHaveLength(4)
    expect(track?.transitions).toHaveLength(1)
    expect(track?.transitions[0]).toMatchObject({
      type: 'crossfade',
      durationFrames: 5,
    })
    const from = track?.clips.find((clip) => clip.id === track.transitions[0]?.fromClipId)
    const to = track?.clips.find((clip) => clip.id === track.transitions[0]?.toClipId)
    expect(from?.name).toBe('Clip-002')
    expect(to?.name).toBe('Clip-003')
    expect(from && to && from.timelineRange.startFrame + from.timelineRange.durationFrames).toBe(to?.timelineRange.startFrame)
  })

  test('records nested compositions, generators, and clip-to-gap dissolves as losses', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const nested = planOtioImport(fixture('nested_example.otio'), SETTINGS_24, ids())
    expect(nested.preview.losses.some((loss) => loss.code === 'nested')).toBe(true)
    const generated = planOtioImport(fixture('generator_reference_test.otio'), SETTINGS_24, ids())
    expect(generated.preview.losses.some((loss) => loss.detail.includes('GeneratorReference'))).toBe(true)
    expect(videoClips(generated)).toHaveLength(0)
    const clipExample = planOtioImport(fixture('clip_example.otio'), SETTINGS_24, ids())
    expect(clipExample.preview.losses.some((loss) => loss.code === 'transition')).toBe(true)
    expect(clipExample.sequences[0]?.tracks[0]?.transitions).toEqual([])
  })

  test('imports the Kdenlive-style marker, audio gap, and dissolve fixture', () => {
    const plan = planOtioImport(fixture('kdenlive_style.otio'), SETTINGS_30, ids())
    expect(plan.sequences[0]?.name).toBe('Kdenlive-style cut')
    const video = plan.sequences[0]?.tracks.find((track) => track.kind === 'video')
    const audio = plan.sequences[0]?.tracks.find((track) => track.kind === 'audio')
    expect(video?.clips).toHaveLength(2)
    expect(video?.transitions).toHaveLength(1)
    expect(video?.transitions[0]?.durationFrames).toBe(10)
    expect(audio?.clips[0]?.timelineRange.startFrame).toBe(10)
    expect(audio?.clips[0]?.timelineRange.durationFrames).toBe(40)
    expect(plan.sequences[0]?.markers?.[0]).toMatchObject({
      frame: 10,
      label: 'Hold',
      color: 'red',
      note: 'Review this cut',
    })
    expect(plan.preview.losses.some((loss) => loss.code === 'metadata')).toBe(true)
    expect(otioRelinkBaseName('file:///home/editor/interview.mp4')).toBe('interview.mp4')
  })
})

describe('OTIO export round-trip', () => {
  test('exports a 24 fps cut list and imports it back with the same integer ranges', () => {
    const source = planOtioImport(fixture('simple_cut.otio'), SETTINGS_24, ids())
    const project = {
      id: 'project',
      name: 'Simple cut',
      rootSequenceId: source.sequences[0]!.id,
      sequences: [...source.sequences],
    }
    const exported = serializeOtioExport(project, source.descriptors)
    expect(exported.fileName.endsWith('.otio')).toBe(true)
    expect(exported.content).toContain('"OTIO_SCHEMA": "Timeline.1"')
    const roundTrip = planOtioImport(exported.content, SETTINGS_24, ids())
    const original = videoClips(source).map((clip) => ({
      start: clip.timelineRange.startFrame,
      duration: clip.timelineRange.durationFrames,
      sourceStart: clip.sourceRange.startFrame,
    }))
    const again = videoClips(roundTrip).map((clip) => ({
      start: clip.timelineRange.startFrame,
      duration: clip.timelineRange.durationFrames,
      sourceStart: clip.sourceRange.startFrame,
    }))
    expect(again).toEqual(original)
  })

  test('reports titles, captions, and nested sequences as export losses', () => {
    const document = JSON.parse(JSON.stringify(createTimelineDoc('Show', SETTINGS_24, 'seq-1'))) as ReturnType<typeof createTimelineDoc>
    const text: Clip = {
      id: 'text-1',
      assetId: '__myrelith_text__:text-1',
      name: 'Title',
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 24 },
      sourceTimeMap: defaultSourceTimeMap(0, 24),
      timelineRange: { startFrame: 0, durationFrames: 24 },
      transform: defaultClipTransform(),
      opacity: 1,
      blendMode: DEFAULT_BLEND_MODE,
      volume: 1,
      lensCorrection: null,
      visual: defaultClipVisualSettings(),
      audio: defaultClipAudioSettings(),
      animation: defaultClipAnimation(),
      effects: [],
      audioEffects: [],
      text: {
        content: 'Hello',
        fontFamily: 'sans-serif',
        fontSizePx: 48,
        color: '#ffffff',
        align: 'center',
        bold: false,
        italic: false,
        boxWidthPx: 400,
        boxHeightPx: 80,
        paddingPx: 8,
        backgroundEnabled: false,
        backgroundColor: '#000000',
        outlineEnabled: false,
        outlineColor: '#000000',
        outlineWidthPx: 0,
        shadowEnabled: false,
        shadowColor: '#000000',
        shadowBlurPx: 0,
        shadowOffsetXPx: 0,
        shadowOffsetYPx: 0,
      },
    }
    document.tracks[0]!.clips.push(text)
    document.captionTracks = [{
      id: 'cap-1',
      name: 'English',
      language: 'en',
      role: 'captions',
      stylePreset: 'classic',
      hidden: false,
      items: [],
    }]
    document.tracks[0]!.sequenceInstances = [{
      kind: 'sequence',
      id: 'inst-1',
      name: 'Child',
      sequenceId: 'missing',
      sourceStartFrame: 0,
      timelineRange: { startFrame: 24, durationFrames: 12 },
    }]
    const exported = serializeOtioExport(sequenceProjectFromTimeline(document), [])
    expect(exported.preview.losses.some((loss) => loss.code === 'generator')).toBe(true)
    expect(exported.preview.losses.some((loss) => loss.code === 'captions')).toBe(true)
    expect(exported.preview.losses.some((loss) => loss.code === 'nested')).toBe(true)
  })
})

describe('OTIO offline identity', () => {
  test('treats zero size/mtime descriptors as incomplete relink identity', () => {
    const descriptor: PortableAssetDescriptor = {
      id: 'asset-1',
      fileName: 'titles.mov',
      mimeType: 'video/quicktime',
      size: 0,
      lastModified: 0,
      kind: 'video',
      durationMicroseconds: 333_333,
      sourceBounds: { video: { status: 'unknown' }, audio: null },
      nativeFrameRate: { num: 24, den: 1 },
      width: null,
      height: null,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    }
    expect(isOtioIncompleteMediaIdentity(descriptor)).toBe(true)
    expect(isOtioIncompleteMediaIdentity({ ...descriptor, size: 12 })).toBe(false)
  })
})
