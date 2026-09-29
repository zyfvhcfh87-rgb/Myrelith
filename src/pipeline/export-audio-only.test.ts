import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import { describe, expect, test } from 'vitest'
import { DEFAULT_AUDIO_ONLY_PROFILE } from '../domain/deliveryProduct'
import type { TimelineDoc } from '../domain/schema'
import {
  TimelineAudioMixer,
  type ExportAudioClipReader,
  type ExportAudioMediaSource,
} from './export-audio'
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

function toneSource(): ExportAudioMediaSource {
  return {
    async openClip(request) {
      let position = request.startSample
      const reader: ExportAudioClipReader = {
        async read(sampleCount) {
          const left = new Float32Array(sampleCount)
          const right = new Float32Array(sampleCount)
          for (let index = 0; index < sampleCount; index++, position++) {
            left[index] = Math.sin(position * 0.37) * 0.93
            right[index] = Math.cos(position * 0.11) * 0.71
          }
          return [left, right]
        },
        close() {},
      }
      return reader
    },
    close() {},
  }
}

/** The former whole-program path: float32 planes, then one s16 encode. */
async function referenceWav(
  sequence: TimelineDoc,
  startFrame: number,
  endFrame: number,
  channelCount: 1 | 2,
): Promise<Uint8Array> {
  const mixer = new TimelineAudioMixer(sequence, toneSource())
  const left: number[] = []
  const right: number[] = []
  for (let frame = 0; frame < endFrame; frame++) {
    await mixer.writeFrame(frame, async (block) => {
      if (frame < startFrame) return
      for (let sample = 0; sample < block.sampleCount; sample++) {
        const l = block.channels[0][sample]!
        const r = block.channels[1][sample]!
        if (channelCount === 1) left.push(Math.fround((l + r) / 2))
        else {
          left.push(l)
          right.push(r)
        }
      }
    })
  }
  await mixer.close()
  const planes = channelCount === 1 ? [left] : [left, right]
  const bytes = new Uint8Array(44 + left.length * channelCount * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  const dataBytes = left.length * channelCount * 2
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sequence.audioSampleRate, true)
  view.setUint32(28, sequence.audioSampleRate * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let sample = 0; sample < left.length; sample++) {
    for (const plane of planes) {
      const scaled = Math.round(Math.max(-1, Math.min(1, plane[sample]!)) * 32767)
      view.setInt16(offset, Math.max(-32768, Math.min(32767, scaled)), true)
      offset += 2
    }
  }
  return bytes
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

  test.each(['stereo', 'mono'] as const)(
    'block-encoded %s WAV is byte-identical to the whole-program encode',
    async (layout) => {
      const sequence = doc(4)
      sequence.tracks[0]!.clips[0]!.volume = 1.4
      const result = await drain(exportAudioOnly(
        sequence,
        { ...DEFAULT_AUDIO_ONLY_PROFILE, audioChannelLayout: layout },
        toneSource(),
        { range: { startFrame: 1, endFrame: 4 } },
      ))
      const buffer = (result as { buffer: ArrayBuffer }).buffer
      const expected = await referenceWav(
        sequence,
        1,
        4,
        layout === 'mono' ? 1 : 2,
      )
      expect(buffer.byteLength).toBe(44 + 3 * 1_600 * (layout === 'mono' ? 2 : 4))
      expect(new Uint8Array(buffer)).toEqual(expected)
    },
  )

  test('early return closes the mixer after cooperative cancel', async () => {
    let closed = 0
    const source: ExportAudioMediaSource = {
      async openClip() {
        return {
          async read(sampleCount) {
            return [new Float32Array(sampleCount), new Float32Array(sampleCount)]
          },
          close() {},
        }
      },
      close() {
        closed++
      },
    }
    const generator = exportAudioOnly(doc(3), DEFAULT_AUDIO_ONLY_PROFILE, source, {
      range: { startFrame: 1, endFrame: 3 },
    })
    await generator.next()
    await generator.next()
    await expect(generator.return(undefined)).resolves.toEqual({
      value: undefined,
      done: true,
    })
    expect(closed).toBe(1)
  })
})
