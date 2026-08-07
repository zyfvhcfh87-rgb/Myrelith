import { describe, expect, test } from 'vitest'
import { MediaJobScheduler } from '../../app/mediaJobScheduler'
import { measureMediaAnalysisScheduler } from './mediaAnalysisBenchmark'

describe('media analysis scheduler performance evidence', () => {
  test('records bounded queue, wait, decoder, cancellation, completion, and priority facts', async () => {
    const evidence = await measureMediaAnalysisScheduler({
      sleep: async () => {},
      createScheduler: (now) => new MediaJobScheduler({
        now,
        yieldControl: async () => {},
      }),
    })

    expect(evidence).toMatchObject({
      scenarioVersion: 'issue-56-100-assets-v1',
      scenarioAssetCount: 100,
      modeledLegacyLaunchAllDecoderCount: 145,
      budget: { maxConcurrentJobs: 2, maxDecoderSlots: 2 },
      finalQueueDepth: 0,
      finalActiveJobCount: 0,
      finalActiveDecoderCount: 0,
      maxQueueDepth: 100,
      maxActiveJobCount: 2,
      maxActiveDecoderCount: 2,
      enqueuedCount: 102,
      completedCount: 101,
      cancelledCount: 1,
      failedCount: 0,
      progressObserved: true,
      selectedStartedBeforeBackground: true,
      visibleStartedBeforeBackground: true,
      yieldStrategy: 'injected',
    })
    expect(evidence.waitTimeMs.count).toBe(102)
    expect(evidence.eventLoopDelayMs.count).toBeGreaterThanOrEqual(1)
    expect(evidence.startOrderPreview[0]).toBe('selected-099')
    expect(evidence.startOrderPreview.some((id) => id.startsWith('background-')))
      .toBe(true)
  })
})
