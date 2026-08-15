import { describe, expect, it } from 'vitest'
import {
  CAPTION_LIMITS,
  activeCaptionItemsAtFrame,
  addCaptionItem,
  addCaptionTrack,
  captionDocumentValidationError,
  createCaptionTrack,
  mergeCaptionWithNext,
  shiftCaptionItems,
  splitCaptionItem,
  updateCaptionItem,
} from './captions'
import type { CaptionItem, TimelineDoc } from './schema'

function doc(): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'doc',
    name: 'Captions',
    frameRate: { num: 30_000, den: 1_001 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [],
    markers: [],
    captionTracks: [],
  }
}

function item(id: string, startFrame: number, durationFrames: number, text = id): CaptionItem {
  return { id, range: { startFrame, durationFrames }, text }
}

describe('semantic captions', () => {
  it('keeps cue identity while sorting integer-frame edits', () => {
    let current = addCaptionTrack(doc(), createCaptionTrack('captions-1', 'English', 'en'))
    current = addCaptionItem(current, 'captions-1', item('cue-b', 20, 10))
    current = addCaptionItem(current, 'captions-1', item('cue-a', 0, 10))
    current = updateCaptionItem(current, 'captions-1', 'cue-b', {
      range: { startFrame: 10, durationFrames: 10 },
      text: '  second line  ',
    })

    expect(current.captionTracks?.[0]?.items).toEqual([
      item('cue-a', 0, 10),
      item('cue-b', 10, 10, 'second line'),
    ])
  })

  it('splits inside a range and merges only touching neighbors', () => {
    let current = addCaptionTrack(doc(), createCaptionTrack('captions-1', 'English'))
    current = addCaptionItem(current, 'captions-1', item('cue-a', 10, 20, 'Hello'))
    current = splitCaptionItem(current, 'captions-1', 'cue-a', 22, 'cue-b')

    expect(current.captionTracks?.[0]?.items).toEqual([
      item('cue-a', 10, 12, 'Hello'),
      item('cue-b', 22, 8, 'Hello'),
    ])

    current = mergeCaptionWithNext(current, 'captions-1', 'cue-a')
    expect(current.captionTracks?.[0]?.items).toEqual([
      item('cue-a', 10, 20, 'Hello\nHello'),
    ])
  })

  it('shifts a selected suffix atomically and rejects unsafe bounds', () => {
    let current = addCaptionTrack(doc(), createCaptionTrack('captions-1', 'English'))
    current = addCaptionItem(current, 'captions-1', item('cue-a', 0, 5))
    current = addCaptionItem(current, 'captions-1', item('cue-b', 10, 5))
    const shifted = shiftCaptionItems(current, 'captions-1', 'cue-b', 7)

    expect(shifted.captionTracks?.[0]?.items.map((cue) => cue.range.startFrame)).toEqual([0, 17])
    expect(() => shiftCaptionItems(current, 'captions-1', null, -1)).toThrow(/start frame/u)
    expect(current.captionTracks?.[0]?.items.map((cue) => cue.range.startFrame)).toEqual([0, 10])
  })

  it('permits bounded overlap with half-open boundary behavior', () => {
    let current = addCaptionTrack(doc(), createCaptionTrack('captions-1', 'English'))
    for (let index = 0; index < CAPTION_LIMITS.maxActiveItems; index += 1) {
      current = addCaptionItem(current, 'captions-1', item(`cue-${index}`, 0, 10))
    }
    expect(activeCaptionItemsAtFrame(current, 0)).toHaveLength(CAPTION_LIMITS.maxActiveItems)
    expect(activeCaptionItemsAtFrame(current, 10)).toHaveLength(0)
    expect(() => addCaptionItem(current, 'captions-1', item('cue-overflow', 0, 10)))
      .toThrow(/overlap/u)
  })

  it('rejects empty text, markup, duplicate ids, and invalid language metadata', () => {
    let current = addCaptionTrack(doc(), createCaptionTrack('captions-1', 'English'))
    expect(() => addCaptionItem(current, 'captions-1', item('empty', 0, 1, '   ')))
      .toThrow(/non-empty/u)
    expect(() => addCaptionItem(current, 'captions-1', item('markup', 0, 1, '<b>hello</b>')))
      .toThrow(/markup/u)
    current = addCaptionItem(current, 'captions-1', item('duplicate', 0, 1))
    expect(() => addCaptionItem(current, 'captions-1', item('duplicate', 2, 1)))
      .toThrow(/Duplicate/u)
    expect(captionDocumentValidationError({
      ...current,
      captionTracks: [{ ...current.captionTracks![0]!, language: 'not a tag!' }],
    })).toMatch(/language/u)
  })
})
