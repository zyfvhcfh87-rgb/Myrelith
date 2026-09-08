import { afterEach, describe, expect, test, vi } from 'vitest'
import { projectPreviewTitleNotices } from './previewTitleStatus'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { createVideoCompositionPlanner } from '../domain/videoCompositionPlan'
import { expandedTitleProject } from '../test/titleOwnerFixtures'

afterEach(() => usePreviewStatusStore.getState().resetPreviewStatus())
describe('current-frame title status', () => {
  test('deduplicates repeated nested owners, bounds the projection, and prioritizes unavailable reasons', () => {
    const plan = createVideoCompositionPlanner(expandedTitleProject().sequences[0], new Map()).planFrame(0)
    const item = plan.items[0]
    if (item.kind !== 'title') throw new Error('Expected a title')
    const repeated = { ...plan, items: Array(40).fill(item) }
    expect(projectPreviewTitleNotices(repeated)).toHaveLength(1)
    const crowded = { ...plan, items: Array.from({ length: 40 }, (_, index) => ({ ...item, clip: { ...item.clip, id: String(index) }, title: {
      elements: [], notices: [{ kind: index === 39 ? 'unavailable' as const : 'notice' as const, name: 'Text', elementId: 'element', detail: String(index) }],
    } })) }
    const result = projectPreviewTitleNotices(crowded)
    expect(result).toHaveLength(32)
    expect(result[0]).toMatchObject({ clipId: '39', kind: 'unavailable' })
  })
  test('identical frame status is a store no-op and replacement clears stale reasons', () => {
    const plan = createVideoCompositionPlanner(expandedTitleProject().sequences[0], new Map()).planFrame(0)
    const notices = projectPreviewTitleNotices(plan), changed = vi.fn()
    const unsubscribe = usePreviewStatusStore.subscribe(changed)
    try {
      usePreviewStatusStore.getState().setTitleNotices(notices)
      const current = usePreviewStatusStore.getState()
      usePreviewStatusStore.getState().setTitleNotices(structuredClone(notices))
      expect(usePreviewStatusStore.getState()).toBe(current)
      expect(changed).toHaveBeenCalledOnce()
      usePreviewStatusStore.getState().setTitleNotices(projectPreviewTitleNotices({ frame: 100, items: [] }))
      expect(usePreviewStatusStore.getState().titleNotices).toEqual([])
      usePreviewStatusStore.getState().setTitleNotices(notices)
      usePreviewStatusStore.getState().resetPreviewStatus()
      expect(usePreviewStatusStore.getState().titleNotices).toEqual([])
    } finally { unsubscribe() }
  })
})
