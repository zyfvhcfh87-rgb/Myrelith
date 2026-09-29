// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'vitest'

/** Loads the real worklet source into a minimal AudioWorkletGlobalScope. */
function loadProcessor(options: { startFrame: number; limitStopFrame?: number }) {
  const source = readFileSync(new URL('./voiceover-capture.worklet.js', import.meta.url), 'utf8')
  const posted: Array<Record<string, unknown>> = []
  let Processor: (new (options: unknown) => {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
    port: { onmessage: ((event: { data: unknown }) => void) | null }
  }) | null = null
  const scope: Record<string, unknown> = {
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (message: Record<string, unknown>) => posted.push(message) }
    },
    registerProcessor: (_name: string, ctor: typeof Processor) => { Processor = ctor },
  }
  runInNewContext(source, scope)
  const processor = new Processor!({ processorOptions: options })
  const render = (frame: number, value = 0.5) => {
    scope.currentFrame = frame
    const output = [new Float32Array(128)]
    return processor.process([[new Float32Array(128).fill(value)]], [output])
  }
  const acked = new Set<unknown>()
  const ackAll = () => {
    for (const message of posted.filter((m) => m.type === 'batch' && !acked.has(m.sequence))) {
      acked.add(message.sequence)
      processor.port.onmessage?.({ data: { type: 'ack', sequence: message.sequence } })
    }
  }
  const ack = (sequence: number) => processor.port.onmessage?.({ data: { type: 'ack', sequence } })
  const stop = (atFrame: number) => processor.port.onmessage?.({ data: { type: 'stop', atFrame } })
  const samples = () => posted.filter((m) => m.type === 'batch').flatMap((m) => {
    const view = new DataView(m.buffer as ArrayBuffer)
    return Array.from({ length: m.frames as number }, (_, index) => view.getInt16(index * 2, true))
  })
  return { render, ack, ackAll, stop, posted, samples }
}

describe('voiceover capture worklet', () => {
  test('a first captured block past the anchor is a missed start, not a late take', () => {
    const w = loadProcessor({ startFrame: 1_000 })
    expect(w.render(1_024)).toBe(false)
    expect(w.posted).toEqual([expect.objectContaining({ type: 'error', reason: 'Recording missed its start sample frame' })])
  })

  test('starts inside the anchor block and ends exactly at the stop frame', () => {
    const w = loadProcessor({ startFrame: 1_000 })
    w.render(896)
    w.render(1_024)
    w.stop(1_200)
    expect(w.render(1_152)).toBe(false)
    expect(w.posted.find((m) => m.type === 'started')).toEqual({ type: 'started', atFrame: 1_000 })
    expect(w.posted.at(-1)).toEqual({ type: 'stopped', endFrame: 1_200 })
    expect(w.samples()).toHaveLength(200)
    expect(new Set(w.samples())).toEqual(new Set([16_384]))
  })

  test('pads a skipped render span with silence and reports it', () => {
    const w = loadProcessor({ startFrame: 0 })
    w.render(0)
    w.render(128)
    // The audio thread skipped 3 quanta (384 frames).
    w.render(640)
    w.stop(896)
    w.render(768)
    const gap = w.posted.find((m) => m.type === 'gap')
    expect(gap).toEqual({ type: 'gap', atFrame: 256, frames: 384 })
    const pcm = w.samples()
    expect(pcm).toHaveLength(896)
    expect(pcm.slice(256, 640).every((value) => value === 0)).toBe(true)
    expect(pcm.slice(640, 768).every((value) => value === 16_384)).toBe(true)
    expect(w.posted.at(-1)).toEqual({ type: 'stopped', endFrame: 896 })
  })

  test('a repeated render quantum is reported and never rewrites written frames', () => {
    const w = loadProcessor({ startFrame: 0 })
    w.render(0, 0.25)
    w.render(128, 0.25)
    expect(w.render(128, 0.75)).toBe(true) // the same quantum again
    w.stop(384)
    w.render(256, 0.5)
    expect(w.posted.find((m) => m.type === 'gap')).toEqual({ type: 'gap', atFrame: 128, frames: -128 })
    const pcm = w.samples()
    expect(pcm).toHaveLength(384)
    expect(pcm.slice(0, 256).every((value) => value === 8_192)).toBe(true)
    expect(pcm.slice(256).every((value) => value === 16_384)).toBe(true)
  })

  test('a jump larger than half a second either way is a fault', () => {
    const large = loadProcessor({ startFrame: 0 })
    large.render(0)
    expect(large.render(128 + 24_001)).toBe(false)
    expect(large.posted.at(-1)).toMatchObject({ type: 'error', reason: expect.stringMatching(/24001 frames/) })

    const backwards = loadProcessor({ startFrame: 0 })
    for (let frame = 0; frame < 30_000; frame += 128) { backwards.render(frame); backwards.ackAll() }
    expect(backwards.render(0)).toBe(false)
    expect(backwards.posted.at(-1)).toMatchObject({ type: 'error', reason: expect.stringMatching(/-30080 frames/) })
  })

  test('the pre-scheduled limit stops without a stop message; Stop may only shorten it', () => {
    const w = loadProcessor({ startFrame: 0, limitStopFrame: 300 })
    w.render(0)
    w.render(128)
    expect(w.render(256)).toBe(false)
    expect(w.posted.at(-1)).toEqual({ type: 'stopped', endFrame: 300 })
    expect(w.samples()).toHaveLength(300)
  })

  test('a repeated acknowledgement is a protocol fault', () => {
    const w = loadProcessor({ startFrame: 0 })
    for (let frame = 0; frame < 8_192; frame += 128) w.render(frame)
    w.ack(1)
    w.ack(1)
    expect(w.posted.at(-1)).toMatchObject({ type: 'error', reason: 'Unexpected recording acknowledgement' })
    expect(w.render(8_192)).toBe(false)
  })

  test('stops for overrun at four unacknowledged batches and retires the processor', () => {
    const w = loadProcessor({ startFrame: 0 })
    let frame = 0
    let alive = true
    while (alive && frame < 8_192 * 6) { alive = w.render(frame); frame += 128 }
    expect(alive).toBe(false)
    expect(w.posted.filter((m) => m.type === 'batch')).toHaveLength(4)
    expect(w.posted.at(-1)).toEqual({ type: 'overrun', endFrame: 8_192 * 4 })
    expect(w.render(frame)).toBe(false)
  })

  test('acknowledged batches keep a long take flowing with contiguous sequence numbers', () => {
    const w = loadProcessor({ startFrame: 0 })
    for (let frame = 0; frame < 8_192 * 10; frame += 128) {
      expect(w.render(frame)).toBe(true)
      w.ackAll()
    }
    const batches = w.posted.filter((m) => m.type === 'batch')
    expect(batches).toHaveLength(10)
    expect(batches.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(batches.map((m) => m.startFrame)).toEqual(batches.map((_, index) => index * 8_192))
    expect(batches.every((m) => m.peak === 16_384 / 32_768)).toBe(true)
  })
})
