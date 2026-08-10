/**
 * domain/operations.ts — Pure, immutable edit operations on a TimelineDoc.
 * Phase 1.1.
 *
 * Contract (ARCHITECTURE.md):
 * - Every operation returns a NEW TimelineDoc; the input is never mutated.
 * - Invalid operations return the ORIGINAL doc unchanged (same reference,
 *   so callers can detect rejection with `result === doc`) and log a
 *   console.warn explaining why.
 * - Invariants enforced here, assumed everywhere else:
 *   - clips on one track never overlap (half-open ranges),
 *   - clip duration >= 1 frame,
 *   - timed source ranges equal the integer envelope of SourceTimeMap,
 *   - still source range is exactly frame 0 with duration 1,
 *   - clips stay sorted by timelineRange.startFrame,
 *   - locked tracks reject all edits.
 *
 * Note: asset length is NOT known here (assets live in state/mediaStore), so
 * trimming past the end of the source material is validated at the store
 * layer, not in domain/. Trimming before frame 0 of the source IS caught.
 */

import type {
  Clip,
  ClipAnimationEasing,
  ClipAnimationKeyframe,
  ClipAnimationProperty,
  ClipAudioSettings,
  ClipId,
  ClipVisualSettings,
  CropInsets,
  Effect,
  EffectId,
  EffectParamValue,
  MediaAsset,
  SourceTimeRate,
  SourceTimeMap,
  SourceTimeSpeedEasing,
  TimeRange,
  TimelineDoc,
  Track,
  TrackId,
  TrackKind,
  Transition,
  TransitionId,
  TextProps,
  Transform,
} from './schema'
import {
  clipAnimation,
  clipAnimationValidationError,
  cloneClipAnimation,
  defaultClipAnimation,
  shiftClipAnimation,
  animationPropertyValueError,
  isClipPropertyAnimated,
  LINEAR_ANIMATION_EASING,
  moveAnimationKeyframe,
  removeAnimationKeyframe,
  removeAnimationTrack,
  upsertAnimationKeyframe,
} from './clipAnimation'
import {
  clipAudioSettings,
  clipAudioSettingsValidationError,
  clipVisualSettings,
  clipVisualSettingsValidationError,
  defaultClipAudioSettings,
  defaultClipVisualSettings,
  transformScaleValidationError,
} from './clipInspector'
import {
  crossfadeWindowsOverlap,
  resolveCrossfade,
} from './selectors'
import {
  evaluateCrossfadeDraft,
  evaluateCrossfadeUpdate,
  type SourceBoundsCatalog,
} from './crossfadePlan'
import { rangeEnd, rangeOverlap } from './time'
import {
  defaultTextProps,
  proceduralTextAssetId,
  textOverlayName,
  textPropsValidationError,
} from './textOverlay'
import {
  blendModeIntentValidationError,
  clipBlendModeIntent,
  DEFAULT_BLEND_MODE,
} from './blendModes'
import {
  effectParamsValidationError,
  effectRegistration,
  cloneEffectDescriptor,
} from './effectStack'
import {
  effectAppendBudgetError,
  effectDescriptorBoundsError,
  effectReplacementBudgetError,
} from './effectBounds'
import {
  clipSourceTimeMap,
  cloneSourceTimeMap,
  defaultSourceTimeMap,
  retimeClipAnimation,
  shiftClipAnimationSourceTimeIntent,
  sourceRangeForMap,
  sourceTicksAtTimelineOffset,
  sourceTimeMapAtOffset,
  sourceTimeMapForTimelineDuration,
  sourceTimeMapUsesSpeedCurve,
  sourceTimeMapValidationError,
  sourceTimeMapWithSpeedPoint,
  sourceTimeMapWithoutSpeedCurve,
  sourceTimeMapWithoutSpeedPoint,
  sourceTimeRateValidationError,
  timelineFramesWithinSourceMap,
  SOURCE_TIME_TICKS_PER_FRAME,
} from './sourceTimeMap'

/** Which clip edge a trim moves. */
export type TrimEdge = 'start' | 'end'

export interface CrossfadeSettings {
  durationFrames: number
  audio: Transition['audio']
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

/** Where a clip lives inside a doc. */
interface ClipLocation {
  trackIndex: number
  track: Track
  clipIndex: number
  clip: Clip
}

interface TransitionLocation {
  trackIndex: number
  track: Track
  transitionIndex: number
  transition: Transition
}

function locateClip(doc: TimelineDoc, clipId: ClipId): ClipLocation | null {
  for (let t = 0; t < doc.tracks.length; t++) {
    const track = doc.tracks[t]
    const c = track.clips.findIndex((cl) => cl.id === clipId)
    if (c !== -1) {
      return { trackIndex: t, track, clipIndex: c, clip: track.clips[c] }
    }
  }
  return null
}

/** Keep authored fades valid when a geometry edit shortens a clip. */
function withClampedAudioFades(clip: Clip): Clip {
  if (!clip.audio) return clip
  const maximum = clip.timelineRange.durationFrames
  const fadeInFrames = Math.min(clip.audio.fadeInFrames, maximum)
  const fadeOutFrames = Math.min(clip.audio.fadeOutFrames, maximum)
  return fadeInFrames === clip.audio.fadeInFrames
    && fadeOutFrames === clip.audio.fadeOutFrames
    ? clip
    : {
        ...clip,
        audio: { ...clip.audio, fadeInFrames, fadeOutFrames },
      }
}

/** Every occurrence on one owning track, so corrupt duplicate ids stay ambiguous. */
function locateTrackTransitions(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
): TransitionLocation[] {
  const locations: TransitionLocation[] = []
  const trackIndex = doc.tracks.findIndex((track) => track.id === trackId)
  if (trackIndex < 0) return locations
  const track = doc.tracks[trackIndex]
  for (let i = 0; i < track.transitions.length; i++) {
    const transition = track.transitions[i]
    if (transition.id === transitionId) {
      locations.push({ trackIndex, track, transitionIndex: i, transition })
    }
  }
  return locations
}

/** Rejection path: warn and hand back the SAME doc reference. */
function reject(doc: TimelineDoc, op: string, why: string): TimelineDoc {
  console.warn(`[operations] ${op} rejected: ${why}`)
  return doc
}

function byStart(a: Clip, b: Clip): number {
  return a.timelineRange.startFrame - b.timelineRange.startFrame
}

/** Rebuild a clip with the optional link key genuinely absent. */
function withoutLinkGroupId(clip: Clip): Clip {
  if (clip.linkGroupId === undefined) return clip
  const { linkGroupId: _linkGroupId, ...rest } = clip
  return rest
}

/** True when `range` overlaps any clip in `clips` other than `excludeId`. */
function overlapsAny(
  clips: readonly Clip[],
  range: TimeRange,
  excludeId?: ClipId,
): boolean {
  return clips.some(
    (c) => c.id !== excludeId && rangeOverlap(c.timelineRange, range),
  )
}

/** New doc with one track replaced (structural sharing everywhere else). */
function withTrack(
  doc: TimelineDoc,
  trackIndex: number,
  track: Track,
): TimelineDoc {
  const tracks = doc.tracks.slice()
  tracks[trackIndex] = track
  return { ...doc, tracks }
}

/** Transition array positions whose definitions resolve without overlap. */
function validTransitionIndexes(track: Track): Set<number> {
  const resolved = track.transitions.map((transition) =>
    resolveCrossfade(track, transition),
  )
  const invalid = new Set<number>()
  const indexesById = new Map<TransitionId, number[]>()

  for (let i = 0; i < track.transitions.length; i++) {
    if (!resolved[i]) invalid.add(i)
    const transition = track.transitions[i]
    const indexes = indexesById.get(transition.id)
    if (indexes) indexes.push(i)
    else indexesById.set(transition.id, [i])
  }

  for (const indexes of indexesById.values()) {
    if (indexes.length > 1) {
      for (const index of indexes) invalid.add(index)
    }
  }

  for (let left = 0; left < resolved.length; left++) {
    const leftWindow = resolved[left]
    if (!leftWindow) continue
    for (let right = left + 1; right < resolved.length; right++) {
      const rightWindow = resolved[right]
      if (
        rightWindow &&
        crossfadeWindowsOverlap(leftWindow, rightWindow)
      ) {
        invalid.add(left)
        invalid.add(right)
      }
    }
  }

  const indexes = new Set<number>()
  for (let i = 0; i < track.transitions.length; i++) {
    if (!invalid.has(i)) indexes.add(i)
  }
  return indexes
}

/**
 * Carry only transitions that were valid before a geometry edit and remain
 * valid afterwards. This prevents a stale serialized definition from
 * springing alive merely because an unrelated ripple makes its endpoints
 * touch. Call only after the geometry operation itself has succeeded.
 */
function reconcileTransitions(before: Track, after: Track): Track {
  if (after.transitions.length === 0) return after
  const beforeValid = validTransitionIndexes(before)
  const candidates = after.transitions.filter((_transition, index) =>
    beforeValid.has(index),
  )
  // Stale-before definitions are excluded BEFORE after-state ambiguity is
  // measured; otherwise one that merely became geometrically plausible could
  // suppress a legitimate survivor by overlapping it.
  const candidateTrack =
    candidates.length === after.transitions.length
      ? after
      : { ...after, transitions: candidates }
  const afterValid = validTransitionIndexes(candidateTrack)
  const transitions = candidates.filter((_transition, index) =>
    afterValid.has(index),
  )
  return transitions.length === after.transitions.length
    ? after
    : { ...after, transitions }
}

/**
 * Unique id for entities created by operations (split's right half, copied
 * effects). crypto.randomUUID is a standard global in Node and workers too,
 * so domain/ stays runnable outside the browser.
 */
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** Mint an id unique on the owning track (schema.ts's TransitionId scope). */
function newTransitionId(track: Track): TransitionId {
  const existing = new Set(
    track.transitions.map((transition) => transition.id),
  )
  let id = newId('transition')
  while (existing.has(id)) id = newId('transition')
  return id
}

/* ------------------------------------------------------------------ */
/* Operations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Add one centered visual crossfade at an existing touching video seam.
 * The transition id is minted internally; callers identify the seam by its
 * ordered outgoing/incoming clip ids. A crossfade is rejected unless the
 * canonical render geometry resolves and its half-open window is disjoint
 * from every other valid transition window on the track.
 */
export function addCrossfade(
  doc: TimelineDoc,
  fromClipId: ClipId,
  toClipId: ClipId,
  durationFrames: number,
  audio: Transition['audio'] = { enabled: true, curve: 'equal-power' },
): TimelineDoc {
  const op = 'addCrossfade'
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    return reject(
      doc,
      op,
      `durationFrames must be a safe integer >= 1, got ${durationFrames}`,
    )
  }
  if (
    typeof audio.enabled !== 'boolean'
    || (audio.curve !== 'linear' && audio.curve !== 'equal-power')
  ) {
    return reject(doc, op, 'invalid crossfade audio settings')
  }
  if (fromClipId === toClipId) {
    return reject(doc, op, 'crossfade endpoints must be distinct clips')
  }

  const fromLoc = locateClip(doc, fromClipId)
  if (!fromLoc) return reject(doc, op, `clip ${fromClipId} not found`)
  const toLoc = locateClip(doc, toClipId)
  if (!toLoc) return reject(doc, op, `clip ${toClipId} not found`)
  if (fromLoc.trackIndex !== toLoc.trackIndex) {
    return reject(doc, op, 'crossfade endpoints must be on the same track')
  }

  const track = fromLoc.track
  if (track.locked) return reject(doc, op, `track ${track.id} is locked`)
  if (track.kind !== 'video') {
    return reject(doc, op, `track ${track.id} is not a video track`)
  }
  if (toLoc.clipIndex !== fromLoc.clipIndex + 1) {
    return reject(doc, op, 'crossfade endpoints must be ordered adjacent clips')
  }
  if (rangeEnd(fromLoc.clip.timelineRange) !== toLoc.clip.timelineRange.startFrame) {
    return reject(doc, op, 'crossfade endpoints must touch on the timeline')
  }
  if (
    track.transitions.some(
      (transition) =>
        transition.fromClipId === fromClipId &&
        transition.toClipId === toClipId,
    )
  ) {
    return reject(doc, op, 'the clip seam already has a transition')
  }

  const transition: Transition = {
    id: newTransitionId(track),
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { ...audio },
  }
  const nextTrack: Track = {
    ...track,
    transitions: [...track.transitions, transition],
  }
  if (!validTransitionIndexes(nextTrack).has(nextTrack.transitions.length - 1)) {
    return reject(
      doc,
      op,
      'crossfade window does not fit its clips or overlaps another transition',
    )
  }
  return withTrack(doc, fromLoc.trackIndex, nextTrack)
}

/**
 * Handle-aware authoring boundary. Rejected proposals retain the exact input
 * document reference; successful proposals reuse the ordinary immutable op.
 */
export function addCrossfadeWithSourceBounds(
  doc: TimelineDoc,
  fromClipId: ClipId,
  toClipId: ClipId,
  durationFrames: number,
  catalog: SourceBoundsCatalog,
  audio: Transition['audio'] = { enabled: true, curve: 'equal-power' },
): TimelineDoc {
  const from = locateClip(doc, fromClipId)
  if (!from) {
    return addCrossfade(doc, fromClipId, toClipId, durationFrames, audio)
  }
  const evaluation = evaluateCrossfadeDraft(
    doc,
    from.track.id,
    fromClipId,
    toClipId,
    durationFrames,
    catalog,
    audio,
  )
  if (evaluation.status !== 'available') {
    const maximum = evaluation.status === 'unavailable'
      && evaluation.maximumDurationFrames !== null
      ? `; maximum ${evaluation.maximumDurationFrames} frames`
      : ''
    return reject(
      doc,
      'addCrossfadeWithSourceBounds',
      `${evaluation.reason}${maximum}`,
    )
  }
  return addCrossfade(doc, fromClipId, toClipId, durationFrames, audio)
}

/**
 * Change one track-owned crossfade's duration without replacing its stable
 * id. A no-op duration is silent; malformed endpoints may be repaired only
 * when the new duration makes the complete canonical definition valid and
 * unambiguous.
 */
export function setCrossfadeDuration(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
  durationFrames: number,
): TimelineDoc {
  const op = 'setCrossfadeDuration'
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    return reject(
      doc,
      op,
      `durationFrames must be a safe integer >= 1, got ${durationFrames}`,
    )
  }

  const locations = locateTrackTransitions(doc, trackId, transitionId)
  if (locations.length === 0) {
    return reject(doc, op, `transition ${transitionId} not found`)
  }
  if (locations.length > 1) {
    return reject(doc, op, `transition id ${transitionId} is ambiguous`)
  }
  const loc = locations[0]
  if (loc.track.locked) {
    return reject(doc, op, `track ${loc.track.id} is locked`)
  }
  if (loc.transition.durationFrames === durationFrames) return doc

  const transition: Transition = { ...loc.transition, durationFrames }
  const transitions = loc.track.transitions.slice()
  transitions[loc.transitionIndex] = transition
  const nextTrack: Track = { ...loc.track, transitions }
  if (!validTransitionIndexes(nextTrack).has(loc.transitionIndex)) {
    return reject(
      doc,
      op,
      'crossfade window does not fit its clips or overlaps another transition',
    )
  }
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/** Replace duration and audio intent together as one immutable edit. */
export function setCrossfadeSettings(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
  settings: CrossfadeSettings,
): TimelineDoc {
  const op = 'setCrossfadeSettings'
  if (
    !Number.isSafeInteger(settings.durationFrames)
    || settings.durationFrames < 1
  ) {
    return reject(
      doc,
      op,
      `durationFrames must be a safe integer >= 1, got ${settings.durationFrames}`,
    )
  }
  if (
    typeof settings.audio.enabled !== 'boolean'
    || (
      settings.audio.curve !== 'linear'
      && settings.audio.curve !== 'equal-power'
    )
  ) {
    return reject(doc, op, 'invalid crossfade audio settings')
  }

  const locations = locateTrackTransitions(doc, trackId, transitionId)
  if (locations.length === 0) {
    return reject(doc, op, `transition ${transitionId} not found`)
  }
  if (locations.length > 1) {
    return reject(doc, op, `transition id ${transitionId} is ambiguous`)
  }
  const loc = locations[0]
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (
    loc.transition.durationFrames === settings.durationFrames
    && loc.transition.audio.enabled === settings.audio.enabled
    && loc.transition.audio.curve === settings.audio.curve
  ) return doc

  const transitions = loc.track.transitions.slice()
  transitions[loc.transitionIndex] = {
    ...loc.transition,
    durationFrames: settings.durationFrames,
    audio: { ...settings.audio },
  }
  const nextTrack: Track = { ...loc.track, transitions }
  if (!validTransitionIndexes(nextTrack).has(loc.transitionIndex)) {
    return reject(
      doc,
      op,
      'crossfade window does not fit its clips or overlaps another transition',
    )
  }
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/** Handle-aware atomic settings update with same-reference rejection. */
export function setCrossfadeSettingsWithSourceBounds(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
  settings: CrossfadeSettings,
  catalog: SourceBoundsCatalog,
): TimelineDoc {
  const evaluation = evaluateCrossfadeUpdate(
    doc,
    trackId,
    transitionId,
    settings.durationFrames,
    catalog,
    settings.audio,
  )
  if (evaluation.status !== 'available') {
    const maximum = evaluation.status === 'unavailable'
      && evaluation.maximumDurationFrames !== null
      ? `; maximum ${evaluation.maximumDurationFrames} frames`
      : ''
    return reject(
      doc,
      'setCrossfadeSettingsWithSourceBounds',
      `${evaluation.reason}${maximum}`,
    )
  }
  return setCrossfadeSettings(doc, trackId, transitionId, settings)
}

/** Handle-aware duration update with same-reference rejection semantics. */
export function setCrossfadeDurationWithSourceBounds(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
  durationFrames: number,
  catalog: SourceBoundsCatalog,
): TimelineDoc {
  const locations = locateTrackTransitions(doc, trackId, transitionId)
  if (locations.length !== 1) {
    return setCrossfadeDuration(doc, trackId, transitionId, durationFrames)
  }
  const location = locations[0]
  return setCrossfadeSettingsWithSourceBounds(
    doc,
    trackId,
    transitionId,
    {
      durationFrames,
      audio: location.transition.audio,
    },
    catalog,
  )
}

/**
 * Remove exactly one transition by owning track + id. Endpoint validity is
 * deliberately not required, so malformed/stale serialized transitions
 * remain removable.
 */
export function removeTransition(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
): TimelineDoc {
  const op = 'removeTransition'
  const locations = locateTrackTransitions(doc, trackId, transitionId)
  if (locations.length === 0) {
    return reject(doc, op, `transition ${transitionId} not found`)
  }
  if (locations.length > 1) {
    return reject(doc, op, `transition id ${transitionId} is ambiguous`)
  }
  const loc = locations[0]
  if (loc.track.locked) {
    return reject(doc, op, `track ${loc.track.id} is locked`)
  }

  const transitions = loc.track.transitions.slice()
  transitions.splice(loc.transitionIndex, 1)
  return withTrack(doc, loc.trackIndex, { ...loc.track, transitions })
}

/**
 * Build a default Clip that plays `asset` in full, starting at timeline
 * frame `startFrame`. Pure factory — it does NOT validate against a doc
 * (insertClip does that); it only fills in the schema defaults (identity
 * transform, full opacity/volume, empty effect chain). Per the MVP
 * conformance note in schema.ts, asset.durationFrames is already measured
 * in document-rate frames. Still images receive a canonical one-frame source
 * and an independently editable nominal timeline duration. When `linkGroupId`
 * is given (the A/V drop path, pairing a video clip with its audio clip), it is
 * stamped onto the clip; omitted, the key is left absent.
 */
export function clipFromAsset(
  asset: MediaAsset,
  startFrame: number,
  linkGroupId?: string,
): Clip {
  return {
    id: newId('clip'),
    assetId: asset.id,
    name: asset.fileName,
    sourceMode: asset.kind === 'image' ? 'still' : 'timed',
    sourceRange: {
      startFrame: 0,
      durationFrames: asset.kind === 'image' ? 1 : asset.durationFrames,
    },
    sourceTimeMap: defaultSourceTimeMap(
      0,
      asset.kind === 'image' ? 1 : asset.durationFrames,
    ),
    timelineRange: { startFrame, durationFrames: asset.durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: DEFAULT_BLEND_MODE,
    volume: 1,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

/** Build one bounded procedural text clip at an explicit timeline range. */
export function createTextClip(
  doc: TimelineDoc,
  startFrame: number,
  durationFrames: number,
  content = 'Your text',
): Clip {
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
    throw new RangeError('Text overlay start frame must be a safe integer at or after 0.')
  }
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    throw new RangeError('Text overlay duration must be a positive safe integer.')
  }
  const id = newId('text')
  const text = defaultTextProps(doc.width, doc.height, content)
  const error = textPropsValidationError(text)
  if (error) throw new RangeError(error)
  return {
    id,
    assetId: proceduralTextAssetId(id),
    name: textOverlayName(content),
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    sourceTimeMap: defaultSourceTimeMap(0, durationFrames),
    timelineRange: { startFrame, durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    blendMode: DEFAULT_BLEND_MODE,
    volume: 1,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    text,
  }
}

/**
 * Insert a new clip onto a track. The clip is defensively deep-copied so
 * later mutation of the caller's object cannot reach into the doc. Rejected
 * on unknown/locked track, duplicate clip id, non-integer or negative
 * frames, duration < 1, invalid timed/still source geometry, or overlap with
 * an existing clip.
 *
 * Asset-kind vs track-kind compatibility is NOT checked here: assets live in
 * state/mediaStore and domain/ cannot see them (same boundary as the
 * source-length note in the file header). The UI gates that before calling.
 */
export function insertClip(
  doc: TimelineDoc,
  trackId: TrackId,
  clip: Clip,
): TimelineDoc {
  const op = 'insertClip'
  const tl = clip.timelineRange
  const src = clip.sourceRange

  if (!Number.isInteger(tl.startFrame) || tl.startFrame < 0) {
    return reject(doc, op, `timeline start must be an integer >= 0, got ${tl.startFrame}`)
  }
  if (!Number.isInteger(tl.durationFrames) || tl.durationFrames < 1) {
    return reject(doc, op, `duration must be an integer >= 1, got ${tl.durationFrames}`)
  }
  if (!Number.isInteger(src.startFrame) || src.startFrame < 0) {
    return reject(doc, op, `source start must be an integer >= 0, got ${src.startFrame}`)
  }
  if (clip.sourceMode !== 'timed' && clip.sourceMode !== 'still') {
    return reject(doc, op, `unknown source mode ${String(clip.sourceMode)}`)
  }
  let sourceTimeMap: SourceTimeMap
  try {
    sourceTimeMap = clipSourceTimeMap(clip)
  } catch (error) {
    return reject(
      doc,
      op,
      error instanceof Error ? error.message : 'invalid source-time mapping',
    )
  }
  const sourceTimeMapError = sourceTimeMapValidationError(sourceTimeMap)
  if (sourceTimeMapError) return reject(doc, op, sourceTimeMapError)
  if (
    clip.sourceMode === 'still'
    && (src.startFrame !== 0 || src.durationFrames !== 1)
  ) {
    return reject(
      doc,
      op,
      'still clips must use source frame 0 with duration 1',
    )
  }
  if (clip.sourceMode !== 'still') {
    let mappedSourceRange: TimeRange
    try {
      mappedSourceRange = sourceRangeForMap(sourceTimeMap, tl.durationFrames)
    } catch (error) {
      return reject(
        doc,
        op,
        error instanceof Error ? error.message : 'invalid source-time mapping',
      )
    }
    if (
      mappedSourceRange.startFrame !== src.startFrame
      || mappedSourceRange.durationFrames !== src.durationFrames
    ) {
      return reject(
        doc,
        op,
        'sourceRange must equal the source-time mapping envelope',
      )
    }
  }
  if (
    clip.sourceMode === 'still'
    && (
      sourceTimeMap.sourceStartTicks !== 0
      || sourceTimeMap.sourceDurationTicks !== SOURCE_TIME_TICKS_PER_FRAME
      || sourceTimeMap.rate.numerator !== 1
      || sourceTimeMap.rate.denominator !== 1
    )
  ) {
    return reject(
      doc,
      op,
      'still clips must use the canonical 1x source-time map',
    )
  }
  if (clip.text !== undefined) {
    if (clip.assetId !== proceduralTextAssetId(clip.id)) {
      return reject(doc, op, 'text clips must use their reserved procedural asset id')
    }
    if (clip.sourceMode !== 'timed') {
      return reject(doc, op, 'text clips must use procedural timed source mode')
    }
    if (src.startFrame !== 0) {
      return reject(doc, op, 'text clips must use procedural source start 0')
    }
    const textError = textPropsValidationError(clip.text)
    if (textError) return reject(doc, op, textError)
  }
  const scaleError = transformScaleValidationError(clip.transform)
  if (scaleError) return reject(doc, op, scaleError)
  const visualError = clipVisualSettingsValidationError(
    clipVisualSettings(clip),
  )
  if (visualError) return reject(doc, op, visualError)
  const audioError = clipAudioSettingsValidationError(
    clipAudioSettings(clip),
    tl.durationFrames,
  )
  if (audioError) return reject(doc, op, audioError)
  const animation = clipAnimation(clip)
  const animationError = clipAnimationValidationError(animation)
  if (animationError) return reject(doc, op, animationError)

  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const track = doc.tracks[trackIndex]
  if (track.locked) return reject(doc, op, `track ${track.id} is locked`)
  if (clip.text !== undefined && track.kind !== 'video') {
    return reject(doc, op, 'text clips can only be placed on video tracks')
  }
  if (
    animation.tracks.length > 0
    && (track.kind !== 'video' || clip.text !== undefined)
  ) {
    return reject(doc, op, 'keyframes are supported only on visual media clips')
  }

  if (locateClip(doc, clip.id)) {
    return reject(doc, op, `clip id ${clip.id} already exists in the document`)
  }
  if (overlapsAny(track.clips, tl)) {
    return reject(doc, op, 'insert would overlap a clip on the target track')
  }

  const copy: Clip = {
    ...clip,
    sourceRange: { ...src },
    sourceTimeMap: cloneSourceTimeMap(sourceTimeMap),
    timelineRange: { ...tl },
    transform: { ...clip.transform },
    visual: {
      ...clipVisualSettings(clip),
      crop: { ...clipVisualSettings(clip).crop },
    },
    audio: { ...clipAudioSettings(clip) },
    animation: cloneClipAnimation(animation),
    effects: clip.effects.map((e) => ({ ...e, params: { ...e.params } })),
    ...(clip.text === undefined ? {} : { text: { ...clip.text } }),
  }

  const clips = [...track.clips, copy].sort(byStart)
  const nextTrack = reconcileTransitions(track, { ...track, clips })
  return withTrack(doc, trackIndex, nextTrack)
}

/**
 * Split a clip in two at a timeline frame strictly inside it. The left half
 * keeps the original clip id; the right half gets a new id and deep-copies
 * the effect chain (with fresh effect-instance ids). Timed halves partition
 * the source exactly; both still halves retain canonical source frame 0.
 */
export function splitClipAtFrame(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
): TimelineDoc {
  const op = 'splitClipAtFrame'
  if (!Number.isInteger(frame)) {
    return reject(doc, op, `frame must be an integer, got ${frame}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip } = loc
  const tl = clip.timelineRange
  if (frame <= tl.startFrame || frame >= rangeEnd(tl)) {
    return reject(
      doc,
      op,
      `frame ${frame} is not strictly inside clip [${tl.startFrame}, ${rangeEnd(tl)})`,
    )
  }

  const offset = frame - tl.startFrame
  const stillSource = clip.sourceMode === 'still'
  const textSource = clip.text !== undefined
  const sourceTimeMap = clipSourceTimeMap(clip)
  const leftSourceTimeMap = textSource || stillSource
    ? defaultSourceTimeMap(0, stillSource ? 1 : offset)
    : sourceTimeMapForTimelineDuration(sourceTimeMap, offset)
  const rightSourceTimeMap = textSource || stillSource
    ? defaultSourceTimeMap(
        0,
        stillSource ? 1 : tl.durationFrames - offset,
      )
    : sourceTimeMapAtOffset(sourceTimeMap, offset)
  const rightAnimation = shiftClipAnimation(clipAnimation(clip), -offset)
  if (!rightAnimation) return reject(doc, op, 'split would exceed keyframe frame bounds')
  const left: Clip = withClampedAudioFades({
    ...clip,
    sourceRange: stillSource
      ? { startFrame: 0, durationFrames: 1 }
      : textSource
        ? { startFrame: 0, durationFrames: offset }
        : sourceRangeForMap(leftSourceTimeMap, offset),
    sourceTimeMap: leftSourceTimeMap,
    timelineRange: { startFrame: tl.startFrame, durationFrames: offset },
  })
  const right: Clip = withClampedAudioFades({
    ...clip,
    id: newId('clip'),
    sourceRange: stillSource
      ? { startFrame: 0, durationFrames: 1 }
      : textSource
        ? { startFrame: 0, durationFrames: tl.durationFrames - offset }
        : sourceRangeForMap(rightSourceTimeMap, tl.durationFrames - offset),
    sourceTimeMap: rightSourceTimeMap,
    timelineRange: { startFrame: frame, durationFrames: tl.durationFrames - offset },
    animation: rightAnimation,
    effects: clip.effects.map((e) => ({
      ...e,
      id: newId('fx'),
      params: { ...e.params },
    })),
    ...(clip.text === undefined ? {} : { text: { ...clip.text } }),
  })

  const clips = loc.track.clips.slice()
  clips.splice(loc.clipIndex, 1, left, right)
  // The original id stays on the left half, so an incoming transition keeps
  // pointing at it. An outgoing transition belongs at the original outer
  // edge and therefore follows the newly minted right half.
  const transitions = loc.track.transitions.map((transition) =>
    transition.fromClipId === clip.id
      ? { ...transition, fromClipId: right.id }
      : transition,
  )
  const nextTrack = reconcileTransitions(loc.track, {
    ...loc.track,
    clips,
    transitions,
  })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Move one edge of a clip by a signed frame delta ("move the edge right" is
 * positive). A timed start trim advances the source in-point so the remaining
 * material still lines up. A still trim changes only timeline geometry, so
 * either edge can extend without inventing source frames. Rejected when the
 * result would be shorter than 1 frame, start before frame 0, or overlap a
 * neighbor.
 */
export function trimClip(
  doc: TimelineDoc,
  clipId: ClipId,
  edge: TrimEdge,
  deltaFrames: number,
): TimelineDoc {
  const op = 'trimClip'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip } = loc
  const tl = clip.timelineRange
  const src = clip.sourceRange
  const stillSource = clip.sourceMode === 'still'
  const textSource = clip.text !== undefined
  const sourceTimeMap = clipSourceTimeMap(clip)

  let newTl: TimeRange
  let newSrc: TimeRange
  let newSourceTimeMap = cloneSourceTimeMap(sourceTimeMap)
  if (edge === 'start') {
    newTl = {
      startFrame: tl.startFrame + deltaFrames,
      durationFrames: tl.durationFrames - deltaFrames,
    }
    if (newTl.durationFrames < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newTl.durationFrames)
      : sourceTimeMapAtOffset(sourceTimeMap, deltaFrames)
    if (!stillSource && !textSource && newSourceTimeMap.sourceStartTicks < 0) {
      return reject(doc, op, 'no source material before the asset start')
    }
    newSrc = stillSource
      ? src
      : textSource
        ? { startFrame: 0, durationFrames: newTl.durationFrames }
        : sourceRangeForMap(newSourceTimeMap, newTl.durationFrames)
  } else {
    newTl = { startFrame: tl.startFrame, durationFrames: tl.durationFrames + deltaFrames }
    if (newTl.durationFrames < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newTl.durationFrames)
      : sourceTimeMapForTimelineDuration(sourceTimeMap, newTl.durationFrames)
    newSrc = stillSource
      ? src
      : textSource
        ? { startFrame: 0, durationFrames: newTl.durationFrames }
        : sourceRangeForMap(newSourceTimeMap, newTl.durationFrames)
  }

  if (newTl.startFrame < 0) {
    return reject(doc, op, 'clip cannot start before timeline frame 0')
  }
  if (overlapsAny(loc.track.clips, newTl, clipId)) {
    return reject(doc, op, 'trim would overlap a neighboring clip')
  }

  const nextAnimation = edge === 'start'
    ? shiftClipAnimation(clipAnimation(clip), -deltaFrames)
    : cloneClipAnimation(clipAnimation(clip))
  if (!nextAnimation) return reject(doc, op, 'trim would exceed keyframe frame bounds')

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = withClampedAudioFades({
    ...clip,
    timelineRange: newTl,
    sourceRange: newSrc,
    sourceTimeMap: newSourceTimeMap,
    animation: nextAnimation,
  })
  clips.sort(byStart)
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

function sameSourceTimeMap(left: SourceTimeMap, right: SourceTimeMap): boolean {
  const leftCurve = left.speedCurve
  const rightCurve = right.speedCurve
  if (
    left.sourceStartTicks !== right.sourceStartTicks
    || left.sourceDurationTicks !== right.sourceDurationTicks
    || left.rate.numerator !== right.rate.numerator
    || left.rate.denominator !== right.rate.denominator
    || (leftCurve?.originFrame ?? 0) !== (rightCurve?.originFrame ?? 0)
    || (leftCurve?.points.length ?? 0) !== (rightCurve?.points.length ?? 0)
  ) return false
  const leftPoints = leftCurve?.points ?? []
  const rightPoints = rightCurve?.points ?? []
  return leftPoints.every((point, index) => {
    const other = rightPoints[index]
    return other !== undefined
      && point.frame === other.frame
      && point.rate.numerator === other.rate.numerator
      && point.rate.denominator === other.rate.denominator
      && point.easing === other.easing
  })
}

function replaceTimedClipSourceTimeMap(
  doc: TimelineDoc,
  loc: ClipLocation,
  newMap: SourceTimeMap,
  op: string,
): TimelineDoc {
  const mapError = sourceTimeMapValidationError(newMap)
  if (mapError) return reject(doc, op, mapError)
  const newDurationFrames = timelineFramesWithinSourceMap(newMap)
  if (!Number.isFinite(newDurationFrames) || newDurationFrames < 1) {
    return reject(doc, op, 'retimed clip must have a finite duration of at least one frame')
  }
  const startFrame = loc.clip.timelineRange.startFrame
  const endFrame = startFrame + newDurationFrames
  if (
    !Number.isSafeInteger(startFrame)
    || startFrame < 0
    || !Number.isSafeInteger(endFrame)
    || endFrame <= startFrame
  ) {
    return reject(doc, op, 'retimed timeline range must stay within safe integer frames')
  }
  const newTimelineRange = { startFrame, durationFrames: newDurationFrames }
  if (overlapsAny(loc.track.clips, newTimelineRange, loc.clip.id)) {
    return reject(doc, op, 'retime would overlap a neighboring clip')
  }
  const oldMap = clipSourceTimeMap(loc.clip)
  const animation = retimeClipAnimation(
    clipAnimation(loc.clip),
    oldMap,
    newMap,
    newDurationFrames,
  )
  if (!animation) {
    return reject(doc, op, 'retime would collapse or exceed keyframe frame bounds')
  }
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = withClampedAudioFades({
    ...loc.clip,
    timelineRange: newTimelineRange,
    sourceRange: sourceRangeForMap(newMap, newDurationFrames),
    sourceTimeMap: cloneSourceTimeMap(newMap),
    animation,
  })
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

function speedEditLocation(
  doc: TimelineDoc,
  clipId: ClipId,
  op: string,
): ClipLocation | null {
  const loc = locateClip(doc, clipId)
  if (!loc) {
    reject(doc, op, `clip ${clipId} not found`)
    return null
  }
  if (loc.track.locked) {
    reject(doc, op, `track ${loc.track.id} is locked`)
    return null
  }
  if (loc.clip.sourceMode === 'still' || loc.clip.text !== undefined) {
    reject(doc, op, 'only timed media clips can be retimed')
    return null
  }
  return loc
}

/** Replace any ramp with one bounded constant rational speed. */
export function retimeClip(
  doc: TimelineDoc,
  clipId: ClipId,
  rate: SourceTimeRate,
): TimelineDoc {
  const op = 'retimeClip'
  const rateError = sourceTimeRateValidationError(rate)
  if (rateError) return reject(doc, op, rateError)
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  const oldMap = clipSourceTimeMap(loc.clip)
  if (
    !sourceTimeMapUsesSpeedCurve(oldMap)
    && oldMap.rate.numerator === rate.numerator
    && oldMap.rate.denominator === rate.denominator
  ) return doc
  const newMap = sourceTimeMapWithoutSpeedCurve(oldMap)
  newMap.rate = { ...rate }
  return replaceTimedClipSourceTimeMap(doc, loc, newMap, op)
}

/** Add or replace one clip-local speed handle; duplicate time is replace. */
export function setClipSpeedPoint(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
  rate: SourceTimeRate,
  easing: SourceTimeSpeedEasing,
): TimelineDoc {
  const op = 'setClipSpeedPoint'
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  if (
    !Number.isSafeInteger(frame)
    || frame < 0
    || frame >= loc.clip.timelineRange.durationFrames
  ) return reject(doc, op, 'speed point must be inside the clip timeline bounds')
  let newMap: SourceTimeMap
  try {
    newMap = sourceTimeMapWithSpeedPoint(
      clipSourceTimeMap(loc.clip),
      frame,
      rate,
      easing,
    )
  } catch (error) {
    return reject(doc, op, error instanceof Error ? error.message : 'invalid speed point')
  }
  if (sameSourceTimeMap(clipSourceTimeMap(loc.clip), newMap)) return doc
  return replaceTimedClipSourceTimeMap(doc, loc, newMap, op)
}

export function removeClipSpeedPoint(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
): TimelineDoc {
  const op = 'removeClipSpeedPoint'
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  let newMap: SourceTimeMap
  try {
    newMap = sourceTimeMapWithoutSpeedPoint(clipSourceTimeMap(loc.clip), frame)
  } catch (error) {
    return reject(doc, op, error instanceof Error ? error.message : 'invalid speed point')
  }
  if (sameSourceTimeMap(clipSourceTimeMap(loc.clip), newMap)) {
    return reject(doc, op, `speed point at frame ${frame} not found`)
  }
  return replaceTimedClipSourceTimeMap(doc, loc, newMap, op)
}

export function clearClipSpeedRamp(
  doc: TimelineDoc,
  clipId: ClipId,
): TimelineDoc {
  const op = 'clearClipSpeedRamp'
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  const oldMap = clipSourceTimeMap(loc.clip)
  if (!sourceTimeMapUsesSpeedCurve(oldMap)) return doc
  return replaceTimedClipSourceTimeMap(
    doc,
    loc,
    sourceTimeMapWithoutSpeedCurve(oldMap),
    op,
  )
}

/**
 * Move a clip to a new timeline position, optionally onto another track of
 * the same kind. Duration and source material are unchanged. Rejected on
 * overlap, unknown target, kind mismatch, or locked tracks.
 */
export function moveClip(
  doc: TimelineDoc,
  clipId: ClipId,
  toTrackId: TrackId,
  toFrame: number,
): TimelineDoc {
  const op = 'moveClip'
  if (!Number.isInteger(toFrame) || toFrame < 0) {
    return reject(doc, op, `toFrame must be an integer >= 0, got ${toFrame}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const targetIndex = doc.tracks.findIndex((t) => t.id === toTrackId)
  if (targetIndex === -1) return reject(doc, op, `track ${toTrackId} not found`)
  const target = doc.tracks[targetIndex]
  if (target.locked) return reject(doc, op, `track ${target.id} is locked`)
  if (target.kind !== loc.track.kind) {
    return reject(
      doc,
      op,
      `cannot move a ${loc.track.kind} clip onto ${target.kind} track ${target.id}`,
    )
  }

  const newRange: TimeRange = {
    startFrame: toFrame,
    durationFrames: loc.clip.timelineRange.durationFrames,
  }
  if (overlapsAny(target.clips, newRange, clipId)) {
    return reject(doc, op, 'move would overlap a clip on the target track')
  }

  const movedClip: Clip = { ...loc.clip, timelineRange: newRange }

  if (targetIndex === loc.trackIndex) {
    const clips = loc.track.clips.slice()
    clips[loc.clipIndex] = movedClip
    clips.sort(byStart)
    const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
    return withTrack(doc, loc.trackIndex, nextTrack)
  }

  // Cross-track: remove from source, insert into target, fix transitions.
  const sourceClips = loc.track.clips.filter((c) => c.id !== clipId)
  const targetClips = [...target.clips, movedClip].sort(byStart)
  const tracks = doc.tracks.slice()
  tracks[loc.trackIndex] = reconcileTransitions(loc.track, {
    ...loc.track,
    clips: sourceClips,
  })
  tracks[targetIndex] = reconcileTransitions(target, {
    ...target,
    clips: targetClips,
  })
  return { ...doc, tracks }
}

/**
 * Delete a clip and close the gap: every clip on the SAME track that starts
 * at/after the deleted clip's end shifts left by the deleted duration.
 * (MVP scope: single-track ripple; other tracks are untouched.)
 */
export function rippleDelete(doc: TimelineDoc, clipId: ClipId): TimelineDoc {
  const op = 'rippleDelete'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const removedEnd = rangeEnd(loc.clip.timelineRange)
  const removedDur = loc.clip.timelineRange.durationFrames

  const clips = loc.track.clips
    .filter((c) => c.id !== clipId)
    .map((c) =>
      c.timelineRange.startFrame >= removedEnd
        ? {
            ...c,
            timelineRange: {
              ...c.timelineRange,
              startFrame: c.timelineRange.startFrame - removedDur,
            },
          }
        : c,
    )

  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Slip: shift WHICH source material a timed clip shows without moving it on
 * the timeline. Positive delta shows later material (source in-point moves
 * forward). timelineRange is untouched, so neighbors can never be affected.
 * A still clip has no alternate source material, so slip is an intentional,
 * silent same-reference no-op.
 * Rejected when the source in-point would go below 0 or the resulting source
 * range would leave JavaScript's safe-integer frame domain. Slipping past the
 * END of the asset is validated at the store/UI layer, like trimClip
 * (domain/ cannot see assets — file-header note).
 */
export function slipClip(
  doc: TimelineDoc,
  clipId: ClipId,
  deltaFrames: number,
): TimelineDoc {
  const op = 'slipClip'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.clip.sourceMode === 'still' || loc.clip.text !== undefined) return doc
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  // Historical pure fixtures can still omit the schema-11 map. Preserve the
  // exact old 1x safe-integer repair path until they cross persistence.
  if (loc.clip.sourceTimeMap === undefined) {
    const sourceRange = loc.clip.sourceRange
    const startFrame = sourceRange.startFrame + deltaFrames
    const endFrame = startFrame + sourceRange.durationFrames - 1
    if (startFrame < 0) {
      return reject(doc, op, 'no source material before the asset start')
    }
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)) {
      return reject(doc, op, 'source range must stay within safe integer frames')
    }
    const clips = loc.track.clips.slice()
    clips[loc.clipIndex] = {
      ...loc.clip,
      sourceRange: { startFrame, durationFrames: sourceRange.durationFrames },
    }
    return withTrack(
      doc,
      loc.trackIndex,
      reconcileTransitions(loc.track, { ...loc.track, clips }),
    )
  }

  let sourceTimeMap: SourceTimeMap
  try {
    sourceTimeMap = clipSourceTimeMap(loc.clip)
  } catch {
    return reject(doc, op, 'source range must stay within safe integer frames')
  }
  const sourceStartTicks = sourceTimeMap.sourceStartTicks
    + deltaFrames * SOURCE_TIME_TICKS_PER_FRAME
  if (!Number.isSafeInteger(sourceStartTicks) || sourceStartTicks < 0) {
    return reject(doc, op, 'no source material before the asset start')
  }
  const newSourceTimeMap = { ...sourceTimeMap, sourceStartTicks }
  const animation = shiftClipAnimationSourceTimeIntent(
    clipAnimation(loc.clip),
    sourceTimeMap,
    sourceStartTicks - sourceTimeMap.sourceStartTicks,
  )
  if (!animation) {
    return reject(doc, op, 'slip would exceed keyframe source-time bounds')
  }
  let sourceRange: TimeRange
  try {
    sourceRange = sourceRangeForMap(
      newSourceTimeMap,
      loc.clip.timelineRange.durationFrames,
    )
  } catch {
    return reject(doc, op, 'source range must stay within safe integer frames')
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    sourceRange,
    sourceTimeMap: newSourceTimeMap,
    animation,
  }
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Slide: move a clip along its track while its TOUCHING neighbors absorb
 * the change — the left neighbor's tail extends/shrinks and the right
 * neighbor's head trims, so the three clips stay glued and everything
 * beyond them keeps its position. The slid clip's duration and source are
 * unchanged. A side with a gap instead of a touching neighbor just slides
 * over the gap. Rejected when a touching neighbor would drop below 1
 * frame, the right neighbor's source would go below 0, the clip would
 * start before 0, or the result would overlap any other clip.
 */
export function slideClip(
  doc: TimelineDoc,
  clipId: ClipId,
  deltaFrames: number,
): TimelineDoc {
  const op = 'slideClip'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip, track, clipIndex } = loc
  const tl = clip.timelineRange
  const newStart = tl.startFrame + deltaFrames
  if (newStart < 0) {
    return reject(doc, op, 'clip cannot start before timeline frame 0')
  }

  const clips = track.clips.slice()
  const left = clipIndex > 0 ? clips[clipIndex - 1] : null
  const right = clipIndex < clips.length - 1 ? clips[clipIndex + 1] : null

  if (left && rangeEnd(left.timelineRange) === tl.startFrame) {
    // Touching left neighbor: its tail follows our head.
    const newDur = left.timelineRange.durationFrames + deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'left neighbor cannot shrink below 1 frame')
    }
    const leftIsText = left.text !== undefined
    const leftSourceTimeMap = leftIsText || left.sourceMode === 'still'
      ? defaultSourceTimeMap(0, left.sourceMode === 'still' ? 1 : newDur)
      : sourceTimeMapForTimelineDuration(clipSourceTimeMap(left), newDur)
    clips[clipIndex - 1] = withClampedAudioFades({
      ...left,
      timelineRange: { ...left.timelineRange, durationFrames: newDur },
      sourceRange: left.sourceMode === 'still'
        ? left.sourceRange
        : leftIsText
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(leftSourceTimeMap, newDur),
      sourceTimeMap: leftSourceTimeMap,
    })
  }
  if (right && right.timelineRange.startFrame === rangeEnd(tl)) {
    // Touching right neighbor: its head follows our tail.
    const newDur = right.timelineRange.durationFrames - deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'right neighbor cannot shrink below 1 frame')
    }
    const rightIsStill = right.sourceMode === 'still'
    const rightIsText = right.text !== undefined
    const rightSourceTimeMap = rightIsStill || rightIsText
      ? defaultSourceTimeMap(0, rightIsStill ? 1 : newDur)
      : sourceTimeMapAtOffset(clipSourceTimeMap(right), deltaFrames)
    if (!rightIsStill && !rightIsText && rightSourceTimeMap.sourceStartTicks < 0) {
      return reject(doc, op, 'right neighbor has no source material before the asset start')
    }
    const rightAnimation = shiftClipAnimation(clipAnimation(right), -deltaFrames)
    if (!rightAnimation) {
      return reject(doc, op, 'slide would exceed right-neighbor keyframe frame bounds')
    }
    clips[clipIndex + 1] = withClampedAudioFades({
      ...right,
      timelineRange: {
        startFrame: right.timelineRange.startFrame + deltaFrames,
        durationFrames: newDur,
      },
      sourceRange: rightIsStill
        ? right.sourceRange
        : rightIsText
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(rightSourceTimeMap, newDur),
      sourceTimeMap: rightSourceTimeMap,
      animation: rightAnimation,
    })
  }
  clips[clipIndex] = {
    ...clip,
    timelineRange: { startFrame: newStart, durationFrames: tl.durationFrames },
  }

  // Gap sides can slide into other clips: re-verify the whole-track
  // invariant. In a sorted-by-start list any overlap shows up between some
  // sort-adjacent pair.
  clips.sort(byStart)
  for (let i = 1; i < clips.length; i++) {
    if (rangeOverlap(clips[i - 1].timelineRange, clips[i].timelineRange)) {
      return reject(doc, op, 'slide would overlap another clip')
    }
  }

  const nextTrack = reconcileTransitions(track, { ...track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Ripple trim: change a clip's length at one edge and shift every clip on
 * the SAME track that starts at/after the clip's OLD end by the same
 * amount, so downstream spacing is preserved (the timeline "breathes"
 * instead of leaving a gap). MVP scope: single-track ripple, matching
 * rippleDelete. For edge 'start' the clip's timeline start stays fixed —
 * material is cut from (delta > 0) or restored to (delta < 0) the head and
 * downstream closes/opens accordingly; for edge 'end' positive delta
 * lengthens the tail and pushes downstream right. Gap preservation means
 * a ripple trim can never create an overlap.
 */
export function rippleTrim(
  doc: TimelineDoc,
  clipId: ClipId,
  edge: TrimEdge,
  deltaFrames: number,
): TimelineDoc {
  const op = 'rippleTrim'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip } = loc
  const tl = clip.timelineRange
  const src = clip.sourceRange
  const oldEnd = rangeEnd(tl)
  const stillSource = clip.sourceMode === 'still'
  const textSource = clip.text !== undefined
  const sourceTimeMap = clipSourceTimeMap(clip)

  let newClip: Clip
  let shiftBy: number
  if (edge === 'start') {
    const newDur = tl.durationFrames - deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    const newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newDur)
      : sourceTimeMapAtOffset(sourceTimeMap, deltaFrames)
    if (!stillSource && !textSource && newSourceTimeMap.sourceStartTicks < 0) {
      return reject(doc, op, 'no source material before the asset start')
    }
    newClip = withClampedAudioFades({
      ...clip,
      timelineRange: { startFrame: tl.startFrame, durationFrames: newDur },
      sourceRange: stillSource
        ? src
        : textSource
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(newSourceTimeMap, newDur),
      sourceTimeMap: newSourceTimeMap,
    })
    shiftBy = -deltaFrames
  } else {
    const newDur = tl.durationFrames + deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    const newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newDur)
      : sourceTimeMapForTimelineDuration(sourceTimeMap, newDur)
    newClip = withClampedAudioFades({
      ...clip,
      timelineRange: { startFrame: tl.startFrame, durationFrames: newDur },
      sourceRange: stillSource
        ? src
        : textSource
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(newSourceTimeMap, newDur),
      sourceTimeMap: newSourceTimeMap,
    })
    shiftBy = deltaFrames
  }

  const clips = loc.track.clips.map((c) => {
    if (c.id === clipId) return newClip
    if (c.timelineRange.startFrame >= oldEnd) {
      return {
        ...c,
        timelineRange: {
          ...c.timelineRange,
          startFrame: c.timelineRange.startFrame + shiftBy,
        },
      }
    }
    return c
  })

  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/** What updateClipTransform can change (the Inspector's surface, 4.3). */
export interface ClipTransformPatch {
  /** Transform fields to merge; omitted fields keep their current values. */
  transform?: Partial<Transform>
  /** New opacity. Clamped into [0, 1] (schema range). */
  opacity?: number
}

/**
 * Merge new visual properties into a clip: any subset of Transform fields
 * plus opacity. Purely presentational — ranges, neighbors and durations
 * cannot be affected. Rejected on an empty patch or any non-finite number
 * (NaN/Infinity from a parsed input must never enter the doc); opacity is
 * clamped rather than rejected, since 0..1 is a UI convention.
 */
export function updateClipTransform(
  doc: TimelineDoc,
  clipId: ClipId,
  patch: ClipTransformPatch,
): TimelineDoc {
  return updateClipVisual(doc, clipId, patch)
}

export interface ClipVisualSettingsPatch {
  crop?: Partial<CropInsets>
  flipHorizontal?: boolean
  flipVertical?: boolean
  scaleLocked?: boolean
}

/** Complete static video/text Inspector mutation surface. */
export interface ClipVisualPatch extends ClipTransformPatch {
  /** Exact serialized blend intent; unknown names remain durable and render safely. */
  blendMode?: string
  visual?: ClipVisualSettingsPatch
}

const TRANSFORM_KEYS = new Set<keyof Transform>([
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
  'anchorX',
  'anchorY',
])

const VISUAL_SETTING_KEYS = new Set<keyof ClipVisualSettings>([
  'crop',
  'flipHorizontal',
  'flipVertical',
  'scaleLocked',
])

const CROP_KEYS = new Set<keyof CropInsets>([
  'left',
  'right',
  'top',
  'bottom',
])

function sameCrop(left: CropInsets, right: CropInsets): boolean {
  return left.left === right.left
    && left.right === right.right
    && left.top === right.top
    && left.bottom === right.bottom
}

function sameVisual(
  left: ClipVisualSettings,
  right: ClipVisualSettings,
): boolean {
  return sameCrop(left.crop, right.crop)
    && left.flipHorizontal === right.flipHorizontal
    && left.flipVertical === right.flipVertical
    && left.scaleLocked === right.scaleLocked
}

/**
 * Atomically edit transform, opacity, blend intent, crop, flips, and scale-lock state.
 * When locking previously independent scales, X is authoritative. While the
 * lock remains enabled, an edit to either scale updates both axes.
 */
export function updateClipVisual(
  doc: TimelineDoc,
  clipId: ClipId,
  patch: ClipVisualPatch,
): TimelineDoc {
  const op = 'updateClipVisual'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const transformPatch = patch.transform ?? {}
  const transformKeys = Object.keys(transformPatch) as Array<keyof Transform>
  for (const key of transformKeys) {
    if (!TRANSFORM_KEYS.has(key)) {
      return reject(doc, op, `unknown transform property ${String(key)}`)
    }
    const value = transformPatch[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return reject(doc, op, `transform.${key} must be a finite number, got ${value}`)
    }
  }

  const visualPatch = patch.visual ?? {}
  const visualKeys = Object.keys(visualPatch) as Array<keyof ClipVisualSettings>
  for (const key of visualKeys) {
    if (!VISUAL_SETTING_KEYS.has(key)) {
      return reject(doc, op, `unknown visual property ${String(key)}`)
    }
  }
  if (visualPatch.crop !== undefined) {
    const cropKeys = Object.keys(visualPatch.crop) as Array<keyof CropInsets>
    for (const key of cropKeys) {
      if (!CROP_KEYS.has(key)) {
        return reject(doc, op, `unknown crop property ${String(key)}`)
      }
    }
  }
  const hasOpacity = patch.opacity !== undefined
  if (hasOpacity && !Number.isFinite(patch.opacity)) {
    return reject(doc, op, `opacity must be a finite number, got ${patch.opacity}`)
  }
  const hasBlendMode = patch.blendMode !== undefined
  if (hasBlendMode) {
    const blendError = blendModeIntentValidationError(patch.blendMode)
    if (blendError) return reject(doc, op, blendError)
  }
  if (transformKeys.length === 0 && visualKeys.length === 0 && !hasOpacity && !hasBlendMode) {
    return reject(doc, op, 'empty patch — nothing to change')
  }

  const currentVisual = clipVisualSettings(loc.clip)
  const nextVisual: ClipVisualSettings = {
    ...currentVisual,
    ...visualPatch,
    crop: {
      ...currentVisual.crop,
      ...(visualPatch.crop ?? {}),
    },
  }
  const visualError = clipVisualSettingsValidationError(nextVisual)
  if (visualError) return reject(doc, op, visualError)

  const nextTransform: Transform = {
    ...loc.clip.transform,
    ...transformPatch,
  }
  if (nextVisual.scaleLocked) {
    const scaleX = transformPatch.scaleX
    const scaleY = transformPatch.scaleY
    if (scaleX !== undefined && scaleY !== undefined && scaleX !== scaleY) {
      return reject(doc, op, 'locked scale X and Y must match')
    }
    if (scaleX !== undefined || scaleY !== undefined) {
      const scale = (scaleX ?? scaleY) as number
      nextTransform.scaleX = scale
      nextTransform.scaleY = scale
    } else if (!currentVisual.scaleLocked && visualPatch.scaleLocked === true) {
      nextTransform.scaleY = nextTransform.scaleX
    }
  }
  const scaleError = transformScaleValidationError(nextTransform)
  if (scaleError) return reject(doc, op, scaleError)
  if (
    nextTransform.anchorX < 0
    || nextTransform.anchorX > 1
    || nextTransform.anchorY < 0
    || nextTransform.anchorY > 1
  ) {
    return reject(doc, op, 'anchor values must be from 0 to 1')
  }

  const opacity = hasOpacity
    ? Math.min(1, Math.max(0, patch.opacity as number))
    : loc.clip.opacity
  const blendMode = hasBlendMode
    ? patch.blendMode as string
    : clipBlendModeIntent(loc.clip)
  const transformUnchanged = [...TRANSFORM_KEYS].every(
    (key) => nextTransform[key] === loc.clip.transform[key],
  )
  if (
    transformUnchanged
    && opacity === loc.clip.opacity
    && blendMode === clipBlendModeIntent(loc.clip)
    && sameVisual(nextVisual, currentVisual)
  ) return doc

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    transform: nextTransform,
    opacity,
    blendMode,
    visual: nextVisual,
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

const TRANSFORM_ANIMATION_PROPERTIES: Partial<
  Record<keyof Transform, ClipAnimationProperty>
> = {
  x: 'position-x',
  y: 'position-y',
  scaleX: 'scale-x',
  scaleY: 'scale-y',
  rotation: 'rotation',
}

function sameAnimationEasing(
  left: ClipAnimationEasing,
  right: ClipAnimationEasing,
): boolean {
  if (left.type !== right.type) return false
  return left.type !== 'cubic-bezier'
    || (
      right.type === 'cubic-bezier'
      && left.x1 === right.x1
      && left.y1 === right.y1
      && left.x2 === right.x2
      && left.y2 === right.y2
    )
}

function animationEditLocation(
  doc: TimelineDoc,
  clipId: ClipId,
  operation: string,
): ClipLocation | null {
  const loc = locateClip(doc, clipId)
  if (!loc) {
    reject(doc, operation, `clip ${clipId} not found`)
    return null
  }
  if (loc.track.locked) {
    reject(doc, operation, `track ${loc.track.id} is locked`)
    return null
  }
  if (loc.track.kind !== 'video' || loc.clip.text !== undefined) {
    reject(doc, operation, 'keyframes are supported only on visual media clips')
    return null
  }
  return loc
}

function replaceClipAnimation(
  doc: TimelineDoc,
  loc: ClipLocation,
  animation: NonNullable<Clip['animation']>,
): TimelineDoc {
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, animation }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/** Add or replace one exact property/time keyframe. Duplicate time is replace. */
export function setClipKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
  keyframe: ClipAnimationKeyframe,
): TimelineDoc {
  const op = 'setClipKeyframe'
  const loc = animationEditLocation(doc, clipId, op)
  if (!loc) return doc
  const current = clipAnimation(loc.clip)
  let sourceTimeTicks: number
  try {
    sourceTimeTicks = sourceTicksAtTimelineOffset(
      clipSourceTimeMap(loc.clip),
      keyframe.frame,
    )
  } catch {
    return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
  }
  const authoredKeyframe = { ...keyframe, sourceTimeTicks }
  const existing = current.tracks
    .find((track) => track.property === property)
    ?.keyframes.find((item) => item.frame === keyframe.frame)
  if (
    existing
    && existing.value === keyframe.value
    && sameAnimationEasing(existing.easing, keyframe.easing)
    && (existing.sourceTimeTicks ?? sourceTimeTicks) === sourceTimeTicks
  ) return doc
  const animation = upsertAnimationKeyframe(current, property, authoredKeyframe)
  if (!animation) return reject(doc, op, 'invalid or over-budget keyframe')
  return replaceClipAnimation(doc, loc, animation)
}

/** Move one keyframe; its source replaces any key already at the target time. */
export function moveClipKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
  fromFrame: number,
  toFrame: number,
): TimelineDoc {
  const op = 'moveClipKeyframe'
  const loc = animationEditLocation(doc, clipId, op)
  if (!loc) return doc
  const animation = moveAnimationKeyframe(
    clipAnimation(loc.clip),
    property,
    fromFrame,
    toFrame,
  )
  if (!animation) return reject(doc, op, 'source keyframe is missing or target frame is invalid')
  if (animation === clipAnimation(loc.clip)) return doc
  const moved = animation.tracks
    .find((track) => track.property === property)
    ?.keyframes.find((keyframe) => keyframe.frame === toFrame)
  if (!moved) return reject(doc, op, 'moved keyframe is missing')
  let sourceTimeTicks: number
  try {
    sourceTimeTicks = sourceTicksAtTimelineOffset(clipSourceTimeMap(loc.clip), toFrame)
  } catch {
    return reject(doc, op, 'keyframe source time exceeds safe integer bounds')
  }
  const withIntent = upsertAnimationKeyframe(animation, property, {
    ...moved,
    sourceTimeTicks,
  })
  if (!withIntent) return reject(doc, op, 'moved keyframe source time is invalid')
  return replaceClipAnimation(doc, loc, withIntent)
}

export function removeClipKeyframe(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
  frame: number,
): TimelineDoc {
  const op = 'removeClipKeyframe'
  const loc = animationEditLocation(doc, clipId, op)
  if (!loc) return doc
  const animation = removeAnimationKeyframe(clipAnimation(loc.clip), property, frame)
  if (!animation) return reject(doc, op, 'keyframe not found')
  return replaceClipAnimation(doc, loc, animation)
}

/** Remove one property track while retaining its underlying static value. */
export function resetClipAnimationTrack(
  doc: TimelineDoc,
  clipId: ClipId,
  property: ClipAnimationProperty,
): TimelineDoc {
  const op = 'resetClipAnimationTrack'
  const loc = animationEditLocation(doc, clipId, op)
  if (!loc) return doc
  const animation = removeAnimationTrack(clipAnimation(loc.clip), property)
  if (!animation) return doc
  return replaceClipAnimation(doc, loc, animation)
}

function staticVisualPatchDiffers(
  clip: Clip,
  patch: ClipVisualPatch,
): boolean {
  for (const [key, value] of Object.entries(patch.transform ?? {}) as Array<
    [keyof Transform, number]
  >) {
    if (clip.transform[key] !== value) return true
  }
  if (patch.opacity !== undefined && clip.opacity !== patch.opacity) return true
  if (
    patch.blendMode !== undefined
    && clipBlendModeIntent(clip) !== patch.blendMode
  ) return true
  if (patch.visual) {
    const current = clipVisualSettings(clip)
    const next = {
      ...current,
      ...patch.visual,
      crop: { ...current.crop, ...(patch.visual.crop ?? {}) },
    }
    if (!sameVisual(current, next)) return true
  }
  return false
}

/**
 * Apply Inspector/Program Monitor edits at one timeline frame. Static
 * properties keep using their durable fields; already-animated properties
 * receive a keyframe at the playhead without mutating the document per frame.
 */
export function updateClipVisualAtFrame(
  doc: TimelineDoc,
  clipId: ClipId,
  timelineFrame: number,
  patch: ClipVisualPatch,
): TimelineDoc {
  const op = 'updateClipVisualAtFrame'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (!Number.isSafeInteger(timelineFrame)) {
    return reject(doc, op, `timeline frame must be a safe integer, got ${timelineFrame}`)
  }

  const normalizedTransform = { ...(patch.transform ?? {}) }
  const currentVisual = clipVisualSettings(loc.clip)
  const scaleLocked = patch.visual?.scaleLocked ?? currentVisual.scaleLocked
  if (
    scaleLocked
    && (normalizedTransform.scaleX !== undefined || normalizedTransform.scaleY !== undefined)
  ) {
    if (
      normalizedTransform.scaleX !== undefined
      && normalizedTransform.scaleY !== undefined
      && normalizedTransform.scaleX !== normalizedTransform.scaleY
    ) return reject(doc, op, 'locked scale X and Y must match')
    const scale = normalizedTransform.scaleX ?? normalizedTransform.scaleY
    normalizedTransform.scaleX = scale
    normalizedTransform.scaleY = scale
  }

  const animatedValues = new Map<ClipAnimationProperty, number>()
  const staticTransform: Partial<Transform> = {}
  for (const [key, value] of Object.entries(normalizedTransform) as Array<
    [keyof Transform, number]
  >) {
    const property = TRANSFORM_ANIMATION_PROPERTIES[key]
    if (property && isClipPropertyAnimated(loc.clip, property)) {
      const valueError = animationPropertyValueError(property, value)
      if (valueError) return reject(doc, op, valueError)
      animatedValues.set(property, value)
    } else {
      staticTransform[key] = value
    }
  }
  let staticOpacity = patch.opacity
  if (patch.opacity !== undefined && isClipPropertyAnimated(loc.clip, 'opacity')) {
    const valueError = animationPropertyValueError('opacity', patch.opacity)
    if (valueError) return reject(doc, op, valueError)
    animatedValues.set('opacity', patch.opacity)
    staticOpacity = undefined
  }

  const localFrame = timelineFrame - loc.clip.timelineRange.startFrame
  if (
    animatedValues.size > 0
    && (
      localFrame < 0
      || localFrame >= loc.clip.timelineRange.durationFrames
    )
  ) return reject(doc, op, 'playhead must be inside the clip to edit animated values')

  const staticPatch: ClipVisualPatch = {
    ...(Object.keys(staticTransform).length === 0 ? {} : { transform: staticTransform }),
    ...(staticOpacity === undefined ? {} : { opacity: staticOpacity }),
    ...(patch.blendMode === undefined ? {} : { blendMode: patch.blendMode }),
    ...(patch.visual === undefined ? {} : { visual: patch.visual }),
  }
  const hasStaticPatch = Object.keys(staticPatch).length > 0
  let working = doc
  if (hasStaticPatch) {
    const next = updateClipVisual(doc, clipId, staticPatch)
    if (next === doc && staticVisualPatchDiffers(loc.clip, staticPatch)) return doc
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
    const next = upsertAnimationKeyframe(animation, property, {
      frame: localFrame,
      sourceTimeTicks: sourceTicksAtTimelineOffset(
        clipSourceTimeMap(workingLoc.clip),
        localFrame,
      ),
      value,
      easing: existing?.easing ?? LINEAR_ANIMATION_EASING,
    })
    if (!next) return reject(doc, op, 'animated edit exceeds keyframe limits')
    animation = next
  }
  return replaceClipAnimation(working, workingLoc, animation)
}

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

/** Per-track toggle flags (timeline header buttons). */
export interface TrackFlagsPatch {
  hidden?: boolean
  muted?: boolean
  solo?: boolean
  locked?: boolean
}

/**
 * Add a new empty track of `kind`, named with the NLE convention V2/V3…
 * (video) or A2/A3… (audio) — the next free number for that kind, counting
 * both existing ids and names so a rename can never cause an id collision.
 *
 * Placement keeps the doc's [videos…, audios…] shape AND the compositing
 * convention (tracks[0] = bottom layer): a video track goes AFTER the last
 * video track, so it composites above the existing video stack; an audio
 * track goes after the last audio track (the end). Never rejects.
 */
export function addTrack(doc: TimelineDoc, kind: TrackKind): TimelineDoc {
  const prefix = kind === 'video' ? 'V' : 'A'
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  let max = 0
  for (const track of doc.tracks) {
    for (const label of [track.id, track.name]) {
      const m = pattern.exec(label)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  const label = `${prefix}${max + 1}`
  const track: Track = {
    id: label,
    kind,
    name: label,
    clips: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }

  let lastOfKind = -1
  for (let t = 0; t < doc.tracks.length; t++) {
    if (doc.tracks[t].kind === kind) lastOfKind = t
  }
  // No video track yet → index 0 (below any audio in the array); no audio
  // track yet → the end. Both keep videos grouped before audios.
  const insertAt =
    lastOfKind !== -1 ? lastOfKind + 1 : kind === 'video' ? 0 : doc.tracks.length
  const tracks = doc.tracks.slice()
  tracks.splice(insertAt, 0, track)
  return { ...doc, tracks }
}

/**
 * Set a track's toggle flags: hidden (video → skipped by the compositor),
 * muted (audio → excluded from the mix), locked (rejects clip edits).
 * DELIBERATE exception to the locked rule: flags may be changed on a locked
 * track — otherwise a track could never be unlocked. A patch that changes
 * nothing returns the same reference WITHOUT a warning (an idempotent
 * toggle is not an error, it just pushes no history entry).
 */
export function setTrackFlags(
  doc: TimelineDoc,
  trackId: TrackId,
  patch: TrackFlagsPatch,
): TimelineDoc {
  const op = 'setTrackFlags'
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const track = doc.tracks[trackIndex]

  const keys = (['hidden', 'muted', 'solo', 'locked'] as const).filter(
    (k) => patch[k] !== undefined,
  )
  if (keys.length === 0) return reject(doc, op, 'empty patch — nothing to change')
  if (keys.every((k) => patch[k] === track[k])) return doc

  const next = { ...track }
  for (const k of keys) next[k] = patch[k] as boolean
  return withTrack(doc, trackIndex, next)
}

/**
 * Rename a track (display name only — the id never changes, so clips,
 * undo snapshots and UI keys keep working). The name is trimmed; an empty
 * result is rejected. Renaming to the CURRENT name returns the same
 * reference silently (idempotent, no history entry), matching
 * setTrackFlags. Renaming a locked track is allowed — like its flags, a
 * track's label is metadata about the track, not an edit of its content.
 */
export function renameTrack(
  doc: TimelineDoc,
  trackId: TrackId,
  name: string,
): TimelineDoc {
  const op = 'renameTrack'
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const trimmed = name.trim()
  if (trimmed === '') return reject(doc, op, 'name must not be empty')
  const track = doc.tracks[trackIndex]
  if (trimmed === track.name) return doc
  return withTrack(doc, trackIndex, { ...track, name: trimmed })
}

/**
 * Delete a track AND everything on it (clips, transitions) — one op, so
 * one undo entry restores the lot. Any link group that would be left with
 * exactly one surviving member is dissolved in the same operation, keeping
 * the document portable and the schema's no-orphan contract intact. A locked
 * target or locked orphan survivor rejects atomically (the lock is exactly
 * the "don't touch this content" guard); unknown ids reject.
 * Deleting the last track of a kind is allowed — the add-track buttons
 * and undo are both one click away, and nothing in the engine requires a
 * lane of each kind to exist.
 */
export function removeTrack(doc: TimelineDoc, trackId: TrackId): TimelineDoc {
  const op = 'removeTrack'
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const removedTrack = doc.tracks[trackIndex]
  if (removedTrack.locked) {
    return reject(doc, op, `track ${trackId} is locked`)
  }

  const touchedGroups = new Set<string>()
  for (const clip of removedTrack.clips) {
    if (clip.linkGroupId !== undefined) touchedGroups.add(clip.linkGroupId)
  }

  const survivingCounts = new Map<string, number>()
  if (touchedGroups.size > 0) {
    for (let index = 0; index < doc.tracks.length; index++) {
      if (index === trackIndex) continue
      for (const clip of doc.tracks[index].clips) {
        if (clip.linkGroupId !== undefined && touchedGroups.has(clip.linkGroupId)) {
          survivingCounts.set(
            clip.linkGroupId,
            (survivingCounts.get(clip.linkGroupId) ?? 0) + 1,
          )
        }
      }
    }
  }

  const orphanedGroups = new Set<string>()
  for (const groupId of touchedGroups) {
    if (survivingCounts.get(groupId) === 1) orphanedGroups.add(groupId)
  }

  // Preflight every survivor before rebuilding anything. Dissolving its link
  // is still an edit to that clip, so a locked partner blocks the whole op.
  for (let index = 0; index < doc.tracks.length; index++) {
    if (index === trackIndex) continue
    const track = doc.tracks[index]
    if (
      track.locked &&
      track.clips.some(
        (clip) =>
          clip.linkGroupId !== undefined &&
          orphanedGroups.has(clip.linkGroupId),
      )
    ) {
      return reject(doc, op, `linked survivor on track ${track.id} is locked`)
    }
  }

  const tracks: Track[] = []
  for (let index = 0; index < doc.tracks.length; index++) {
    if (index === trackIndex) continue
    const track = doc.tracks[index]
    if (
      !track.clips.some(
        (clip) =>
          clip.linkGroupId !== undefined &&
          orphanedGroups.has(clip.linkGroupId),
      )
    ) {
      tracks.push(track)
      continue
    }
    tracks.push({
      ...track,
      clips: track.clips.map((clip) =>
        clip.linkGroupId !== undefined &&
        orphanedGroups.has(clip.linkGroupId)
          ? withoutLinkGroupId(clip)
          : clip,
      ),
    })
  }
  return { ...doc, tracks }
}

/** Upper clip-volume bound: 200% gain, the usual NLE headroom. */
export const MAX_CLIP_VOLUME = 2

/**
 * Set a clip's audio volume (linear gain, clamped to [0, MAX_CLIP_VOLUME]
 * like opacity's [0,1] — a UI convention, not an error). Meaningful for
 * clips on audio tracks; the mix (Phase 5 export, future playback) reads
 * it via clip.volume. Rejects non-finite values, unknown clips and locked
 * tracks; setting the current value returns the same reference silently.
 */
export function setClipVolume(
  doc: TimelineDoc,
  clipId: ClipId,
  volume: number,
): TimelineDoc {
  const op = 'setClipVolume'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (!Number.isFinite(volume)) {
    return reject(doc, op, `volume must be a finite number, got ${volume}`)
  }

  const clamped = Math.min(MAX_CLIP_VOLUME, Math.max(0, volume))
  if (clamped === loc.clip.volume) return doc

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, volume: clamped }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/**
 * Append an effect to a clip's chain. The effect is defensively copied so
 * later mutation of the caller's object cannot reach into the doc.
 */
export function addEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effect: Effect,
): TimelineDoc {
  const op = 'addEffect'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  const validationError = effectDescriptorValidationError(effect)
  if (validationError) return reject(doc, op, validationError)
  const budgetError = effectAppendBudgetError(doc, loc.clip, effect)
  if (budgetError) return reject(doc, op, budgetError)
  if (effectIdExists(doc, effect.id)) {
    return reject(doc, op, `document already has an effect with id ${effect.id}`)
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    effects: [...loc.clip.effects, cloneEffectDescriptor(effect)],
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

function effectIdExists(doc: TimelineDoc, effectId: EffectId): boolean {
  return doc.tracks.some((track) =>
    track.clips.some((clip) => clip.effects.some((effect) => effect.id === effectId)),
  )
}

function effectDescriptorValidationError(effect: Effect): string | null {
  return effectDescriptorBoundsError(effect) ?? effectParamsValidationError(effect)
}

function updateEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  op: string,
  update: (effect: Effect, index: number, effects: readonly Effect[]) => Effect[] | null,
): TimelineDoc {
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  const effectIndex = loc.clip.effects.findIndex((effect) => effect.id === effectId)
  if (effectIndex < 0) return reject(doc, op, `effect ${effectId} not found on clip ${clipId}`)
  const effects = update(loc.clip.effects[effectIndex], effectIndex, loc.clip.effects)
  if (!effects) return doc
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, effects }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/** Enable or bypass one effect without disturbing its position or parameters. */
export function setEffectEnabled(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  enabled: boolean,
): TimelineDoc {
  if (typeof enabled !== 'boolean') return reject(doc, 'setEffectEnabled', 'enabled must be a boolean')
  return updateEffect(doc, clipId, effectId, 'setEffectEnabled', (effect, index, current) => {
    if (effect.enabled === enabled) return null
    const effects = current.slice()
    effects[index] = { ...effect, enabled, params: { ...effect.params } }
    return effects
  })
}

/** Merge a typed parameter patch into one descriptor after registry validation. */
export function updateEffectParams(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  patch: Readonly<Record<string, EffectParamValue>>,
): TimelineDoc {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return reject(doc, 'updateEffectParams', 'parameter patch must be a record')
  }
  return updateEffect(doc, clipId, effectId, 'updateEffectParams', (effect, index, current) => {
    const next = { ...effect, params: { ...effect.params, ...patch } }
    const validationError = effectDescriptorValidationError(next)
    if (validationError) {
      reject(doc, 'updateEffectParams', validationError)
      return null
    }
    const budgetError = effectReplacementBudgetError(doc, effect, next)
    if (budgetError) {
      reject(doc, 'updateEffectParams', budgetError)
      return null
    }
    const changed = Object.entries(patch).some(([key, value]) => effect.params[key] !== value)
    if (!changed) return null
    const effects = current.slice()
    effects[index] = next
    return effects
  })
}

/** Move one descriptor to an exact index while retaining stable instance identity. */
export function reorderEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
  targetIndex: number,
): TimelineDoc {
  if (!Number.isSafeInteger(targetIndex)) {
    return reject(doc, 'reorderEffect', `target index must be a safe integer, got ${targetIndex}`)
  }
  return updateEffect(doc, clipId, effectId, 'reorderEffect', (_effect, index, current) => {
    if (targetIndex < 0 || targetIndex >= current.length) {
      reject(doc, 'reorderEffect', `target index ${targetIndex} is outside the effect stack`)
      return null
    }
    if (targetIndex === index) return null
    const effects = current.slice()
    const [moved] = effects.splice(index, 1)
    effects.splice(targetIndex, 0, moved)
    return effects
  })
}

/** Reset registered parameters while retaining unknown forward-compatible keys. */
export function resetEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
): TimelineDoc {
  return updateEffect(doc, clipId, effectId, 'resetEffect', (effect, index, current) => {
    const registration = effectRegistration(effect.type)
    if (!registration || registration.version !== effect.version) {
      reject(doc, 'resetEffect', `effect ${effectId} has no supported reset contract`)
      return null
    }
    const params = { ...effect.params, ...registration.defaultParams }
    const changed = Object.entries(registration.defaultParams)
      .some(([key, value]) => effect.params[key] !== value)
    if (!changed) return null
    const effects = current.slice()
    effects[index] = { ...effect, params }
    return effects
  })
}

/** Remove one descriptor from a clip's ordered stack. */
export function removeEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effectId: EffectId,
): TimelineDoc {
  return updateEffect(doc, clipId, effectId, 'removeEffect', (_effect, index, current) => {
    const effects = current.slice()
    effects.splice(index, 1)
    return effects
  })
}
