/** Data-only animation editor facts exposed to the lazy UI through state. */
export { ANIMATION_EDIT_LIMITS, animationKeyKey, animationLaneKey, type AnimationKeyAddress, type AnimationLaneAddress } from '../domain/animationAddresses'
export type { AnimationBatchCommand } from '../domain/animationBatch'
export type { AnimationPasteMapping } from '../domain/animationClipboard'
export { buildAnimationLaneIndex, resolveAnimationFocusedLane, filterAnimationLanes, animationKeyGlyphs, animationLowerBound, animationKeyAt, animationValueAt, animationCurvePoints, ANIMATION_VIEW_LIMITS, type AnimationLaneRow, type AnimationLaneIndex, type AnimationLaneFilter } from '../domain/animationLaneIndex'
