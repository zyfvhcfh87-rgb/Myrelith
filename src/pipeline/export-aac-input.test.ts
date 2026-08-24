import { describe, expect, test, vi } from 'vitest'
import {
  AAC_ENCODER_STARTUP_SAMPLES,
  AacInputAssembler,
  type AacInputChunk,
} from './export-aac-input'

function chunk(
  startSample: number,
  sampleCount: number,
  value: number,
): AacInputChunk {
  return {
    startSample,
    sampleCount,
    data: new Float32Array(sampleCount * 2).fill(value),
  }
}

describe('AacInputAssembler', () => {
  test('coalesces 60 fps mixer chunks into a stable AAC startup block', async () => {
    const assembler = new AacInputAssembler(2)
    const writes: AacInputChunk[] = []
    const write = vi.fn(async (output: AacInputChunk) => {
      writes.push(output)
    })

    await assembler.add(chunk(0, 800, 1), write)
    await assembler.add(chunk(800, 800, 2), write)
    expect(write).not.toHaveBeenCalled()

    await assembler.add(chunk(1_600, 800, 3), write)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      startSample: 0,
      sampleCount: AAC_ENCODER_STARTUP_SAMPLES,
    })
    expect(writes[0].data[0]).toBe(1)
    expect(writes[0].data[800 * 2]).toBe(2)
    expect(writes[0].data[1_600 * 2]).toBe(3)

    await assembler.flush(write)
    expect(writes[1]).toMatchObject({
      startSample: AAC_ENCODER_STARTUP_SAMPLES,
      sampleCount: 352,
    })
    expect(writes[1].data).toHaveLength(704)
    expect(new Set(writes[1].data)).toEqual(new Set([3]))
  })

  test('zero-pads a short stream to the native AAC startup minimum', async () => {
    const assembler = new AacInputAssembler(1)
    const writes: AacInputChunk[] = []
    const write = vi.fn(async (output: AacInputChunk) => {
      writes.push(output)
    })

    await assembler.add({
      startSample: 0,
      sampleCount: 800,
      data: new Float32Array(800).fill(0.5),
    }, write)
    await assembler.flush(write)

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      startSample: 0,
      sampleCount: AAC_ENCODER_STARTUP_SAMPLES,
    })
    expect(writes[0].data.slice(0, 800)).toEqual(
      new Float32Array(800).fill(0.5),
    )
    expect(writes[0].data.slice(800)).toEqual(
      new Float32Array(AAC_ENCODER_STARTUP_SAMPLES - 800),
    )
  })

  test('rejects gaps instead of inventing timeline samples', async () => {
    const assembler = new AacInputAssembler(2)
    const write = vi.fn(async (_output: AacInputChunk) => undefined)

    await assembler.add(chunk(0, 800, 1), write)
    await expect(assembler.add(chunk(801, 800, 2), write)).rejects.toThrow(
      'AAC input chunks must be sample-contiguous',
    )
  })
})
