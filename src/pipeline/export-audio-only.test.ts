import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import { describe, expect, test } from 'vitest'
import { DEFAULT_AUDIO_ONLY_PROFILE } from '../domain/deliveryProduct'
import type { TimelineDoc } from '../domain/schema'
import type { ExportAudioClipReader, ExportAudioMediaSource } from './export-audio'
import { exportAudioOnly } from './export-audio-only'

function silentSource(): ExportAudioMediaSource {
  return {
    async openClip() {
      const reader: ExportAudioClipReader = {
        async read(sampleCount) {
          return [new Float32Array(sampleCount), new Float32Array(sampleCount)]
        },
        close() {},
      }
      return reader
    },
    close() {},
  }
}

function doc(duration = 3): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'wav',
    name: 'wav',
    frameRate: { num: 30, den: 1 },
    width: 64,
    height: 36,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'A1', kind: 'audio', name: 'A1', clips: [{
        id: 'tone', assetId: 'audio', name: 'tone', sourceMode: 'timed',
        sourceRange: { startFrame: 0, durationFrames: duration },
        timelineRange: { startFrame: 0, durationFrames: duration },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
        opacity: 1, volume: 1, effects: [],
      }],
      transitions: [], hidden: false, muted: false, solo: false, locked: false,
    }],
  }
}

async function drain(
  run: AsyncGenerator<number, unknown, void>,
): Promise<unknown> {
  while (true) {
    const step = await run.next()
    if (step.done) return step.value
  }
}

describe('audio-only WAV export', () => {
  test('writes document-rate stereo PCM with no video container', async () => {
    const sequence = doc(2)
    const result = await drain(exportAudioOnly(
      sequence,
      DEFAULT_AUDIO_ONLY_PROFILE,
      silentSource(),
      { range: { startFrame: 0, endFrame: 2 } },
    ))
    expect(result).toMatchObject({
      destination: 'download',
      kind: 'audio-only',
      mimeType: 'audio/wav',
      fileExtension: 'wav',
      completion: 'complete',
    })
    if (!result || typeof result !== 'object' || !('buffer' in result)) throw new Error('missing buffer')
    const view = new DataView((result as { buffer: ArrayBuffer }).buffer)
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint16(20, true)).toBe(1)
  })
})
