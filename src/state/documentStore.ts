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
import type { Clip, ClipId, Effect, TimelineDoc, TrackId, TrackKind } from '../domain/schema'
import type { ClipTransformPatch, TrackFlagsPatch, TrimEdge } from '../domain/operations'
import {
  addEffect,
  addTrack,
  insertClip,
  moveClip,
  removeTrack,
  renameTrack,
  rippleDelete,
  rippleTrim,
  setClipVolume,
  setTrackFlags,
  slideClip,
  slipClip,
  splitClipAtFrame,
  trimClip,
  updateClipTransform,
} from '../domain/operations'
import { rangeEnd } from '../domain/time'

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
   * unlocked tracks. One history entry for the whole gesture.
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
   * splitClipAtPlayhead is the split-everything keyboard variant).
   */
  splitClipAt: (clipId: ClipId, frame: number) => void
  /** Trim one clip edge by a signed frame delta. */
  trimClip: (clipId: ClipId, edge: TrimEdge, deltaFrames: number) => void
  /**
   * Ripple-trim one clip edge: downstream clips on the same track shift to
   * keep their spacing (Phase 4.2 trim tool).
   */
  rippleTrim: (clipId: ClipId, edge: TrimEdge, deltaFrames: number) => void
  /** Shift a clip's source material without moving it (Phase 4.2 slip tool). */
  slipClip: (clipId: ClipId, deltaFrames: number) => void
  /** Move a clip while touching neighbors absorb the change (slide tool). */
  slideClip: (clipId: ClipId, deltaFrames: number) => void
  /** Move a clip to a new frame, optionally onto another same-kind track. */
  moveClip: (clipId: ClipId, toTrackId: TrackId, toFrame: number) => void
  /** Delete a clip and shift later clips on its track left to close the gap. */
  rippleDelete: (clipId: ClipId) => void
  /** Merge transform fields / opacity into a clip (Inspector, 4.3). */
  updateClipTransform: (clipId: ClipId, patch: ClipTransformPatch) => void
  /**
   * Set a clip's audio volume (Inspector for audio clips). Domain-clamped
   * to [0, MAX_CLIP_VOLUME]; an unchanged value pushes no history entry.
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

/** Fresh default project: 1080p, 30fps, one video + one audio track. */
function emptyDoc(): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc_default',
    name: 'Untitled',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      {
        id: 'V1',
        kind: 'video',
        name: 'V1',
        clips: [],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
      {
        id: 'A1',
        kind: 'audio',
        name: 'A1',
        clips: [],
        transitions: [],
        hidden: false,
        muted: false,
        solo: false,
        locked: false,
      },
    ],
  }
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
  doc: emptyDoc(),
  past: [],
  future: [],

  setDoc: (doc) => set({ doc, past: [], future: [] }),

  splitClipAtPlayhead: (playheadFrame) =>
    set((state) => {
      let next = state.doc
      // Collect targets from the CURRENT doc; left halves keep their ids, so
      // each original clip is split at most once even as `next` evolves.
      for (const track of state.doc.tracks) {
        if (track.locked) continue
        for (const clip of track.clips) {
          const tl = clip.timelineRange
          if (playheadFrame > tl.startFrame && playheadFrame < rangeEnd(tl)) {
            next = splitClipAtFrame(next, clip.id, playheadFrame)
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
    set((state) => commit(state, splitClipAtFrame(state.doc, clipId, frame))),

  trimClip: (clipId, edge, deltaFrames) =>
    set((state) => commit(state, trimClip(state.doc, clipId, edge, deltaFrames))),

  rippleTrim: (clipId, edge, deltaFrames) =>
    set((state) => commit(state, rippleTrim(state.doc, clipId, edge, deltaFrames))),

  slipClip: (clipId, deltaFrames) =>
    set((state) => commit(state, slipClip(state.doc, clipId, deltaFrames))),

  slideClip: (clipId, deltaFrames) =>
    set((state) => commit(state, slideClip(state.doc, clipId, deltaFrames))),

  moveClip: (clipId, toTrackId, toFrame) =>
    set((state) => commit(state, moveClip(state.doc, clipId, toTrackId, toFrame))),

  rippleDelete: (clipId) =>
    set((state) => commit(state, rippleDelete(state.doc, clipId))),

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
