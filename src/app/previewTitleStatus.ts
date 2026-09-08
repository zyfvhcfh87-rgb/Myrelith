import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import type { PreviewTitleNotice } from '../state/previewStatusStore'

/** Small current-frame projection; repeated nested occurrences share a notice. */
export function projectPreviewTitleNotices(plan: VideoCompositionPlan): readonly PreviewTitleNotice[] {
  const notices: PreviewTitleNotice[] = []
  const seen = new Set<string>()
  for (const item of plan.items) {
    if (item.kind !== 'title') continue
    for (const notice of item.title.notices) {
      const key = JSON.stringify([item.clip.id, notice.elementId, notice.kind, notice.detail])
      if (seen.has(key)) continue
      seen.add(key)
      notices.push({ ...notice, clipId: item.clip.id, clipName: item.clip.name })
    }
  }
  return notices.sort((left, right) => Number(right.kind === 'unavailable') - Number(left.kind === 'unavailable')).slice(0, 32)
}
