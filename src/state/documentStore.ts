import { captionProjectIntentError, captionRetentionError, type CaptionIntentOwner, type CaptionUsageCache } from '../domain/captionIntentBudget'
import { captionDocumentValidationError } from '../domain/captions'
import type { TitleBudgetOwner } from '../domain/titleBudgets'
import type { TitleElementIntent } from '../domain/titleElements'
import { retainedEffectPreviewDocuments } from './transportStore'
import { animationRetentionError, type AnimationProjectionCache } from '../domain/animationProjectBudget'
import type { EffectPathAnimationTrack } from '../domain/maskPathAnimation'
import { COLOR_LUT_LIMITS } from '../domain/colorLut'
import { createTitleElementIdAllocator } from '../domain/titleOwnership'
import { newColorLutReferenceError, retainedColorLutBytes, type PortableColorLut } from '../domain/colorLutCatalog'
import { sequenceProjectWithinEditBudget, sequenceProjectReservedIds } from '../domain/projectSequences'
import { editVideoBus, type VideoBusEdit, type VideoBusTarget } from '../domain/videoBusEffects'
/**
 * state/documentStore.ts — Zustand store owning the complete sequence project,
 * its active TimelineDoc adapter, and project-wide undo/redo history.
 *
 * Layering (ARCHITECTURE.md): domain operations plus transport preview-retention facts — never ui/, engine/,
 * pipeline/, workers/, or react.
 *
 * History model: plain SequenceProject snapshot stacks. `past` holds older
 * projects (most recent last), `future` holds undone projects (next redo
 * first), both capped at HISTORY_LIMIT. Because domain operations return the
 * SAME active document reference when an edit is rejected, a rejected/no-op
 * edit pushes NO history entry — undo never has to step through non-changes.
 *
 * Design note (deviation from the plan, on purpose): the plan suggested the
 * Immer middleware, but domain/operations already returns brand-new immutable
 * docs, so Immer would add a proxy layer with nothing to do. Plain snapshot
 * swaps are simpler and behave identically. Revisit only if non-operation
 * actions ever get mutation-heavy.
 */

import { create } from 'zustand'
import {
  resetClipAttributes, type ClipAttributeCommand,
} from '../domain/clipAttributes'
import type {
  AdjustmentAnimationKeyframe,
  AdjustmentItem,
  AdjustmentItemId,
  CaptionItem,
  CaptionItemId,
  CaptionTrack,
  CaptionTrackId,
  AudioEffectDescriptor,
  AudioEffectId,
  Clip,
  ClipId,
  Effect,
  EffectId,
  EffectParamValue,
  FrameRate,
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
  addCaptionItem,
  addCaptionTrack,
  mergeCaptionWithNext,
  removeCaptionItem,
  removeCaptionTrack,
  replaceCaptionItems,
  splitCaptionItem,
  updateCaptionItem,
  updateCaptionTrack,
} from '../domain/captions'
import type { TimelineMarkerPatch } from '../domain/timelineMarkers'
import {
  addTimelineMarker,
  deleteTimelineMarker,
  duplicateTimelineMarker,
  updateTimelineMarker,
} from '../domain/timelineMarkers'
import type {
  ClipAudioPatch,
  ClipFramingOperationResult,
  ClipTransformPatch,
  ClipVisualPatch,
  CrossfadeSettings,
  TextPropsPatch,
  AudioEffectTarget,
  MasterAudioPatch,
  TrackFlagsPatch,
  TrackMixerPatch,
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
  addCrossfadeWithSourceBounds as addExactCrossfade,
  addAudioEffect,
  applyAudioEffectPreset,
  addEffect,
  applyDynamicZoomWithResult,
  applyVideoStabilizationWithResult,
  applyMotionTrackingWithResult,
  addTrack,
  insertClip,
  removeTransition,
  removeTrack,
  removeAudioEffect,
  removeEffect,
  reorderAudioEffect,
  reorderEffect,
  resetAudioEffect,
  resetEffect,
  resetVideoStabilizationWithResult,
  renameTrack,
  setMasterAudio,
  normalizeMasterLoudness,
  setAudioEffectEnabled,
  setEffectEnabled,
  setCrossfadeSettingsWithSourceBounds,
  setTrackFlags,
  setTrackMixer,
  updateClipAudioAtFrame,
  updateClipTransform,
  updateClipVisualAtFrame,
  updateAudioEffectParams,
  updateEffectParams,
  updateEffectParamsAtFrame,
  resetClipFramingAnimationWithResult,
  updateTextClip,
} from '../domain/operations'
import {
  linkClips,
  linkedMoveClip,
  linkedMoveClips,
  linkedRippleDelete,
  linkedRippleTrim,
  linkedClearClipSpeedRamp,
  linkedRemoveClipSpeedPoint,
  linkedRetimeClip,
  linkedRetimeClips,
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
import {
  addAdjustmentEffect,
  clearAdjustmentEffectAnimation,
  clearAdjustmentOpacityAnimation,
  duplicateAdjustment,
  insertAdjustment,
  moveAdjustment,
  removeAdjustment,
  removeAdjustmentEffect,
  renameAdjustment,
  reorderAdjustmentEffect,
  resetAdjustmentEffect,
  setAdjustmentEffectEnabled,
  setAdjustmentEffectKeyframe,
  setAdjustmentEnabled,
  setAdjustmentOpacityAtFrame,
  setAdjustmentOpacityKeyframe,
  splitAdjustmentAtFrame,
  trimAdjustment,
  updateAdjustmentEffectParamsAtFrame,
} from '../domain/adjustmentItems'
import {
  chooseProjectRootSequence,
  createProjectSequence,
  deleteProjectSequence,
  duplicateProjectSequence,
  matchEmptyProjectFrameRate,
  renameProjectSequence,
  replaceProjectSequence,
  sequenceById,
  sequenceProjectFromTimeline,
  type SequenceEntityKind,
  type SequenceProject,
} from '../domain/projectSequences'
import {
  applySequenceInstanceEdit as applyProjectSequenceInstanceEdit,
  createCompoundSequenceFromClips,
  makeSequenceInstanceIndependent as makeProjectSequenceInstanceIndependent,
  type SequenceInstanceEditCommand,
} from '../domain/sequenceInstanceOperations'
import {
  applyMulticamDefinitionEdit as applyProjectMulticamDefinitionEdit,
  applyMulticamInstanceEdit as applyProjectMulticamInstanceEdit,
  createMulticamFromAssets,
  type CreateMulticamCommand,
  type MulticamDefinitionEditCommand,
  type MulticamInstanceEditCommand,
} from '../domain/multicamOperations'

/** Max undo levels; snapshots beyond this fall off the old end. */
const HISTORY_LIMIT = 100

/** The DocumentActions contract (see ARCHITECTURE.md, store contracts). */
export interface DocumentState {
  /** Data-only clipboard retention ledger; shares immutable project records. */
  retainedClipboardColorLuts: readonly PortableColorLut[]
  retainedAttributePathTracks: readonly EffectPathAnimationTrack[]
  retainedKeyPathTracks: readonly EffectPathAnimationTrack[]
  retainedTitleClipboardOwners: readonly TitleBudgetOwner[]
  retainedTitleClipboardElements: readonly TitleElementIntent[]
  retainedTitleClipboardKeys: readonly object[]
  retainedCaptionOwners: Readonly<Record<string, readonly CaptionIntentOwner[]>>
  retainCaptionOwners: (ownerId: string, owners: readonly CaptionIntentOwner[]) => string | null
  releaseCaptionOwners: (ownerId: string) => void
  commitAnimationEdit: (expectedProject: SequenceProject, generation: number, sequenceId: string, next: SequenceProject) => string | null
  commitProjectEdit: (expectedProject: SequenceProject, generation: number, next: SequenceProject) => string | null

  /** Complete portable edit snapshot. Browser resources remain elsewhere. */
  project: SequenceProject
  /** Session replacement identity, including reloading the same portable project. */
  projectGeneration: number
  /** Session-only active navigation; never persisted or placed in history. */
  activeSequenceId: string
  /** Session-only breadcrumb stack for exact Open compound / Back navigation. */
  sequenceNavigation: readonly SequenceNavigationEntry[]
  /** Active-sequence adapter consumed by existing timeline/render callers. */
  doc: TimelineDoc
  /** Undo stack: older whole-project snapshots, most recent last. */
  past: SequenceProject[]
  /** Redo stack: undone whole-project snapshots, next redo first. */
  future: SequenceProject[]

  /** Replace the complete project (load/recovery). Clears history. */
  setProject: (project: SequenceProject, activeSequenceId?: string) => void
  /** Historical/test adapter: replace with a sole-root project. */
  setDoc: (doc: TimelineDoc) => void
  /** Commit a prevalidated whole-document gesture without clearing history. */
  setDocWithHistory: (doc: TimelineDoc) => void
  /** Freshly validated mask gesture; rejection must retain both history branches. */
  commitMaskEdit: (expectedProject: SequenceProject, generation: number, sequenceId: string, doc: TimelineDoc) => string | null
  /** Validate and commit an entire attribute reset batch once against its opening snapshot. */
  applyClipAttributes: (expectedProject: SequenceProject, sequenceId: string, command: ClipAttributeCommand) => string | null
  /** Navigate without persistence, dirty state, or history. */
  switchSequence: (sequenceId: string) => boolean
  openSequenceInstance: (
    instanceId: string,
    parentPlayheadFrame: number,
  ) => number | null
  returnToParentSequence: () => SequenceNavigationEntry | null
  createCompoundFromClips: (
    selectedClipIds: readonly ClipId[],
    name: string,
  ) => Readonly<{ sequenceId: string; instanceId: string }> | null
  editSequenceInstance: (command: SequenceInstanceEditCommand) => boolean
  createMulticam: (command: CreateMulticamCommand) => Readonly<{
    definitionId: string
    videoInstanceId: string
    audioInstanceId: string | null
  }> | null
  editMulticamInstance: (command: MulticamInstanceEditCommand) => boolean
  editMulticamDefinition: (command: MulticamDefinitionEditCommand) => boolean
  makeSequenceInstanceIndependent: (instanceId: string) => string | null
  /** Add an empty same-settings sequence and navigate to it. */
  createSequence: (name: string) => string | null
  /** Duplicate the active sequence with fresh project-wide ids. */
  duplicateSequence: (sequenceId: string, name: string) => string | null
  /** Rename one sequence through project history. */
  renameSequence: (sequenceId: string, name: string) => boolean
  /** Delete a non-root definition; active navigation falls back to root. */
  deleteSequence: (sequenceId: string) => boolean
  /** Choose the portable root/render truth through project history. */
  chooseRootSequence: (sequenceId: string) => boolean
  /** Match every content-empty sequence to one frame rate through history. */
  matchProjectFrameRate: (rate: FrameRate) => boolean
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
  /** Add and edit explicit resource-free full-frame adjustment items. */
  insertAdjustment: (trackId: TrackId, item: AdjustmentItem) => void
  moveAdjustment: (
    adjustmentId: AdjustmentItemId,
    toTrackId: TrackId,
    toFrame: number,
  ) => void
  trimAdjustment: (
    adjustmentId: AdjustmentItemId,
    edge: TrimEdge,
    deltaFrames: number,
  ) => void
  splitAdjustmentAt: (adjustmentId: AdjustmentItemId, frame: number) => void
  duplicateAdjustment: (adjustmentId: AdjustmentItemId, toFrame?: number) => void
  removeAdjustment: (adjustmentId: AdjustmentItemId) => void
  setAdjustmentEnabled: (adjustmentId: AdjustmentItemId, enabled: boolean) => void
  renameAdjustment: (adjustmentId: AdjustmentItemId, name: string) => void
  setAdjustmentOpacityAtFrame: (
    adjustmentId: AdjustmentItemId,
    timelineFrame: number,
    opacity: number,
  ) => void
  setAdjustmentOpacityKeyframe: (
    adjustmentId: AdjustmentItemId,
    keyframe: AdjustmentAnimationKeyframe,
  ) => void
  clearAdjustmentOpacityAnimation: (adjustmentId: AdjustmentItemId) => void
  addAdjustmentEffect: (adjustmentId: AdjustmentItemId, effect: Effect) => void
  setAdjustmentEffectEnabled: (
    adjustmentId: AdjustmentItemId,
    effectId: EffectId,
    enabled: boolean,
  ) => void
  updateAdjustmentEffectParamsAtFrame: (
    adjustmentId: AdjustmentItemId,
    effectId: EffectId,
    timelineFrame: number,
    patch: Readonly<Record<string, EffectParamValue>>,
  ) => void
  setAdjustmentEffectKeyframe: (
    adjustmentId: AdjustmentItemId,
    effectId: EffectId,
    parameter: string,
    keyframe: AdjustmentAnimationKeyframe,
  ) => void
  clearAdjustmentEffectAnimation: (
    adjustmentId: AdjustmentItemId,
    effectId: EffectId,
    parameter?: string,
  ) => void
  reorderAdjustmentEffect: (
    adjustmentId: AdjustmentItemId,
    effectId: EffectId,
    targetIndex: number,
  ) => void
  resetAdjustmentEffect: (adjustmentId: AdjustmentItemId, effectId: EffectId) => void
  removeAdjustmentEffect: (adjustmentId: AdjustmentItemId, effectId: EffectId) => void
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
  /** Change constant speed for a selection; each root expands its link group. */
  retimeClips: (clipIds: readonly ClipId[], rate: SourceTimeRate) => void
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
  /** Add exact handle-aware duration/audio intent as one history entry. */
  addCrossfadeWithSourceBounds: (
    fromClipId: ClipId,
    toClipId: ClipId,
    settings: CrossfadeSettings,
    catalog: SourceBoundsCatalog,
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
  /** Edit static audio fields or upsert active volume/balance keys at one playhead frame. */
  updateClipAudioAtFrame: (
    clipId: ClipId,
    timelineFrame: number,
    patch: ClipAudioPatch,
  ) => void
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
  /** Track fader/pan. One history entry; mute/solo stay on setTrackFlags. */
  setTrackMixer: (trackId: TrackId, patch: TrackMixerPatch) => void
  /** Master bus gain/pan/mute. One history entry. */
  setMasterAudio: (patch: MasterAudioPatch) => void
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
  /** Move one effect to an exact stack index. */
  reorderEffect: (clipId: ClipId, effectId: EffectId, targetIndex: number) => void
  /** Restore registered defaults without discarding opaque keys. */
  resetEffect: (clipId: ClipId, effectId: EffectId) => void
  /** Remove one effect descriptor. */
  removeEffect: (clipId: ClipId, effectId: EffectId) => void
  addAudioEffect: (target: AudioEffectTarget, effect: AudioEffectDescriptor) => void
  setAudioEffectEnabled: (
    target: AudioEffectTarget,
    effectId: AudioEffectId,
    enabled: boolean,
  ) => void
  updateAudioEffectParams: (
    target: AudioEffectTarget,
    effectId: AudioEffectId,
    patch: Readonly<Record<string, EffectParamValue>>,
  ) => void
  reorderAudioEffect: (
    target: AudioEffectTarget,
    effectId: AudioEffectId,
    targetIndex: number,
  ) => void
  resetAudioEffect: (target: AudioEffectTarget, effectId: AudioEffectId) => void
  removeAudioEffect: (target: AudioEffectTarget, effectId: AudioEffectId) => void
  editVideoBus: (expectedProject: SequenceProject, target: VideoBusTarget, command: VideoBusEdit) => string | null
  applyAudioEffectPreset: (target: AudioEffectTarget, presetId: string) => void
  normalizeMasterLoudness: (measuredLufs: number, targetLufs?: number) => void
  /** Step back one snapshot. No-op when history is empty. */
  undo: () => void
  /** Step forward one undone snapshot. No-op when future is empty. */
  redo: () => void
}

export interface SequenceNavigationEntry {
  readonly sequenceId: string
  readonly playheadFrame: number
}

/**
 * Fold an active-sequence edit into the complete project: push the outgoing
 * project onto `past`, clear `future`. A rejected edit changes nothing.
 */
function commit(
  state: DocumentState,
  next: TimelineDoc,
): Partial<DocumentState> | DocumentState {
  if (next === state.doc) return state
  const project = replaceProjectSequence(
    state.project,
    state.activeSequenceId,
    next,
  )
  if (project === state.project || projectCommitError(state, project)) return state
  return pushProject(state, project, { doc: next })
}

/**
 * Push an admitted project: the outgoing project joins `past` and redo
 * clears. Callers have already checked it with projectCommitError.
 */
function pushProject(
  state: DocumentState,
  project: SequenceProject,
  active: Partial<Pick<DocumentState, 'activeSequenceId' | 'doc'>> = activeSequenceFor(project, state.activeSequenceId),
): Partial<DocumentState> {
  return {
    project,
    ...active,
    past: [...state.past, state.project].slice(-HISTORY_LIMIT),
    future: [],
  }
}

/**
 * Retention usage of the snapshots this store holds as current/past/future.
 * The store never mutates a held snapshot, so an entry stays valid for that
 * object's lifetime; the domain helpers always measure a candidate afresh.
 * Without it every edit re-measured all ~100 history snapshots.
 */
const heldCaptionUsage: CaptionUsageCache = new WeakMap()
const heldAnimationProjections: AnimationProjectionCache = { paths: new WeakMap(), titles: new WeakMap() }

function projectCommitError(state: DocumentState, project: SequenceProject): string | null {
  const captionError = captionRetentionError(state, project, [], heldCaptionUsage)
  if (captionError) return captionError
  const animationError = animationRetentionError(
    { ...state, retainedTitlePreviewDocuments: retainedEffectPreviewDocuments() },
    project,
    heldAnimationProjections,
  )
  if (animationError) return animationError
  if (!state.project.colorLuts?.length && !project.colorLuts?.length && !state.retainedClipboardColorLuts.length) {
    return newColorLutReferenceError(state.project, project)
  }
  const referenceError = newColorLutReferenceError(state.project, project)
  if (referenceError) return referenceError
  if (project.colorLuts !== state.project.colorLuts && retainedColorLutBytes(
    [project, state.project, ...state.past, ...state.future], state.retainedClipboardColorLuts,
  ) > COLOR_LUT_LIMITS.retainedBytes) return 'This edit exceeds 64 MiB of LUT history and clipboard data. Start a fresh project session before importing more tables.'
  return null
}

function activeSequenceFor(
  project: SequenceProject,
  preferredId: string,
): { activeSequenceId: string; doc: TimelineDoc } {
  const preferred = sequenceById(project, preferredId)
  if (preferred) return { activeSequenceId: preferred.id, doc: preferred }
  const root = sequenceById(project, project.rootSequenceId)
  if (!root) throw new Error('Cannot activate a project without its root sequence')
  return { activeSequenceId: root.id, doc: root }
}

/**
 * Admit one whole-project edit. `null` means history-wide admission rejected
 * it, so result-returning actions must not report success; an unchanged
 * project is an accepted no-op that keeps `state`.
 */
function admitProject(
  state: DocumentState,
  project: SequenceProject,
  preferredActiveId = state.activeSequenceId,
): Partial<DocumentState> | DocumentState | null {
  if (project === state.project) return state
  if (projectCommitError(state, project)) return null
  return pushProject(state, project, activeSequenceFor(project, preferredActiveId))
}

function randomSequenceId(
  kind: SequenceEntityKind,
): string {
  return `${kind.replace('-', '_')}_${crypto.randomUUID()}`
}

/** Session-owned retention, navigation and history that a project replacement clears. */
function projectReplacementReset(): Pick<DocumentState,
  | 'retainedClipboardColorLuts' | 'retainedAttributePathTracks' | 'retainedKeyPathTracks'
  | 'retainedTitleClipboardOwners' | 'retainedTitleClipboardElements' | 'retainedTitleClipboardKeys'
  | 'sequenceNavigation' | 'past' | 'future'> {
  return {
    retainedClipboardColorLuts: [],
    retainedAttributePathTracks: [],
    retainedKeyPathTracks: [],
    retainedTitleClipboardOwners: [],
    retainedTitleClipboardElements: [],
    retainedTitleClipboardKeys: [],
    sequenceNavigation: [],
    past: [],
    future: [],
  }
}

/** Project-unique ids for title elements that a split or sequence edit copies. */
function titleElementIds(project: SequenceProject) {
  return createTitleElementIdAllocator(project, () => `title-element_${crypto.randomUUID()}`)
}

const INITIAL_DOCUMENT = createTimelineDoc(
  'Untitled',
  DEFAULT_PROJECT_SETTINGS,
  'doc_default',
)
const INITIAL_PROJECT = sequenceProjectFromTimeline(INITIAL_DOCUMENT)

export const useDocumentStore = create<DocumentState>()((set) => {
  /**
   * Bind one pure active-document operation as an action. A rejected edit
   * returns the same doc, so commit keeps the state and pushes no history.
   */
  const edit = <A extends unknown[]>(operation: (doc: TimelineDoc, ...args: A) => TimelineDoc) =>
    (...args: A): void => set((state) => commit(state, operation(state.doc, ...args)))

  return {
    retainedCaptionOwners: {},
    retainCaptionOwners: (ownerId, owners) => {
      let error: string | null = null
      set((state) => {
        // Old owner copies remain charged until replacement is admitted.
        error = captionRetentionError(state, undefined, owners, heldCaptionUsage)
        return error ? state : { retainedCaptionOwners: { ...state.retainedCaptionOwners, [ownerId]: owners } }
      })
      return error
    },
    releaseCaptionOwners: (ownerId) => set((state) => {
      if (!Object.hasOwn(state.retainedCaptionOwners, ownerId)) return state
      const { [ownerId]: _released, ...remaining } = state.retainedCaptionOwners
      return { retainedCaptionOwners: remaining }
    }),
    retainedClipboardColorLuts: [],
    retainedAttributePathTracks: [],
    retainedKeyPathTracks: [],
    retainedTitleClipboardOwners: [],
    retainedTitleClipboardElements: [],
    retainedTitleClipboardKeys: [],
    commitAnimationEdit: (expectedProject, generation, sequenceId, next) => {
      let error: string | null = null
      set((state) => {
        if (state.project !== expectedProject || state.projectGeneration !== generation || state.activeSequenceId !== sequenceId) { error = 'The animation project or active sequence changed.'; return state }
        if (next === expectedProject) return state
        if (!sequenceProjectWithinEditBudget(next)) { error = 'The animation edit exceeds project limits.'; return state }
        error = projectCommitError(state, next)
        return error ? state : pushProject(state, next)
      })
      return error
    },
    commitProjectEdit: (expectedProject, generation, next) => {
      let error: string | null = null
      set((state) => {
        if (state.project !== expectedProject || state.projectGeneration !== generation) { error = 'The project changed. Reopen the editing controls.'; return state }
        if (!sequenceProjectWithinEditBudget(next)) { error = 'The edit exceeds project limits.'; return state }
        error = projectCommitError(state, next)
        return error || next === state.project ? state : pushProject(state, next)
      })
      return error
    },
    project: INITIAL_PROJECT,
    projectGeneration: 0,
    activeSequenceId: INITIAL_DOCUMENT.id,
    sequenceNavigation: [],
    doc: INITIAL_DOCUMENT,
    past: [],
    future: [],

    setProject: (project, activeSequenceId = project.rootSequenceId) => set((state) => {
      const error = captionProjectIntentError(project) ?? project.sequences.map(captionDocumentValidationError).find(Boolean)
        ?? captionRetentionError({ ...state, project, past: [], future: [] })
      if (error) throw new RangeError(error)
      return {
        project,
        projectGeneration: state.projectGeneration + 1,
        ...projectReplacementReset(),
        ...activeSequenceFor(project, activeSequenceId),
      }
    }),

    setDoc: (doc) => set((state) => {
      const project = sequenceProjectFromTimeline(doc)
      const error = captionDocumentValidationError(doc) ?? captionProjectIntentError(project)
        ?? captionRetentionError({ ...state, project, past: [], future: [] })
      if (error) throw new RangeError(error)
      return {
        project,
        projectGeneration: state.projectGeneration + 1,
        ...projectReplacementReset(),
        activeSequenceId: doc.id,
        doc,
      }
    }),

    setDocWithHistory: (doc) =>
      set((state) => commit(state, doc)),

    commitMaskEdit: (expectedProject, generation, sequenceId, doc) => {
      let error: string | null = null
      set((state) => {
        if (state.project !== expectedProject || state.projectGeneration !== generation || state.activeSequenceId !== sequenceId || doc.id !== sequenceId) {
          error = 'The project changed. Start the mask edit again.'; return state
        }
        // replaceProjectSequence returns a changed candidate only within the edit budget.
        const candidate = replaceProjectSequence(state.project, sequenceId, doc)
        if (candidate === state.project && (doc !== state.doc || !sequenceProjectWithinEditBudget(candidate))) {
          error = 'The mask edit exceeds project limits.'; return state
        }
        error = projectCommitError(state, candidate)
        return error || candidate === state.project ? state : pushProject(state, candidate, { doc })
      })
      return error
    },

    editVideoBus: (expectedProject, target, command) => {
      let error: string | null = null
      set((state) => {
        if (state.project !== expectedProject || state.activeSequenceId !== target.sequenceId) {
          error = 'The project or active sequence changed. Reopen the video-bus controls.'
          return state
        }
        const result = editVideoBus(state.project, target, command, randomSequenceId)
        if (!result.ok) { error = result.reason; return state }
        error = projectCommitError(state, result.project)
        return error || result.project === state.project ? state : pushProject(state, result.project)
      })
      return error
    },

    applyClipAttributes: (expectedProject, sequenceId, command) => {
      let error: string | null = null
      set((state) => {
        if (state.project !== expectedProject || state.activeSequenceId !== sequenceId) {
          error = 'The project or active sequence changed. Reopen the attribute dialog.'
          return state
        }
        const result = resetClipAttributes(state.project, sequenceId, command.targetIds, command.groups, command.selectedEffectIds)
        if (!result.ok) { error = result.reason; return state }
        error = projectCommitError(state, result.project)
        return error || result.project === state.project ? state : pushProject(state, result.project)
      })
      return error
    },

    switchSequence: (sequenceId) => {
      let switched = false
      set((state) => {
        const doc = sequenceById(state.project, sequenceId)
        if (!doc || sequenceId === state.activeSequenceId) return state
        switched = true
        return { activeSequenceId: sequenceId, doc, sequenceNavigation: [] }
      })
      return switched
    },

    openSequenceInstance: (instanceId, parentPlayheadFrame) => {
      let childPlayheadFrame: number | null = null
      set((state) => {
        const instance = state.doc.tracks.flatMap((track) => (
          track.sequenceInstances ?? []
        )).find((candidate) => candidate.id === instanceId)
        if (!instance) return state
        const doc = sequenceById(state.project, instance.sequenceId)
        if (!doc) return state
        const offset = parentPlayheadFrame >= instance.timelineRange.startFrame
          && parentPlayheadFrame < instance.timelineRange.startFrame
            + instance.timelineRange.durationFrames
          ? parentPlayheadFrame - instance.timelineRange.startFrame
          : 0
        childPlayheadFrame = instance.sourceStartFrame + offset
        return {
          activeSequenceId: doc.id,
          doc,
          sequenceNavigation: [
            ...state.sequenceNavigation,
            Object.freeze({
              sequenceId: state.activeSequenceId,
              playheadFrame: Math.max(0, Math.round(parentPlayheadFrame)),
            }),
          ],
        }
      })
      return childPlayheadFrame
    },

    returnToParentSequence: () => {
      let returned: SequenceNavigationEntry | null = null
      set((state) => {
        const parent = state.sequenceNavigation.at(-1)
        if (!parent) return state
        const doc = sequenceById(state.project, parent.sequenceId)
        if (!doc) return { sequenceNavigation: [] }
        returned = parent
        return {
          activeSequenceId: parent.sequenceId,
          doc,
          sequenceNavigation: state.sequenceNavigation.slice(0, -1),
        }
      })
      return returned
    },

    createCompoundFromClips: (selectedClipIds, name) => {
      let created: Readonly<{ sequenceId: string; instanceId: string }> | null = null
      set((state) => {
        const result = createCompoundSequenceFromClips(
          state.project,
          state.activeSequenceId,
          selectedClipIds,
          name,
          randomSequenceId,
        )
        if (result.failure || !result.sequenceId || !result.instanceId) return state
        const next = admitProject(state, result.project)
        if (!next) return state
        created = Object.freeze({
          sequenceId: result.sequenceId,
          instanceId: result.instanceId,
        })
        return next
      })
      return created
    },

    editSequenceInstance: (command) => {
      let edited = false
      set((state) => {
        const result = applyProjectSequenceInstanceEdit(
          state.project,
          state.activeSequenceId,
          command,
          randomSequenceId,
        )
        const next = result.failure ? null : admitProject(state, result.project)
        edited = next !== null
        return next ?? state
      })
      return edited
    },

    createMulticam: (command) => {
      let created: Readonly<{
        definitionId: string
        videoInstanceId: string
        audioInstanceId: string | null
      }> | null = null
      set((state) => {
        const result = createMulticamFromAssets(
          state.project,
          state.activeSequenceId,
          command,
          randomSequenceId,
        )
        if (result.failure || !result.definitionId || !result.videoInstanceId) return state
        const next = admitProject(state, result.project)
        if (!next) return state
        created = Object.freeze({
          definitionId: result.definitionId,
          videoInstanceId: result.videoInstanceId,
          audioInstanceId: result.audioInstanceId,
        })
        return next
      })
      return created
    },

    editMulticamInstance: (command) => {
      let edited = false
      set((state) => {
        const result = applyProjectMulticamInstanceEdit(
          state.project,
          state.activeSequenceId,
          command,
          randomSequenceId,
        )
        const next = result.failure ? null : admitProject(state, result.project)
        edited = next !== null
        return next ?? state
      })
      return edited
    },

    editMulticamDefinition: (command) => {
      let edited = false
      set((state) => {
        const result = applyProjectMulticamDefinitionEdit(state.project, command)
        const next = result.failure ? null : admitProject(state, result.project)
        edited = next !== null
        return next ?? state
      })
      return edited
    },

    makeSequenceInstanceIndependent: (instanceId) => {
      let sequenceId: string | null = null
      set((state) => {
        const result = makeProjectSequenceInstanceIndependent(
          state.project,
          state.activeSequenceId,
          instanceId,
          randomSequenceId,
        )
        if (result.failure || !result.sequenceId) return state
        const next = admitProject(state, result.project)
        if (!next) return state
        sequenceId = result.sequenceId
        return next
      })
      return sequenceId
    },

    createSequence: (name) => {
      let createdId: string | null = null
      set((state) => {
        const result = createProjectSequence(state.project, name, randomSequenceId)
        const next = result.failure || !result.sequenceId
          ? null
          : admitProject(state, result.project, result.sequenceId)
        if (next) createdId = result.sequenceId
        return next ?? state
      })
      return createdId
    },

    duplicateSequence: (sequenceId, name) => {
      let duplicateId: string | null = null
      set((state) => {
        const result = duplicateProjectSequence(
          state.project,
          sequenceId,
          name,
          randomSequenceId,
        )
        const next = result.failure || !result.sequenceId
          ? null
          : admitProject(state, result.project, result.sequenceId)
        if (next) duplicateId = result.sequenceId
        return next ?? state
      })
      return duplicateId
    },

    renameSequence: (sequenceId, name) => {
      let renamed = false
      set((state) => {
        const result = renameProjectSequence(state.project, sequenceId, name)
        const next = result.failure ? null : admitProject(state, result.project)
        renamed = next !== null
        return next ?? state
      })
      return renamed
    },

    deleteSequence: (sequenceId) => {
      let deleted = false
      set((state) => {
        const result = deleteProjectSequence(state.project, sequenceId)
        const next = result.failure ? null : admitProject(state, result.project)
        deleted = next !== null
        return next ?? state
      })
      return deleted
    },

    chooseRootSequence: (sequenceId) => {
      let chosen = false
      set((state) => {
        const result = chooseProjectRootSequence(state.project, sequenceId)
        const next = result.failure ? null : admitProject(state, result.project)
        chosen = next !== null
        return next ?? state
      })
      return chosen
    },

    matchProjectFrameRate: (rate) => {
      let matched = false
      set((state) => {
        const project = matchEmptyProjectFrameRate(state.project, rate)
        const next = project ? admitProject(state, project) : null
        matched = next !== null
        return next ?? state
      })
      return matched
    },

    splitClipAtPlayhead: (playheadFrame) =>
      set((state) => {
        let next = state.doc
        const allocateTitleId = titleElementIds(state.project)
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
              next = linkedSplitClipAtFrame(next, clip.id, playheadFrame, allocateTitleId)
            }
          }
        }
        return commit(state, next)
      }),

    insertClip: edit(insertClip),

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

    insertAdjustment: edit(insertAdjustment),
    moveAdjustment: edit(moveAdjustment),
    trimAdjustment: edit(trimAdjustment),
    splitAdjustmentAt: edit(splitAdjustmentAtFrame),
    duplicateAdjustment: edit(duplicateAdjustment),
    removeAdjustment: edit(removeAdjustment),
    setAdjustmentEnabled: edit(setAdjustmentEnabled),
    renameAdjustment: edit(renameAdjustment),
    setAdjustmentOpacityAtFrame: edit(setAdjustmentOpacityAtFrame),
    setAdjustmentOpacityKeyframe: edit(setAdjustmentOpacityKeyframe),
    clearAdjustmentOpacityAnimation: edit(clearAdjustmentOpacityAnimation),
    addAdjustmentEffect: edit(addAdjustmentEffect),
    setAdjustmentEffectEnabled: edit(setAdjustmentEffectEnabled),
    updateAdjustmentEffectParamsAtFrame: edit(updateAdjustmentEffectParamsAtFrame),
    setAdjustmentEffectKeyframe: edit(setAdjustmentEffectKeyframe),
    clearAdjustmentEffectAnimation: edit(clearAdjustmentEffectAnimation),
    reorderAdjustmentEffect: edit(reorderAdjustmentEffect),
    resetAdjustmentEffect: edit(resetAdjustmentEffect),
    removeAdjustmentEffect: edit(removeAdjustmentEffect),

    splitClipAt: (clipId, frame) =>
      set((state) => commit(state, linkedSplitClipAtFrame(state.doc, clipId, frame, titleElementIds(state.project)))),

    trimClip: edit(linkedTrimClip),
    rippleTrim: edit(linkedRippleTrim),
    retimeClip: edit(linkedRetimeClip),
    retimeClips: edit(linkedRetimeClips),
    setClipSpeedPoint: edit(linkedSetClipSpeedPoint),
    removeClipSpeedPoint: edit(linkedRemoveClipSpeedPoint),
    clearClipSpeedRamp: edit(linkedClearClipSpeedRamp),
    slipClip: edit(linkedSlipClip),
    slideClip: edit(linkedSlideClip),
    moveClip: edit(linkedMoveClip),
    moveClips: edit(linkedMoveClips),
    rippleDelete: edit(linkedRippleDelete),

    applySequenceEdit: (plan, asset, catalog) =>
      set((state) => commit(
        state,
        applySequenceEditToDocument(state.doc, plan, asset, catalog, titleElementIds(state.project)),
      )),

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

    setCrossfadeSettings: edit(setCrossfadeSettingsWithSourceBounds),
    removeTransition: edit(removeTransition),
    linkClips: edit(linkClips),
    unlinkClip: edit(unlinkClip),
    updateClipTransform: edit(updateClipTransform),
    setManualLensCorrection: edit(setManualLensCorrection),
    updateClipVisualAtFrame: edit(updateClipVisualAtFrame),

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

    updateTextClip: edit(updateTextClip),
    updateClipAudioAtFrame: edit(updateClipAudioAtFrame),
    addTrack: edit(addTrack),
    setTrackFlags: edit(setTrackFlags),
    setTrackMixer: edit(setTrackMixer),
    setMasterAudio: edit(setMasterAudio),
    renameTrack: edit(renameTrack),
    removeTrack: edit(removeTrack),
    addTimelineMarker: edit(addTimelineMarker),
    updateTimelineMarker: edit(updateTimelineMarker),
    duplicateTimelineMarker: edit(duplicateTimelineMarker),
    deleteTimelineMarker: edit(deleteTimelineMarker),
    addCaptionTrack: edit(addCaptionTrack),
    updateCaptionTrack: edit(updateCaptionTrack),
    deleteCaptionTrack: edit(removeCaptionTrack),
    addCaptionItem: edit(addCaptionItem),
    updateCaptionItem: edit(updateCaptionItem),
    deleteCaptionItem: edit(removeCaptionItem),
    replaceCaptionItems: edit(replaceCaptionItems),

    splitCaptionItem: (trackId, itemId, frame, rightItemId) =>
      set((state) => {
        if (sequenceProjectReservedIds(state.project).has(rightItemId)) throw new RangeError('The split caption identity is already reserved in the project')
        return commit(state, splitCaptionItem(state.doc, trackId, itemId, frame, rightItemId))
      }),

    mergeCaptionWithNext: edit(mergeCaptionWithNext),
    addEffect: edit(addEffect),
    setEffectEnabled: edit(setEffectEnabled),
    updateEffectParams: edit(updateEffectParams),
    updateEffectParamsAtFrame: edit(updateEffectParamsAtFrame),
    reorderEffect: edit(reorderEffect),
    resetEffect: edit(resetEffect),
    removeEffect: edit(removeEffect),
    addAudioEffect: edit(addAudioEffect),
    setAudioEffectEnabled: edit(setAudioEffectEnabled),
    updateAudioEffectParams: edit(updateAudioEffectParams),
    reorderAudioEffect: edit(reorderAudioEffect),
    resetAudioEffect: edit(resetAudioEffect),
    removeAudioEffect: edit(removeAudioEffect),
    applyAudioEffectPreset: edit(applyAudioEffectPreset),
    normalizeMasterLoudness: edit(normalizeMasterLoudness),

    undo: () =>
      set((state) => {
        const previous = state.past[state.past.length - 1]
        if (!previous || captionRetentionError(state, undefined, [], heldCaptionUsage)
          || previous.sequences.some((sequence) => captionDocumentValidationError(sequence))) return state
        return {
          project: previous,
          ...activeSequenceFor(previous, state.activeSequenceId),
          past: state.past.slice(0, -1),
          future: [state.project, ...state.future].slice(0, HISTORY_LIMIT),
        }
      }),

    redo: () =>
      set((state) => {
        const next = state.future[0]
        if (!next || captionRetentionError(state, undefined, [], heldCaptionUsage)
          || next.sequences.some((sequence) => captionDocumentValidationError(sequence))) return state
        return {
          project: next,
          ...activeSequenceFor(next, state.activeSequenceId),
          past: [...state.past, state.project].slice(-HISTORY_LIMIT),
          future: state.future.slice(1),
        }
      }),
  }
})
