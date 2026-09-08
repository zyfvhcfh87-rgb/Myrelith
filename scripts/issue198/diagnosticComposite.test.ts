import { expect, test } from 'vitest'
import { createVideoCompositionPlanner, videoCompositionRequests } from '../../src/domain/videoCompositionPlan'
import { docDurationFrames } from '../../src/domain/selectors'
import { diagnosticDocument, diagnosticBounded } from './diagnosticComposite'

test('the local diagnostic document retains the original300-frame mapping and held path at127', () => {
  const { doc, asset, paths } = diagnosticDocument()
  expect(docDurationFrames(doc)).toBe(300)
  expect(doc).toMatchObject({ width: 1280, height: 720, frameRate: { num: 30, den: 1 }, masterVideoEffects: [] })
  const planner = createVideoCompositionPlanner(doc, new Map([[asset.id, asset.sourceBounds]]))
  for (const frame of [0, 126, 127, 128, 255, 299]) {
    const requests = videoCompositionRequests(planner.planFrame(frame))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.sourceFrame).toBe(frame)
    expect(requests[0]!.clip.effects[0]!.params.path).toBe(paths[Math.min(frame, 255) % 2])
    expect(requests[0]!.clip.effects[0]!.params.feather).toBe(0.05)
  }
})
test('browser diagnostic deadlines reject a stalled owner and clear successful timers', async () => {
  expect(await diagnosticBounded(Promise.resolve(17), 1000, 'ready')).toBe(17)
  await expect(diagnosticBounded(new Promise(() => {}), 5, 'stalled source')).rejects.toThrow('stalled source exceeded 5 ms')
})
