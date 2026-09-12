import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_IMAGE_SEQUENCE_PROFILE } from '../domain/deliveryProduct'
import type { TimelineDoc } from '../domain/schema'
import { unzipStore } from './zipStore'
import { createImageSequenceSink } from './export-image-sequence'

class FakeCanvas {
  width: number
  height: number
  getContext = vi.fn(() => ({ canvas: this }))
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
}

function doc(): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'png',
    name: 'png',
    frameRate: { num: 30, den: 1 },
    width: 16,
    height: 9,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'V1', kind: 'video', name: 'V1', clips: [{
        id: 'c', assetId: 'a', name: 'c', sourceMode: 'timed',
        sourceRange: { startFrame: 0, durationFrames: 4 },
        timelineRange: { startFrame: 0, durationFrames: 4 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        opacity: 1, volume: 1, effects: [],
      }],
      transitions: [], hidden: false, muted: false, solo: false, locked: false,
    }],
  }
}

describe('PNG image-sequence sink', () => {
  test('writes exact range names and reports partial completion', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
    const pngs: string[] = []
    const sink = await createImageSequenceSink(
      doc(),
      DEFAULT_IMAGE_SEQUENCE_PROFILE,
      { startFrame: 1, endFrame: 4 },
      undefined,
      {
        convertPng: async () => {
          pngs.push('x')
          return new Uint8Array([137, 80, 78, 71])
        },
      },
    )
    expect(sink.compositeBackground).toBe('transparent')
    await sink.addFrame(0, 1 / 30)
    await sink.addFrame(1 / 30, 1 / 30)
    expect(sink.commitPartial).toBeTypeOf('function')
    const partial = await sink.commitPartial!()
    expect(partial?.destination).toBe('download')
    if (partial?.destination !== 'download' || !('kind' in partial)) throw new Error('expected zip')
    expect(partial.completion).toBe('partial')
    expect(partial.writtenFrames).toBe(2)
    expect(partial.expectedFrames).toBe(3)
    const names = unzipStore(new Uint8Array(partial.buffer)).map((entry) => entry.name)
    expect(names).toEqual(['frame_00001.png', 'frame_00002.png'])
    expect(pngs).toHaveLength(2)
  })

  test('refuses to overwrite existing folder files unless asked', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
    const written: string[] = []
    const sink = await createImageSequenceSink(
      doc(),
      { ...DEFAULT_IMAGE_SEQUENCE_PROFILE, destination: 'directory', overwriteExisting: false },
      { startFrame: 0, endFrame: 1 },
      {
        directoryName: 'out',
        exists: async (name) => name === 'frame_00000.png',
        write: async (name) => { written.push(name) },
      },
      { convertPng: async () => new Uint8Array([1]) },
    )
    await expect(sink.addFrame(0, 1 / 30)).rejects.toThrow(/already exists/i)
    expect(written).toEqual([])
  })
})
