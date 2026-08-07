import {
  summarizeDistribution,
  type MediaAnalysisSchedulerEvidence,
} from './contract'

export const MEDIA_ANALYSIS_SCENARIO_VERSION = 'issue-56-100-assets-v1'

type MediaAnalysisPriority = 'background' | 'visible' | 'selected'

interface MediaAnalysisPlanItem {
  readonly id: string
  readonly priority: MediaAnalysisPriority
  readonly decoderSlots: number
}

interface MediaAnalysisJobContext {
  readonly signal: AbortSignal
  reportProgress(progress: number): void
  setActiveDecoderCount(count: number): void
}

interface MediaAnalysisSchedulerSnapshot {
  readonly budget: MediaAnalysisSchedulerEvidence['budget']
  readonly aging: MediaAnalysisSchedulerEvidence['aging']
  readonly yieldStrategy: MediaAnalysisSchedulerEvidence['yieldStrategy']
  readonly queueDepth: number
  readonly activeJobCount: number
  readonly activeDecoderCount: number
  readonly maxQueueDepth: number
  readonly maxActiveJobCount: number
  readonly maxActiveDecoderCount: number
  readonly enqueuedCount: number
  readonly completedCount: number
  readonly cancelledCount: number
  readonly failedCount: number
  readonly waitTimesMs: readonly number[]
  readonly jobs: readonly { readonly progress: number }[]
}

export interface MediaAnalysisSchedulerAdapter {
  enqueue(request: {
    readonly id: string
    readonly generation: number
    readonly priority: MediaAnalysisPriority
    readonly resources: { readonly decoderSlots: number }
    readonly run: (context: MediaAnalysisJobContext) => Promise<void>
  }): void
  cancel(id: string, reason: 'removed'): boolean
  subscribe(listener: (snapshot: MediaAnalysisSchedulerSnapshot) => void): () => void
  whenIdle(): Promise<MediaAnalysisSchedulerSnapshot>
  dispose(): void
}

export interface MediaAnalysisBenchmarkOptions {
  readonly now?: () => number
  readonly sleep?: () => Promise<void>
  readonly createScheduler: (
    now: () => number,
  ) => MediaAnalysisSchedulerAdapter
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error('Media analysis benchmark cancellation')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) rejectAbort()
    else signal.addEventListener('abort', rejectAbort, { once: true })
  })
}

function scenarioPlan(): MediaAnalysisPlanItem[] {
  const plans: MediaAnalysisPlanItem[] = []
  for (let index = 0; index < 100; index++) {
    const priority: MediaAnalysisPriority = index === 99
      ? 'selected'
      : index >= 91 ? 'visible' : 'background'
    plans.push({
      id: `${priority}-${String(index).padStart(3, '0')}`,
      priority,
      // The deterministic fixture's video cohort models an A/V source; audio
      // and still entries reserve one decoder each.
      decoderSlots: index < 45 ? 2 : 1,
    })
  }
  return plans
}

export async function measureMediaAnalysisScheduler(
  options: MediaAnalysisBenchmarkOptions,
): Promise<MediaAnalysisSchedulerEvidence> {
  const now = options.now ?? (() => performance.now())
  const sleep = options.sleep
    ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  const scheduler = options.createScheduler(now)
  const cancellableStarted = deferred()
  const blockerStarted = deferred()
  const blockerRelease = deferred()
  const startOrder: string[] = []
  const loopGaps: number[] = []
  let progressObserved = false
  let lastLoopTick = now()
  const timer = setInterval(() => {
    const current = now()
    loopGaps.push(Math.max(0, current - lastLoopTick))
    lastLoopTick = current
  }, 0)
  const unsubscribe = scheduler.subscribe((snapshot) => {
    if (snapshot.jobs.some((job) => job.progress > 0 && job.progress < 1)) {
      progressObserved = true
    }
  })

  const runScenarioJob = (plan: MediaAnalysisPlanItem) =>
    async (context: MediaAnalysisJobContext): Promise<void> => {
      startOrder.push(plan.id)
      context.setActiveDecoderCount(plan.decoderSlots)
      try {
        context.reportProgress(0.25)
        await sleep()
        context.reportProgress(0.75)
        await Promise.resolve()
      } finally {
        context.setActiveDecoderCount(0)
      }
    }

  try {
    scheduler.enqueue({
      id: 'cancellation-probe',
      generation: 1,
      priority: 'selected',
      resources: { decoderSlots: 1 },
      run: async (context) => {
        context.setActiveDecoderCount(1)
        cancellableStarted.resolve()
        try {
          await abortPromise(context.signal)
        } finally {
          context.setActiveDecoderCount(0)
        }
      },
    })
    scheduler.enqueue({
      id: 'capacity-blocker',
      generation: 1,
      priority: 'selected',
      resources: { decoderSlots: 1 },
      run: async (context) => {
        context.setActiveDecoderCount(1)
        blockerStarted.resolve()
        try {
          await blockerRelease.promise
        } finally {
          context.setActiveDecoderCount(0)
        }
      },
    })
    await Promise.all([cancellableStarted.promise, blockerStarted.promise])

    const plans = scenarioPlan()
    for (const plan of plans) {
      scheduler.enqueue({
        id: plan.id,
        generation: 1,
        priority: plan.priority,
        resources: { decoderSlots: plan.decoderSlots },
        run: runScenarioJob(plan),
      })
    }
    scheduler.cancel('cancellation-probe', 'removed')
    blockerRelease.resolve()
    const snapshot = await scheduler.whenIdle()
    const scenarioOrder = startOrder.filter((id) => id !== 'capacity-blocker')
    const firstBackground = scenarioOrder.findIndex((id) => id.startsWith('background-'))
    const selectedIndex = scenarioOrder.findIndex((id) => id.startsWith('selected-'))
    const visibleIndex = scenarioOrder.findIndex((id) => id.startsWith('visible-'))
    const delays = loopGaps.length > 0
      ? loopGaps
      : [Math.max(0, now() - lastLoopTick)]
    return {
      scenarioVersion: MEDIA_ANALYSIS_SCENARIO_VERSION,
      scenarioAssetCount: plans.length,
      modeledLegacyLaunchAllDecoderCount: plans.reduce(
        (total, plan) => total + plan.decoderSlots,
        0,
      ),
      budget: { ...snapshot.budget },
      aging: { ...snapshot.aging },
      yieldStrategy: snapshot.yieldStrategy,
      finalQueueDepth: snapshot.queueDepth,
      maxQueueDepth: snapshot.maxQueueDepth,
      finalActiveJobCount: snapshot.activeJobCount,
      maxActiveJobCount: snapshot.maxActiveJobCount,
      finalActiveDecoderCount: snapshot.activeDecoderCount,
      maxActiveDecoderCount: snapshot.maxActiveDecoderCount,
      enqueuedCount: snapshot.enqueuedCount,
      completedCount: snapshot.completedCount,
      cancelledCount: snapshot.cancelledCount,
      failedCount: snapshot.failedCount,
      waitTimeMs: summarizeDistribution(snapshot.waitTimesMs),
      eventLoopDelayMs: summarizeDistribution(delays),
      progressObserved,
      selectedStartedBeforeBackground:
        selectedIndex >= 0 && firstBackground >= 0 && selectedIndex < firstBackground,
      visibleStartedBeforeBackground:
        visibleIndex >= 0 && firstBackground >= 0 && visibleIndex < firstBackground,
      startOrderPreview: scenarioOrder.slice(0, 12),
    }
  } finally {
    clearInterval(timer)
    unsubscribe()
    blockerRelease.resolve()
    scheduler.dispose()
  }
}
