/** Pure, atomic caption batch proposals. The app owns currentness and history. */
import { CAPTION_LIMITS, captionDocumentValidationError, compareCaptionItems, findCaptionTrack, normalizeCaptionText } from './captions'
import { mergedCaptionIntent } from './captionMerge'
import type { CaptionItem, CaptionTrack, FrameRate, TimelineDoc } from './schema'
import { rangeEnd } from './time'

export const CAPTION_BATCH_LIMITS = Object.freeze({ maxPreviewRows: 100, maxPreviewItemsPerRow: 10, defaultReadingCps: 17 })
export type CaptionBatchScope =
  | { readonly kind: 'selected'; readonly ids: readonly string[] }
  | { readonly kind: 'following'; readonly fromId: string }
  | { readonly kind: 'all' }
export type CaptionBatchOperation =
  | { readonly kind: 'shift'; readonly deltaFrames: number }
  | { readonly kind: 'stretch'; readonly anchorFrame: number; readonly numerator: number; readonly denominator: number }
  | { readonly kind: 'split'; readonly plans: readonly { readonly itemId: string; readonly frame: number; readonly textOffset: number; readonly rightId: string }[] }
  | { readonly kind: 'merge' }
  | { readonly kind: 'replace'; readonly find: string; readonly replacement: string }
  | { readonly kind: 'case'; readonly value: 'upper' | 'lower' }
export interface CaptionBatchPreviewRow {
  readonly before: readonly CaptionItem[]
  readonly after: readonly CaptionItem[]
  readonly omittedBeforeItems: number
  readonly omittedAfterItems: number
}
export type CaptionBatchProposal =
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'unchanged'; readonly document: TimelineDoc }
  | { readonly kind: 'ready'; readonly expectedDocument: TimelineDoc; readonly document: TimelineDoc;
    readonly trackId: string; readonly selectedIds: readonly string[]; readonly changedCueCount: number;
    readonly replacementCount: number; readonly preview: readonly CaptionBatchPreviewRow[]; readonly omittedPreviewRows: number }

function fail(message: string): never { throw new RangeError(message) }
const safeFrame = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= CAPTION_LIMITS.maxFrame
function selectedIds(track: CaptionTrack, scope: CaptionBatchScope): Set<string> {
  if (scope.kind === 'all') return new Set(track.items.map((item) => item.id))
  if (scope.kind === 'following') {
    const index = track.items.findIndex((item) => item.id === scope.fromId)
    if (index < 0) fail('The following-cue anchor no longer exists')
    return new Set(track.items.slice(index).map((item) => item.id))
  }
  if (scope.ids.length > CAPTION_LIMITS.maxItemsPerTrack) fail('Caption selection exceeds the track budget')
  const ids = new Set(scope.ids)
  const existing = new Set(track.items.map((item) => item.id))
  if (ids.size !== scope.ids.length || [...ids].some((id) => !existing.has(id))) fail('Caption selection has duplicate or missing identities')
  return ids
}
const floor = (numerator: bigint, denominator: bigint): bigint => numerator >= 0n
  ? numerator / denominator : -((-numerator + denominator - 1n) / denominator)
const ceil = (numerator: bigint, denominator: bigint): bigint => -floor(-numerator, denominator)
function literalReplace(text: string, find: string, replacement: string): { text: string; count: number } {
  let cursor = 0
  let result = ''
  let count = 0
  for (let index = text.indexOf(find); index >= 0; index = text.indexOf(find, cursor)) {
    result += text.slice(cursor, index) + replacement
    if (result.length > CAPTION_LIMITS.maxItemCharacters) fail('Replacement exceeds the per-cue text budget')
    cursor = index + find.length
    count++
  }
  result += text.slice(cursor)
  if (result.length > CAPTION_LIMITS.maxItemCharacters) fail('Replacement exceeds the per-cue text budget')
  return { text: normalizeCaptionText(result), count }
}

/**
 * Whole-project reservedIds must be supplied by the app before split planning.
 * Current-document caption identities are also reserved locally. No store mutation
 * or redo clearing occurs here; final project/retained-byte admission stays above.
 */
export function planCaptionBatch(document: TimelineDoc, trackId: string, scope: CaptionBatchScope,
  operation: CaptionBatchOperation, reservedIds: ReadonlySet<string>): CaptionBatchProposal {
  try {
    const currentError = captionDocumentValidationError(document)
    if (currentError) fail(currentError)
    const track = findCaptionTrack(document, trackId)
    if (!track) fail('The caption track no longer exists')
    const selected = selectedIds(track, scope)
    if (!selected.size) return { kind: 'unchanged', document }
    const selectedItems = track.items.filter((item) => selected.has(item.id))
    const changes: CaptionBatchPreviewRow[] = []
    let replacementCount = 0
    let changedCueCount = 0
    const record = (before: readonly CaptionItem[], after: readonly CaptionItem[]) => {
      changedCueCount += before.length
      if (changes.length < CAPTION_BATCH_LIMITS.maxPreviewRows) {
        const limit = CAPTION_BATCH_LIMITS.maxPreviewItemsPerRow
        changes.push({ before: before.slice(0, limit), after: after.slice(0, limit),
          omittedBeforeItems: Math.max(0, before.length - limit), omittedAfterItems: Math.max(0, after.length - limit) })
      }
    }
    let previewRows = 0
    const note = (before: readonly CaptionItem[], after: readonly CaptionItem[]) => { previewRows++; record(before, after) }
    let items: CaptionItem[]
    if (operation.kind === 'merge') {
      if (selectedItems.length < 2) fail('Select at least two adjacent captions to merge')
      const first = track.items.indexOf(selectedItems[0]!)
      if (track.items.slice(first, first + selectedItems.length).some((item) => !selected.has(item.id))) fail('Merge selection must be adjacent in the track')
      let text = selectedItems[0]!.text
      let intent = mergedCaptionIntent(track, selectedItems[0]!, selectedItems[0]!)
      for (let index = 1; index < selectedItems.length; index++) {
        const previous = selectedItems[index - 1]!; const item = selectedItems[index]!
        if (rangeEnd(previous.range) !== item.range.startFrame) fail('Merged caption ranges must touch exactly')
        intent = mergedCaptionIntent(track, { ...selectedItems[0]!, ...intent }, item)
        text += '\n' + item.text
        if (text.length > CAPTION_LIMITS.maxItemCharacters) fail('Merged text exceeds the per-cue budget')
      }
      const start = selectedItems[0]!
      const merged = { ...start, ...intent, text, range: { startFrame: start.range.startFrame,
        durationFrames: rangeEnd(selectedItems.at(-1)!.range) - start.range.startFrame } }
      items = track.items.filter((item) => !selected.has(item.id)).concat(merged)
      note(selectedItems, [merged])
    } else {
      if (operation.kind === 'shift' && !Number.isSafeInteger(operation.deltaFrames)) fail('Shift must use a signed integer frame count')
      if (operation.kind === 'stretch' && (!safeFrame(operation.anchorFrame)
        || !Number.isInteger(operation.numerator) || operation.numerator < 1 || operation.numerator > 1000
        || !Number.isInteger(operation.denominator) || operation.denominator < 1 || operation.denominator > 1000
        || operation.numerator * 10 < operation.denominator || operation.numerator > operation.denominator * 10)) fail('Stretch requires an integer anchor and a bounded ratio from 0.1 to 10')
      if (operation.kind === 'replace' && (!operation.find.length || operation.find.length > CAPTION_LIMITS.maxItemCharacters
        || operation.replacement.length > CAPTION_LIMITS.maxItemCharacters)) fail('Literal search and replacement must use bounded nonempty search text')
      if (operation.kind === 'case' && !['upper', 'lower'].includes(operation.value)) fail('Select upper or lower case')
      const splits = new Map<string, Extract<CaptionBatchOperation, { kind: 'split' }>['plans'][number]>()
      if (operation.kind === 'split') {
        if (operation.plans.length !== selected.size) fail('Each selected caption requires exactly one split plan')
        const reserved = new Set(reservedIds)
        for (const otherTrack of document.captionTracks ?? []) {
          reserved.add(otherTrack.id)
          for (const item of otherTrack.items) reserved.add(item.id)
        }
        for (const plan of operation.plans) {
          if (!selected.has(plan.itemId) || splits.has(plan.itemId)) fail('Split plans contain missing or duplicate selected identities')
          if (reserved.has(plan.rightId)) fail('A generated split identity is already reserved in the project')
          reserved.add(plan.rightId)
          splits.set(plan.itemId, plan)
        }
      }
      items = track.items.flatMap((item) => {
        if (!selected.has(item.id)) return [item]
        let after: CaptionItem[]
        if (operation.kind === 'shift') after = [{ ...item, range: { ...item.range, startFrame: item.range.startFrame + operation.deltaFrames } }]
        else if (operation.kind === 'stretch') {
          const anchor = BigInt(operation.anchorFrame); const n = BigInt(operation.numerator); const d = BigInt(operation.denominator)
          const start = Number(anchor + floor((BigInt(item.range.startFrame) - anchor) * n, d))
          const end = Number(anchor + ceil((BigInt(rangeEnd(item.range)) - anchor) * n, d))
          after = [{ ...item, range: { startFrame: start, durationFrames: end - start } }]
        } else if (operation.kind === 'split') {
          const plan = splits.get(item.id)!
          if (!Number.isSafeInteger(plan.frame) || plan.frame <= item.range.startFrame || plan.frame >= rangeEnd(item.range)) fail('Split frame must lie strictly inside the caption')
          if (!Number.isInteger(plan.textOffset) || plan.textOffset < 1 || plan.textOffset >= item.text.length
            || (/^[\uDC00-\uDFFF]$/u.test(item.text[plan.textOffset]!) && /^[\uD800-\uDBFF]$/u.test(item.text[plan.textOffset - 1]!))) fail('Split text offset must be inside text and between complete Unicode code points')
          after = [{ ...item, text: normalizeCaptionText(item.text.slice(0, plan.textOffset)), range: { ...item.range, durationFrames: plan.frame - item.range.startFrame } },
            { ...item, id: plan.rightId, text: normalizeCaptionText(item.text.slice(plan.textOffset)), range: { startFrame: plan.frame, durationFrames: rangeEnd(item.range) - plan.frame } }]
        } else if (operation.kind === 'replace') {
          const result = literalReplace(item.text, operation.find, operation.replacement)
          replacementCount += result.count
          after = [{ ...item, text: result.text }]
        } else after = [{ ...item, text: operation.value === 'upper' ? item.text.toUpperCase() : item.text.toLowerCase() }]
        if (after.length === 1 && after[0]!.text === item.text && after[0]!.range.startFrame === item.range.startFrame
          && after[0]!.range.durationFrames === item.range.durationFrames) return [item]
        note([item], after)
        return after
      })
    }
    if (!changedCueCount) return { kind: 'unchanged', document }
    items.sort(compareCaptionItems)
    const candidate = { ...document, captionTracks: document.captionTracks!.map((other) => other.id === trackId ? { ...track, items } : other) }
    const error = captionDocumentValidationError(candidate)
    if (error) fail(error)
    return { kind: 'ready', expectedDocument: document, document: candidate, trackId,
      selectedIds: selectedItems.map((item) => item.id), changedCueCount, replacementCount,
      preview: changes, omittedPreviewRows: previewRows - changes.length }
  } catch (error) {
    if (error instanceof RangeError) return { kind: 'rejected', reason: error.message }
    throw error
  }
}

export function captionReadingSpeed(item: CaptionItem, rate: FrameRate, advisoryCps = CAPTION_BATCH_LIMITS.defaultReadingCps): {
  characters: number; charactersPerSecond: number; aboveAdvisory: boolean;
} {
  if (!Number.isSafeInteger(rate.num) || rate.num < 1 || !Number.isSafeInteger(rate.den) || rate.den < 1
    || !Number.isSafeInteger(item.range.durationFrames) || item.range.durationFrames < 1
    || !Number.isFinite(advisoryCps) || advisoryCps <= 0) fail('Reading speed requires positive duration, rational frame rate and advisory threshold')
  let characters = 0
  for (const character of item.text) if (character !== '\n') characters++
  const charactersPerSecond = characters * rate.num / (item.range.durationFrames * rate.den)
  return { characters, charactersPerSecond, aboveAdvisory: charactersPerSecond > advisoryCps }
}
