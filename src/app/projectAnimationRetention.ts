/** App admission includes every retained named preview, not just the visible winner. */
import { animationRetentionError as domainRetentionError } from '../domain/animationProjectBudget'
import { retainedEffectPreviewDocuments } from '../state/transportStore'
export function animationRetentionError(state: Parameters<typeof domainRetentionError>[0], candidate: Parameters<typeof domainRetentionError>[1]): string | null {
  return domainRetentionError({ ...state, retainedTitlePreviewDocuments: retainedEffectPreviewDocuments() }, candidate)
}
