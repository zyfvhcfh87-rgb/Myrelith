/**
 * Browser-backed preview fold-down parity for multichannel sources.
 *
 * Preview uses AudioBuffer channel planes plus the live Web Audio output.
 * Export coverage lives in export-mediabunny-audio-source.test.ts and uses
 * the same fixtures. Both paths must match the shared policy for every
 * documented 3-channel and 5.1 source channel.
 */

import { describe, expect, test, vi } from 'vitest'
import {
  applyStereoBalanceToSample,
  foldDecodedFrameToStereo,
} from '../domain/audioChannelMix'
import { stereoBalanceGains } from '../domain/clipInspector'
import {
  expectedParityStereo,
  isolatedParityPlanes,
  MULTICHANNEL_FOLD_PARITY_CASES,
  PARITY_FRAME_COUNT,
  PARITY_SAMPLE_RATE,
} from '../test/audioChannelMixParity'
import {
  createWebAudioPlaybackOutput,
  type ScheduledPlaybackAudio,
} from './playback-audio'

interface FakeAudioParam {
  value: number
  cancelScheduledValues: ReturnType<typeof vi.fn>
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  setValueCurveAtTime: ReturnType<typeof vi.fn>
}

interface FakeGainNode {
  gain: FakeAudioParam
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeSourceNode {
  buffer: AudioBuffer | null
  onended: (() => void) | null
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

function makePlanarAudioBuffer(
  channels: readonly Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const length = channels[0]?.length ?? 0
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    duration: sampleRate > 0 ? length / sampleRate : 0,
    getChannelData: (index: number) => {
      const plane = channels[index]
      if (!plane) throw new Error(`Missing audio channel ${index}`)
      return plane
    },
  } as AudioBuffer
}

function makePreviewHarness(): {
  context: AudioContext
  sources: FakeSourceNode[]
  gains: FakeGainNode[]
} {
  const sources: FakeSourceNode[] = []
  const gains: FakeGainNode[] = []
  const makeGain = (): FakeGainNode => {
    const node: FakeGainNode = {
      gain: {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        setValueCurveAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    gains.push(node)
    return node
  }
  const context = {
    currentTime: 0,
    state: 'running',
    destination: {},
    createGain: vi.fn(() => makeGain()),
    createAnalyser: vi.fn(() => ({
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((samples: Float32Array) => {
        samples.fill(0)
      }),
    })),
    createChannelSplitter: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createChannelMerger: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createBufferSource: vi.fn(() => {
      const source: FakeSourceNode = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      sources.push(source)
      return source
    }),
    createBuffer: vi.fn((
      numberOfChannels: number,
      length: number,
      sampleRate: number,
    ) => makePlanarAudioBuffer(
      Array.from({ length: numberOfChannels }, () => new Float32Array(length)),
      sampleRate,
    )),
  } as unknown as AudioContext
  return { context, sources, gains }
}

function schedulePreview(
  planes: readonly Float32Array[],
  balance: number,
): {
  folded: AudioBuffer
  leftGain: number
  rightGain: number
  routedLeftGain: number | undefined
  routedRightGain: number | undefined
} {
  const harness = makePreviewHarness()
  const output = createWebAudioPlaybackOutput(harness.context)
  const [leftGain, rightGain] = stereoBalanceGains(balance)
  const request: ScheduledPlaybackAudio = {
    clipId: 'parity',
    buffer: makePlanarAudioBuffer(planes, PARITY_SAMPLE_RATE),
    timelineStartTime: 0,
    when: 0,
    offset: 0,
    duration: PARITY_FRAME_COUNT / PARITY_SAMPLE_RATE,
    volume: 1,
    envelope: null,
    balance,
    leftGain,
    rightGain,
  }
  output.schedule(request)
  const folded = harness.sources[0]?.buffer
  if (!folded) throw new Error('Preview did not assign a playback buffer')
  output.stop()
  return {
    folded,
    leftGain,
    rightGain,
    routedLeftGain: harness.gains[2]?.gain.value,
    routedRightGain: harness.gains[3]?.gain.value,
  }
}

describe('multichannel preview/export fold-down parity', () => {
  test.each(MULTICHANNEL_FOLD_PARITY_CASES)(
    'preview keeps $id through fold-down and balance',
    ({ channelCount, hotChannel, balance }) => {
      const planes = isolatedParityPlanes(channelCount, hotChannel)
      const scheduled = schedulePreview(planes, balance)
      expect(scheduled.folded.numberOfChannels).toBe(2)
      expect(scheduled.folded.length).toBe(PARITY_FRAME_COUNT)

      for (let frame = 0; frame < PARITY_FRAME_COUNT; frame++) {
        const folded = foldDecodedFrameToStereo(planes, frame)
        expect(scheduled.folded.getChannelData(0)[frame]).toBeCloseTo(folded[0])
        expect(scheduled.folded.getChannelData(1)[frame]).toBeCloseTo(folded[1])
        const audible = applyStereoBalanceToSample(
          scheduled.folded.getChannelData(0)[frame],
          scheduled.folded.getChannelData(1)[frame],
          scheduled.leftGain,
          scheduled.rightGain,
        )
        const expected = expectedParityStereo(planes, frame, balance)
        expect(audible[0]).toBeCloseTo(expected[0], 6)
        expect(audible[1]).toBeCloseTo(expected[1], 6)
      }

      if (balance === 0) {
        expect(scheduled.routedLeftGain).toBeUndefined()
        expect(scheduled.routedRightGain).toBeUndefined()
      } else {
        expect(scheduled.routedLeftGain).toBe(scheduled.leftGain)
        expect(scheduled.routedRightGain).toBe(scheduled.rightGain)
      }
    },
  )

  test('preview mixed 5.1 matches the shared fold before and after balance', () => {
    const values = [0.05, 0.1, 0.05, 0.02, 0.05, 0.1]
    const planes = values.map((value) => {
      const plane = new Float32Array(PARITY_FRAME_COUNT)
      plane.fill(value)
      return plane
    })
    for (const balance of [0, 0.5]) {
      const scheduled = schedulePreview(planes, balance)
      const expected = expectedParityStereo(planes, 0, balance)
      const audible = applyStereoBalanceToSample(
        scheduled.folded.getChannelData(0)[0],
        scheduled.folded.getChannelData(1)[0],
        scheduled.leftGain,
        scheduled.rightGain,
      )
      expect(audible[0]).toBeCloseTo(expected[0])
      expect(audible[1]).toBeCloseTo(expected[1])
    }
  })
})
