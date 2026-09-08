import { describe, expect, it } from 'vitest'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import { CAPTION_BATCH_LIMITS, captionReadingSpeed, planCaptionBatch as planBatch, type CaptionBatchOperation, type CaptionBatchScope } from './captionBatch'
import { CAPTION_LIMITS, createCaptionTrack } from './captions'
import type { CaptionItem, TimelineDoc } from './schema'

const cue = (id: string, startFrame = 0, durationFrames = 10, text = id): CaptionItem => ({ id, range: { startFrame, durationFrames }, text })
function doc(items: CaptionItem[] = [cue('a', 0, 10, 'first'), cue('b', 10, 10, 'second'), cue('c', 20, 10, 'third')]): TimelineDoc {
  return { schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION, id: 'doc', name: 'Batch', frameRate: { num: 25, den: 1 }, width: 1920, height: 1080,
    audioSampleRate: 48000, tracks: [], markers: [], captionTracks: [{ ...createCaptionTrack('captions', 'Captions'), items }] }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
const all = { kind: 'all' } as const
// Test documents contain one sequence; an explicit pool represents any other
// project identities. Production callers must always supply the project pool.
const planCaptionBatch = (document: TimelineDoc, trackId: string, scope: CaptionBatchScope,
  operation: CaptionBatchOperation, projectIds: ReadonlySet<string> = new Set()) => planBatch(document, trackId, scope, operation, projectIds)
function ready(document: TimelineDoc, operation: CaptionBatchOperation, scope: CaptionBatchScope = all) {
  const result = planCaptionBatch(document, 'captions', scope, operation)
  expect(result.kind).toBe('ready')
  if (result.kind !== 'ready') throw new Error(JSON.stringify(result))
  return result
}

describe('atomic caption batch proposals', () => {
  it('shifts only selected identities and retains untouched document/track/item references', () => {
    const source = doc()
    source.captionTracks!.push({ ...createCaptionTrack('other', 'Other'), hidden: true, items: [cue('other-a')] })
    freeze(source)
    const result = ready(source, { kind: 'shift', deltaFrames: 5 }, { kind: 'selected', ids: ['b'] })
    expect(result.expectedDocument).toBe(source)
    expect(result.document).not.toBe(source)
    expect(result.document.tracks).toBe(source.tracks)
    expect(result.document.captionTracks![1]).toBe(source.captionTracks![1])
    expect(result.document.captionTracks![0]!.items[0]).toBe(source.captionTracks![0]!.items[0])
    expect(result.document.captionTracks![0]!.items[1]!.range.startFrame).toBe(15)
    expect(source.captionTracks![0]!.items[1]!.range.startFrame).toBe(10)
    expect(result.changedCueCount).toBe(1)
  })

  it('resolves following scope by a stable anchor and reports selected IDs in track order', () => {
    const result = ready(freeze(doc()), { kind: 'shift', deltaFrames: 10 }, { kind: 'following', fromId: 'b' })
    expect(result.selectedIds).toEqual(['b', 'c'])
    expect(result.document.captionTracks![0]!.items.map((i) => i.range.startFrame)).toEqual([0, 20, 30])
    expect(planCaptionBatch(doc(), 'captions', { kind: 'following', fromId: 'gone' }, { kind: 'shift', deltaFrames: 1 }).kind).toBe('rejected')
  })

  it('returns no-op source identity and rejects stale or duplicate selection without mutation', () => {
    const source = freeze(doc())
    for (const operation of [{ kind: 'shift', deltaFrames: 0 }, { kind: 'stretch', anchorFrame: 10, numerator: 2, denominator: 2 },
      { kind: 'replace', find: 'absent', replacement: 'new' }, { kind: 'case', value: 'lower' }] satisfies CaptionBatchOperation[]) {
      const result = planCaptionBatch(source, 'captions', all, operation)
      expect(result).toEqual({ kind: 'unchanged', document: source })
      if (result.kind === 'unchanged') expect(result.document).toBe(source)
    }
    for (const ids of [['a', 'a'], ['missing']]) expect(planCaptionBatch(source, 'captions', { kind: 'selected', ids }, { kind: 'shift', deltaFrames: 1 }).kind).toBe('rejected')
  })

  it('uses signed BigInt floor/ceil on both stretched boundaries around the anchor', () => {
    const source = freeze(doc([cue('a', 9, 2)]))
    const result = ready(source, { kind: 'stretch', anchorFrame: 10, numerator: 3, denominator: 2 })
    expect(result.document.captionTracks![0]!.items[0]!.range).toEqual({ startFrame: 8, durationFrames: 4 })
  })

  it.each([
    { kind: 'shift', deltaFrames: -1 }, { kind: 'shift', deltaFrames: 0.5 },
    { kind: 'stretch', anchorFrame: 0, numerator: 0, denominator: 1 },
    { kind: 'stretch', anchorFrame: 0, numerator: 1001, denominator: 1000 },
    { kind: 'stretch', anchorFrame: 0, numerator: 1, denominator: 11 },
    { kind: 'stretch', anchorFrame: 0, numerator: 11, denominator: 1 },
  ] satisfies CaptionBatchOperation[])('rejects invalid or out-of-document timing atomically: %j', (operation) => {
    expect(planCaptionBatch(freeze(doc()), 'captions', all, operation).kind).toBe('rejected')
  })

  it('rejects a shift past the maximum and cross-track visible overlap before returning a candidate', () => {
    expect(planCaptionBatch(doc([cue('a', CAPTION_LIMITS.maxFrame - 1, 1)]), 'captions', all, { kind: 'shift', deltaFrames: 1 }).kind).toBe('rejected')
    const source = doc([cue('a', 30)])
    source.captionTracks!.push({ ...createCaptionTrack('other', 'Other'), items: Array.from({ length: 8 }, (_, i) => cue(`other-${i}`)) })
    freeze(source)
    expect(planCaptionBatch(source, 'captions', all, { kind: 'shift', deltaFrames: -30 }).kind).toBe('rejected')
    expect(source.captionTracks![0]!.items[0]!.range.startFrame).toBe(30)
  })

  it('splits at explicit frame/text boundaries, retains left ID and immutable extended intent', () => {
    const extended = { ...cue('a', 0, 10, 'hello world'), style: { version: 7, params: { future: 'keep' } }, origin: { version: 9, params: { run: 'same' } } }
    const source = freeze(doc([extended]))
    const result = ready(source, { kind: 'split', plans: [{ itemId: 'a', frame: 4, textOffset: 5, rightId: 'right' }] })
    const items = result.document.captionTracks![0]!.items
    expect(items).toMatchObject([{ id: 'a', text: 'hello', range: { startFrame: 0, durationFrames: 4 } },
      { id: 'right', text: 'world', range: { startFrame: 4, durationFrames: 6 } }])
    for (const item of items) {
      expect(Reflect.get(item, 'style')).toBe(extended.style)
      expect(Reflect.get(item, 'origin')).toBe(extended.origin)
    }
  })

  it('rejects globally reserved split IDs, missing plans, duplicate generated IDs and broken surrogate pairs', () => {
    const source = doc([cue('a', 0, 10, 'a😀b'), cue('b', 10, 10, 'other cue')])
    const scope = { kind: 'selected', ids: ['a'] } as const
    const split = { itemId: 'a', frame: 5, textOffset: 1, rightId: 'external-sequence-id' }
    expect(planCaptionBatch(source, 'captions', scope, { kind: 'split', plans: [split] }, new Set(['external-sequence-id'])).kind).toBe('rejected')
    expect(planCaptionBatch(source, 'captions', scope, { kind: 'split', plans: [{ ...split, textOffset: 2 }] }).kind).toBe('rejected')
    expect(planCaptionBatch(source, 'captions', scope, { kind: 'split', plans: [{ ...split, rightId: 'b' }] }).kind).toBe('rejected')
    expect(planCaptionBatch(source, 'captions', all, { kind: 'split', plans: [split] }).kind).toBe('rejected')
    expect(planCaptionBatch(source, 'captions', all, { kind: 'split', plans: [split, { ...split, itemId: 'b', frame: 15 }] }).kind).toBe('rejected')
  })

  it('merges adjacent touching cues, keeps earliest identity and rejects semantic style/provenance loss', () => {
    const source = freeze(doc())
    const result = ready(source, { kind: 'merge' }, { kind: 'selected', ids: ['b', 'a'] })
    expect(result.document.captionTracks![0]!.items[0]).toEqual(cue('a', 0, 20, 'first\nsecond'))
    expect(result.changedCueCount).toBe(2)
    expect(planCaptionBatch(source, 'captions', { kind: 'selected', ids: ['a', 'c'] }, { kind: 'merge' }).kind).toBe('rejected')
    const differentStyle = doc([{ ...cue('a'), style: { version: 1, params: { bold: true } } }, cue('b', 10)])
    expect(planCaptionBatch(differentStyle, 'captions', all, { kind: 'merge' }).kind).toBe('rejected')
    const differentOrigin = doc([{ ...cue('a'), origin: { version: 9, params: { run: 'one' } } }, { ...cue('b', 10), origin: { version: 9, params: { run: 'two' } } }])
    expect(planCaptionBatch(differentOrigin, 'captions', all, { kind: 'merge' }).kind).toBe('rejected')
  })

  it('recognizes equivalent supported track/cue overrides without throwing away unknown descriptors', () => {
    const style = { version: 1, params: { bold: true } }
    const source = doc([cue('a'), { ...cue('b', 10), style }])
    Object.assign(source.captionTracks![0]!, { style })
    expect(planCaptionBatch(freeze(source), 'captions', all, { kind: 'merge' }).kind).toBe('ready')
    const unknown = { version: 4, params: { bold: true } }
    const identicalOpaque = doc([{ ...cue('a'), style: unknown }, { ...cue('b', 10), style: { ...unknown } }])
    expect(planCaptionBatch(freeze(identicalOpaque), 'captions', all, { kind: 'merge' }).kind).toBe('ready')
    const incompatible = doc([{ ...cue('a'), style: unknown }, { ...cue('b', 10), style: { ...unknown, params: { bold: false } } }])
    expect(planCaptionBatch(freeze(incompatible), 'captions', all, { kind: 'merge' }).kind).toBe('rejected')
  })

  it('does literal replacement without regex or replacement-template interpretation', () => {
    const source = freeze(doc([cue('a', 0, 10, '.* .* $&')]))
    const result = ready(source, { kind: 'replace', find: '.*', replacement: '$&' })
    expect(result.document.captionTracks![0]!.items[0]!.text).toBe('$& $& $&')
    expect(result.replacementCount).toBe(2)
    expect(planCaptionBatch(source, 'captions', all, { kind: 'replace', find: '', replacement: '' }).kind).toBe('rejected')
    expect(planCaptionBatch(doc([cue('a', 0, 10, 'a'.repeat(4000))]), 'captions', all, { kind: 'replace', find: 'a', replacement: 'aa' }).kind).toBe('rejected')
  })

  it('uses locale-independent Unicode case mapping and rejects expansion beyond the cue budget', () => {
    expect(ready(doc([cue('a', 0, 10, 'straße')]), { kind: 'case', value: 'upper' }).document.captionTracks![0]!.items[0]!.text).toBe('STRASSE')
    expect(planCaptionBatch(doc([cue('a', 0, 10, 'ß'.repeat(3000))]), 'captions', all, { kind: 'case', value: 'upper' }).kind).toBe('rejected')
  })

  it('bounds preview rows and merged row contents while retaining exact counts', () => {
    const source = doc(Array.from({ length: 150 }, (_, i) => cue(`cue-${i}`, i * 10, 10, 'a')))
    const shifted = ready(freeze(source), { kind: 'shift', deltaFrames: 1 })
    expect(shifted.preview).toHaveLength(CAPTION_BATCH_LIMITS.maxPreviewRows)
    expect(shifted.omittedPreviewRows).toBe(50)
    const merged = ready(source, { kind: 'merge' })
    expect(merged.preview[0]!.before).toHaveLength(10)
    expect(merged.preview[0]!.omittedBeforeItems).toBe(140)
    expect(merged.changedCueCount).toBe(150)
  })

  it('computes advisory reading speed from Unicode code points and exact rational seconds', () => {
    expect(captionReadingSpeed(cue('a', 0, 25, 'a😀 b\nc'), { num: 25, den: 1 })).toEqual({ characters: 5, charactersPerSecond: 5, aboveAdvisory: false })
    expect(captionReadingSpeed(cue('a', 0, 30, 'a'.repeat(30)), { num: 30_000, den: 1001 }, 17).charactersPerSecond).toBeCloseTo(29.97003)
    expect(() => captionReadingSpeed(cue('a'), { num: 0, den: 1 })).toThrow()
  })
})
