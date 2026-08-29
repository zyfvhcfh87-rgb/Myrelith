import { describe, expect, test } from 'vitest'
import type { Clip } from '../domain/schema'
import {
  createConstantRateAudioStretch,
  type ConstantRateAudioStretch,
} from '../domain/audioMixPlan'
import {
  sourceTimeAudioPolicy,
  sourceTimeRateFromPercent,
  SOURCE_TIME_TICKS_PER_FRAME,
} from '../domain/sourceTimeMap'
import {
  AUDIO_STRETCH_MAX_OUTPUT_SAMPLES,
  AUDIO_STRETCH_MAX_SESSIONS,
  AUDIO_STRETCH_RECHUNK_FRAMES,
  audioStretchSourceLeadSamples,
  createConstantRateAudioStretcher,
  type StereoPcm,
  wsolaTimeConstants,
} from './audioStretch'

const SAMPLE_RATE = 48_000

function clipAt(percent: number): Clip {
  const rate = sourceTimeRateFromPercent(percent)
  return {
    id: 'clip',
    assetId: 'asset',
    name: 'Clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 1_000 },
    sourceTimeMap: {
      sourceStartTicks: 0,
      sourceDurationTicks: 1_000 * SOURCE_TIME_TICKS_PER_FRAME,
      rate,
    },
    timelineRange: { startFrame: 0, durationFrames: 500 },
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
    volume: 1,
    effects: [],
  }
}

function stretchAt(percent: number): ConstantRateAudioStretch {
  const clip = clipAt(percent)
  const policy = sourceTimeAudioPolicy(clip)
  if (policy.status !== 'supported' || policy.kind !== 'stretched') {
    throw new Error(`Expected ${percent}% to produce a constant stretch rate`)
  }
  return createConstantRateAudioStretch(
    policy.rate,
    0,
    1_000 * SOURCE_TIME_TICKS_PER_FRAME,
  )
}

function sineReader(
  frequency: number,
  rightFrequency = frequency,
): (sampleCount: number) => StereoPcm {
  let cursor = 0
  return (sampleCount) => {
    const left = new Float32Array(sampleCount)
    const right = new Float32Array(sampleCount)
    for (let index = 0; index < sampleCount; index++) {
      left[index] = Math.sin(2 * Math.PI * frequency * (cursor + index) / SAMPLE_RATE)
      right[index] = Math.sin(
        2 * Math.PI * rightFrequency * (cursor + index) / SAMPLE_RATE,
      )
    }
    cursor += sampleCount
    return { left, right }
  }
}

function estimateFrequency(samples: Float32Array): number {
  const trim = 4_096
  let crossings = 0
  for (let index = trim + 1; index < samples.length - trim; index++) {
    if (samples[index - 1]! <= 0 && samples[index]! > 0) crossings++
  }
  return crossings * SAMPLE_RATE / (samples.length - trim * 2)
}

function expectNearPitch(actual: number, expected: number): void {
  const cents = 1_200 * Math.log2(actual / expected)
  expect(Math.abs(cents)).toBeLessThanOrEqual(10)
}

describe('audio stretch constants', () => {
  test('exports host admission and rechunk bounds', () => {
    expect(AUDIO_STRETCH_RECHUNK_FRAMES).toBe(4_096)
    expect(AUDIO_STRETCH_MAX_SESSIONS).toBe(8)
  })

  test('uses the reviewed 48 kHz constants', () => {
    expect(wsolaTimeConstants(48_000)).toEqual({
      windowSamples: 1_024,
      outputHopSamples: 256,
      searchSamples: 512,
    })
  })

  test('snaps the other supported output hops', () => {
    expect(wsolaTimeConstants(44_100).outputHopSamples).toBe(236)
    expect(wsolaTimeConstants(96_000).outputHopSamples).toBe(512)
  })

  test.each([44_100, 48_000, 96_000])(
    'keeps every non-unity 25%% rate integral at %i Hz',
    (sampleRate) => {
      const { outputHopSamples } = wsolaTimeConstants(sampleRate)
      for (let percent = 25; percent <= 400; percent += 25) {
        if (percent === 100) continue
        const rate = sourceTimeRateFromPercent(percent)
        expect(outputHopSamples * rate.numerator % rate.denominator).toBe(0)
      }
    },
  )

  test.each([44_100, 48_000, 96_000])(
    'defines lead as one window plus search at %i Hz',
    (sampleRate) => {
      const constants = wsolaTimeConstants(sampleRate)
      expect(audioStretchSourceLeadSamples(sampleRate)).toBe(
        constants.windowSamples + constants.searchSamples,
      )
    },
  )
})

describe('constant-rate audio stretcher boundaries', () => {
  test.each([
    { sampleRate: 32_000, outputStartSample: 0 },
    { sampleRate: 1.5, outputStartSample: 0 },
    { sampleRate: SAMPLE_RATE, outputStartSample: -1 },
  ])('rejects invalid factory arguments', (args) => {
    expect(() => createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      ...args,
    })).toThrow(RangeError)
  })

  test.each([0, AUDIO_STRETCH_MAX_OUTPUT_SAMPLES + 1, 1.5])(
    'rejects pull count %s',
    async (outputSampleCount) => {
      const session = createConstantRateAudioStretcher({
        stretch: stretchAt(200),
        sampleRate: SAMPLE_RATE,
        outputStartSample: 0,
      })
      await expect(session.pull(outputSampleCount, sineReader(440))).rejects.toThrow(
        RangeError,
      )
    },
  )

  test('close is idempotent and rejects later pulls', async () => {
    const session = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    session.close()
    expect(() => session.close()).not.toThrow()
    await expect(session.pull(256, sineReader(440))).rejects.toThrow(/closed/i)
  })

  test('rejects source planes with the wrong length', async () => {
    const session = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    await expect(session.pull(256, (sampleCount) => ({
      left: new Float32Array(sampleCount - 1),
      right: new Float32Array(sampleCount),
    }))).rejects.toThrow(/length/i)
  })

  test('rejects non-finite source samples', async () => {
    const session = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    await expect(session.pull(256, (sampleCount) => {
      const left = new Float32Array(sampleCount)
      left[17] = Number.NaN
      return { left, right: new Float32Array(sampleCount) }
    })).rejects.toThrow(/finite/i)
  })

  test('keeps unity on the direct path', () => {
    expect(sourceTimeAudioPolicy(clipAt(100))).toEqual({
      status: 'supported',
      kind: 'direct',
    })
  })
})

describe('constant-rate WSOLA output', () => {
  test('returns the requested length on both new planes', async () => {
    const session = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    const source = sineReader(440)
    const inputs: StereoPcm[] = []
    const output = await session.pull(12_345, (sampleCount) => {
      const input = source(sampleCount)
      inputs.push(input)
      return input
    })
    expect(output.left).toHaveLength(12_345)
    expect(output.right).toHaveLength(12_345)
    expect(output.left).not.toBe(inputs[0]!.left)
    expect(output.right).not.toBe(inputs[0]!.right)
  })

  test('is bit-identical for equal sessions, pulls, and source bytes', async () => {
    const first = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    const second = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    const firstReader = sineReader(440)
    const secondReader = sineReader(440)
    for (const count of [257, 4_096, 777, 8_192]) {
      const left = await first.pull(count, firstReader)
      const right = await second.pull(count, secondReader)
      expect(left.left).toEqual(right.left)
      expect(left.right).toEqual(right.right)
    }
  })

  test.each([
    { percent: 200, wrongPitch: 880 },
    { percent: 50, wrongPitch: 220 },
  ])('keeps a 440 Hz sine near pitch at $percent%', async ({
    percent,
    wrongPitch,
  }) => {
    const session = createConstantRateAudioStretcher({
      stretch: stretchAt(percent),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    const output = await session.pull(SAMPLE_RATE, sineReader(440))
    const measured = estimateFrequency(output.left)
    expectNearPitch(measured, 440)
    expect(Math.abs(measured - 440)).toBeLessThan(Math.abs(measured - wrongPitch))
  })

  test('applies one selected lag to both stereo planes', async () => {
    const session = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    const output = await session.pull(16_384, sineReader(440))
    expect(output.left).toEqual(output.right)
  })

  test('measures main-thread pull cost against a 100ms pump window', async () => {
    const pumpSamples = SAMPLE_RATE / 10
    const lookaheadSamples = Math.round(SAMPLE_RATE * 0.75)
    const rows: Array<{ percent: number; pumpMs: number; lookaheadMs: number }> = []
    for (const percent of [25, 50, 200, 400]) {
      const pumpSession = createConstantRateAudioStretcher({
        stretch: stretchAt(percent),
        sampleRate: SAMPLE_RATE,
        outputStartSample: 0,
      })
      const pumpStarted = performance.now()
      await pumpSession.pull(pumpSamples, sineReader(440))
      const pumpMs = performance.now() - pumpStarted
      pumpSession.close()

      const lookaheadSession = createConstantRateAudioStretcher({
        stretch: stretchAt(percent),
        sampleRate: SAMPLE_RATE,
        outputStartSample: 0,
      })
      const lookaheadStarted = performance.now()
      await lookaheadSession.pull(lookaheadSamples, sineReader(440))
      const lookaheadMs = performance.now() - lookaheadStarted
      lookaheadSession.close()
      rows.push({ percent, pumpMs, lookaheadMs })
    }
    const slow = rows.find((row) => row.percent === 25)
    expect(slow).toBeDefined()
    expect(slow!.pumpMs).toBeLessThan(80)
    expect(slow!.lookaheadMs).toBeLessThan(400)
  })

  test('matches one large pull when sequential pulls concatenate', async () => {
    const sequential = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    const single = createConstantRateAudioStretcher({
      stretch: stretchAt(200),
      sampleRate: SAMPLE_RATE,
      outputStartSample: 0,
    })
    const sequentialReader = sineReader(440)
    const first = await sequential.pull(3_072, sequentialReader)
    const second = await sequential.pull(5_120, sequentialReader)
    const combined = new Float32Array(8_192)
    combined.set(first.left)
    combined.set(second.left, first.left.length)
    const whole = await single.pull(8_192, sineReader(440))
    expect(combined).toEqual(whole.left)
  })
})
