import type { ClipId, TimelineDoc, Track, TrackId, Transition, TransitionId } from '../schema';
import { evaluateCrossfadeDraft, evaluateCrossfadeUpdate, type SourceBoundsCatalog } from '../crossfadePlan';
import { rangeEnd } from '../time';
import { locateClip, locateTrackTransitions, newTransitionId, reject, validTransitionIndexes, withTrack } from './operationInternals';
import type { CrossfadeSettings } from './operationTypes';

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
