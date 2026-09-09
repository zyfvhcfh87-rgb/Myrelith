import { expect, test, vi } from 'vitest'
import { readBoundedSpeechResponse } from './modelCache'
test('forged declared lengths cannot enlarge the bounded body read', async () => {
  const cancelled = vi.fn()
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel: cancelled })
  await expect(readBoundedSpeechResponse(new Response(body, { headers: { 'content-length': '4' } }), 4)).rejects.toThrow('exceeds')
  expect(cancelled).toHaveBeenCalledOnce()
})
test('small fragmented chunks fill a fixed allocation and truncated bodies reject', async () => {
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array([i])); controller.close() } })
  expect([...new Uint8Array(await readBoundedSpeechResponse(new Response(body), 20))]).toEqual(Array.from({ length: 20 }, (_, i) => i))
  await expect(readBoundedSpeechResponse(new Response(new Uint8Array(3)), 4)).rejects.toThrow('truncated')
})
test('abort interrupts a pending read and releases its reader', async () => {
  const aborted = new AbortController(), cancel = vi.fn()
  const response = new Response(new ReadableStream({ cancel }))
  const reading = readBoundedSpeechResponse(response, 8, true, aborted.signal)
  aborted.abort()
  await expect(reading).rejects.toThrow()
  expect(cancel).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false)
})
