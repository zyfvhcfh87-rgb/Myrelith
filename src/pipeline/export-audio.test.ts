/**
 * pipeline/export-audio.test.ts — exact timeline-audio scheduling and mixing.
 *
 * Browser media decoding stays behind small fakes here. These tests exercise
 * the integer sample grid, timeline selection, bounded PCM ownership, and
 * sequential writer backpressure without AudioBuffer or WebCodecs globals.
 */

import { describe, expect, test, vi } from 'vitest'
import type {
  Clip,
  FrameRate,
  MediaSourceBounds,
  TimelineDoc,
  Track,
  Transition,
} from '../domain/schema'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import { splitClipAtFrame, trimClip } from '../domain/operations'
import { docDurationFrames } from '../domain/selectors'
import {
  audioSampleBoundary,
  EXPORT_AUDIO_BLOCK_SAMPLES,
  TimelineAudioMixer,
  type ExportAudioClipRequest,
  type ExportAudioClipReader,
  type ExportAudioMediaSource,
  type MixedAudioBlock,
} from './export-audio'

const F30: FrameRate = { num: 30, den: 1 }
const NTSC_2997: FrameRate = { num: 30_000, den: 1_001 }

function makeClip(
  id: string,
  timelineStart: number,
  duration: number,
  options: {
    sourceStart?: number
    volume?: number
    assetId?: string
    linkGroupId?: string
    audio?: Clip['audio']
  } = {},
): Clip {
  return {
    id,
    assetId: options.assetId ?? `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: {
      startFrame: options.sourceStart ?? 0,
      durationFrames: duration,
    },
    timelineRange: { startFrame: timelineStart, durationFrames: duration },
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
    volume: options.volume ?? 1,
    ...(options.audio === undefined ? {} : { audio: options.audio }),
    effects: [],
    ...(options.linkGroupId ? { linkGroupId: options.linkGroupId } : {}),
  }
}

function makeTrack(
  id: string,
  kind: Track['kind'],
  clips: Clip[],
  flags: Partial<Pick<Track, 'muted' | 'solo' | 'hidden' | 'locked'>> = {},
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: flags.hidden ?? false,
    muted: flags.muted ?? false,
    solo: flags.solo ?? false,
    locked: flags.locked ?? false,
  }
}

function makeDoc(
  tracks: Track[] = [],
  frameRate: FrameRate = F30,
  audioSampleRate = 48_000,
): TimelineDoc {
  return {
    schemaVersion: 10,
    id: 'doc',
    name: 'Audio export test',
    frameRate,
    width: 64,
    height: 48,
    audioSampleRate,
    tracks,
  }
}

type SampleFactory = (
  request: ExportAudioClipRequest,
  sampleCount: number,
  offset: number,
) => readonly Float32Array[]

interface ReaderRecord {
  request: ExportAudioClipRequest
  readCounts: number[]
  read: ExportAudioClipReader['read']
  close: ExportAudioClipReader['close']
}

function silence(sampleCount: number, channelCount = 2): Float32Array[] {
  return Array.from(
    { length: channelCount },
    () => new Float32Array(sampleCount),
  )
}

function filled(sampleCount: number, value: number): Float32Array {
  return new Float32Array(sampleCount).fill(value)
}

function makeSource(
  samples: SampleFactory = (request, sampleCount) =>
    silence(sampleCount, request.channelCount),
): {
  source: ExportAudioMediaSource
  requests: ExportAudioClipRequest[]
  readers: ReaderRecord[]
  close: ReturnType<typeof vi.fn>
} {
  const requests: ExportAudioClipRequest[] = []
  const readers: ReaderRecord[] = []
  const close = vi.fn(async () => undefined)

  const source: ExportAudioMediaSource = {
    openClip: vi.fn(async (request) => {
      requests.push(request)
      let offset = 0
      const readCounts: number[] = []
      const read = vi.fn(async (sampleCount: number) => {
        readCounts.push(sampleCount)
        const result = samples(request, sampleCount, offset)
        offset += sampleCount
        return result
      })
      const closeReader = vi.fn(async () => undefined)
      readers.push({ request, readCounts, read, close: closeReader })
      return { read, close: closeReader }
    }),
    close,
  }

  return { source, requests, readers, close }
}

interface CapturedBlock {
  startSample: number
  sampleCount: number
  channels: number[][]
}

function captureBlock(block: MixedAudioBlock): CapturedBlock {
  return {
    startSample: block.startSample,
    sampleCount: block.sampleCount,
    channels: block.channels.map((channel) => Array.from(channel)),
  }
}

function exactBounds(endSeconds = 20): MediaSourceBounds {
  return {
    video: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: endSeconds * 1_000_000,
    },
    audio: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: endSeconds * 1_000_000,
    },
  }
}

function crossfadeFixture(options: {
  durationFrames?: number
  curve?: Transition['audio']['curve']
  frameRate?: FrameRate
  audioSampleRate?: number
  sameAudioAsset?: boolean
} = {}): { doc: TimelineDoc; catalog: SourceBoundsCatalog } {
  const videoFrom = makeClip('video-from', 0, 4, {
    assetId: 'video-from-asset',
    sourceStart: 4,
    linkGroupId: 'from-link',
  })
  const videoTo = makeClip('video-to', 4, 4, {
    assetId: 'video-to-asset',
    sourceStart: 12,
    linkGroupId: 'to-link',
  })
  const audioFrom = makeClip('audio-from', 0, 4, {
    assetId: options.sameAudioAsset ? 'shared-audio' : 'audio-from-asset',
    sourceStart: 4,
    linkGroupId: 'from-link',
  })
  const audioTo = makeClip('audio-to', 4, 4, {
    assetId: options.sameAudioAsset ? 'shared-audio' : 'audio-to-asset',
    sourceStart: 12,
    linkGroupId: 'to-link',
  })
  const transition: Transition = {
    id: 'crossfade',
    type: 'crossfade',
    fromClipId: videoFrom.id,
    toClipId: videoTo.id,
    durationFrames: options.durationFrames ?? 4,
    audio: { enabled: true, curve: options.curve ?? 'linear' },
  }
  const videoTrack = makeTrack('V1', 'video', [videoFrom, videoTo])
  videoTrack.transitions = [transition]
  const audioTrack = makeTrack('A1', 'audio', [audioFrom, audioTo])
  const assetIds = [
    'video-from-asset',
    'video-to-asset',
    audioFrom.assetId,
    audioTo.assetId,
  ]
  return {
    doc: {
      ...makeDoc(
        [videoTrack, audioTrack],
        options.frameRate ?? { num: 1, den: 1 },
        options.audioSampleRate ?? 4_096,
      ),
      schemaVersion: 10,
    },
    catalog: new Map(
      [...new Set(assetIds)].map((assetId) => [assetId, exactBounds()]),
    ),
  }
}

async function renderSourceSamplePattern(doc: TimelineDoc): Promise<{
  samples: number[]
  requests: ExportAudioClipRequest[]
}> {
  const h = makeSource((request, sampleCount, offset) => {
    const channel = Float32Array.from(
      { length: sampleCount },
      (_, index) =>
        ((request.startSample + offset + index) % 8_192) / 8_192,
    )
    return [channel, channel.slice()]
  })
  const mixer = new TimelineAudioMixer(doc, h.source)
  const samples: number[] = []

  try {
    for (let frame = 0; frame < docDurationFrames(doc); frame++) {
      await mixer.writeFrame(frame, async (block) => {
        samples.push(...block.channels[0])
      })
    }
  } finally {
    await mixer.close()
  }

  return { samples, requests: h.requests }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('audioSampleBoundary', () => {
  test('maps integer-rate frames to exact sample boundaries', () => {
    const doc = makeDoc([], F30, 48_000)

    expect(audioSampleBoundary(0, doc)).toBe(0)
    expect(audioSampleBoundary(1, doc)).toBe(1_600)
    expect(audioSampleBoundary(300, doc)).toBe(480_000)
  })

  test('derives every NTSC boundary independently without rounded-per-frame drift', () => {
    const doc = makeDoc([], NTSC_2997, 48_000)
    const boundaries = Array.from(
      { length: 6 },
      (_, frame) => audioSampleBoundary(frame, doc),
    )

    expect(boundaries).toEqual([0, 1_602, 3_203, 4_805, 6_406, 8_008])
    expect(boundaries.slice(1).map((end, index) => end - boundaries[index]))
      .toEqual([1_602, 1_601, 1_602, 1_601, 1_602])
    expect(audioSampleBoundary(30_000, doc)).toBe(48_048_000)
  })

  test('stays exact at an eight-hour-scale NTSC frame index', () => {
    const doc = makeDoc([], NTSC_2997, 48_000)

    expect(audioSampleBoundary(863_136, doc)).toBe(1_382_398_618)
  })
})

describe('TimelineAudioMixer selection and mapping', () => {
  test('uses audibleTracks, ignores video clips, and skips zero-volume readers', async () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('video', 0, 1)]),
      makeTrack('A-normal', 'audio', [makeClip('normal', 0, 1)]),
      makeTrack('A-muted', 'audio', [makeClip('muted', 0, 1)], {
        muted: true,
      }),
      makeTrack('A-solo-muted', 'audio', [makeClip('solo-muted', 0, 1)], {
        muted: true,
        solo: true,
      }),
      makeTrack(
        'A-solo-zero',
        'audio',
        [makeClip('solo-zero', 0, 1, { volume: 0 })],
        { solo: true },
      ),
      makeTrack('A-solo-live', 'audio', [makeClip('solo-live', 0, 1)], {
        solo: true,
      }),
    ])
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)

    expect(mixer.hasAudio).toBe(true)
    await mixer.writeFrame(0, async () => undefined)

    expect(h.requests.map((request) => request.clipId)).toEqual(['solo-live'])
    await mixer.close()
  })

  test('keeps an audio stream but emits silence when every clip is suppressed', async () => {
    const doc = makeDoc([
      makeTrack('A-muted-solo', 'audio', [makeClip('muted-solo', 0, 1)], {
        muted: true,
        solo: true,
      }),
      makeTrack('A-non-solo', 'audio', [makeClip('non-solo', 0, 1)]),
      makeTrack(
        'A-zero-solo',
        'audio',
        [makeClip('zero-solo', 0, 1, { volume: 0 })],
        { solo: true },
      ),
    ])
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)
    const blocks: CapturedBlock[] = []

    expect(mixer.hasAudio).toBe(true)
    await mixer.writeFrame(0, async (block) => {
      blocks.push(captureBlock(block))
    })

    expect(h.requests).toEqual([])
    expect(blocks.map((block) => block.sampleCount)).toEqual([1_024, 576])
    expect(blocks.every((block) =>
      block.channels.every((channel) => channel.every((sample) => sample === 0)),
    )).toBe(true)
    await mixer.close()
  })

  test('opens a trimmed source range at its document-rate sample offset', async () => {
    const clip = makeClip('trimmed', 1, 2, {
      sourceStart: 3,
      assetId: 'asset-a',
    })
    const doc = makeDoc([makeTrack('A1', 'audio', [clip])])
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)
    const leading: CapturedBlock[] = []

    await mixer.writeFrame(0, async (block) => {
      leading.push(captureBlock(block))
    })
    expect(h.requests).toEqual([])
    expect(leading.every((block) =>
      block.channels.every((channel) => channel.every((sample) => sample === 0)),
    )).toBe(true)

    await mixer.writeFrame(1, async () => undefined)
    expect(h.requests).toEqual([
      {
        clipId: 'trimmed',
        assetId: 'asset-a',
        startSample: 4_800,
        endSample: 8_000,
        sampleRate: 48_000,
        channelCount: 2,
      },
    ])

    await mixer.close()
  })

  test('keeps NTSC source length equal to its destination without a rounded tail gap', async () => {
    const clip = makeClip('phase-shifted', 0, 1, { sourceStart: 1 })
    const doc = makeDoc(
      [makeTrack('A1', 'audio', [clip])],
      NTSC_2997,
      48_000,
    )
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)

    await mixer.writeFrame(0, async () => undefined)

    expect(h.requests[0]).toMatchObject({
      startSample: 1_602,
      endSample: 3_204,
    })
    expect(h.readers[0].readCounts).toEqual([1_024, 578])
    await mixer.close()
  })

  test('keeps the complete NTSC source sample stream unchanged across a razor split', async () => {
    const clip = makeClip('continuous', 0, 2, {
      sourceStart: 1,
      assetId: 'asset-a',
    })
    const originalDoc = makeDoc(
      [makeTrack('A1', 'audio', [clip])],
      NTSC_2997,
      48_000,
    )
    const splitDoc = splitClipAtFrame(originalDoc, clip.id, 1)

    const original = await renderSourceSamplePattern(originalDoc)
    const split = await renderSourceSamplePattern(splitDoc)

    expect(split.samples).toEqual(original.samples)
    expect(original.requests.map(({ startSample, endSample }) => ({
      startSample,
      endSample,
    }))).toEqual([{ startSample: 1_602, endSample: 4_805 }])
    expect(split.requests.map(({ startSample, endSample }) => ({
      startSample,
      endSample,
    }))).toEqual([
      { startSample: 1_602, endSample: 3_204 },
      { startSample: 3_204, endSample: 4_805 },
    ])
  })

  test('keeps an NTSC start-trim equal to the original source suffix', async () => {
    const clip = makeClip('continuous', 0, 2, {
      sourceStart: 1,
      assetId: 'asset-a',
    })
    const originalDoc = makeDoc(
      [makeTrack('A1', 'audio', [clip])],
      NTSC_2997,
      48_000,
    )
    const trimmedDoc = trimClip(originalDoc, clip.id, 'start', 1)

    const original = await renderSourceSamplePattern(originalDoc)
    const trimmed = await renderSourceSamplePattern(trimmedDoc)
    const suffixStart = audioSampleBoundary(1, originalDoc)

    expect(trimmed.samples.slice(0, suffixStart).every((sample) => sample === 0))
      .toBe(true)
    expect(trimmed.samples.slice(suffixStart)).toEqual(
      original.samples.slice(suffixStart),
    )
    expect(trimmed.requests.map(({ startSample, endSample }) => ({
      startSample,
      endSample,
    }))).toEqual([{ startSample: 3_204, endSample: 4_805 }])
  })

  test('rounds a negative half-sample phase away from zero', async () => {
    const clip = makeClip('negative-phase', 1, 1, { sourceStart: 0 })
    const doc = makeDoc(
      [makeTrack('A1', 'audio', [clip])],
      { num: 2, den: 1 },
      3,
    )
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)

    await mixer.writeFrame(0, async () => undefined)
    await mixer.writeFrame(1, async () => undefined)

    // B(1) = 2 and the signed phase is roundAway(-1.5) = -2. A
    // Math.round-style negative tie would incorrectly start at sample 1.
    expect(h.requests[0]).toMatchObject({ startSample: 0, endSample: 1 })
    await mixer.close()
  })

  test('applies linear gain, sums all tracks, then clamps once', async () => {
    const clips = ['a', 'b', 'c'].map((id) =>
      makeClip(id, 0, 1, { volume: 0.8 }),
    )
    const doc = makeDoc(
      clips.map((clip, index) => makeTrack(`A${index + 1}`, 'audio', [clip])),
    )
    const h = makeSource((request, sampleCount) => {
      if (request.clipId === 'c') {
        return [filled(sampleCount, -1), filled(sampleCount, 0)]
      }
      return [filled(sampleCount, 1), filled(sampleCount, 1)]
    })
    const mixer = new TimelineAudioMixer(doc, h.source)
    const blocks: CapturedBlock[] = []

    await mixer.writeFrame(0, async (block) => {
      blocks.push(captureBlock(block))
    })

    // Left: 0.8 + 0.8 - 0.8 = 0.8. Clamping after each add would be 0.2.
    // Right: 0.8 + 0.8 + 0 = 1.6, saturated to 1 only after the sum.
    for (const block of blocks) {
      expect(block.channels[0][0]).toBeCloseTo(0.8)
      expect(block.channels[0].at(-1)).toBeCloseTo(0.8)
      expect(block.channels[1][0]).toBe(1)
      expect(block.channels[1].at(-1)).toBe(1)
    }
    await mixer.close()
  })

  test('multiplies frame fades and stereo balance on the absolute sample grid', async () => {
    const clip = makeClip('shaped', 0, 2, {
      audio: {
        enabled: true,
        balance: 0.5,
        fadeInFrames: 1,
        fadeOutFrames: 1,
      },
    })
    const doc = makeDoc([makeTrack('A1', 'audio', [clip])], { num: 1, den: 1 }, 4)
    const h = makeSource((_request, sampleCount) => [
      filled(sampleCount, 1),
      filled(sampleCount, 1),
    ])
    const mixer = new TimelineAudioMixer(doc, h.source)
    const observed: number[][][] = []

    await mixer.writeFrame(0, async (block) => {
      observed.push(captureBlock(block).channels)
    })
    await mixer.writeFrame(1, async (block) => {
      observed.push(captureBlock(block).channels)
    })

    expect(observed[0][0]).toEqual([0, 0.125, 0.25, 0.375])
    expect(observed[0][1]).toEqual([0, 0.25, 0.5, 0.75])
    expect(observed[1][0]).toEqual([0.5, 0.375, 0.25, 0.125])
    expect(observed[1][1]).toEqual([1, 0.75, 0.5, 0.25])
    await mixer.close()
  })

  test.each([1, 3, 4])(
    'opens exact virtual source ranges for a %i-frame crossfade',
    async (durationFrames) => {
      const fixture = crossfadeFixture({
        durationFrames,
        audioSampleRate: 10,
      })
      const h = makeSource()
      const mixer = new TimelineAudioMixer(
        fixture.doc,
        h.source,
        fixture.catalog,
      )
      for (let frame = 0; frame < 8; frame++) {
        await mixer.writeFrame(frame, async () => undefined)
      }

      const startFrame = 4 - Math.floor(durationFrames / 2)
      const endFrame = startFrame + durationFrames
      expect(h.requests).toEqual([
        {
          clipId: 'audio-from',
          assetId: 'audio-from-asset',
          startSample: 40,
          endSample: (4 + endFrame) * 10,
          sampleRate: 10,
          channelCount: 2,
          requireComplete: true,
        },
        {
          clipId: 'audio-to',
          assetId: 'audio-to-asset',
          startSample: (startFrame + 8) * 10,
          endSample: 160,
          sampleRate: 10,
          channelCount: 2,
          requireComplete: true,
        },
      ])
      await mixer.close()
    },
  )

  test.each(['linear', 'equal-power'] as const)(
    'evaluates %s gain from absolute samples across 1024-sample blocks',
    async (curve) => {
      const fixture = crossfadeFixture({ curve })
      fixture.doc.tracks[1].clips[0].volume = 0.5
      fixture.doc.tracks[1].clips[1].volume = 0.25
      const h = makeSource((request, sampleCount) =>
        request.clipId === 'audio-from'
          ? [filled(sampleCount, 1), filled(sampleCount, 0)]
          : [filled(sampleCount, 0), filled(sampleCount, 1)],
      )
      const mixer = new TimelineAudioMixer(
        fixture.doc,
        h.source,
        fixture.catalog,
      )
      const observed = new Map<number, [number, number]>()
      for (let frame = 0; frame < 8; frame++) {
        await mixer.writeFrame(frame, async (block) => {
          for (let index = 0; index < block.sampleCount; index++) {
            observed.set(block.startSample + index, [
              block.channels[0][index],
              block.channels[1][index],
            ])
          }
        })
      }

      const start = audioSampleBoundary(2, fixture.doc)
      const end = audioSampleBoundary(6, fixture.doc)
      const span = end - start
      for (const offset of [0, 1_024, span / 2, span - 1]) {
        const sample = start + offset
        const pair = observed.get(sample)
        if (!pair) throw new Error(`Missing mixed sample ${sample}`)
        const progress = offset / span
        const fromGain = curve === 'linear'
          ? 1 - progress
          : Math.cos(progress * Math.PI / 2)
        const toGain = curve === 'linear'
          ? progress
          : Math.sin(progress * Math.PI / 2)
        expect(pair[0]).toBeCloseTo(fromGain * 0.5, 5)
        expect(pair[1]).toBeCloseTo(toGain * 0.25, 5)
      }
      await mixer.close()
    },
  )

  test('keeps NTSC virtual ranges on the signed phase grid', async () => {
    const fixture = crossfadeFixture({
      durationFrames: 3,
      frameRate: NTSC_2997,
      audioSampleRate: 48_000,
      sameAudioAsset: true,
    })
    const h = makeSource()
    const mixer = new TimelineAudioMixer(
      fixture.doc,
      h.source,
      fixture.catalog,
    )
    for (let frame = 0; frame < 8; frame++) {
      await mixer.writeFrame(frame, async () => undefined)
    }

    const fromStart = audioSampleBoundary(4, fixture.doc)
    const fromLength = audioSampleBoundary(6, fixture.doc)
    const toStart =
      audioSampleBoundary(3, fixture.doc)
      + audioSampleBoundary(8, fixture.doc)
    const toLength =
      audioSampleBoundary(8, fixture.doc)
      - audioSampleBoundary(3, fixture.doc)
    expect(h.requests).toEqual([
      expect.objectContaining({
        clipId: 'audio-from',
        assetId: 'shared-audio',
        startSample: fromStart,
        endSample: fromStart + fromLength,
        requireComplete: true,
      }),
      expect.objectContaining({
        clipId: 'audio-to',
        assetId: 'shared-audio',
        startSample: toStart,
        endSample: toStart + toLength,
        requireComplete: true,
      }),
    ])
    expect(h.readers).toHaveLength(2)
    await mixer.close()
  })

  test('fails instead of accepting a short exact-handle reader block', async () => {
    const fixture = crossfadeFixture()
    const source: ExportAudioMediaSource = {
      openClip: vi.fn(async (_request) => ({
        read: vi.fn(async (sampleCount: number) => [
          new Float32Array(sampleCount - 1),
          new Float32Array(sampleCount - 1),
        ]),
        close: vi.fn(),
      })),
      close: vi.fn(),
    }
    const mixer = new TimelineAudioMixer(
      fixture.doc,
      source,
      fixture.catalog,
    )

    await expect(mixer.writeFrame(0, async () => undefined)).rejects.toThrow(
      'returned an invalid block',
    )
    expect(source.openClip).toHaveBeenCalledWith(
      expect.objectContaining({ requireComplete: true }),
    )
    await mixer.close()
  })
})

describe('TimelineAudioMixer streaming and ownership', () => {
  test('caps PCM blocks at 1024 samples and emits the exact frame tail', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('clip', 0, 1)]),
    ])
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)
    const blocks: CapturedBlock[] = []

    expect(EXPORT_AUDIO_BLOCK_SAMPLES).toBe(1_024)
    await mixer.writeFrame(0, async (block) => {
      blocks.push(captureBlock(block))
    })

    expect(blocks.map(({ startSample, sampleCount }) => ({
      startSample,
      sampleCount,
    }))).toEqual([
      { startSample: 0, sampleCount: 1_024 },
      { startSample: 1_024, sampleCount: 576 },
    ])
    expect(blocks.reduce((sum, block) => sum + block.sampleCount, 0)).toBe(
      audioSampleBoundary(1, doc),
    )
    expect(blocks.every((block) => block.sampleCount <= 1_024)).toBe(true)
    expect(h.readers[0].readCounts).toEqual([1_024, 576])
    await mixer.close()
  })

  test('awaits each writer before reading or publishing the next block', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('clip', 0, 1)]),
    ])
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)
    const firstWrite = deferred()
    let writes = 0
    const writeBlock = vi.fn(async () => {
      writes++
      if (writes === 1) await firstWrite.promise
    })

    const pending = mixer.writeFrame(0, writeBlock)
    await vi.waitFor(() => expect(writeBlock).toHaveBeenCalledOnce())
    expect(h.readers[0].readCounts).toEqual([1_024])

    firstWrite.resolve()
    await pending
    expect(writeBlock).toHaveBeenCalledTimes(2)
    expect(h.readers[0].readCounts).toEqual([1_024, 576])
    await mixer.close()
  })

  test('waits for every concurrent reader before surfacing the first failure', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('fails', 0, 1)]),
      makeTrack('A2', 'audio', [makeClip('slow', 0, 1)]),
    ])
    const slowRead = deferred()
    const primary = new Error('reader failed')
    const source: ExportAudioMediaSource = {
      openClip: vi.fn(async (request) => ({
        read: vi.fn(async (sampleCount: number) => {
          if (request.clipId === 'fails') throw primary
          await slowRead.promise
          return silence(sampleCount)
        }),
        close: vi.fn(),
      })),
      close: vi.fn(),
    }
    const mixer = new TimelineAudioMixer(doc, source)
    let rejected = false
    const pending = mixer.writeFrame(0, async () => undefined)
    void pending.catch(() => {
      rejected = true
    })

    await vi.waitFor(() =>
      expect(source.openClip).toHaveBeenCalledTimes(2),
    )
    await Promise.resolve()
    expect(rejected).toBe(false)

    slowRead.resolve()
    await expect(pending).rejects.toBe(primary)
    await mixer.close()
  })

  test('reuses a reader across frames and closes it when the clip becomes inactive', async () => {
    const audio = makeClip('audio', 0, 2)
    const runway = makeClip('video-runway', 0, 3)
    const doc = makeDoc([
      makeTrack('V1', 'video', [runway]),
      makeTrack('A1', 'audio', [audio]),
    ])
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)

    await mixer.writeFrame(0, async () => undefined)
    await mixer.writeFrame(1, async () => undefined)
    expect(h.requests.map((request) => request.clipId)).toEqual(['audio'])
    expect(h.readers[0].readCounts).toEqual([1_024, 576, 1_024, 576])
    expect(h.readers[0].close).not.toHaveBeenCalled()

    await mixer.writeFrame(2, async () => undefined)
    expect(h.readers[0].close).toHaveBeenCalledOnce()

    await mixer.close()
    expect(h.readers[0].close).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
  })

  test('cancellation closes active readers and the media source exactly once', async () => {
    const doc = makeDoc([
      makeTrack('A1', 'audio', [makeClip('long', 0, 10)]),
    ])
    const h = makeSource()
    const mixer = new TimelineAudioMixer(doc, h.source)

    await mixer.writeFrame(0, async () => undefined)
    expect(h.readers[0].close).not.toHaveBeenCalled()

    const firstClose = mixer.close()
    const secondClose = mixer.close()
    expect(secondClose).toBe(firstClose)
    await firstClose

    expect(h.readers[0].close).toHaveBeenCalledOnce()
    expect(h.close).toHaveBeenCalledOnce()
  })
})
