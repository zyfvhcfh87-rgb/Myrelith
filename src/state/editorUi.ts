/**
 * State-layer facade for pure editor facts consumed by React surfaces.
 * Keeping these exports here preserves the ui -> state -> domain direction.
 */
export { CLIP_ATTRIBUTE_LABELS } from '../domain/clipAttributes'

export {
  adjustmentEditDeltaBounds,
  createAdjustmentItem,
  findAdjustment,
  locateAdjustment,
  resolveAdjustmentAtFrame,
} from '../domain/adjustmentItems'
export { DEFAULT_NORMALIZE_TARGET_LUFS } from '../domain/audioLoudness'
export {
  clipAudioEffects,
  masterAudioEffects,
  trackAudioEffects,
  audioEffectAppendBudgetError,
} from '../domain/audioEffectBounds'
export {
  COMPRESSOR_EFFECT_TYPE,
  COMPRESSOR_EFFECT_VERSION,
  COMPRESSOR_LIMITS,
  createCompressorEffect,
  createLimiterEffect,
  createNoiseGateEffect,
  createParametricEqEffect,
  EQ_BAND_GAIN_LIMITS,
  EQ_BAND_FREQ_LIMITS,
  EQ_BAND_Q_LIMITS,
  EQ_BAND_TYPES,
  LIMITER_EFFECT_TYPE,
  LIMITER_EFFECT_VERSION,
  LIMITER_LIMITS,
  NOISE_GATE_EFFECT_TYPE,
  NOISE_GATE_EFFECT_VERSION,
  NOISE_GATE_LIMITS,
  PARAMETRIC_EQ_EFFECT_TYPE,
  PARAMETRIC_EQ_EFFECT_VERSION,
  audioEffectRegistration,
  type EqBandType,
} from '../domain/audioEffectStack'
export { AUDIO_EFFECT_PRESETS } from '../domain/audioEffectPresets'
export {
  AUDIO_METER_CEILING_DB,
  AUDIO_METER_FLOOR_DB,
} from '../domain/audioMeter'
export {
  masterAudioSettings,
  mixerAudioTracks,
  trackBalance,
  trackVolume,
} from '../domain/audioMixer'
export {
  COLOR_ADJUST_EFFECT_TYPE,
  COLOR_ADJUST_LIMITS,
  createColorAdjustEffect,
  effectAnimationParameterSpec,
  resolvePostCompositeEffectStack,
} from '../domain/effectStack'
export {
  ANIMATABLE_AUDIO_PROPERTIES,
  ANIMATABLE_CLIP_PROPERTIES,
  ANIMATABLE_VISUAL_PROPERTIES,
  animationPropertyValueError,
  clipAnimationPropertyLabel,
  clipAnimationTrack,
  evaluateAnimationTrack,
  LINEAR_ANIMATION_EASING,
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  readClipAnimationProperty,
  resolveClipAnimationAtFrame,
} from '../domain/clipAnimation'
export {
  MAX_AUDIO_BALANCE,
  MAX_CLIP_SCALE,
  MAX_CLIP_VOLUME,
  MIN_AUDIO_BALANCE,
  MIN_CLIP_SCALE,
  MIN_CLIP_VOLUME,
  clipAudioSettings,
  DEFAULT_CLIP_AUDIO_SETTINGS,
} from '../domain/clipInspector'
export { linkedPartners } from '../domain/linking'
export { MAX_PROJECT_NAME_CHARACTERS } from '../domain/projectLimits'
export { docDurationFrames, findClip, trackOfClip } from '../domain/selectors'
export {
  clipAudioPresentation,
  clipSourceTimeMap,
  sourceTimeMapUsesSpeedCurve,
  sourceTimeSpeedAtTimelineOffset,
  sourceTimeSpeedPointsAtClip,
  sourceTimeRateFromPercent,
  sourceTimeRatePercent,
  sourceTimeMapWholeClipSpeed,
  sourceTimeSpeedRateFromPercent,
  sourceTimeSpeedRatePercent,
} from '../domain/sourceTimeMap'
export { rangeEnd, secondsToFrames } from '../domain/time'

export { SPATIAL_EFFECT_PARAMETERS, spatialEffectKind, spatialEffectParams } from '../domain/spatialEffectDefinitions'

export { COLOR_LUT_TYPE } from '../domain/colorLut'
export { isColorLutV1 } from '../domain/colorLutCatalog'
export { isColorGradingType } from '../domain/colorGradingEffects'
export { COLOR_CURVES_TYPE, COLOR_CURVE_LIMITS, COLOR_CURVE_CHANNELS, colorCurvesParams, parseColorCurve, compileColorCurve, type ColorCurve, type ColorCurveChannel } from '../domain/colorCurves'
export { COLOR_WHEELS_TYPE, COLOR_WHEEL_GROUPS, COLOR_WHEEL_LIMITS, COLOR_RGB, colorWheelsParams, colorWheelPosition, colorWheelAtPosition, colorWheelBrightness, type ColorWheelGroup } from '../domain/colorWheels'
