import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { scanTimelineLoudness } from './loudnessScan'
import type { ExportAudioClipRequest, ExportAudioMediaSource } from './export-audio'

function makeClip(): Clip {
  return {
    id: 'tone',
    assetId: 'asset',
    name: 'tone',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 1 },
    timelineRange: { startFrame: 0, durationFrames: 1 },
    transform: {
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeDoc(): TimelineDoc {
  const track: Track = {
    id: 'A1',
    kind: 'audio',
    name: 'A1',
    clips: [makeClip()],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
  return {
    schemaVersion: 17,
    id: 'loudness',
    name: 'Loudness',
    frameRate: { num: 1, den: 1 },
    width: 64,
    height: 48,
    audioSampleRate: 48_000,
    tracks: [track],
  }
}

function makeSource(): ExportAudioMediaSource {
  return {
    openClip: async (_request: ExportAudioClipRequest) => {
      const step = 2 * Math.PI * 1_000 / 48_000
      let offset = 0
      return {
        read: async (sampleCount: number) => {
          const left = new Float32Array(sampleCount)
          for (let i = 0; i < sampleCount; i++) left[i] = Math.sin((offset + i) * step)
          offset += sampleCount
          return [left, left.slice()]
        },
        close: async () => undefined,
      }
    },
    close: async () => undefined,
  }
}

describe('loudness scan', () => {
  test('completes a one-frame mix and reports finite LUFS', async () => {
    const measurement = await scanTimelineLoudness(makeDoc(), makeSource())
    expect(measurement.coverage).toBe('complete')
    expect(measurement.integratedLufs).not.toBeNull()
    expect(measurement.truePeakDbtp).not.toBeNull()
  })

  test('aborts without claiming complete coverage', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(scanTimelineLoudness(makeDoc(), makeSource(), {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
