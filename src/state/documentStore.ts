/**
 * state/documentStore.ts — Zustand store owning the TimelineDoc plus
 * undo/redo history. Phase 1.2.
 *
 * Layering (ARCHITECTURE.md): imports domain/ only — never ui/, engine/,
 * pipeline/, workers/, or react.
 *
 * History model: plain snapshot stacks. `past` holds older docs (most recent
 * last), `future` holds undone docs (next redo first), both capped at
 * HISTORY_LIMIT. Because domain/operations returns the SAME doc reference
 * when an edit is rejected, a rejected/no-op edit is detected with `===` and
 * pushes NO history entry — undo never has to step through non-changes.
 *
 * Design note (deviation from the plan, on purpose): the plan suggested the
 * Immer middleware, but domain/operations already returns brand-new immutable
 * docs, so Immer would add a proxy layer with nothing to do. Plain snapshot
 * swaps are simpler and behave identically. Revisit only if non-operation
 * actions ever get mutation-heavy.
 */

import { create } from 'zustand'
import type {
  Clip,
  ClipId,
  Effect,
  TimelineDoc,
  TrackId,
  TrackKind,
  TransitionId,
} from '../domain/schema'
import type {
  ClipTransformPatch,
  CrossfadeSettings,
  TrackFlagsPatch,
  TrimEdge,
} from '../domain/operations'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import {
  addCrossfade,
  addCrossfadeWithSourceBounds as addExactCrossfade,
  addEffect,
  addTrack,
  insertClip,
  removeTransition,
  removeTrack,
  renameTrack,
  setClipVolume,
  setCrossfadeDuration,
  setCrossfadeSettingsWithSourceBounds,
  setTrackFlags,
  updateClipTransform,
} from '../domain/operations'
import {
  linkClips as linkClipsInDocument,
  linkedMoveClip,
  linkedRippleDelete,
  linkedRippleTrim,
  linkedSlideClip,
  linkedSlipClip,
  linkedSplitClipAtFrame,
  linkedTrimClip,
  unlinkClip,
} from '../domain/linking'
import { rangeEnd } from '../domain/time'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
} from '../domain/projectSettings'

/** Max undo levels; snapshots beyond this fall off the old end. */
const HISTORY_LIMIT = 100

/** The DocumentActions contract (see ARCHITECTURE.md, store contracts). */
export interface DocumentState {
  /** The current document — the single source of truth for the timeline. */
  doc: TimelineDoc
  /** Undo stack: older snapshots, most recent last. */
  past: TimelineDoc[]
  /** Redo stack: undone snapshots, next redo first. */
  future: TimelineDoc[]

  /** Replace the whole document (project load). Clears history. */
  setDoc: (doc: TimelineDoc) => void
  /**
   * Split every clip that the playhead falls strictly inside, across all
   * unlocked tracks. One history entry for the whole gesture. Each link
   * group is split at most once — a partner's split follows automatically
   * (domain/linking) even though its own range would also match the test.
   */
  splitClipAtPlayhead: (playheadFrame: number) => void
  /**
   * Insert a new clip onto a track (Phase 4.0 media → timeline flow).
   * Callers build the clip (e.g. domain clipFromAsset); a rejected insert
   * (overlap, locked, bad geometry) pushes no history entry.
   */
  insertClip: (trackId: TrackId, clip: Clip) => void
  /**
   * Insert several clips as ONE gesture — the A/V drop path, where a video
   * asset with audio lands as a video clip plus its audio clip. Atomic:
   * if ANY insert is rejected the doc is left untouched (a drop can never
   * place half of a linked pair), and a successful batch is ONE history
   * entry, so a single undo removes the whole pair.
   */
  insertClips: (inserts: ReadonlyArray<{ trackId: TrackId; clip: Clip }>) => void
  /**
   * Split ONE clip at a timeline frame strictly inside it (the razor tool;
   * splitClipAtPlayhead is the split-everything keyboard variant). Linked
   * partners follow (one entry); see domain/linking.
   */
  splitClipAt: (clipId: ClipId, frame: number) => void
  /**
   * Trim one clip edge by a signed frame delta. Linked partners follow
   * (one entry); see domain/linking.
   */
  trimClip: (clipId: ClipId, edge: TrimEdge, deltaFrames: number) => void
  /**
   * Ripple-trim one clip edge: downstream clips on the same track shift to
   * keep their spacing (Phase 4.2 trim tool). Linked partners follow (one
   * entry); see domain/linking.
   */
  rippleTrim: (clipId: ClipId, edge: TrimEdge, deltaFrames: number) => void
  /**
   * Shift a clip's source material without moving it (Phase 4.2 slip tool).
   * Linked partners follow (one entry); see domain/linking.
   */
  slipClip: (clipId: ClipId, deltaFrames: number) => void
  /**
   * Move a clip while touching neighbors absorb the change (slide tool).
   * Linked partners follow (one entry); see domain/linking.
   */
  slideClip: (clipId: ClipId, deltaFrames: number) => void
  /**
   * Move a clip to a new frame, optionally onto another same-kind track.
   * Linked partners follow (one entry); see domain/linking.
   */
  moveClip: (clipId: ClipId, toTrackId: TrackId, toFrame: number) => void
  /**
   * Delete a clip and shift later clips on its track left to close the gap.
   * Linked partners follow (one entry); see domain/linking.
   */
  rippleDelete: (clipId: ClipId) => void
  /**
   * Add a centered crossfade between ordered touching video clips. A valid
   * add is one undo entry; rejected geometry or a locked track adds none.
   */
  addCrossfade: (
    fromClipId: ClipId,
    toClipId: ClipId,
    durationFrames: number,
  ) => void
  /** Add exact handle-aware duration/audio intent as one history entry. */
  addCrossfadeWithSourceBounds: (
    fromClipId: ClipId,
    toClipId: ClipId,
    settings: CrossfadeSettings,
    catalog: SourceBoundsCatalog,
  ) => void
  /**
   * Change one crossfade duration while preserving its id. `trackId` scopes
   * stale UI calls; unchanged or rejected edits add no history entry.
   */
  setCrossfadeDuration: (
    trackId: TrackId,
    transitionId: TransitionId,
    durationFrames: number,
  ) => void
  /** Atomically replace duration and audio intent in one history entry. */
  setCrossfadeSettings: (
    trackId: TrackId,
    transitionId: TransitionId,
    settings: CrossfadeSettings,
    catalog: SourceBoundsCatalog,
  ) => void
  /**
   * Remove one transition from its owning track. Stale endpoint definitions
   * remain removable; unknown/mismatched ids and locked tracks are no-ops.
   */
  removeTransition: (trackId: TrackId, transitionId: TransitionId) => void
  /**
   * Link one existing video clip to one existing audio clip. A successful
   * link is one history entry; the pure domain contract rejects invalid,
   * locked, or already-linked pairs without changing history.
   */
  linkClips: (videoClipId: ClipId, audioClipId: ClipId) => void
  /**
   * Dissolve clipId's whole link group in one entry — every member loses
   * its linkGroupId (the Inspector's manual "unlink" button). A clip with
   * no linkGroupId, or any group member on a locked track, is rejected: no
   * history entry, a console.warn explains why.
   */
  unlinkClip: (clipId: ClipId) => void
  /**
   * Merge transform fields / opacity into a clip (Inspector, 4.3). Does NOT
   * follow links — transform lives on the video half and stays
   * independently editable even when linked to an audio half.
   */
  updateClipTransform: (clipId: ClipId, patch: ClipTransformPatch) => void
  /**
   * Set a clip's audio volume (Inspector for audio clips). Domain-clamped
   * to [0, MAX_CLIP_VOLUME]; an unchanged value pushes no history entry.
   * Does NOT follow links — volume lives on the audio half and stays
   * independently editable even when linked to a video half.
   */
  setClipVolume: (clipId: ClipId, volume: number) => void
  /**
   * Add a new empty V#/A# track (timeline header "+ track" buttons). One
   * history entry — an added track is undoable like any other edit.
   */
  addTrack: (kind: TrackKind) => void
  /**
   * Toggle a track's hidden/muted/solo/locked flags (timeline header
   * buttons). An idempotent patch changes nothing and pushes no history
   * entry.
   */
  setTrackFlags: (trackId: TrackId, patch: TrackFlagsPatch) => void
  /**
   * Rename a track's display name (header double-click). Trimmed by the
   * domain op; renaming to the current name pushes no history entry.
   */
  renameTrack: (trackId: TrackId, name: string) => void
  /**
   * Delete a track with everything on it — ONE history entry, so one undo
   * brings the track and all its clips back. Locked tracks reject.
   */
  removeTrack: (trackId: TrackId) => void
  /** Append an effect to a clip's chain. */
  addEffect: (clipId: ClipId, effect: Effect) => void
  /** Step back one snapshot. No-op when history is empty. */
  undo: () => void
  /** Step forward one undone snapshot. No-op when future is empty. */
  redo: () => void
}

/**
 * Fold a successful edit into the state: push the outgoing doc onto `past`,
 * clear `future`. A rejected edit (same reference) changes nothing at all.
 */
function commit(
  state: DocumentState,
  next: TimelineDoc,
): Pick<DocumentState, 'doc' | 'past' | 'future'> | DocumentState {
  if (next === state.doc) return state
  return {
    doc: next,
    past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
    future: [],
  }
}

export const useDocumentStore = create<DocumentState>()((set) => ({
  doc: createTimelineDoc('Untitled', DEFAULT_PROJECT_SETTINGS, 'doc_default'),
  past: [],
  future: [],

  setDoc: (doc) => set({ doc, past: [], future: [] }),

  splitClipAtPlayhead: (playheadFrame) =>
    set((state) => {
      let next = state.doc
      // Collect targets from the CURRENT doc; left halves keep their ids, so
      // each original clip is split at most once even as `next` evolves.
      // A linked group is split via whichever member is visited first; mark
      // it in `splitGroups` BEFORE calling (win or lose) so a partner from
      // the same group is skipped outright instead of re-attempting a split
      // linkedSplitClipAtFrame already resolved — the op is atomic per
      // group, so a second call would just reject again and double the warn.
      const splitGroups = new Set<string>()
      for (const track of state.doc.tracks) {
        if (track.locked) continue
        for (const clip of track.clips) {
          const tl = clip.timelineRange
          if (playheadFrame > tl.startFrame && playheadFrame < rangeEnd(tl)) {
            if (clip.linkGroupId) {
              if (splitGroups.has(clip.linkGroupId)) continue
              splitGroups.add(clip.linkGroupId)
            }
            next = linkedSplitClipAtFrame(next, clip.id, playheadFrame)
          }
        }
      }
      return commit(state, next)
    }),

  insertClip: (trackId, clip) =>
    set((state) => commit(state, insertClip(state.doc, trackId, clip))),

  insertClips: (inserts) =>
    set((state) => {
      let next = state.doc
      for (const { trackId, clip } of inserts) {
        const after = insertClip(next, trackId, clip)
        // Any rejection (insertClip already warned why) aborts the WHOLE
        // batch: return the untouched state so no history entry appears.
        if (after === next) return state
        next = after
      }
      return commit(state, next)
    }),

  splitClipAt: (clipId, frame) =>
    set((state) => commit(state, linkedSplitClipAtFrame(state.doc, clipId, frame))),

  trimClip: (clipId, edge, deltaFrames) =>
    set((state) => commit(state, linkedTrimClip(state.doc, clipId, edge, deltaFrames))),

  rippleTrim: (clipId, edge, deltaFrames) =>
    set((state) => commit(state, linkedRippleTrim(state.doc, clipId, edge, deltaFrames))),

  slipClip: (clipId, deltaFrames) =>
    set((state) => commit(state, linkedSlipClip(state.doc, clipId, deltaFrames))),

  slideClip: (clipId, deltaFrames) =>
    set((state) => commit(state, linkedSlideClip(state.doc, clipId, deltaFrames))),

  moveClip: (clipId, toTrackId, toFrame) =>
    set((state) => commit(state, linkedMoveClip(state.doc, clipId, toTrackId, toFrame))),

  rippleDelete: (clipId) =>
    set((state) => commit(state, linkedRippleDelete(state.doc, clipId))),

  addCrossfade: (fromClipId, toClipId, durationFrames) =>
    set((state) =>
      commit(
        state,
        addCrossfade(state.doc, fromClipId, toClipId, durationFrames),
      ),
    ),

  addCrossfadeWithSourceBounds: (
    fromClipId,
    toClipId,
    settings,
    catalog,
  ) =>
    set((state) =>
      commit(
        state,
        addExactCrossfade(
          state.doc,
          fromClipId,
          toClipId,
          settings.durationFrames,
          catalog,
          settings.audio,
        ),
      ),
    ),

  setCrossfadeDuration: (trackId, transitionId, durationFrames) =>
    set((state) =>
      commit(
        state,
        setCrossfadeDuration(
          state.doc,
          trackId,
          transitionId,
          durationFrames,
        ),
      ),
    ),

  setCrossfadeSettings: (trackId, transitionId, settings, catalog) =>
    set((state) =>
      commit(
        state,
        setCrossfadeSettingsWithSourceBounds(
          state.doc,
          trackId,
          transitionId,
          settings,
          catalog,
        ),
      ),
    ),

  removeTransition: (trackId, transitionId) =>
    set((state) =>
      commit(
        state,
        removeTransition(state.doc, trackId, transitionId),
      ),
    ),

  linkClips: (videoClipId, audioClipId) =>
    set((state) =>
      commit(
        state,
        linkClipsInDocument(state.doc, videoClipId, audioClipId),
      ),
    ),

  unlinkClip: (clipId) =>
    set((state) => commit(state, unlinkClip(state.doc, clipId))),

  updateClipTransform: (clipId, patch) =>
    set((state) => commit(state, updateClipTransform(state.doc, clipId, patch))),

  setClipVolume: (clipId, volume) =>
    set((state) => commit(state, setClipVolume(state.doc, clipId, volume))),

  addTrack: (kind) => set((state) => commit(state, addTrack(state.doc, kind))),

  setTrackFlags: (trackId, patch) =>
    set((state) => commit(state, setTrackFlags(state.doc, trackId, patch))),

  renameTrack: (trackId, name) =>
    set((state) => commit(state, renameTrack(state.doc, trackId, name))),

  removeTrack: (trackId) =>
    set((state) => commit(state, removeTrack(state.doc, trackId))),

  addEffect: (clipId, effect) =>
    set((state) => commit(state, addEffect(state.doc, clipId, effect))),

  undo: () =>
    set((state) => {
      const previous = state.past[state.past.length - 1]
      if (!previous) return state
      return {
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
      }
    }),

  redo: () =>
    set((state) => {
      const next = state.future[0]
      if (!next) return state
      return {
        doc: next,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
      }
    }),
}))
