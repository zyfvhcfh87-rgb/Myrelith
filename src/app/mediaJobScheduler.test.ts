import { describe, expect, test, vi } from 'vitest'
import {
  MediaJobExecutionError,
  MediaJobScheduler,
  type MediaJobContext,
  type MediaJobPriority,
} from './mediaJobScheduler'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function enqueue(
  scheduler: MediaJobScheduler,
  id: string,
  priority: MediaJobPriority,
  slots: number,
  run: (context: MediaJobContext) => Promise<void>,
  generation = 1,
): void {
  scheduler.enqueue({
    id,
    generation,
    priority,
    resources: { decoderSlots: slots },
    run,
  })
}

describe('MediaJobScheduler', () => {
  test('bounds active assets and decoder slots while exposing progress and wait evidence', async () => {
    let now = 100
    const scheduler = new MediaJobScheduler({
      now: () => now,
      yieldControl: async () => {},
    })
    const first = deferred()
    const second = deferred()
    const third = deferred()
    const runs: string[] = []
    const work = (id: string, gate: { promise: Promise<void> }, decoders: number) =>
      async (context: MediaJobContext) => {
        runs.push(id)
        context.reportProgress(0.25)
        context.setActiveDecoderCount(decoders)
        await gate.promise
        context.setActiveDecoderCount(0)
      }

    enqueue(scheduler, 'video-av', 'background', 2, work('video-av', first, 2))
    enqueue(scheduler, 'audio-a', 'background', 1, work('audio-a', second, 1))
    enqueue(scheduler, 'image-a', 'background', 1, work('image-a', third, 1))
    now = 125
    await flush()

    expect(runs).toEqual(['video-av'])
    expect(scheduler.snapshot()).toMatchObject({
      queueDepth: 2,
      activeJobCount: 1,
      activeDecoderCount: 2,
      maxQueueDepth: 3,
      maxActiveJobCount: 1,
      maxActiveDecoderCount: 2,
      waitTimesMs: [25],
    })
    expect(scheduler.snapshot().jobs.find((job) => job.id === 'video-av'))
      .toMatchObject({ state: 'running', progress: 0.25 })

    first.resolve()
    await flush()
    expect(runs).toEqual(['video-av', 'audio-a', 'image-a'])
    expect(scheduler.snapshot()).toMatchObject({
      activeJobCount: 2,
      activeDecoderCount: 2,
      maxActiveJobCount: 2,
      maxActiveDecoderCount: 2,
    })

    second.resolve()
    third.resolve()
    const evidence = await scheduler.whenIdle()
    expect(evidence).toMatchObject({
      queueDepth: 0,
      activeJobCount: 0,
      activeDecoderCount: 0,
      enqueuedCount: 3,
      completedCount: 3,
      cancelledCount: 0,
      failedCount: 0,
    })
  })

  test('selected work wins immediately while aging lets old background work beat fresh priority', async () => {
    let now = 0
    const scheduler = new MediaJobScheduler({
      budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
      now: () => now,
      yieldControl: async () => {},
      agingIntervalMs: 1_000,
      agingStep: 1,
    })
    const blocker = deferred()
    const oldBackground = deferred()
    const freshSelected = deferred()
    const order: string[] = []

    enqueue(scheduler, 'blocker', 'selected', 1, async () => {
      order.push('blocker')
      await blocker.promise
    })
    await flush()
    enqueue(scheduler, 'old-background', 'background', 1, async () => {
      order.push('old-background')
      await oldBackground.promise
    })
    now = 10_000
    enqueue(scheduler, 'fresh-selected', 'selected', 1, async () => {
      order.push('fresh-selected')
      await freshSelected.promise
    })

    blocker.resolve()
    await flush()
    expect(order).toEqual(['blocker', 'old-background'])
    oldBackground.resolve()
    await flush()
    expect(order).toEqual(['blocker', 'old-background', 'fresh-selected'])
    freshSelected.resolve()
    await scheduler.whenIdle()
  })

  test('reserves capacity for aged multi-decoder work instead of starving it with smaller jobs', async () => {
    let now = 0
    const scheduler = new MediaJobScheduler({
      now: () => now,
      yieldControl: async () => {},
      agingIntervalMs: 1_000,
      agingStep: 1,
    })
    const firstBlocker = deferred()
    const secondBlocker = deferred()
    const video = deferred()
    const small = deferred()
    const order: string[] = []
    enqueue(scheduler, 'blocker-a', 'selected', 1, async () => {
      order.push('blocker-a')
      await firstBlocker.promise
    })
    enqueue(scheduler, 'blocker-b', 'selected', 1, async () => {
      order.push('blocker-b')
      await secondBlocker.promise
    })
    await flush()
    enqueue(scheduler, 'aged-video', 'background', 2, async () => {
      order.push('aged-video')
      await video.promise
    })
    now = 10_000
    enqueue(scheduler, 'fresh-small', 'selected', 1, async () => {
      order.push('fresh-small')
      await small.promise
    })

    firstBlocker.resolve()
    await flush()
    expect(order).toEqual(['blocker-a', 'blocker-b'])
    expect(scheduler.snapshot()).toMatchObject({
      activeJobCount: 1,
      activeDecoderCount: 0,
      queueDepth: 2,
    })

    secondBlocker.resolve()
    await flush()
    expect(order).toEqual(['blocker-a', 'blocker-b', 'aged-video'])
    video.resolve()
    await flush()
    small.resolve()
    await scheduler.whenIdle()
    expect(order).toEqual([
      'blocker-a',
      'blocker-b',
      'aged-video',
      'fresh-small',
    ])
  })

  test('reprioritizes queued work without changing its generation or FIFO identity', async () => {
    const scheduler = new MediaJobScheduler({
      budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
      yieldControl: async () => {},
    })
    const first = deferred()
    const visible = deferred()
    const background = deferred()
    const order: string[] = []
    enqueue(scheduler, 'first', 'selected', 1, async () => {
      order.push('first')
      await first.promise
    })
    await flush()
    enqueue(scheduler, 'background', 'background', 1, async () => {
      order.push('background')
      await background.promise
    })
    enqueue(scheduler, 'visible', 'background', 1, async () => {
      order.push('visible')
      await visible.promise
    })
    expect(scheduler.reprioritize('visible', 'visible')).toBe(true)

    first.resolve()
    await flush()
    expect(order).toEqual(['first', 'visible'])
    visible.resolve()
    await flush()
    background.resolve()
    await scheduler.whenIdle()
  })

  test('cancels a replaced generation and records a typed failure without retrying it', async () => {
    const scheduler = new MediaJobScheduler({
      budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
      yieldControl: async () => {},
    })
    const oldAborted = deferred()
    const replacement = deferred()
    enqueue(scheduler, 'asset', 'background', 1, async ({ signal }) => {
      signal.addEventListener('abort', () => oldAborted.resolve(), { once: true })
      await oldAborted.promise
      throw new Error('aborted work settled')
    }, 1)
    await flush()

    enqueue(scheduler, 'asset', 'selected', 1, async () => {
      await replacement.promise
      throw new MediaJobExecutionError('decode-failed', 'waveform broke')
    }, 2)
    await flush()
    expect(scheduler.snapshot().cancelledCount).toBe(1)
    replacement.resolve()
    const evidence = await scheduler.whenIdle()
    expect(evidence).toMatchObject({
      enqueuedCount: 2,
      completedCount: 0,
      cancelledCount: 1,
      failedCount: 1,
      lastFailures: [{
        id: 'asset',
        generation: 2,
        code: 'decode-failed',
        detail: 'waveform broke',
      }],
    })
  })

  test('contains one job failure and continues queued sibling work', async () => {
    const scheduler = new MediaJobScheduler({
      budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
      yieldControl: async () => {},
    })
    const completed: string[] = []
    enqueue(scheduler, 'broken', 'selected', 1, async () => {
      throw new MediaJobExecutionError('decode-failed', 'bad media')
    })
    enqueue(scheduler, 'sibling', 'background', 1, async () => {
      completed.push('sibling')
    })

    const evidence = await scheduler.whenIdle()
    expect(completed).toEqual(['sibling'])
    expect(evidence).toMatchObject({
      completedCount: 1,
      failedCount: 1,
    })
    expect(evidence.queueDepth).toBe(0)
    expect(evidence.lastFailures[0]).toMatchObject({
      id: 'broken',
      code: 'decode-failed',
    })
  })

  test('bounds retained failure details before snapshots clone them', async () => {
    const scheduler = new MediaJobScheduler({
      budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
      yieldControl: async () => {},
    })
    enqueue(scheduler, 'oversized-failure', 'selected', 1, async () => {
      throw new Error('x'.repeat(4_096))
    })

    const evidence = await scheduler.whenIdle()
    expect(evidence.lastFailures).toHaveLength(1)
    expect(evidence.lastFailures[0]?.detail).toHaveLength(2_048)
    expect(evidence.lastFailures[0]?.detail).toMatch(/…$/)
    expect(scheduler.snapshot().lastFailures[0]?.detail).toBe(
      evidence.lastFailures[0]?.detail,
    )
  })

  test('cooperatively yields before launching a bulk batch', async () => {
    const releaseYield = deferred()
    const run = vi.fn(async () => {})
    const scheduler = new MediaJobScheduler({
      yieldControl: () => releaseYield.promise,
    })
    enqueue(scheduler, 'a', 'background', 1, run)
    enqueue(scheduler, 'b', 'background', 1, run)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(scheduler.snapshot().queueDepth).toBe(2)

    releaseYield.resolve()
    await scheduler.whenIdle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(scheduler.snapshot().yieldStrategy).toBe('injected')
  })
})
