import { describe, expect, it } from 'vitest'
import {
  CaptionFileError,
  captionEndMillisecondsToFrame,
  captionStartMillisecondsToFrame,
  parseCaptionFile,
  serializeCaptionTrack,
} from './captionFiles'
import type { CaptionTrack, FrameRate } from './schema'
import { PROJECT_FRAME_RATE_PRESETS } from './projectSettings'

const NTSC: FrameRate = { num: 30_000, den: 1_001 }

function idFactory(index: number): string {
  return `cue-${index + 1}`
}

describe('caption file round trips', () => {
  it('imports SRT using covering half-open frame conversion', () => {
    const items = parseCaptionFile(
      '\uFEFF1\r\n00:00:00,034 --> 00:00:01,001\r\nHello\r\nworld\r\n',
      'srt',
      NTSC,
      idFactory,
    )

    expect(items).toEqual([{
      id: 'cue-1',
      range: {
        startFrame: captionStartMillisecondsToFrame(34, NTSC),
        durationFrames: captionEndMillisecondsToFrame(1_001, NTSC)
          - captionStartMillisecondsToFrame(34, NTSC),
      },
      text: 'Hello\nworld',
    }])
  })

  it.each(['srt', 'vtt'] as const)('round trips exact integer frames through %s', (format) => {
    const track: CaptionTrack = {
      id: 'captions-1',
      name: 'English',
      language: 'en',
      role: 'captions',
      stylePreset: 'boxed',
      hidden: false,
      items: [
        { id: 'cue-a', range: { startFrame: 1, durationFrames: 29 }, text: 'One' },
        { id: 'cue-b', range: { startFrame: 30, durationFrames: 31 }, text: 'Two\nlines' },
      ],
    }
    const serialized = serializeCaptionTrack(track, format, NTSC)
    const parsed = parseCaptionFile(serialized, format, NTSC, idFactory)

    expect(parsed.map((item) => ({ range: item.range, text: item.text }))).toEqual(
      track.items.map((item) => ({ range: item.range, text: item.text })),
    )
  })

  it.each(PROJECT_FRAME_RATE_PRESETS)(
    'keeps one-frame and long cues stable at $num/$den fps',
    (rate) => {
      const track: CaptionTrack = {
        id: 'captions-1',
        name: 'Rate test',
        language: 'und',
        role: 'subtitles',
        stylePreset: 'classic',
        hidden: false,
        items: [
          { id: 'one-frame', range: { startFrame: 17, durationFrames: 1 }, text: 'One' },
          { id: 'long-cue', range: { startFrame: 1_001, durationFrames: 997 }, text: 'Long' },
        ],
      }
      for (const format of ['srt', 'vtt'] as const) {
        const parsed = parseCaptionFile(
          serializeCaptionTrack(track, format, rate),
          format,
          rate,
          (index, sourceId) => sourceId ?? `cue-${index}`,
        )
        expect(parsed.map((item) => item.range)).toEqual(track.items.map((item) => item.range))
      }
    },
  )

  it('preserves portable stable ids in WebVTT cue identifiers', () => {
    const track: CaptionTrack = {
      id: 'captions-1',
      name: 'English',
      language: 'en',
      role: 'captions',
      stylePreset: 'classic',
      hidden: false,
      items: [{ id: 'stable.cue-1', range: { startFrame: 0, durationFrames: 30 }, text: 'Hello' }],
    }
    const parsed = parseCaptionFile(
      serializeCaptionTrack(track, 'vtt', { num: 30, den: 1 }),
      'vtt',
      { num: 30, den: 1 },
      (_index, sourceId) => sourceId ?? 'generated',
    )
    expect(parsed[0]?.id).toBe('stable.cue-1')
  })

  it('accepts WebVTT cue ids and NOTE blocks but rejects unsupported positioning', () => {
    const items = parseCaptionFile(
      'WEBVTT local caption export\n\nNOTE generated locally\nignored\n\nhello-id\n00:00.000 --> 00:01.000\nHello\n',
      'vtt',
      { num: 30, den: 1 },
      (index, sourceId) => `${sourceId}-${index}`,
    )
    expect(items[0]?.id).toBe('hello-id-0')

    expect(() => parseCaptionFile(
      'WEBVTT\n\n00:00.000 --> 00:01.000 align:start\nHello\n',
      'vtt',
      { num: 30, den: 1 },
      idFactory,
    )).toThrow(/settings/u)
  })

  it.each([
    ['srt', '1\n00:00:01,000 --> 00:00:00,500\nBackwards\n', 'timing'],
    ['srt', '1\n00:00:00,000 --> 00:00:01,000\n<b>Markup</b>\n', 'unsupported-markup'],
    ['vtt', 'NOTVTT\n\n00:00.000 --> 00:01.000\nHello\n', 'malformed-header'],
    ['vtt', 'WEBVTT\n\nSTYLE\n::cue { color: lime }\n', 'unsupported-feature'],
  ] as const)('reports atomic actionable %s failures', (format, source, code) => {
    let error: unknown
    try {
      parseCaptionFile(source, format, { num: 30, den: 1 }, idFactory)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CaptionFileError)
    expect((error as CaptionFileError).code).toBe(code)
    expect((error as CaptionFileError).message.length).toBeGreaterThan(8)
  })
})
