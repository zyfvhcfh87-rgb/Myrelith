/**
 * Pure immutable TimelineDoc edit facade.
 *
 * Focused implementations live under domain/operations; this stable facade
 * preserves every existing caller import and the same-reference rejection
 * contract documented in ARCHITECTURE.md.
 */
export type { CrossfadeSettings, TrimEdge } from './operations/operationTypes'
export {
  addCrossfade,
  addCrossfadeWithSourceBounds,
  removeTransition,
  setCrossfadeDuration,
  setCrossfadeDurationWithSourceBounds,
  setCrossfadeSettings,
  setCrossfadeSettingsWithSourceBounds,
} from './operations/transitions'
export { clipFromAsset, clipFromAssetRange, createTextClip, insertClip } from './operations/creation'
export {
  clearClipSpeedRamp,
  deleteClip,
  moveClip,
  moveClipsByDelta,
  removeClipSpeedPoint,
  retimeClip,
  rippleDelete,
  rippleTrim,
  setClipSpeedPoint,
  slideClip,
  slipClip,
  splitClipAtFrame,
  trimClip,
} from './operations/geometry'
export type {
  ClipTransformPatch,
  ClipVisualPatch,
  ClipVisualSettingsPatch,
} from './operations/visual'
export {
  updateClipTransform,
  updateClipVisual,
} from './operations/visual'
export {
  moveClipKeyframe,
  moveEffectKeyframe,
  removeClipKeyframe,
  removeEffectKeyframe,
  resetClipAnimationTrack,
  resetEffectAnimationTrack,
  setClipKeyframe,
  setEffectKeyframe,
} from './operations/animation'
export type { ClipFramingOperationResult } from './operations/framing'
export {
  applyDynamicZoom,
  applyDynamicZoomWithResult,
  applyMotionTrackingWithResult,
  applyVideoStabilizationWithResult,
  resetClipFramingAnimation,
  resetClipFramingAnimationWithResult,
  resetVideoStabilizationWithResult,
  updateClipVisualAtFrame,
} from './operations/framing'
export type {
  ClipAudioPatch,
  ClipAudioSettingsPatch,
  TextPropsPatch,
} from './operations/audioText'
export { updateClipAudio, updateTextClip } from './operations/audioText'
export type { TrackFlagsPatch } from './operations/tracks'
export {
  MAX_CLIP_VOLUME,
  addTrack,
  removeTrack,
  renameTrack,
  setClipVolume,
  setTrackFlags,
} from './operations/tracks'
export {
  addEffect,
  removeEffect,
  reorderEffect,
  resetEffect,
  setEffectEnabled,
  updateEffectParams,
  updateEffectParamsAtFrame,
} from './operations/effects'
