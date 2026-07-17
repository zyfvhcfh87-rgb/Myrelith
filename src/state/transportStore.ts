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
import type { ClipId, TimeRange, TrackId } from '../domain/schema'

/**
 * Live position of a clip mid-drag — the "scrubbing" half of the
 * scrubbing-vs-committed pattern (ARCHITECTURE.md). While a drag gesture is
 * active, ClipView renders from here; documentStore is untouched until
 * pointerup commits ONE moveClip (one undo entry).
 */
export interface DragPreview {
  clipId: ClipId
  /** Where the dragged clip's timelineRange would start right now. */
  startFrame: number
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
  /** In/out selection for preview/export, or null when unset. */
  inOut: TimeRange | null
  /** Clip-drag preview, or null when no drag is in flight. */
  dragPreview: DragPreview | null
  /** Active timeline tool (Phase 4.2). */
  tool: TimelineTool
  /** The selected clip, or null. Ephemeral UI state — never in undo. */
  selectedClipId: ClipId | null
  /** Trim/ripple/slip/slide gesture preview, or null when none is live. */
  editPreview: EditPreview | null

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
  /** Set or clear the in/out selection. */
  setInOut: (inOut: TimeRange | null) => void
  /**
   * Update or clear the clip-drag preview. Frame is forced to a
   * non-negative integer like the playhead. No other field is touched.
   */
  setDragPreview: (preview: DragPreview | null) => void
  /** Switch the active timeline tool. */
  setTool: (tool: TimelineTool) => void
  /** Select a clip (or clear with null). */
  setSelectedClip: (clipId: ClipId | null) => void
  /**
   * Update or clear the edit-gesture preview. deltaFrames is rounded to an
   * integer (negative allowed — deltas are signed).
   */
  setEditPreview: (preview: EditPreview | null) => void
  /** Clear every session-owned playback/navigation value for a new project. */
  resetTransport: () => void
}

export const INITIAL_TRANSPORT_STATE = Object.freeze({
  playheadFrame: 0,
  isPlaying: false,
  isScrubbing: false,
  zoom: 1,
  zoomMode: 'custom' as ZoomMode,
  customZoom: 1,
  inOut: null,
  dragPreview: null,
  tool: 'select' as TimelineTool,
  selectedClipId: null,
  editPreview: null,
})

// A queued range-input frame must not resurrect pre-reset zoom state. Keep
// this sequence outside Zustand so resetTransport can still restore the
// complete public transport state to the exact deterministic initial values.
let transportResetRevision = 0

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
  setInOut: (inOut) => set({ inOut }),
  setDragPreview: (preview) =>
    set({
      dragPreview: preview
        ? { ...preview, startFrame: Math.max(0, Math.round(preview.startFrame)) }
        : null,
    }),
  setTool: (tool) => set({ tool }),
  setSelectedClip: (clipId) => set({ selectedClipId: clipId }),
  setEditPreview: (preview) =>
    set({
      editPreview: preview
        ? { ...preview, deltaFrames: Math.round(preview.deltaFrames) }
        : null,
    }),
  resetTransport: () => {
    transportResetRevision += 1
    set({ ...INITIAL_TRANSPORT_STATE })
  },
}))
