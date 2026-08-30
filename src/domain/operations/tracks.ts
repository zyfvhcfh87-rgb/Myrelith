import type { ClipId, MasterAudioSettings, TimelineDoc, Track, TrackId, TrackKind } from '../schema';
import {
  MAX_AUDIO_BALANCE,
  MAX_CLIP_VOLUME,
  MIN_AUDIO_BALANCE,
} from '../clipInspector';
import {
  masterAudioSettings,
  masterAudioValidationError,
  trackBalance,
  trackMixerValidationError,
  trackVolume,
} from '../audioMixer';
import { locateClip, reject, withoutLinkGroupId, withTrack } from './operationInternals';

export { MAX_CLIP_VOLUME }

/** Per-track toggle flags (timeline header buttons). */
export interface TrackFlagsPatch {
  hidden?: boolean
  muted?: boolean
  solo?: boolean
  locked?: boolean
}

/** Linear track fader and pan. Mute/solo stay on TrackFlagsPatch. */
export interface TrackMixerPatch {
  volume?: number
  balance?: number
}

export type MasterAudioPatch = Partial<MasterAudioSettings>

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
    adjustments: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    volume: 1,
    balance: 0,
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
 * Set an audio track's mixer volume/balance. Locked tracks reject — this is
 * mix content, unlike mute/solo which remain reachable from the header.
 * Video tracks reject; they are not in the mix bus. Idempotent patches
 * return the same document reference.
 */
export function setTrackMixer(
  doc: TimelineDoc,
  trackId: TrackId,
  patch: TrackMixerPatch,
): TimelineDoc {
  const op = 'setTrackMixer'
  const trackIndex = doc.tracks.findIndex((item) => item.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const track = doc.tracks[trackIndex]
  if (track.kind !== 'audio') {
    return reject(doc, op, `track ${trackId} is not an audio track`)
  }
  if (track.locked) return reject(doc, op, `track ${trackId} is locked`)

  const hasVolume = patch.volume !== undefined
  const hasBalance = patch.balance !== undefined
  if (!hasVolume && !hasBalance) {
    return reject(doc, op, 'empty patch — nothing to change')
  }
  if (hasVolume && !Number.isFinite(patch.volume)) {
    return reject(doc, op, `volume must be a finite number, got ${patch.volume}`)
  }
  if (hasBalance && !Number.isFinite(patch.balance)) {
    return reject(doc, op, `balance must be a finite number, got ${patch.balance}`)
  }

  const volume = patch.volume === undefined
    ? trackVolume(track)
    : Math.min(MAX_CLIP_VOLUME, Math.max(0, patch.volume))
  const balance = patch.balance === undefined
    ? trackBalance(track)
    : Math.min(MAX_AUDIO_BALANCE, Math.max(MIN_AUDIO_BALANCE, patch.balance))
  const error = trackMixerValidationError(volume, balance)
  if (error) return reject(doc, op, error)
  if (volume === trackVolume(track) && balance === trackBalance(track)) return doc

  return withTrack(doc, trackIndex, { ...track, volume, balance })
}

/**
 * Set the document master bus. Idempotent patches return the same reference.
 */
export function setMasterAudio(
  doc: TimelineDoc,
  patch: MasterAudioPatch,
): TimelineDoc {
  const op = 'setMasterAudio'
  const keys = (['volume', 'balance', 'muted'] as const).filter(
    (key) => patch[key] !== undefined,
  )
  if (keys.length === 0) return reject(doc, op, 'empty patch — nothing to change')
  if (patch.volume !== undefined && !Number.isFinite(patch.volume)) {
    return reject(doc, op, `volume must be a finite number, got ${patch.volume}`)
  }
  if (patch.balance !== undefined && !Number.isFinite(patch.balance)) {
    return reject(doc, op, `balance must be a finite number, got ${patch.balance}`)
  }

  const current = masterAudioSettings(doc)
  const volume = patch.volume === undefined
    ? current.volume
    : Math.min(MAX_CLIP_VOLUME, Math.max(0, patch.volume))
  const balance = patch.balance === undefined
    ? current.balance
    : Math.min(MAX_AUDIO_BALANCE, Math.max(MIN_AUDIO_BALANCE, patch.balance))
  const muted = patch.muted ?? current.muted
  const next: MasterAudioSettings = { volume, balance, muted }
  const error = masterAudioValidationError(next)
  if (error) return reject(doc, op, error)
  if (
    next.volume === current.volume
    && next.balance === current.balance
    && next.muted === current.muted
  ) return doc

  return { ...doc, masterAudio: next }
}
