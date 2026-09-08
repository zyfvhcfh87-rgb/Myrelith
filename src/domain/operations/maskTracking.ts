/** One immutable attachment edit; the app owns source provenance and portable admission. */
import { clipAnimation } from '../clipAnimation'
import { maskTrackingAnimation, maskTrackingOwnedTracks, maskTrackingReviewKey, maskTrackingTarget, type MaskTrackingPlan } from '../maskTracking'
import type { TimelineDoc } from '../schema'
import { replaceClipAnimation } from './animation'
import { locateClip } from './operationInternals'

export type MaskTrackingOperationResult =
  | { readonly ok: true; readonly changed: boolean; readonly doc: TimelineDoc }
  | { readonly ok: false; readonly changed: false; readonly doc: TimelineDoc; readonly reason: string }

/** A Boolean is deliberately insufficient: consent names the exact reviewed candidate. */
export function applyMaskTrackingWithResult(doc: TimelineDoc, plan: MaskTrackingPlan, replacementConsent: string | null): MaskTrackingOperationResult {
  try {
    const { clip } = maskTrackingTarget(doc, plan.target, plan.selectionGlobalFrame)
    const current = clipAnimation(clip)
    const animation = maskTrackingAnimation(doc, clip, plan)
    const reviewKey = maskTrackingReviewKey(plan, current)
    if (plan.reviewKey !== reviewKey) throw new Error('The mask attachment changed; review a fresh candidate.')
    if (maskTrackingOwnedTracks(current, plan.target, plan.includeSize).length > 0 && replacementConsent !== reviewKey) throw new Error('Replacing these complete mask scalar tracks requires confirmation of the current candidate, including keys outside the accepted range.')
    if (JSON.stringify(animation) === JSON.stringify(current)) return { ok: true, changed: false, doc }
    return { ok: true, changed: true, doc: replaceClipAnimation(doc, locateClip(doc, clip.id)!, animation) }
  } catch (error) {
    return { ok: false, changed: false, doc, reason: error instanceof Error ? error.message : 'The mask tracking attachment could not be applied.' }
  }
}
