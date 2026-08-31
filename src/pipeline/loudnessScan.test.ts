import { describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { scanTimelineLoudness } from './loudnessScan'
import type { ExportAudioClipRequest, ExportAudioMediaSource } from './export-audio'

function makeClip(durationFrames = 1): Clip {
  return {
    id: 'tone',
    assetId: 'asset',
    name: 'tone',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame: 0, durationFrames },
    transform: {
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeDoc(durationFrames = 1): TimelineDoc {
  const track: Track = {
    id: 'A1',
    kind: 'audio',
    name: 'A1',
    clips: [makeClip(durationFrames)],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
  return {
    schemaVersion: 18,
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
    const measurement = await scanTimelineLoudness(makeDoc(), makeSource(), {
      range: { startFrame: 0, endFrame: 1 },
    })
    expect(measurement.coverage).toBe('complete')
    expect(measurement.integratedLufs).not.toBeNull()
    expect(measurement.truePeakDbtp).not.toBeNull()
  })

  test('aborts without claiming complete coverage', async () => {
    const controller = new AbortController()
    const source = makeSource()
    const sourceClose = vi.spyOn(source, 'close')
    controller.abort()
    await expect(scanTimelineLoudness(makeDoc(), source, {
      range: { startFrame: 0, endFrame: 1 },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(sourceClose).toHaveBeenCalledOnce()
  })

  test('closes source ownership for an empty range', async () => {
    const source = makeSource()
    const sourceClose = vi.spyOn(source, 'close')

    const measurement = await scanTimelineLoudness(makeDoc(), source, {
      range: { startFrame: 0, endFrame: 0 },
    })

    expect(measurement.expectedSamples).toBe(0)
    expect(sourceClose).toHaveBeenCalledOnce()
  })

  test('propagates cancellation into an active decoder read and still closes ownership', async () => {
    const controller = new AbortController()
    const readerClose = vi.fn(async () => undefined)
    const sourceClose = vi.fn(async () => undefined)
    let requestSignal: AbortSignal | undefined
    const source: ExportAudioMediaSource = {
      openClip: async (request) => {
        requestSignal = request.signal
        return {
          read: () => new Promise<readonly Float32Array[]>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(
              new DOMException('cancelled', 'AbortError'),
            ), { once: true })
          }),
          close: readerClose,
        }
      },
      close: sourceClose,
    }

    const pending = scanTimelineLoudness(makeDoc(), source, {
      range: { startFrame: 0, endFrame: 1 },
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(requestSignal).toBe(controller.signal))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(readerClose).toHaveBeenCalledOnce()
    expect(sourceClose).toHaveBeenCalledOnce()
  })

  test('measures only the explicit range while reporting range-local progress', async () => {
    const onProgress = vi.fn()
    const measurement = await scanTimelineLoudness(makeDoc(3), makeSource(), {
      range: { startFrame: 1, endFrame: 2 },
      onProgress,
    })

    expect(measurement.coverage).toBe('complete')
    expect(measurement.measuredSamples).toBe(48_000)
    expect(measurement.expectedSamples).toBe(48_000)
    expect(onProgress).toHaveBeenCalledOnce()
    expect(onProgress).toHaveBeenCalledWith({ framesDone: 1, frameCount: 1 })
  })

  test('rejects a range outside the document', async () => {
    const source = makeSource()
    const sourceClose = vi.spyOn(source, 'close')
    await expect(scanTimelineLoudness(makeDoc(), source, {
      range: { startFrame: 0, endFrame: 2 },
    })).rejects.toThrow(RangeError)
    expect(sourceClose).toHaveBeenCalledOnce()
  })

  test('preserves the scan failure when owned-source cleanup also fails', async () => {
    const source = makeSource()
    source.close = vi.fn(async () => {
      throw new Error('cleanup failed')
    })

    await expect(scanTimelineLoudness(makeDoc(), source, {
      range: { startFrame: 0, endFrame: 2 },
    })).rejects.toThrow('loudness range must be integer document frames')
  })
})
