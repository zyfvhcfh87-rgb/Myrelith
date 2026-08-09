/**
 * Pure sequence-marker operations. Every accepted edit returns a new document;
 * every rejection returns the original reference so the document store does
 * not create a phantom undo step.
 */

import type {
  TimelineDoc,
  TimelineMarker,
  TimelineMarkerColor,
  TimelineMarkerId,
} from './schema'

export const TIMELINE_MARKER_COLORS: readonly TimelineMarkerColor[] =
  Object.freeze(['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'green'])
export const MAX_TIMELINE_MARKERS = 50_000
export const MAX_TIMELINE_MARKER_FRAME = 1_000_000_000
export const MAX_TIMELINE_MARKER_LABEL_CHARACTERS = 120
export const MAX_TIMELINE_MARKER_NOTE_CHARACTERS = 4_000
export const MAX_TIMELINE_MARKER_ID_CHARACTERS = 256

const EMPTY_MARKERS: readonly TimelineMarker[] = Object.freeze([])
const COLOR_SET = new Set<TimelineMarkerColor>(TIMELINE_MARKER_COLORS)

function reject(doc: TimelineDoc, operation: string, reason: string): TimelineDoc {
  console.warn(`[timelineMarkers] ${operation} rejected: ${reason}`)
  return doc
}

export function timelineMarkers(doc: TimelineDoc): readonly TimelineMarker[] {
  return doc.markers ?? EMPTY_MARKERS
}

export function compareTimelineMarkers(
  left: TimelineMarker,
  right: TimelineMarker,
): number {
  const frameOrder = left.frame - right.frame
  if (frameOrder !== 0) return frameOrder
  if (left.id === right.id) return 0
  // Locale collation can vary by browser/OS. Code-unit order keeps portable
  // files and equal-frame navigation byte-for-byte deterministic everywhere.
  return left.id < right.id ? -1 : 1
}

export function findTimelineMarker(
  doc: TimelineDoc,
  markerId: TimelineMarkerId,
): TimelineMarker | null {
  return timelineMarkers(doc).find((marker) => marker.id === markerId) ?? null
}

function markerValidationError(marker: TimelineMarker): string | null {
  if (marker.id.length === 0 || marker.id.length > MAX_TIMELINE_MARKER_ID_CHARACTERS) {
    return `id must contain 1-${MAX_TIMELINE_MARKER_ID_CHARACTERS} characters`
  }
  if (!Number.isSafeInteger(marker.frame) || marker.frame < 0 || marker.frame > MAX_TIMELINE_MARKER_FRAME) {
    return `frame must be an integer from 0-${MAX_TIMELINE_MARKER_FRAME}`
  }
  if (marker.label.trim().length === 0 || marker.label.length > MAX_TIMELINE_MARKER_LABEL_CHARACTERS) {
    return `label must contain 1-${MAX_TIMELINE_MARKER_LABEL_CHARACTERS} characters`
  }
  if (!COLOR_SET.has(marker.color)) return 'color is not supported'
  if (marker.note !== undefined && marker.note.length > MAX_TIMELINE_MARKER_NOTE_CHARACTERS) {
    return `note exceeds ${MAX_TIMELINE_MARKER_NOTE_CHARACTERS} characters`
  }
  return null
}

function withSortedMarkers(
  doc: TimelineDoc,
  markers: readonly TimelineMarker[],
): TimelineDoc {
  return {
    ...doc,
    markers: [...markers].sort(compareTimelineMarkers),
  }
}

export function addTimelineMarker(
  doc: TimelineDoc,
  marker: TimelineMarker,
): TimelineDoc {
  const markers = timelineMarkers(doc)
  if (markers.length >= MAX_TIMELINE_MARKERS) {
    return reject(doc, 'add', `document already has ${MAX_TIMELINE_MARKERS} markers`)
  }
  const validationError = markerValidationError(marker)
  if (validationError) return reject(doc, 'add', validationError)
  if (markers.some((candidate) => candidate.id === marker.id)) {
    return reject(doc, 'add', `marker id ${marker.id} already exists`)
  }
  return withSortedMarkers(doc, [...markers, { ...marker }])
}

export interface TimelineMarkerPatch {
  readonly frame?: number
  readonly label?: string
  readonly color?: TimelineMarkerColor
  readonly note?: string | undefined
}

export function updateTimelineMarker(
  doc: TimelineDoc,
  markerId: TimelineMarkerId,
  patch: TimelineMarkerPatch,
): TimelineDoc {
  const markers = timelineMarkers(doc)
  const index = markers.findIndex((marker) => marker.id === markerId)
  if (index < 0) return reject(doc, 'update', `marker ${markerId} was not found`)
  const current = markers[index]
  const next: TimelineMarker = {
    ...current,
    ...patch,
    label: patch.label === undefined ? current.label : patch.label.trim(),
  }
  if (patch.note !== undefined) {
    const trimmed = patch.note.trim()
    if (trimmed.length === 0) delete next.note
    else next.note = trimmed
  }
  const validationError = markerValidationError(next)
  if (validationError) return reject(doc, 'update', validationError)
  if (
    next.frame === current.frame
    && next.label === current.label
    && next.color === current.color
    && next.note === current.note
  ) return doc
  const updated = [...markers]
  updated[index] = next
  return withSortedMarkers(doc, updated)
}

export function moveTimelineMarker(
  doc: TimelineDoc,
  markerId: TimelineMarkerId,
  frame: number,
): TimelineDoc {
  return updateTimelineMarker(doc, markerId, { frame })
}

export function duplicateTimelineMarker(
  doc: TimelineDoc,
  markerId: TimelineMarkerId,
  duplicateId: TimelineMarkerId,
): TimelineDoc {
  const marker = findTimelineMarker(doc, markerId)
  if (!marker) return reject(doc, 'duplicate', `marker ${markerId} was not found`)
  return addTimelineMarker(doc, {
    ...marker,
    id: duplicateId,
    label: `${marker.label} copy`.slice(0, MAX_TIMELINE_MARKER_LABEL_CHARACTERS),
  })
}

export function deleteTimelineMarker(
  doc: TimelineDoc,
  markerId: TimelineMarkerId,
): TimelineDoc {
  const markers = timelineMarkers(doc)
  const next = markers.filter((marker) => marker.id !== markerId)
  return next.length === markers.length
    ? reject(doc, 'delete', `marker ${markerId} was not found`)
    : { ...doc, markers: next }
}

/** Mint a collision-safe id; randomness is isolated from the pure edit ops. */
export function createTimelineMarkerId(doc: TimelineDoc): TimelineMarkerId {
  const ids = new Set(timelineMarkers(doc).map((marker) => marker.id))
  const base = `marker_${crypto.randomUUID()}`
  if (!ids.has(base)) return base
  for (let suffix = 2; suffix <= ids.size + 1; suffix++) {
    const candidate = `${base}_${suffix}`
    if (!ids.has(candidate)) return candidate
  }
  return `${base}_${ids.size + 2}`
}

export function createDefaultTimelineMarker(
  doc: TimelineDoc,
  frame: number,
): TimelineMarker {
  return {
    id: createTimelineMarkerId(doc),
    frame: Math.max(0, Math.min(MAX_TIMELINE_MARKER_FRAME, Math.round(frame))),
    label: `Marker ${timelineMarkers(doc).length + 1}`,
    color: 'yellow',
  }
}

function selectedIndex(
  markers: readonly TimelineMarker[],
  selectedId: TimelineMarkerId | null,
): number {
  return selectedId === null
    ? -1
    : markers.findIndex((marker) => marker.id === selectedId)
}

/** Equal-frame traversal is deterministic because marker arrays use (frame,id). */
export function nextTimelineMarker(
  doc: TimelineDoc,
  frame: number,
  selectedId: TimelineMarkerId | null = null,
): TimelineMarker | null {
  const markers = timelineMarkers(doc)
  const index = selectedIndex(markers, selectedId)
  if (index >= 0) return markers[index + 1] ?? null
  return markers.find((marker) => marker.frame >= frame) ?? null
}

export function previousTimelineMarker(
  doc: TimelineDoc,
  frame: number,
  selectedId: TimelineMarkerId | null = null,
): TimelineMarker | null {
  const markers = timelineMarkers(doc)
  const index = selectedIndex(markers, selectedId)
  if (index >= 0) return markers[index - 1] ?? null
  for (let candidate = markers.length - 1; candidate >= 0; candidate--) {
    if (markers[candidate].frame <= frame) return markers[candidate]
  }
  return null
}
