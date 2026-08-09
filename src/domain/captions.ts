/**
 * Pure semantic caption contracts and edit operations.
 *
 * Captions remain distinct from procedural text clips. The renderer may share
 * text layout/paint machinery, but authored identity, timing, language, role,
 * import/export, and edit behavior live here on the integer-frame timebase.
 */

import type {
  CaptionItem,
  CaptionItemId,
  CaptionStylePreset,
  CaptionTrack,
  CaptionTrackId,
  CaptionTrackRole,
  ClipVisualSettings,
  TextProps,
  TimelineDoc,
  Transform,
} from './schema'
import { rangeEnd } from './time'

export const CAPTION_LIMITS = Object.freeze({
  maxTracks: 32,
  maxItemsPerTrack: 20_000,
  maxItemsTotal: 50_000,
  maxActiveItems: 8,
  maxItemCharacters: 4_000,
  maxTotalCharacters: 2_000_000,
  maxFrame: 1_000_000_000,
  maxIdCharacters: 256,
  maxTrackNameCharacters: 120,
  maxLanguageCharacters: 35,
})

export const CAPTION_TRACK_ROLES = Object.freeze([
  'subtitles',
  'captions',
] as const satisfies readonly CaptionTrackRole[])

export const CAPTION_STYLE_PRESETS = Object.freeze([
  'classic',
  'boxed',
  'minimal',
] as const satisfies readonly CaptionStylePreset[])

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const LANGUAGE_TAG = /^(?:und|[A-Za-z]{2,8})(?:-[A-Za-z0-9]{1,8})*$/u
const MARKUP = /<[^>\n]+>/u

function isSafeFrame(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= CAPTION_LIMITS.maxFrame
}

function errorForPortableId(value: string, label: string): string | null {
  if (value.length === 0) return `${label} must not be empty`
  if (value.length > CAPTION_LIMITS.maxIdCharacters) {
    return `${label} must not exceed ${CAPTION_LIMITS.maxIdCharacters} characters`
  }
  if (!PORTABLE_ID.test(value)) {
    return `${label} may contain only letters, numbers, dot, underscore, colon, and hyphen`
  }
  return null
}

/** Normalize platform line endings and trim only outer cue whitespace. */
export function normalizeCaptionText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim()
}

export function captionItemValidationError(item: CaptionItem): string | null {
  const idError = errorForPortableId(item.id, 'Caption item id')
  if (idError) return idError
  if (!isSafeFrame(item.range.startFrame)) {
    return `Caption ${item.id} start frame must be an integer from 0 to ${CAPTION_LIMITS.maxFrame}`
  }
  if (!Number.isSafeInteger(item.range.durationFrames) || item.range.durationFrames < 1) {
    return `Caption ${item.id} duration must be a positive integer frame count`
  }
  if (rangeEnd(item.range) > CAPTION_LIMITS.maxFrame) {
    return `Caption ${item.id} must end at or before frame ${CAPTION_LIMITS.maxFrame}`
  }
  if (item.text !== normalizeCaptionText(item.text) || item.text.length === 0) {
    return `Caption ${item.id} text must be non-empty with no outer whitespace`
  }
  if (item.text.length > CAPTION_LIMITS.maxItemCharacters) {
    return `Caption ${item.id} text must not exceed ${CAPTION_LIMITS.maxItemCharacters} characters`
  }
  if (MARKUP.test(item.text)) {
    return `Caption ${item.id} contains unsupported markup; captions accept plain text only`
  }
  return null
}

export function compareCaptionItems(left: CaptionItem, right: CaptionItem): number {
  return left.range.startFrame - right.range.startFrame
    || rangeEnd(left.range) - rangeEnd(right.range)
    || left.id.localeCompare(right.id)
}

export function captionTrackValidationError(track: CaptionTrack): string | null {
  const idError = errorForPortableId(track.id, 'Caption track id')
  if (idError) return idError
  if (track.name !== track.name.trim() || track.name.length === 0) {
    return `Caption track ${track.id} name must be non-empty with no outer whitespace`
  }
  if (track.name.length > CAPTION_LIMITS.maxTrackNameCharacters) {
    return `Caption track ${track.id} name must not exceed ${CAPTION_LIMITS.maxTrackNameCharacters} characters`
  }
  if (
    track.language.length > CAPTION_LIMITS.maxLanguageCharacters
    || !LANGUAGE_TAG.test(track.language)
  ) {
    return `Caption track ${track.id} language must be a BCP-47-compatible tag or und`
  }
  if (!CAPTION_TRACK_ROLES.includes(track.role)) {
    return `Caption track ${track.id} has an unsupported role`
  }
  if (!CAPTION_STYLE_PRESETS.includes(track.stylePreset)) {
    return `Caption track ${track.id} has an unsupported style preset`
  }
  if (track.items.length > CAPTION_LIMITS.maxItemsPerTrack) {
    return `Caption track ${track.id} exceeds ${CAPTION_LIMITS.maxItemsPerTrack} items`
  }

  const ids = new Set<CaptionItemId>()
  let previous: CaptionItem | null = null
  for (const item of track.items) {
    const itemError = captionItemValidationError(item)
    if (itemError) return itemError
    if (ids.has(item.id)) return `Duplicate caption item id: ${item.id}`
    ids.add(item.id)
    if (previous && compareCaptionItems(previous, item) > 0) {
      return `Caption track ${track.id} items must be sorted by timing and id`
    }
    previous = item
  }
  return null
}

/** Validate global ids, resource limits, and the bounded overlap contract. */
export function captionDocumentValidationError(doc: TimelineDoc): string | null {
  const tracks = doc.captionTracks ?? []
  if (tracks.length > CAPTION_LIMITS.maxTracks) {
    return `Project exceeds ${CAPTION_LIMITS.maxTracks} caption tracks`
  }

  const trackIds = new Set<CaptionTrackId>()
  const itemIds = new Set<CaptionItemId>()
  const events: { frame: number; delta: -1 | 1 }[] = []
  let itemCount = 0
  let characterCount = 0
  for (const track of tracks) {
    const trackError = captionTrackValidationError(track)
    if (trackError) return trackError
    if (trackIds.has(track.id)) return `Duplicate caption track id: ${track.id}`
    trackIds.add(track.id)
    for (const item of track.items) {
      if (itemIds.has(item.id)) return `Duplicate caption item id: ${item.id}`
      itemIds.add(item.id)
      itemCount += 1
      characterCount += item.text.length
      if (!track.hidden) {
        events.push({ frame: item.range.startFrame, delta: 1 })
        events.push({ frame: rangeEnd(item.range), delta: -1 })
      }
    }
  }
  if (itemCount > CAPTION_LIMITS.maxItemsTotal) {
    return `Project exceeds ${CAPTION_LIMITS.maxItemsTotal} caption items`
  }
  if (characterCount > CAPTION_LIMITS.maxTotalCharacters) {
    return `Project exceeds ${CAPTION_LIMITS.maxTotalCharacters} caption characters`
  }

  events.sort((left, right) => left.frame - right.frame || left.delta - right.delta)
  let active = 0
  for (const event of events) {
    active += event.delta
    if (active > CAPTION_LIMITS.maxActiveItems) {
      return `More than ${CAPTION_LIMITS.maxActiveItems} visible captions overlap at frame ${event.frame}`
    }
  }
  return null
}

function assertCaptionDocument(doc: TimelineDoc): void {
  const error = captionDocumentValidationError(doc)
  if (error) throw new RangeError(error)
}

function replaceCaptionTrack(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  replace: (track: CaptionTrack) => CaptionTrack,
): TimelineDoc {
  const tracks = doc.captionTracks ?? []
  const index = tracks.findIndex((track) => track.id === trackId)
  if (index < 0) throw new RangeError(`Caption track not found: ${trackId}`)
  const nextTracks = tracks.slice()
  nextTracks[index] = replace(tracks[index]!)
  const next = { ...doc, captionTracks: nextTracks }
  assertCaptionDocument(next)
  return next
}

export function createCaptionTrack(
  id: CaptionTrackId,
  name: string,
  language = 'und',
): CaptionTrack {
  const track: CaptionTrack = {
    id,
    name: name.trim(),
    language,
    role: 'captions',
    stylePreset: 'classic',
    hidden: false,
    items: [],
  }
  const error = captionTrackValidationError(track)
  if (error) throw new RangeError(error)
  return track
}

export function addCaptionTrack(doc: TimelineDoc, track: CaptionTrack): TimelineDoc {
  const next = { ...doc, captionTracks: [...(doc.captionTracks ?? []), track] }
  assertCaptionDocument(next)
  return next
}

export function updateCaptionTrack(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  patch: Partial<Pick<CaptionTrack, 'name' | 'language' | 'role' | 'stylePreset' | 'hidden'>>,
): TimelineDoc {
  return replaceCaptionTrack(doc, trackId, (track) => ({
    ...track,
    ...patch,
    name: patch.name === undefined ? track.name : patch.name.trim(),
  }))
}

export function removeCaptionTrack(doc: TimelineDoc, trackId: CaptionTrackId): TimelineDoc {
  const tracks = doc.captionTracks ?? []
  if (!tracks.some((track) => track.id === trackId)) {
    throw new RangeError(`Caption track not found: ${trackId}`)
  }
  return { ...doc, captionTracks: tracks.filter((track) => track.id !== trackId) }
}

export function addCaptionItem(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  item: CaptionItem,
): TimelineDoc {
  return replaceCaptionTrack(doc, trackId, (track) => ({
    ...track,
    items: [...track.items, { ...item, text: normalizeCaptionText(item.text) }]
      .sort(compareCaptionItems),
  }))
}

/** Replace one track's complete cue set as one atomic import/edit gesture. */
export function replaceCaptionItems(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  items: CaptionItem[],
): TimelineDoc {
  return replaceCaptionTrack(doc, trackId, (track) => ({
    ...track,
    items: items.map((item) => ({ ...item, text: normalizeCaptionText(item.text) }))
      .sort(compareCaptionItems),
  }))
}

export function updateCaptionItem(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  itemId: CaptionItemId,
  patch: Partial<Pick<CaptionItem, 'range' | 'text'>>,
): TimelineDoc {
  return replaceCaptionTrack(doc, trackId, (track) => {
    if (!track.items.some((item) => item.id === itemId)) {
      throw new RangeError(`Caption item not found: ${itemId}`)
    }
    return {
      ...track,
      items: track.items.map((item) => item.id === itemId
        ? {
            ...item,
            ...patch,
            text: patch.text === undefined ? item.text : normalizeCaptionText(patch.text),
          }
        : item).sort(compareCaptionItems),
    }
  })
}

export function removeCaptionItem(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  itemId: CaptionItemId,
): TimelineDoc {
  return replaceCaptionTrack(doc, trackId, (track) => {
    if (!track.items.some((item) => item.id === itemId)) {
      throw new RangeError(`Caption item not found: ${itemId}`)
    }
    return { ...track, items: track.items.filter((item) => item.id !== itemId) }
  })
}

export function splitCaptionItem(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  itemId: CaptionItemId,
  splitFrame: number,
  rightItemId: CaptionItemId,
): TimelineDoc {
  return replaceCaptionTrack(doc, trackId, (track) => {
    const item = track.items.find((candidate) => candidate.id === itemId)
    if (!item) throw new RangeError(`Caption item not found: ${itemId}`)
    const end = rangeEnd(item.range)
    if (!Number.isSafeInteger(splitFrame) || splitFrame <= item.range.startFrame || splitFrame >= end) {
      throw new RangeError('Split frame must be strictly inside the caption range')
    }
    const right: CaptionItem = {
      ...item,
      id: rightItemId,
      range: { startFrame: splitFrame, durationFrames: end - splitFrame },
    }
    return {
      ...track,
      items: track.items.flatMap((candidate) => candidate.id === itemId
        ? [
            { ...candidate, range: { ...candidate.range, durationFrames: splitFrame - candidate.range.startFrame } },
            right,
          ]
        : [candidate]).sort(compareCaptionItems),
    }
  })
}

export function mergeCaptionWithNext(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  itemId: CaptionItemId,
): TimelineDoc {
  return replaceCaptionTrack(doc, trackId, (track) => {
    const index = track.items.findIndex((item) => item.id === itemId)
    const current = track.items[index]
    const next = track.items[index + 1]
    if (!current) throw new RangeError(`Caption item not found: ${itemId}`)
    if (!next) throw new RangeError('The selected caption has no following caption to merge')
    if (rangeEnd(current.range) !== next.range.startFrame) {
      throw new RangeError('Captions can merge only when their ranges touch exactly')
    }
    const merged: CaptionItem = {
      ...current,
      range: {
        startFrame: current.range.startFrame,
        durationFrames: rangeEnd(next.range) - current.range.startFrame,
      },
      text: `${current.text}\n${next.text}`,
    }
    return {
      ...track,
      items: track.items.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1)
        .concat(merged)
        .sort(compareCaptionItems),
    }
  })
}

/** Shift all cues or the selected cue and everything after it as one edit. */
export function shiftCaptionItems(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  fromItemId: CaptionItemId | null,
  deltaFrames: number,
): TimelineDoc {
  if (!Number.isSafeInteger(deltaFrames) || deltaFrames === 0) {
    throw new RangeError('Caption timing shift must be a non-zero integer frame count')
  }
  return replaceCaptionTrack(doc, trackId, (track) => {
    const startIndex = fromItemId === null
      ? 0
      : track.items.findIndex((item) => item.id === fromItemId)
    if (startIndex < 0) throw new RangeError(`Caption item not found: ${String(fromItemId)}`)
    return {
      ...track,
      items: track.items.map((item, index) => index < startIndex
        ? item
        : {
            ...item,
            range: {
              ...item.range,
              startFrame: item.range.startFrame + deltaFrames,
            },
          }).sort(compareCaptionItems),
    }
  })
}

export function findCaptionTrack(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
): CaptionTrack | null {
  return (doc.captionTracks ?? []).find((track) => track.id === trackId) ?? null
}

export function findCaptionItem(
  doc: TimelineDoc,
  trackId: CaptionTrackId,
  itemId: CaptionItemId,
): CaptionItem | null {
  return findCaptionTrack(doc, trackId)?.items.find((item) => item.id === itemId) ?? null
}

/** Visible active items in deterministic track/item order for one exact frame. */
export function activeCaptionItemsAtFrame(
  doc: TimelineDoc,
  frame: number,
): { track: CaptionTrack; item: CaptionItem }[] {
  const active: { track: CaptionTrack; item: CaptionItem }[] = []
  for (const track of doc.captionTracks ?? []) {
    if (track.hidden) continue
    for (const item of track.items) {
      if (item.range.startFrame > frame) break
      if (frame < rangeEnd(item.range)) active.push({ track, item })
    }
  }
  return active
}

export interface CaptionPaint {
  id: CaptionItemId
  text: TextProps
  transform: Transform
  visual: ClipVisualSettings
  opacity: number
}

const CAPTION_VISUAL: ClipVisualSettings = Object.freeze({
  crop: Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 }),
  flipHorizontal: false,
  flipVertical: false,
  scaleLocked: true,
})

/** Resolve one semantic preset into shared text-paint inputs. */
export function captionPaintFor(
  doc: TimelineDoc,
  track: CaptionTrack,
  item: CaptionItem,
  stackIndex: number,
  stackSize: number,
): CaptionPaint {
  const boxWidth = Math.round(doc.width * 0.86)
  const availableHeight = doc.height * 0.78
  const gap = Math.max(4, Math.round(doc.height * 0.008))
  const boxHeight = Math.max(44, Math.floor((availableHeight - gap * (stackSize - 1)) / stackSize))
  const bottomMargin = Math.round(doc.height * 0.06)
  const top = doc.height - bottomMargin - boxHeight * (stackIndex + 1) - gap * stackIndex
  const y = top - (doc.height - boxHeight) / 2
  const minimal = track.stylePreset === 'minimal'
  const boxed = track.stylePreset === 'boxed'
  const fontSize = Math.max(18, Math.min(
    Math.round(doc.height * (minimal ? 0.043 : 0.052)),
    Math.floor(boxHeight / 2.4),
  ))
  return {
    id: item.id,
    text: {
      content: item.text,
      fontFamily: 'sans-serif',
      fontSizePx: fontSize,
      color: '#ffffff',
      align: 'center',
      bold: !minimal,
      italic: false,
      boxWidthPx: boxWidth,
      boxHeightPx: boxHeight,
      paddingPx: Math.max(8, Math.round(fontSize * 0.28)),
      backgroundEnabled: boxed,
      backgroundColor: '#000000cc',
      outlineEnabled: !boxed && !minimal,
      outlineColor: '#000000',
      outlineWidthPx: Math.max(1, Math.round(fontSize * 0.07)),
      shadowEnabled: !boxed,
      shadowColor: '#000000',
      shadowBlurPx: Math.max(2, Math.round(fontSize * 0.12)),
      shadowOffsetXPx: 0,
      shadowOffsetYPx: Math.max(1, Math.round(fontSize * 0.07)),
    },
    transform: {
      x: 0,
      y,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    visual: CAPTION_VISUAL,
    opacity: 1,
  }
}
