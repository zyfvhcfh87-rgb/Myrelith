/**
 * state/transportStore.ts — Playback/navigation state. Phase 1.3.
 *
 * Rules (from the plan and ARCHITECTURE.md):
 * - NO history middleware: scrubbing must never pollute undo.
 * - NO external side effects and NO document coupling. Setters update one
 *   conceptual transport slice (zoom + its mode/remembered value are one
 *   slice) and never read or write documentStore.
 * - playheadFrame is an integer frame at the document rate (rule 2); the
 *   setter rounds and clamps to >= 0 so a stray float can never leak in.
 */

import { create } from 'zustand'
import type {
  ClipId,
  ClipVisualSettings,
  TextProps,
  TimelineMarkerId,
  TimeRange,
  TrackId,
  Transform,
} from '../domain/schema'
import type { TimelineSnapGuide } from '../domain/timelineSnapping'

/**
 * Live position of a clip mid-drag — the "scrubbing" half of the
 * scrubbing-vs-committed pattern (ARCHITECTURE.md). While a drag gesture is
 * active, ClipView renders from here; documentStore is untouched until
 * pointerup commits ONE moveClip (one undo entry).
 */
export interface DragPreview {
  clipId: ClipId
  /** Signed frame delta from every participating clip's committed start. */
  deltaFrames: number
  /**
   * Exact multi-selection/link closure sharing deltaFrames. Omitted for the
   * established single-owner/link-group path to keep that contract compact.
   */
  clipIds?: readonly ClipId[]
  /** Same-kind lane currently under the gesture owner, when cross-track. */
  targetTrackId?: TrackId
  /** Pixel offset from the source lane used to ghost the owner vertically. */
  trackOffsetY?: number
  /**
   * When the dragged clip is linked, the UI stamps its group id here so
   * partner ClipViews can ghost the same move; absent for unlinked clips.
   */
  linkGroupId?: string
}

/** The Phase 4.2 timeline tools (Toolbar buttons + A/B/T/Y/U keys). */
export type TimelineTool = 'select' | 'razor' | 'trim' | 'slip' | 'slide'

/** Ephemeral timeline zoom preset. Zoom never belongs to document history. */
export type ZoomMode = 'full' | 'detail' | 'custom'
export type PresetZoomMode = Exclude<ZoomMode, 'custom'>

/** What kind of edit an in-flight edge/body gesture previews. */
export type EditPreviewKind =
  | 'trim-start'
  | 'trim-end'
  | 'ripple-start'
  | 'ripple-end'
  | 'slip'
  | 'slide'

/**
 * Live state of a trim/ripple/slip/slide gesture — same
 * scrubbing-vs-committed contract as DragPreview (which stays dedicated to
 * select-tool moves): pointermove writes ONLY this; pointerup commits ONE
 * documentStore action and clears it.
 */
export interface EditPreview {
  clipId: ClipId
  kind: EditPreviewKind
  /** Signed frame delta of the gesture so far (integer, may be negative). */
  deltaFrames: number
  /**
   * When the dragged clip is linked, the UI stamps its group id here so
   * partner ClipViews can ghost the same edit; absent for unlinked clips.
   */
  linkGroupId?: string
}

/** Live preview-only geometry for direct manipulation in the program monitor. */
export interface TextOverlayPreview {
  clipId: ClipId
  transform?: Transform
  text?: TextProps
}

export type ClipVisualPreviewOwner =
  | 'visual-gesture'
  | 'stabilization'
  | 'motion-tracking'

/**
 * Ephemeral geometry for dropping a Media Pool asset or OS file onto a lane.
 * Duration is null for an unopened OS file (insertion marker). Never holds a
 * File, handle, blob, or object URL.
 */
export type MediaPlacementPreviewPhase = 'hover' | 'pending'

export interface MediaPlacementPreview {
  trackId: TrackId
  startFrame: number
  durationFrames: number | null
  valid: boolean
  phase: MediaPlacementPreviewPhase
}

/** Bounded-surface pixels plus live candidate ids for an empty-lane drag. */
export interface SelectionMarqueePreview {
  left: number
  top: number
  width: number
  height: number
  clipIds: readonly ClipId[]
}

/** Live preview-only geometry for a media clip direct-manipulation gesture. */
export interface ClipVisualPreview {
  /** Named editor ownership prevents one mounted preview surface clearing another. */
  owner?: ClipVisualPreviewOwner
  clipId: ClipId
  transform: Transform
  visual: ClipVisualSettings
}

export interface TransportState {
  /** Current playhead position, integer frames at the document rate. */
  playheadFrame: number
  /** True while the playback engine is running (Phase 2 drives this). */
  isPlaying: boolean
  /** True while the user is dragging the playhead/a scrub gesture is live. */
  isScrubbing: boolean
  /** Timeline zoom in pixels per frame (> 0). UI tunes the default later. */
  zoom: number
  /** Active timeline zoom preset; session-only and never undoable. */
  zoomMode: ZoomMode
  /** Remembered Custom-mode pixels-per-frame value. */
  customZoom: number
  /** Integer global frame represented by local x=0 in the bounded DOM lane. */
  timelineOriginFrame: number
  /** In/out selection for preview/export, or null when unset. */
  inOut: TimeRange | null
  /** Clip-drag preview, or null when no drag is in flight. */
  dragPreview: DragPreview | null
  /** Active timeline tool (Phase 4.2). */
  tool: TimelineTool
  /**
   * Ordered selected clips. Ephemeral UI state — never in undo/history.
   * The final id is the most recently added clip.
   */
  selectedClipIds: readonly ClipId[]
  /**
   * Primary selected clip for single-clip surfaces such as the Inspector,
   * or null. When present it is always a member of selectedClipIds.
   */
  selectedClipId: ClipId | null
  /** Live box-selection rectangle and membership preview, never history. */
  selectionMarquee: SelectionMarqueePreview | null
  /** Primary sequence marker selection; mutually exclusive with clips. */
  selectedMarkerId: TimelineMarkerId | null
  /** Marker whose explicit edit popover is open, or null. */
  editingMarkerId: TimelineMarkerId | null
  /** Trim/ripple/slip/slide gesture preview, or null when none is live. */
  editPreview: EditPreview | null
  /** Chosen alignment target for the active timeline preview, never history. */
  snapGuide: TimelineSnapGuide | null
  /** Uncommitted text move/resize shown by the shared preview compositor. */
  textOverlayPreview: TextOverlayPreview | null
  /** Uncommitted media geometry shown by the shared preview compositor. */
  clipVisualPreview: ClipVisualPreview | null
  /** Lane ghost / insertion marker for an in-flight media drop. */
  mediaPlacementPreview: MediaPlacementPreview | null
  /** Polite live-region copy for drop import/placement outcomes. */
  mediaPlacementStatus: string

  /** Move the playhead. Does NOTHING else — no side effects, no coupling. */
  setPlayheadFrame: (frame: number) => void
  /** Flip the playing flag (the playback engine owns when this happens). */
  setIsPlaying: (isPlaying: boolean) => void
  /** Flip the scrubbing flag (pointer handlers own when this happens). */
  setIsScrubbing: (isScrubbing: boolean) => void
  /**
   * Set a user-authored zoom in pixels per frame. Activates Custom mode and
   * remembers the value; invalid/non-positive values are ignored.
   */
  setZoom: (zoom: number) => void
  /** Apply Full/Detail without overwriting the remembered Custom value. */
  setPresetZoom: (mode: PresetZoomMode, zoom: number) => void
  /** Rebase the browser-safe timeline surface; never changes zoom/history. */
  setTimelineOriginFrame: (frame: number) => void
  /** Set or clear the in/out selection. */
  setInOut: (inOut: TimeRange | null) => void
  /**
   * Update or clear the clip-drag preview. deltaFrames is rounded to an
   * integer and stays signed so linked members can each add it to their own
   * committed start. No other field is touched.
   */
  setDragPreview: (preview: DragPreview | null) => void
  /** Switch the active timeline tool. */
  setTool: (tool: TimelineTool) => void
  /** Replace the selection with one clip (or clear both fields with null). */
  setSelectedClip: (clipId: ClipId | null) => void
  /** Replace the complete ordered clip selection in one transport update. */
  setClipSelection: (
    clipIds: readonly ClipId[],
    primaryClipId?: ClipId | null,
  ) => void
  /**
   * Context invocation promotes an already-selected clip without destroying
   * its multi-selection; an unselected clip becomes the sole selection.
   */
  promoteContextClipSelection: (clipId: ClipId) => void
  /** Add/remove one clip from the ordered selection and update its primary. */
  toggleClipSelection: (clipId: ClipId) => void
  /**
   * Drop selected ids that no longer exist in the active document. The app
   * composition root supplies the valid ids so this store stays document-
   * agnostic; surviving order and primary selection remain stable.
   */
  reconcileClipSelection: (existingClipIds: ReadonlySet<ClipId>) => void
  /** Publish or clear the live empty-lane box-selection preview. */
  setSelectionMarquee: (preview: SelectionMarqueePreview | null) => void
  /** Select/clear one sequence marker without adding document history. */
  setSelectedMarker: (markerId: TimelineMarkerId | null) => void
  /** Open/close the explicit sequence-marker editor. */
  setEditingMarker: (markerId: TimelineMarkerId | null) => void
  /** Drop marker selection/editor state when document history removes ids. */
  reconcileMarkerSelection: (
    existingMarkerIds: ReadonlySet<TimelineMarkerId>,
  ) => void
  /**
   * Update or clear the edit-gesture preview. deltaFrames is rounded to an
   * integer (negative allowed — deltas are signed).
   */
  setEditPreview: (preview: EditPreview | null) => void
  /** Publish or clear the visible alignment guide for a transient edit. */
  setSnapGuide: (guide: TimelineSnapGuide | null) => void
  /** Update or clear one preview-only text manipulation. */
  setTextOverlayPreview: (preview: TextOverlayPreview | null) => void
  /** Update or clear one preview-only media manipulation. */
  setClipVisualPreview: (preview: ClipVisualPreview | null) => void
  /** Publish or release one independently mounted media-preview candidate. */
  setOwnedClipVisualPreview: (
    owner: ClipVisualPreviewOwner,
    preview: Omit<ClipVisualPreview, 'owner'> | null,
  ) => void
  /** Publish or clear the media-drop ghost. Never writes document history. */
  setMediaPlacementPreview: (preview: MediaPlacementPreview | null) => void
  /** Replace the drop-import live region; empty string is silence. */
  setMediaPlacementStatus: (status: string) => void
  /** Clear every session-owned playback/navigation value for a new project. */
  resetTransport: () => void
}

const EMPTY_SELECTED_CLIP_IDS: readonly ClipId[] = Object.freeze([])

export const INITIAL_TRANSPORT_STATE = Object.freeze({
  playheadFrame: 0,
  isPlaying: false,
  isScrubbing: false,
  zoom: 1,
  zoomMode: 'custom' as ZoomMode,
  customZoom: 1,
  timelineOriginFrame: 0,
  inOut: null,
  dragPreview: null,
  tool: 'select' as TimelineTool,
  selectedClipIds: EMPTY_SELECTED_CLIP_IDS,
  selectedClipId: null,
  selectionMarquee: null,
  selectedMarkerId: null,
  editingMarkerId: null,
  editPreview: null,
  snapGuide: null,
  textOverlayPreview: null,
  clipVisualPreview: null,
  mediaPlacementPreview: null,
  mediaPlacementStatus: '',
})

// A queued range-input frame must not resurrect pre-reset zoom state. Keep
// this sequence outside Zustand so resetTransport can still restore the
// complete public transport state to the exact deterministic initial values.
let transportResetRevision = 0

interface OwnedClipVisualPreview {
  activationSequence: number
  preview: ClipVisualPreview
}

const ownedClipVisualPreviews = new Map<
  ClipVisualPreviewOwner,
  OwnedClipVisualPreview
>()
let clipVisualPreviewActivationSequence = 0

function cloneClipVisualPreview(
  preview: ClipVisualPreview | null,
): ClipVisualPreview | null {
  return preview
    ? {
        ...preview,
        transform: { ...preview.transform },
        visual: {
          ...preview.visual,
          crop: { ...preview.visual.crop },
        },
      }
    : null
}

function activeOwnedClipVisualPreview(): ClipVisualPreview | null {
  let active: OwnedClipVisualPreview | null = null
  for (const candidate of ownedClipVisualPreviews.values()) {
    if (!active || candidate.activationSequence > active.activationSequence) {
      active = candidate
    }
  }
  return cloneClipVisualPreview(active?.preview ?? null)
}

function clearOwnedClipVisualPreviews(): void {
  ownedClipVisualPreviews.clear()
  clipVisualPreviewActivationSequence = 0
}

export function getTransportResetRevision(): number {
  return transportResetRevision
}

export const useTransportStore = create<TransportState>()((set) => ({
  ...INITIAL_TRANSPORT_STATE,

  setPlayheadFrame: (frame) =>
    set({ playheadFrame: Math.max(0, Math.round(frame)) }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setIsScrubbing: (isScrubbing) => set({ isScrubbing }),
  setZoom: (zoom) =>
    set((state) =>
      Number.isFinite(zoom) && zoom > 0
        ? state.zoom === zoom &&
          state.customZoom === zoom &&
          state.zoomMode === 'custom'
          ? state
          : { zoom, customZoom: zoom, zoomMode: 'custom' }
        : state,
    ),
  setPresetZoom: (zoomMode, zoom) =>
    set((state) =>
      Number.isFinite(zoom) && zoom > 0
        ? state.zoom === zoom && state.zoomMode === zoomMode
          ? state
          : { zoom, zoomMode }
        : state,
    ),
  setTimelineOriginFrame: (frame) =>
    set((state) => {
      if (!Number.isFinite(frame)) return state
      const timelineOriginFrame = Math.max(
        0,
        Math.min(Number.MAX_SAFE_INTEGER, Math.round(frame)),
      )
      return state.timelineOriginFrame === timelineOriginFrame
        ? state
        : { timelineOriginFrame }
    }),
  setInOut: (inOut) => set({ inOut }),
  setDragPreview: (preview) =>
    set({
      dragPreview: preview
        ? { ...preview, deltaFrames: Math.round(preview.deltaFrames) }
        : null,
    }),
  setTool: (tool) => set({ tool }),
  setSelectedClip: (clipId) =>
    set((state) => {
      if (clipId === null) {
        return state.selectedClipId === null
          && state.selectedClipIds.length === 0
          && state.selectedMarkerId === null
          && state.editingMarkerId === null
          ? state
          : {
              selectedClipIds: EMPTY_SELECTED_CLIP_IDS,
              selectedClipId: null,
              selectedMarkerId: null,
              editingMarkerId: null,
            }
      }

      return state.selectedClipId === clipId &&
        state.selectedClipIds.length === 1 &&
        state.selectedClipIds[0] === clipId &&
        state.selectedMarkerId === null &&
        state.editingMarkerId === null
        ? state
        : {
            selectedClipIds: [clipId],
            selectedClipId: clipId,
            selectedMarkerId: null,
            editingMarkerId: null,
          }
    }),
  setClipSelection: (clipIds, primaryClipId) =>
    set((state) => {
      const selectedClipIds = [...new Set(clipIds)]
      const selectedClipId = primaryClipId !== null
        && primaryClipId !== undefined
        && selectedClipIds.includes(primaryClipId)
        ? primaryClipId
        : (selectedClipIds[selectedClipIds.length - 1] ?? null)
      const unchanged = selectedClipId === state.selectedClipId
        && selectedClipIds.length === state.selectedClipIds.length
        && selectedClipIds.every((clipId, index) => (
          clipId === state.selectedClipIds[index]
        ))
        && state.selectedMarkerId === null
        && state.editingMarkerId === null
      if (unchanged) return state
      return {
        selectedClipIds: selectedClipIds.length === 0
          ? EMPTY_SELECTED_CLIP_IDS
          : selectedClipIds,
        selectedClipId,
        selectedMarkerId: null,
        editingMarkerId: null,
      }
    }),
  promoteContextClipSelection: (clipId) =>
    set((state) => {
      if (!state.selectedClipIds.includes(clipId)) {
        return {
          selectedClipIds: [clipId],
          selectedClipId: clipId,
          selectedMarkerId: null,
          editingMarkerId: null,
        }
      }
      return state.selectedClipId === clipId
        && state.selectedMarkerId === null
        && state.editingMarkerId === null
        ? state
        : {
            selectedClipIds: state.selectedClipIds,
            selectedClipId: clipId,
            selectedMarkerId: null,
            editingMarkerId: null,
          }
    }),
  toggleClipSelection: (clipId) =>
    set((state) => {
      if (!state.selectedClipIds.includes(clipId)) {
        return {
          selectedClipIds: [...state.selectedClipIds, clipId],
          selectedClipId: clipId,
          selectedMarkerId: null,
          editingMarkerId: null,
        }
      }

      const selectedClipIds = state.selectedClipIds.filter(
        (selectedId) => selectedId !== clipId,
      )
      return {
        selectedClipIds:
          selectedClipIds.length === 0
            ? EMPTY_SELECTED_CLIP_IDS
            : selectedClipIds,
        selectedClipId:
          state.selectedClipId === clipId
            ? (selectedClipIds[selectedClipIds.length - 1] ?? null)
            : state.selectedClipId,
      }
    }),
  reconcileClipSelection: (existingClipIds) =>
    set((state) => {
      const selectedClipIds = state.selectedClipIds.filter((clipId) =>
        existingClipIds.has(clipId),
      )
      const selectedClipId =
        state.selectedClipId !== null &&
        selectedClipIds.includes(state.selectedClipId)
          ? state.selectedClipId
          : (selectedClipIds[selectedClipIds.length - 1] ?? null)

      if (
        selectedClipIds.length === state.selectedClipIds.length &&
        selectedClipId === state.selectedClipId
      ) {
        return state
      }

      return {
        selectedClipIds:
          selectedClipIds.length === 0
            ? EMPTY_SELECTED_CLIP_IDS
            : selectedClipIds,
        selectedClipId,
      }
    }),
  setSelectionMarquee: (preview) =>
    set((state) => {
      if (preview === null) {
        return state.selectionMarquee === null
          ? state
          : { selectionMarquee: null }
      }
      const values = [preview.left, preview.top, preview.width, preview.height]
      if (!values.every(Number.isFinite)) return state
      return {
        selectionMarquee: {
          left: preview.left,
          top: preview.top,
          width: Math.max(0, preview.width),
          height: Math.max(0, preview.height),
          clipIds: [...new Set(preview.clipIds)],
        },
      }
    }),
  setSelectedMarker: (markerId) =>
    set((state) => {
      if (markerId === null) {
        return state.selectedMarkerId === null && state.editingMarkerId === null
          ? state
          : { selectedMarkerId: null, editingMarkerId: null }
      }
      return state.selectedMarkerId === markerId
        && state.selectedClipIds.length === 0
        && state.selectedClipId === null
        ? state
        : {
            selectedMarkerId: markerId,
            selectedClipIds: EMPTY_SELECTED_CLIP_IDS,
            selectedClipId: null,
          }
    }),
  setEditingMarker: (markerId) =>
    set((state) => (
      state.editingMarkerId === markerId
        ? state
        : { editingMarkerId: markerId }
    )),
  reconcileMarkerSelection: (existingMarkerIds) =>
    set((state) => {
      const selectedMarkerId = state.selectedMarkerId !== null
        && existingMarkerIds.has(state.selectedMarkerId)
        ? state.selectedMarkerId
        : null
      const editingMarkerId = state.editingMarkerId !== null
        && existingMarkerIds.has(state.editingMarkerId)
        ? state.editingMarkerId
        : null
      return selectedMarkerId === state.selectedMarkerId
        && editingMarkerId === state.editingMarkerId
        ? state
        : { selectedMarkerId, editingMarkerId }
    }),
  setEditPreview: (preview) =>
    set({
      editPreview: preview
        ? { ...preview, deltaFrames: Math.round(preview.deltaFrames) }
        : null,
    }),
  setSnapGuide: (snapGuide) =>
    set((state) => {
      if (snapGuide === null) {
        return state.snapGuide === null ? state : { snapGuide: null }
      }
      if (
        state.snapGuide?.frame === snapGuide.frame
        && state.snapGuide.candidateKind === snapGuide.candidateKind
        && state.snapGuide.candidateId === snapGuide.candidateId
        && state.snapGuide.label === snapGuide.label
        && state.snapGuide.trackId === snapGuide.trackId
      ) return state
      return { snapGuide: { ...snapGuide } }
    }),
  setTextOverlayPreview: (textOverlayPreview) =>
    set({
      textOverlayPreview: textOverlayPreview
        ? {
            ...textOverlayPreview,
            ...(textOverlayPreview.transform
              ? { transform: { ...textOverlayPreview.transform } }
              : {}),
            ...(textOverlayPreview.text
              ? { text: { ...textOverlayPreview.text } }
              : {}),
          }
        : null,
    }),
  setClipVisualPreview: (clipVisualPreview) => {
    clearOwnedClipVisualPreviews()
    set({ clipVisualPreview: cloneClipVisualPreview(clipVisualPreview) })
  },
  setOwnedClipVisualPreview: (owner, preview) => {
    if (preview) {
      const current = ownedClipVisualPreviews.get(owner)
      ownedClipVisualPreviews.set(owner, {
        activationSequence:
          current?.activationSequence ?? ++clipVisualPreviewActivationSequence,
        preview: cloneClipVisualPreview({ ...preview, owner })!,
      })
    } else {
      ownedClipVisualPreviews.delete(owner)
    }
    set({ clipVisualPreview: activeOwnedClipVisualPreview() })
  },
  setMediaPlacementPreview: (preview) =>
    set((state) => {
      const mediaPlacementPreview = preview
        ? {
            trackId: preview.trackId,
            startFrame: Math.max(0, Math.round(preview.startFrame)),
            durationFrames: preview.durationFrames === null
              ? null
              : Math.max(0, Math.round(preview.durationFrames)),
            valid: preview.valid,
            phase: preview.phase,
          }
        : null
      if (
        state.mediaPlacementPreview === null
        && mediaPlacementPreview === null
      ) return state
      if (
        state.mediaPlacementPreview?.trackId === mediaPlacementPreview?.trackId
        && state.mediaPlacementPreview?.startFrame
          === mediaPlacementPreview?.startFrame
        && state.mediaPlacementPreview?.durationFrames
          === mediaPlacementPreview?.durationFrames
        && state.mediaPlacementPreview?.valid === mediaPlacementPreview?.valid
        && state.mediaPlacementPreview?.phase === mediaPlacementPreview?.phase
      ) return state
      return { mediaPlacementPreview }
    }),
  setMediaPlacementStatus: (status) =>
    set((state) => (
      state.mediaPlacementStatus === status
        ? state
        : { mediaPlacementStatus: status }
    )),
  resetTransport: () => {
    transportResetRevision += 1
    clearOwnedClipVisualPreviews()
    set({ ...INITIAL_TRANSPORT_STATE })
  },
}))
