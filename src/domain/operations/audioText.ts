import type { ClipAudioSettings, ClipId, TimelineDoc, TextProps } from '../schema';
import { clipAudioSettings, clipAudioSettingsValidationError } from '../clipInspector';
import { textOverlayName, textPropsValidationError } from '../textOverlay';
import { locateClip, reject, withTrack } from './operationInternals';
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
