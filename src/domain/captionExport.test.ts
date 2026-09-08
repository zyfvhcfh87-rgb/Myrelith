import { describe, expect, it } from 'vitest'
import { createCaptionTrack } from './captions'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import { sequenceProjectFromTimeline } from './projectSequences'
import type { CaptionItem, CaptionTrack, SequenceInstance, TimelineDoc, Track } from './schema'
import { firstCaptionExportBlocker } from './captionExport'

const future = { version: 999, params: { color: '#ff0000ff', future: true } }
const cue = (id: string, start: number, duration: number, unavailable = false): CaptionItem => ({
  id, text: id, range: { startFrame: start, durationFrames: duration }, ...(unavailable ? { style: future } : {}) })
const captions = (id: string, items: CaptionItem[], more: Partial<CaptionTrack> = {}): CaptionTrack => ({
  ...createCaptionTrack(id, id), items, ...more })
const doc = (id: string, captionTracks: CaptionTrack[] = [], tracks: Track[] = []): TimelineDoc => ({
  ...createTimelineDoc(id, DEFAULT_PROJECT_SETTINGS, id), captionTracks, tracks })
const instance = (id: string, childId: string, parentStart: number, sourceStart: number, duration: number): SequenceInstance => ({
  kind: 'sequence', id, name: id, sequenceId: childId, sourceStartFrame: sourceStart,
  timelineRange: { startFrame: parentStart, durationFrames: duration } })
const track = (id: string, sequenceInstances: SequenceInstance[], more: Partial<Track> = {}): Track => ({
  id, name: id, kind: 'video', clips: [], transitions: [], hidden: false, muted: false, solo: false,
  locked: false, sequenceInstances, ...more })
const project = (root: TimelineDoc, ...children: TimelineDoc[]) => ({
  ...sequenceProjectFromTimeline(root), sequences: [root, ...children] })

describe('staged caption export availability', () => {
  it('blocks visible unavailable cue intent with exact identity/frame', () => {
    const root = doc('root', [captions('cc', [cue('future', 8, 2, true)])])
    expect(firstCaptionExportBlocker(project(root), root.id)).toMatchObject({
      sequenceId: 'root', trackId: 'cc', cueId: 'future', frame: 8 })
  })
  it('keeps an unavailable track blocked when the cue overrides known fields', () => {
    const root = doc('root', [captions('cc', [{ ...cue('known', 0, 1), style: { version: 1, params: { color: '#ffffffff' } } }], { style: future })])
    expect(firstCaptionExportBlocker(project(root), root.id)?.cueId).toBe('known')
  })
  it('ignores hidden captions, empty unavailable tracks, and dormant sequences', () => {
    const root = doc('root', [captions('hidden', [cue('x', 0, 5, true)], { hidden: true }), captions('empty', [], { style: future })])
    const child = doc('dormant', [captions('dormant-cc', [cue('dormant-cue', 0, 50, true)])])
    expect(firstCaptionExportBlocker(project(root, child), root.id)).toBeNull()
  })
  it('does not interpret unknown provenance as unavailable style', () => {
    const root = doc('root', [captions('cc', [{ ...cue('x', 0, 1), origin: future }], { origin: future })])
    expect(firstCaptionExportBlocker(project(root), root.id)).toBeNull()
  })
  it.each([{ kind: 'video' as const, hidden: true }, { kind: 'audio' as const, hidden: false }])
    ('does not reach child captions through excluded lane %s', (more) => {
      const child = doc('child', [captions('cc', [cue('future', 0, 5, true)])])
      const root = doc('root', [], [track('lane', [instance('inst', child.id, 0, 0, 5)], more)])
      expect(firstCaptionExportBlocker(project(root, child), root.id)).toBeNull()
    })
  it('respects both source trim edges as half-open integer frames', () => {
    const child = doc('child', [captions('cc', [cue('before', 0, 10, true), cue('after', 20, 10, true)])])
    const root = doc('root', [], [track('v', [instance('inst', child.id, 0, 10, 10)])])
    expect(firstCaptionExportBlocker(project(root, child), root.id)).toBeNull()
    const intersects = { ...root, tracks: [track('v', [instance('inst', child.id, 0, 10, 11)])] }
    expect(firstCaptionExportBlocker(project(intersects, child), root.id)?.frame).toBe(20)
  })
  it('does not widen disjoint child visits into a bounding interval', () => {
    const child = doc('child', [captions('cc', [cue('gap', 20, 10, true)])])
    const root = doc('root', [], [track('v', [instance('a', child.id, 0, 0, 10), instance('b', child.id, 10, 40, 10)])])
    expect(firstCaptionExportBlocker(project(root, child), root.id)).toBeNull()
  })
  it('does not skip a later covered gap merely because child was seen earlier', () => {
    const child = doc('child', [captions('cc', [cue('gap', 20, 10, true)])])
    const root = doc('root', [], [track('v', [instance('a', child.id, 0, 0, 10),
      instance('b', child.id, 10, 40, 10), instance('c', child.id, 20, 20, 10)])])
    expect(firstCaptionExportBlocker(project(root, child), root.id)?.cueId).toBe('gap')
  })
  it('composes source trim through two child levels', () => {
    const leaf = doc('leaf', [captions('cc', [cue('future', 102, 1, true)])])
    const child = doc('child', [], [track('child-v', [instance('leaf-inst', leaf.id, 10, 100, 10)])])
    const root = doc('root', [], [track('v', [instance('child-inst', child.id, 0, 11, 3)])])
    expect(firstCaptionExportBlocker(project(root, child, leaf), root.id))
      .toMatchObject({ sequenceId: leaf.id, cueId: 'future', frame: 102 })
  })
  it('exports the selected sequence independently of the project root', () => {
    const root = doc('root'), child = doc('child', [captions('cc', [cue('future', 1, 2, true)])])
    expect(firstCaptionExportBlocker(project(root, child), child.id)?.sequenceId).toBe(child.id)
  })
  it('checks geometry after other captions start, with stable track order', () => {
    const root = doc('root', [captions('first', [cue('a', 5, 5)]), captions('second', [cue('b', 0, 10)])])
    const observed: [string, number, number][] = []
    const result = firstCaptionExportBlocker(project(root), root.id, (_doc, _track, item, index, size) => {
      observed.push([item.id, index, size])
      return item.id === 'b' && size === 2 ? 'Stack makes the caption unavailable' : null
    })
    expect(observed).toEqual([['b', 0, 1], ['a', 0, 2], ['b', 1, 2]])
    expect(result).toMatchObject({ cueId: 'b', frame: 5 })
  })
  it('checks geometry again after a caption ends and the stack shrinks', () => {
    const root = doc('root', [captions('first', [cue('a', 0, 5)]), captions('second', [cue('b', 0, 10)])])
    expect(firstCaptionExportBlocker(project(root), root.id, (_doc, _track, item, _index, size) =>
      item.id === 'b' && size === 1 ? 'Unavailable single-stack geometry' : null)).toMatchObject({ cueId: 'b', frame: 5 })
  })
  it('does not double-check a repeated complete child interval', () => {
    const child = doc('child', [captions('cc', [cue('known', 0, 10)])])
    const root = doc('root', [], [track('v', [instance('a', child.id, 0, 0, 10), instance('b', child.id, 10, 0, 10)])])
    let calls = 0
    expect(firstCaptionExportBlocker(project(root, child), root.id, () => { calls++; return null })).toBeNull()
    expect(calls).toBe(1)
  })
  it('checks only the intersecting cue in a 20,000-cue child', () => {
    const child = doc('child', [captions('cc', Array.from({ length: 20_000 }, (_, i) => cue(`cue-${i}`, i * 10, 5)))])
    const root = doc('root', [], [track('v', [instance('inst', child.id, 0, 199_990, 5)])])
    const observed: string[] = []
    expect(firstCaptionExportBlocker(project(root, child), root.id, (_doc, _track, item) => { observed.push(item.id); return null })).toBeNull()
    expect(observed).toEqual(['cue-19999'])
  })
  it('does not mutate source documents or unknown intent', () => {
    const root = doc('root', [captions('cc', [cue('future', 0, 1, true)])]), input = project(root)
    const before = JSON.stringify(input)
    firstCaptionExportBlocker(input, root.id)
    expect(JSON.stringify(input)).toBe(before)
    expect(root.captionTracks![0]!.items[0]!.style).toBe(future)
  })
})
