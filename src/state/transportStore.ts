/**
 * state/transportStore.ts — Playback/navigation state. Phase 1.3.
 *
 * Rules (from the plan and ARCHITECTURE.md):
 * - NO history middleware: scrubbing must never pollute undo.
 * - NO side effects and NO coupling: setters touch exactly their own field
 *   and never read or write documentStore.
 * - playheadFrame is an integer frame at the document rate (rule 2); the
 *   setter rounds and clamps to >= 0 so a stray float can never leak in.
 */

import { create } from 'zustand'
import type { ClipId, TimeRange } from '../domain/schema'

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
}

/** The Phase 4.2 timeline tools (Toolbar buttons + A/B/T/Y/U keys). */
export type TimelineTool = 'select' | 'razor' | 'trim' | 'slip' | 'slide'

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
  /** Set zoom in pixels per frame; values <= 0 are ignored. */
  setZoom: (zoom: number) => void
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
}

export const useTransportStore = create<TransportState>()((set) => ({
  playheadFrame: 0,
  isPlaying: false,
  isScrubbing: false,
  zoom: 1,
  inOut: null,
  dragPreview: null,
  tool: 'select',
  selectedClipId: null,
  editPreview: null,

  setPlayheadFrame: (frame) =>
    set({ playheadFrame: Math.max(0, Math.round(frame)) }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setIsScrubbing: (isScrubbing) => set({ isScrubbing }),
  setZoom: (zoom) => set((state) => (zoom > 0 ? { zoom } : state)),
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
}))
