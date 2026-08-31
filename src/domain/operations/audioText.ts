import type { ClipAnimationProperty, ClipAudioSettings, ClipId, TimelineDoc, TextProps } from '../schema';
import {
  animationPropertyValueError,
  clipAnimation,
  documentAnimationKeyframeGrowthAllowed,
  isClipPropertyAnimated,
  LINEAR_ANIMATION_EASING,
  upsertAnimationKeyframe,
} from '../clipAnimation';
import { clipAudioSettings, clipAudioSettingsValidationError } from '../clipInspector';
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from '../sourceTimeMap';
import { textOverlayName, textPropsValidationError } from '../textOverlay';
import { locateClip, reject, withTrack } from './operationInternals';
import { replaceClipAnimation } from './animation';
import { MAX_CLIP_VOLUME } from './tracks';

export type ClipAudioSettingsPatch = Partial<ClipAudioSettings>

export interface ClipAudioPatch {
  volume?: number
  audio?: ClipAudioSettingsPatch
}

const AUDIO_SETTING_KEYS = new Set<keyof ClipAudioSettings>([
  'enabled',
  'balance',
  'fadeInFrames',
  'fadeOutFrames',
])

function sameAudio(
  left: ClipAudioSettings,
  right: ClipAudioSettings,
): boolean {
  return left.enabled === right.enabled
    && left.balance === right.balance
    && left.fadeInFrames === right.fadeInFrames
    && left.fadeOutFrames === right.fadeOutFrames
}

/** Atomically edit volume, enabled state, balance, and authored fades. */
export function updateClipAudio(
  doc: TimelineDoc,
  clipId: ClipId,
  patch: ClipAudioPatch,
): TimelineDoc {
  const op = 'updateClipAudio'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const audioPatch = patch.audio ?? {}
  const audioKeys = Object.keys(audioPatch) as Array<keyof ClipAudioSettings>
  for (const key of audioKeys) {
    if (!AUDIO_SETTING_KEYS.has(key)) {
      return reject(doc, op, `unknown audio property ${String(key)}`)
    }
  }
  const hasVolume = patch.volume !== undefined
  if (hasVolume && !Number.isFinite(patch.volume)) {
    return reject(doc, op, `volume must be a finite number, got ${patch.volume}`)
  }
  if (!hasVolume && audioKeys.length === 0) {
    return reject(doc, op, 'empty patch — nothing to change')
  }

  const currentAudio = clipAudioSettings(loc.clip)
  const audio: ClipAudioSettings = { ...currentAudio, ...audioPatch }
  const audioError = clipAudioSettingsValidationError(
    audio,
    loc.clip.timelineRange.durationFrames,
  )
  if (audioError) return reject(doc, op, audioError)
  const volume = hasVolume
    ? Math.min(MAX_CLIP_VOLUME, Math.max(0, patch.volume as number))
    : loc.clip.volume
  if (volume === loc.clip.volume && sameAudio(audio, currentAudio)) return doc

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, volume, audio }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/**
 * Edit static audio fields, or upsert volume/balance keys when that property
 * is already animated. One history entry. Playhead must sit inside the clip
 * for animated edits.
 */
export function updateClipAudioAtFrame(
  doc: TimelineDoc,
  clipId: ClipId,
  timelineFrame: number,
  patch: ClipAudioPatch,
): TimelineDoc {
  const op = 'updateClipAudioAtFrame'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (!Number.isSafeInteger(timelineFrame)) {
    return reject(doc, op, `timeline frame must be a safe integer, got ${timelineFrame}`)
  }

  const animatedValues = new Map<ClipAnimationProperty, number>()
  let staticVolume = patch.volume
  if (patch.volume !== undefined && isClipPropertyAnimated(loc.clip, 'volume')) {
    const volume = Math.min(MAX_CLIP_VOLUME, Math.max(0, patch.volume))
    const valueError = animationPropertyValueError('volume', volume)
    if (valueError) return reject(doc, op, valueError)
    staticVolume = undefined
    animatedValues.set('volume', volume)
  }
  const audioPatch = { ...(patch.audio ?? {}) }
  if (
    audioPatch.balance !== undefined
    && isClipPropertyAnimated(loc.clip, 'balance')
  ) {
    const valueError = animationPropertyValueError('balance', audioPatch.balance)
    if (valueError) return reject(doc, op, valueError)
    animatedValues.set('balance', audioPatch.balance)
    delete audioPatch.balance
  }

  const localFrame = timelineFrame - loc.clip.timelineRange.startFrame
  if (
    animatedValues.size > 0
    && (
      localFrame < 0
      || localFrame >= loc.clip.timelineRange.durationFrames
    )
  ) return reject(doc, op, 'playhead must be inside the clip to edit animated values')

  const additionalKeyframes = [...animatedValues.keys()].filter((property) => (
    !clipAnimation(loc.clip).tracks
      .find((track) => track.property === property)
      ?.keyframes.some((keyframe) => keyframe.frame === localFrame)
  )).length
  if (!documentAnimationKeyframeGrowthAllowed(doc, additionalKeyframes)) {
    return reject(doc, op, 'animated edit would exceed the document keyframe budget')
  }

  const staticPatch: ClipAudioPatch = {
    ...(staticVolume === undefined ? {} : { volume: staticVolume }),
    ...(Object.keys(audioPatch).length === 0 ? {} : { audio: audioPatch }),
  }
  const hasStaticPatch = Object.keys(staticPatch).length > 0
  let working = doc
  if (hasStaticPatch) {
    const next = updateClipAudio(doc, clipId, staticPatch)
    if (next === doc && staticAudioPatchDiffers(loc.clip, staticPatch)) return doc
    working = next
  }
  if (animatedValues.size === 0) return working

  const workingLoc = locateClip(working, clipId)
  if (!workingLoc) return doc
  let animation = clipAnimation(workingLoc.clip)
  for (const [property, value] of animatedValues) {
    const existing = animation.tracks
      .find((track) => track.property === property)
      ?.keyframes.find((keyframe) => keyframe.frame === localFrame)
    let next
    try {
      next = upsertAnimationKeyframe(animation, property, {
        frame: localFrame,
        sourceTimeTicks: sourceTicksAtTimelineOffset(
          clipSourceTimeMap(workingLoc.clip),
          localFrame,
        ),
        value,
        easing: existing?.easing ?? LINEAR_ANIMATION_EASING,
      })
    } catch {
      return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
    }
    if (!next) return reject(doc, op, 'animated edit exceeds keyframe limits')
    animation = next
  }
  return replaceClipAnimation(working, workingLoc, animation)
}

function staticAudioPatchDiffers(clip: { volume: number }, patch: ClipAudioPatch): boolean {
  if (patch.volume !== undefined && patch.volume !== clip.volume) return true
  return patch.audio !== undefined && Object.keys(patch.audio).length > 0
}

/** Complete editable surface for one procedural text payload. */
export type TextPropsPatch = Partial<TextProps>

const TEXT_PROP_KEYS = new Set<keyof TextProps>([
  'content',
  'fontFamily',
  'fontSizePx',
  'color',
  'align',
  'bold',
  'italic',
  'boxWidthPx',
  'boxHeightPx',
  'paddingPx',
  'backgroundEnabled',
  'backgroundColor',
  'outlineEnabled',
  'outlineColor',
  'outlineWidthPx',
  'shadowEnabled',
  'shadowColor',
  'shadowBlurPx',
  'shadowOffsetXPx',
  'shadowOffsetYPx',
])

/**
 * Merge one text edit and reject unsupported values without substitution.
 * Geometry/timing remain untouched; one successful call is one history entry.
 */
export function updateTextClip(
  doc: TimelineDoc,
  clipId: ClipId,
  patch: TextPropsPatch,
): TimelineDoc {
  const op = 'updateTextClip'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (loc.clip.text === undefined) {
    return reject(doc, op, `clip ${clipId} is not a text overlay`)
  }
  const keys = Object.keys(patch) as Array<keyof TextProps>
  if (keys.length === 0) return reject(doc, op, 'empty patch — nothing to change')
  for (const key of keys) {
    if (!TEXT_PROP_KEYS.has(key)) {
      return reject(doc, op, `unknown text property ${String(key)}`)
    }
  }
  const text: TextProps = { ...loc.clip.text, ...patch }
  const error = textPropsValidationError(text)
  if (error) return reject(doc, op, error)
  if (keys.every((key) => Object.is(text[key], loc.clip.text?.[key]))) {
    return doc
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    name: patch.content === undefined
      ? loc.clip.name
      : textOverlayName(text.content),
    text,
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}
