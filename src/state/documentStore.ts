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
  CaptionItem,
  CaptionItemId,
  CaptionTrack,
  CaptionTrackId,
  Clip,
  ClipAnimationKeyframe,
  ClipAnimationProperty,
  ClipId,
  Effect,
  EffectId,
  EffectParamValue,
  MediaAsset,
  SourceTimeRate,
  SourceTimeSpeedEasing,
  TimelineDoc,
  TimelineMarker,
  TimelineMarkerId,
  TrackId,
  TrackKind,
  TransitionId,
} from '../domain/schema'
import {
  applySequenceEdit as applySequenceEditToDocument,
  type SequenceEditAcceptedPlan,
} from '../domain/threePointEdit'
import {
  addCaptionItem as addCaptionCue,
  addCaptionTrack as addCaptionLane,
  mergeCaptionWithNext,
  removeCaptionItem as deleteCaptionCue,
  removeCaptionTrack as deleteCaptionLane,
  replaceCaptionItems,
  shiftCaptionItems,
  splitCaptionItem,
  updateCaptionItem as updateCaptionCue,
  updateCaptionTrack as updateCaptionLane,
} from '../domain/captions'
import type { TimelineMarkerPatch } from '../domain/timelineMarkers'
import {
  addTimelineMarker as addMarker,
  deleteTimelineMarker as deleteMarker,
  duplicateTimelineMarker as duplicateMarker,
  updateTimelineMarker as updateMarker,
} from '../domain/timelineMarkers'
import type {
  ClipAudioPatch,
  ClipFramingOperationResult,
  ClipTransformPatch,
  ClipVisualPatch,
  CrossfadeSettings,
  TextPropsPatch,
  TrackFlagsPatch,
  TrimEdge,
} from '../domain/operations'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type {
  DynamicZoomRequest,
  DynamicZoomSourceDimensions,
} from '../domain/dynamicZoom'
import type { VideoStabilizationPlan } from '../domain/videoStabilization'
import type { MotionTrackingPlan } from '../domain/motionTracking'
import {
  addCrossfade,
  addCrossfadeWithSourceBounds as addExactCrossfade,
  addEffect,
  applyDynamicZoomWithResult,
  applyVideoStabilizationWithResult,
  applyMotionTrackingWithResult,
  addTrack,
  insertClip,
  removeTransition,
  removeTrack,
  removeEffect,
  reorderEffect,
  resetEffect,
  resetVideoStabilizationWithResult,
  renameTrack,
  setClipVolume,
  setEffectEnabled,
  setCrossfadeDuration,
  setCrossfadeSettingsWithSourceBounds,
  setTrackFlags,
  updateClipAudio,
  updateClipTransform,
  updateClipVisual,
  updateClipVisualAtFrame,
  updateEffectParams,
  updateEffectParamsAtFrame,
  setClipKeyframe,
  setEffectKeyframe,
  moveEffectKeyframe,
  removeEffectKeyframe,
  resetEffectAnimationTrack,
  moveClipKeyframe,
  removeClipKeyframe,
  resetClipAnimationTrack,
  resetClipFramingAnimationWithResult,
  updateTextClip,
} from '../domain/operations'
import {
  linkClips as linkClipsInDocument,
  linkedMoveClip,
  linkedMoveClips,
  linkedRippleDelete,
  linkedRippleTrim,
  linkedClearClipSpeedRamp,
  linkedRemoveClipSpeedPoint,
  linkedRetimeClip,
  linkedSetClipSpeedPoint,
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
import type { ManualLensCorrectionModel } from '../domain/lensCorrection'
import { setManualLensCorrection } from '../domain/lensCorrectionOperations'

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
  /** Commit a prevalidated whole-document gesture without clearing history. */
  setDocWithHistory: (doc: TimelineDoc) => void
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
  /** Change constant speed for a timed clip and every linked partner. */
  retimeClip: (clipId: ClipId, rate: SourceTimeRate) => void
  /** Add or replace one clip-local speed-ramp point across linked partners. */
  setClipSpeedPoint: (
    clipId: ClipId,
    frame: number,
    rate: SourceTimeRate,
    easing: SourceTimeSpeedEasing,
  ) => void
  /** Remove one clip-local speed-ramp point across linked partners. */
  removeClipSpeedPoint: (clipId: ClipId, frame: number) => void
  /** Restore the retained constant fallback across linked partners. */
  clearClipSpeedRamp: (clipId: ClipId) => void
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
   * Move an ordered clip selection horizontally by one signed frame delta.
   * Linked partners join automatically; success is one history entry and any
   * rejected member rolls the complete group back.
   */
  moveClips: (clipIds: readonly ClipId[], deltaFrames: number) => void
  /**
   * Delete a clip and shift later clips on its track left to close the gap.
   * Linked partners follow (one entry); see domain/linking.
   */
  rippleDelete: (clipId: ClipId) => void
  /**
   * Commit one accepted three-point/sequence-edit plan. Rejected apply
   * paths keep the current document reference and add no history entry.
   */
  applySequenceEdit: (
    plan: SequenceEditAcceptedPlan,
    asset: MediaAsset | null,
    catalog?: SourceBoundsCatalog,
  ) => void
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
  /** Atomically edit/reset the complete static visual Inspector surface. */
  updateClipVisual: (clipId: ClipId, patch: ClipVisualPatch) => void
  /** Replace or clear the supported manual source-geometry model. */
  setManualLensCorrection: (
    clipId: ClipId,
    model: Readonly<ManualLensCorrectionModel> | null,
  ) => void
  /** Edit static fields or upsert active animation tracks at one playhead frame. */
  updateClipVisualAtFrame: (
    clipId: ClipId,
    timelineFrame: number,
    patch: ClipVisualPatch,
  ) => void
  /** Add/replace, move, remove, or reset one property keyframe track. */
  setClipKeyframe: (
    clipId: ClipId,
    property: ClipAnimationProperty,
    keyframe: ClipAnimationKeyframe,
  ) => void
  moveClipKeyframe: (
    clipId: ClipId,
    property: ClipAnimationProperty,
    fromFrame: number,
    toFrame: number,
  ) => void
  removeClipKeyframe: (
    clipId: ClipId,
    property: ClipAnimationProperty,
    frame: number,
  ) => void
  resetClipAnimationTrack: (
    clipId: ClipId,
    property: ClipAnimationProperty,
  ) => void
  /** Replace Position X/Y and Scale X/Y with one ordinary-keyframe preset. */
  applyDynamicZoom: (
    clipId: ClipId,
    source: DynamicZoomSourceDimensions,
    request: DynamicZoomRequest,
  ) => ClipFramingOperationResult
  /** Replace Position/Rotation/Scale with an accepted stabilization plan. */
  applyVideoStabilization: (
    clipId: ClipId,
    plan: VideoStabilizationPlan,
    replaceExisting: boolean,
  ) => ClipFramingOperationResult
  /** Replace one target's Position and optional Scale tracks in one history entry. */
  applyMotionTracking: (
    plan: MotionTrackingPlan,
    replaceExisting: boolean,
  ) => ClipFramingOperationResult
  /** Explicitly remove all ordinary Position/Rotation/Scale tracks in one entry. */
  resetVideoStabilization: (clipId: ClipId) => ClipFramingOperationResult
  /** Explicitly remove all four position/scale animation tracks. */
  resetClipFramingAnimation: (clipId: ClipId) => ClipFramingOperationResult
  /** Update one text payload atomically; invalid/unchanged patches add no history. */
  updateTextClip: (clipId: ClipId, patch: TextPropsPatch) => void
  /**
   * Set a clip's audio volume (Inspector for audio clips). Domain-clamped
   * to [0, MAX_CLIP_VOLUME]; an unchanged value pushes no history entry.
   * Does NOT follow links — volume lives on the audio half and stays
   * independently editable even when linked to a video half.
   */
  setClipVolume: (clipId: ClipId, volume: number) => void
  /** Atomically edit/reset the complete static audio Inspector surface. */
  updateClipAudio: (clipId: ClipId, patch: ClipAudioPatch) => void
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
  /** Add/edit/duplicate/delete sequence markers as ordinary undoable edits. */
  addTimelineMarker: (marker: TimelineMarker) => void
  updateTimelineMarker: (
    markerId: TimelineMarkerId,
    patch: TimelineMarkerPatch,
  ) => void
  duplicateTimelineMarker: (
    markerId: TimelineMarkerId,
    duplicateId: TimelineMarkerId,
  ) => void
  deleteTimelineMarker: (markerId: TimelineMarkerId) => void
  /** Semantic caption edits. Every call is one bounded undoable gesture. */
  addCaptionTrack: (track: CaptionTrack) => void
  updateCaptionTrack: (
    trackId: CaptionTrackId,
    patch: Partial<Pick<CaptionTrack, 'name' | 'language' | 'role' | 'stylePreset' | 'hidden'>>,
  ) => void
  deleteCaptionTrack: (trackId: CaptionTrackId) => void
  addCaptionItem: (trackId: CaptionTrackId, item: CaptionItem) => void
  updateCaptionItem: (
    trackId: CaptionTrackId,
    itemId: CaptionItemId,
    patch: Partial<Pick<CaptionItem, 'range' | 'text'>>,
  ) => void
  deleteCaptionItem: (trackId: CaptionTrackId, itemId: CaptionItemId) => void
  replaceCaptionItems: (trackId: CaptionTrackId, items: CaptionItem[]) => void
  splitCaptionItem: (
    trackId: CaptionTrackId,
    itemId: CaptionItemId,
    frame: number,
    rightItemId: CaptionItemId,
  ) => void
  mergeCaptionWithNext: (trackId: CaptionTrackId, itemId: CaptionItemId) => void
  shiftCaptionItems: (
    trackId: CaptionTrackId,
    fromItemId: CaptionItemId | null,
    deltaFrames: number,
  ) => void
  /** Append an effect to a clip's chain. */
  addEffect: (clipId: ClipId, effect: Effect) => void
  /** Enable or bypass one effect. */
  setEffectEnabled: (clipId: ClipId, effectId: EffectId, enabled: boolean) => void
  /** Commit one parameter patch as one history action. */
  updateEffectParams: (
    clipId: ClipId,
    effectId: EffectId,
    patch: Readonly<Record<string, EffectParamValue>>,
  ) => void
  /** Edit static values or an existing effect track at one playhead frame. */
  updateEffectParamsAtFrame: (
    clipId: ClipId,
    effectId: EffectId,
    timelineFrame: number,
    patch: Readonly<Record<string, EffectParamValue>>,
  ) => void
  setEffectKeyframe: (
    clipId: ClipId,
    effectId: EffectId,
    parameter: string,
    keyframe: ClipAnimationKeyframe,
  ) => void
  moveEffectKeyframe: (
    clipId: ClipId,
    effectId: EffectId,
    parameter: string,
    fromFrame: number,
    toFrame: number,
  ) => void
  removeEffectKeyframe: (
    clipId: ClipId,
    effectId: EffectId,
    parameter: string,
    frame: number,
  ) => void
  resetEffectAnimationTrack: (
    clipId: ClipId,
    effectId: EffectId,
    parameter: string,
  ) => void
  /** Move one effect to an exact stack index. */
  reorderEffect: (clipId: ClipId, effectId: EffectId, targetIndex: number) => void
  /** Restore registered defaults without discarding opaque keys. */
  resetEffect: (clipId: ClipId, effectId: EffectId) => void
  /** Remove one effect descriptor. */
  removeEffect: (clipId: ClipId, effectId: EffectId) => void
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

  setDocWithHistory: (doc) =>
    set((state) => commit(state, doc)),

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

  retimeClip: (clipId, rate) =>
    set((state) => commit(state, linkedRetimeClip(state.doc, clipId, rate))),

  setClipSpeedPoint: (clipId, frame, rate, easing) =>
    set((state) => commit(
      state,
      linkedSetClipSpeedPoint(state.doc, clipId, frame, rate, easing),
    )),

  removeClipSpeedPoint: (clipId, frame) =>
    set((state) => commit(
      state,
      linkedRemoveClipSpeedPoint(state.doc, clipId, frame),
    )),

  clearClipSpeedRamp: (clipId) =>
    set((state) => commit(state, linkedClearClipSpeedRamp(state.doc, clipId))),

  slipClip: (clipId, deltaFrames) =>
    set((state) => commit(state, linkedSlipClip(state.doc, clipId, deltaFrames))),

  slideClip: (clipId, deltaFrames) =>
    set((state) => commit(state, linkedSlideClip(state.doc, clipId, deltaFrames))),

  moveClip: (clipId, toTrackId, toFrame) =>
    set((state) => commit(state, linkedMoveClip(state.doc, clipId, toTrackId, toFrame))),

  moveClips: (clipIds, deltaFrames) =>
    set((state) => commit(state, linkedMoveClips(state.doc, clipIds, deltaFrames))),

  rippleDelete: (clipId) =>
    set((state) => commit(state, linkedRippleDelete(state.doc, clipId))),

  applySequenceEdit: (plan, asset, catalog) =>
    set((state) => commit(
      state,
      applySequenceEditToDocument(state.doc, plan, asset, catalog),
    )),

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

  updateClipVisual: (clipId, patch) =>
    set((state) => commit(state, updateClipVisual(state.doc, clipId, patch))),

  setManualLensCorrection: (clipId, model) =>
    set((state) => commit(
      state,
      setManualLensCorrection(state.doc, clipId, model),
    )),

  updateClipVisualAtFrame: (clipId, timelineFrame, patch) =>
    set((state) => commit(
      state,
      updateClipVisualAtFrame(state.doc, clipId, timelineFrame, patch),
    )),

  setClipKeyframe: (clipId, property, keyframe) =>
    set((state) => commit(
      state,
      setClipKeyframe(state.doc, clipId, property, keyframe),
    )),

  moveClipKeyframe: (clipId, property, fromFrame, toFrame) =>
    set((state) => commit(
      state,
      moveClipKeyframe(state.doc, clipId, property, fromFrame, toFrame),
    )),

  removeClipKeyframe: (clipId, property, frame) =>
    set((state) => commit(
      state,
      removeClipKeyframe(state.doc, clipId, property, frame),
    )),

  resetClipAnimationTrack: (clipId, property) =>
    set((state) => commit(
      state,
      resetClipAnimationTrack(state.doc, clipId, property),
    )),

  applyDynamicZoom: (clipId, source, request) => {
    let result: ClipFramingOperationResult | undefined
    set((state) => {
      result = applyDynamicZoomWithResult(state.doc, clipId, source, request)
      return commit(state, result.doc)
    })
    return result!
  },

  applyVideoStabilization: (clipId, plan, replaceExisting) => {
    let result: ClipFramingOperationResult | undefined
    set((state) => {
      result = applyVideoStabilizationWithResult(
        state.doc,
        clipId,
        plan,
        replaceExisting,
      )
      return commit(state, result.doc)
    })
    return result!
  },

  applyMotionTracking: (plan, replaceExisting) => {
    let result: ClipFramingOperationResult | undefined
    set((state) => {
      result = applyMotionTrackingWithResult(state.doc, plan, replaceExisting)
      return commit(state, result.doc)
    })
    return result!
  },

  resetVideoStabilization: (clipId) => {
    let result: ClipFramingOperationResult | undefined
    set((state) => {
      result = resetVideoStabilizationWithResult(state.doc, clipId)
      return commit(state, result.doc)
    })
    return result!
  },

  resetClipFramingAnimation: (clipId) => {
    let result: ClipFramingOperationResult | undefined
    set((state) => {
      result = resetClipFramingAnimationWithResult(state.doc, clipId)
      return commit(state, result.doc)
    })
    return result!
  },

  updateTextClip: (clipId, patch) =>
    set((state) => commit(state, updateTextClip(state.doc, clipId, patch))),

  setClipVolume: (clipId, volume) =>
    set((state) => commit(state, setClipVolume(state.doc, clipId, volume))),

  updateClipAudio: (clipId, patch) =>
    set((state) => commit(state, updateClipAudio(state.doc, clipId, patch))),

  addTrack: (kind) => set((state) => commit(state, addTrack(state.doc, kind))),

  setTrackFlags: (trackId, patch) =>
    set((state) => commit(state, setTrackFlags(state.doc, trackId, patch))),

  renameTrack: (trackId, name) =>
    set((state) => commit(state, renameTrack(state.doc, trackId, name))),

  removeTrack: (trackId) =>
    set((state) => commit(state, removeTrack(state.doc, trackId))),

  addTimelineMarker: (marker) =>
    set((state) => commit(state, addMarker(state.doc, marker))),

  updateTimelineMarker: (markerId, patch) =>
    set((state) => commit(state, updateMarker(state.doc, markerId, patch))),

  duplicateTimelineMarker: (markerId, duplicateId) =>
    set((state) => commit(
      state,
      duplicateMarker(state.doc, markerId, duplicateId),
    )),

  deleteTimelineMarker: (markerId) =>
    set((state) => commit(state, deleteMarker(state.doc, markerId))),

  addCaptionTrack: (track) =>
    set((state) => commit(state, addCaptionLane(state.doc, track))),

  updateCaptionTrack: (trackId, patch) =>
    set((state) => commit(state, updateCaptionLane(state.doc, trackId, patch))),

  deleteCaptionTrack: (trackId) =>
    set((state) => commit(state, deleteCaptionLane(state.doc, trackId))),

  addCaptionItem: (trackId, item) =>
    set((state) => commit(state, addCaptionCue(state.doc, trackId, item))),

  updateCaptionItem: (trackId, itemId, patch) =>
    set((state) => commit(state, updateCaptionCue(state.doc, trackId, itemId, patch))),

  deleteCaptionItem: (trackId, itemId) =>
    set((state) => commit(state, deleteCaptionCue(state.doc, trackId, itemId))),

  replaceCaptionItems: (trackId, items) =>
    set((state) => commit(state, replaceCaptionItems(state.doc, trackId, items))),

  splitCaptionItem: (trackId, itemId, frame, rightItemId) =>
    set((state) => commit(
      state,
      splitCaptionItem(state.doc, trackId, itemId, frame, rightItemId),
    )),

  mergeCaptionWithNext: (trackId, itemId) =>
    set((state) => commit(
      state,
      mergeCaptionWithNext(state.doc, trackId, itemId),
    )),

  shiftCaptionItems: (trackId, fromItemId, deltaFrames) =>
    set((state) => commit(
      state,
      shiftCaptionItems(state.doc, trackId, fromItemId, deltaFrames),
    )),

  addEffect: (clipId, effect) =>
    set((state) => commit(state, addEffect(state.doc, clipId, effect))),

  setEffectEnabled: (clipId, effectId, enabled) =>
    set((state) => commit(
      state,
      setEffectEnabled(state.doc, clipId, effectId, enabled),
    )),

  updateEffectParams: (clipId, effectId, patch) =>
    set((state) => commit(
      state,
      updateEffectParams(state.doc, clipId, effectId, patch),
    )),

  updateEffectParamsAtFrame: (clipId, effectId, timelineFrame, patch) =>
    set((state) => commit(
      state,
      updateEffectParamsAtFrame(state.doc, clipId, effectId, timelineFrame, patch),
    )),

  setEffectKeyframe: (clipId, effectId, parameter, keyframe) =>
    set((state) => commit(
      state,
      setEffectKeyframe(state.doc, clipId, effectId, parameter, keyframe),
    )),

  moveEffectKeyframe: (clipId, effectId, parameter, fromFrame, toFrame) =>
    set((state) => commit(
      state,
      moveEffectKeyframe(
        state.doc,
        clipId,
        effectId,
        parameter,
        fromFrame,
        toFrame,
      ),
    )),

  removeEffectKeyframe: (clipId, effectId, parameter, frame) =>
    set((state) => commit(
      state,
      removeEffectKeyframe(state.doc, clipId, effectId, parameter, frame),
    )),

  resetEffectAnimationTrack: (clipId, effectId, parameter) =>
    set((state) => commit(
      state,
      resetEffectAnimationTrack(state.doc, clipId, effectId, parameter),
    )),

  reorderEffect: (clipId, effectId, targetIndex) =>
    set((state) => commit(
      state,
      reorderEffect(state.doc, clipId, effectId, targetIndex),
    )),

  resetEffect: (clipId, effectId) =>
    set((state) => commit(state, resetEffect(state.doc, clipId, effectId))),

  removeEffect: (clipId, effectId) =>
    set((state) => commit(state, removeEffect(state.doc, clipId, effectId))),

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
