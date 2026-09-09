import { describe, expect, test } from 'vitest'
import { expandedTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { planTitleEdit, titleElementBounds, titleResizeDelta, titleEditOwner, type TitleEditCommand } from './titleEditing'
import { resolveTitleElementAnimation } from './animationPropertyCatalog'
import { readTitleElement } from './titleElements'
import { SOURCE_TIME_TICKS_PER_FRAME } from './sourceTimeMap'
const target = { sequenceId: 'root', clipId: 'root-text' }, ids = ['root-element']
function fixture() { let id = 0; return { project: expandedTitleProject(), factory: () => `new-element-${++id}` } }
function element(project: ReturnType<typeof expandedTitleProject>, index = 0) {
  const parsed = readTitleElement(titleEditOwner(project, target).elements[index]); if (parsed.status !== 'supported') throw new Error(parsed.reason); return parsed.element
}
function key(elementId: string, property: string, value = 100, propertyVersion = 1) { return { elementId, property, propertyVersion, keyframes: [{ frame: 0, value, easing: { type: 'linear' as const } }] } }
const motion = (direction: 'up' | 'down' | 'left' | 'right'): Extract<TitleEditCommand, { kind: 'motion' }> => ({ kind: 'motion', ids, direction, start: 0, end: 99, replace: false })
describe('atomic title authoring', () => {
  test('keeps IDs and unrelated lanes through edit/reorder, duplicates keys with fresh IDs, deletes only owned tracks', () => {
    const { factory } = fixture()
    let project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [key(ids[0], 'position-x'), key('orphan', 'future', 42, 7)] } }))
    project = planTitleEdit(project, target, { kind: 'duplicate', ids }, factory)
    const duplicated = titleEditOwner(project, target)
    expect(duplicated.elements.map((e) => e.id)).toEqual([ids[0], 'new-element-1'])
    expect(duplicated.clip.animation!.titleTracks!.map((lane) => lane.elementId)).toEqual([ids[0], 'orphan', 'new-element-1'])
    project = planTitleEdit(project, target, { kind: 'reorder', ids: ['new-element-1', ids[0]] }, factory)
    project = planTitleEdit(project, target, { kind: 'patch', ids, patch: { name: 'Renamed', text: { content: 'Edited' } } }, factory)
    expect(titleEditOwner(project, target).elements[1].id).toBe(ids[0])
    project = planTitleEdit(project, target, { kind: 'delete', ids }, factory)
    expect(titleEditOwner(project, target).clip.animation!.titleTracks!.map((lane) => lane.elementId)).toEqual(['orphan', 'new-element-1'])
    expect(() => planTitleEdit(project, target, { kind: 'delete', ids: ['new-element-1'] }, factory)).toThrow(/at least one/)
  })
  test('reserves IDs owned by dormant elements and orphan lanes', () => {
    let project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [key('reserved', 'future', 0, 3)] } }))
    const offered = ['root-element', 'reserved', 'fresh']
    project = planTitleEdit(project, target, { kind: 'add', elementKind: 'ellipse' }, () => offered.shift()!)
    expect(element(project, 1).id).toBe('fresh')
  })
  test('edits both locked scales atomically, and enabling follows X', () => {
    const { project, factory } = fixture()
    let next = planTitleEdit(project, target, { kind: 'values', ids, values: { 'scale-y': 2 } }, factory)
    expect(element(next).transform).toMatchObject({ scaleX: 2, scaleY: 2 })
    next = planTitleEdit(next, target, { kind: 'patch', ids, patch: { visual: { scaleLocked: false }, transform: { scaleY: 3 } } }, factory)
    next = planTitleEdit(next, target, { kind: 'patch', ids, patch: { visual: { scaleLocked: true } } }, factory)
    expect(element(next).transform).toMatchObject({ scaleX: 2, scaleY: 2 })
  })
  test('rejects static padding that invalidates an existing key, and over-cap duplication', () => {
    const { factory } = fixture()
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [key(ids[0], 'box-width', 100)] } }))
    expect(() => planTitleEdit(project, target, { kind: 'patch', ids, patch: { text: { paddingPx: 50 } } }, factory)).toThrow(/padding/)
    let next = expandedTitleProject()
    for (let count = 1; count < 16; count++) next = planTitleEdit(next, target, { kind: 'add', elementKind: 'rectangle' }, factory)
    expect(() => planTitleEdit(next, target, { kind: 'duplicate', ids }, factory)).toThrow(/16/)
  })
  test('persisted fallback retains original font intent', () => {
    const { project, factory } = fixture()
    const next = planTitleEdit(project, target, { kind: 'patch', ids, patch: { font: { family: 'Missing Named Face', fallbackFamily: 'serif' } } }, factory)
    expect(element(next)).toMatchObject({ font: { family: 'Missing Named Face', fallbackFamily: 'serif' } })
  })
  test('no-op edits preserve the exact project', () => {
    const { project, factory } = fixture()
    expect(planTitleEdit(project, target, { kind: 'values', ids, values: { 'position-x': 0 } }, factory)).toBe(project)
  })
})
describe('ordinary roll and crawl keys', () => {
  test.each(['up', 'down', 'left', 'right'] as const)('%s keeps transformed group spacing and both endpoints fully outside the canvas', (direction) => {
    const { factory } = fixture()
    let project = planTitleEdit(expandedTitleProject(), target, { kind: 'patch', ids, patch: { transform: { rotation: 31, anchorX: .2, anchorY: .8, scaleX: 1.2, scaleY: .7 }, visual: { scaleLocked: false, flipHorizontal: true, crop: { left: .2, bottom: .1 } } } }, factory)
    project = planTitleEdit(project, target, { kind: 'duplicate', ids }, factory)
    project = planTitleEdit(project, target, { kind: 'values', ids: ['new-element-1'], values: { 'position-x': 280, 'position-y': -90 } }, factory)
    const before = titleEditOwner(project, target)
    const next = planTitleEdit(project, target, { ...motion(direction), ids: [ids[0], 'new-element-1'] }, factory)
    const { clip, sequence } = titleEditOwner(next, target), lanes = clip.animation!.titleTracks!
    expect(lanes).toHaveLength(2)
    for (const frame of [0, 99]) {
      const resolved = [element(next), element(next, 1)].map((e) => resolveTitleElementAnimation(e, lanes, frame).element)
      expect(resolved[1].transform.x - resolved[0].transform.x).toBeCloseTo(280)
      expect(resolved[1].transform.y - resolved[0].transform.y).toBeCloseTo(-90)
      const bounds = resolved.map((e) => titleElementBounds(e, sequence))
      const negative = direction === 'up' || direction === 'left', beforeCanvas = negative ? frame === 99 : frame === 0
      if (direction === 'up' || direction === 'down') expect(bounds.every((b) => beforeCanvas ? b.bottom < 0 : b.top > sequence.height)).toBe(true)
      else expect(bounds.every((b) => beforeCanvas ? b.right < 0 : b.left > sequence.width)).toBe(true)
    }
    for (const lane of lanes) expect(lane.keyframes).toEqual(lane.keyframes.map((key) => ({ ...key, sourceTimeTicks: key.frame * SOURCE_TIME_TICKS_PER_FRAME, easing: { type: 'linear' } })))
    expect(before.clip.animation!.titleTracks).toBeUndefined()
    expect(() => planTitleEdit(next, target, motion(direction), factory)).toThrow(/Reapply/)
    expect(titleEditOwner(planTitleEdit(next, target, { ...motion(direction), replace: true } as TitleEditCommand, factory), target).clip.animation!.titleTracks).toHaveLength(2)
  })
  test.each([{ start: 0, end: 0 }, { start: -1, end: 2 }, { start: 0, end: 100 }, { start: 0.5, end: 4 }])('rejects invalid range %j', (range) => {
    const { project, factory } = fixture()
    expect(() => planTitleEdit(project, target, { ...motion('up'), ...range }, factory)).toThrow(/integer frames/)
  })
  test('refuses unavailable font, future motion, and zero geometry', () => {
    const { project, factory } = fixture()
    const missing = planTitleEdit(project, target, { kind: 'patch', ids, patch: { font: { family: 'Missing Face', fallbackFamily: null } } }, factory)
    expect(() => planTitleEdit(missing, target, motion('up'), factory)).toThrow(/font fallback/)
    const zero = planTitleEdit(project, target, { kind: 'values', ids, values: { 'scale-x': 0 } }, factory)
    expect(() => planTitleEdit(zero, target, motion('up'), factory)).toThrow(/Zero-scale/)
    const future = replaceFirstTitleClip(project, (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [key(ids[0], 'position-y', 0, 7)] } }))
    expect(() => planTitleEdit(future, target, { ...motion('up'), replace: true } as TitleEditCommand, factory)).toThrow(/unavailable movement version/)
  })
  test('gesture updates existing keys through shared planning, and resizes the transformed crop corner exactly', () => {
    const { factory } = fixture()
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, animation: { ...clip.animation!, titleTracks: [key(ids[0], 'position-x', 100)] } }))
    const next = planTitleEdit(project, target, { kind: 'gesture', ids, mode: 'move', dx: 35, dy: -5, frame: 20 }, factory)
    const owner = titleEditOwner(next, target)
    expect(owner.clip.animation!.titleTracks![0].keyframes.map((key) => [key.frame, key.value, key.sourceTimeTicks])).toEqual([[0, 100, undefined], [20, 135, 20 * SOURCE_TIME_TICKS_PER_FRAME]])
    expect(element(next).transform).toMatchObject({ x: 0, y: -5 })
    const transformed = planTitleEdit(expandedTitleProject(), target, { kind: 'patch', ids, patch: { transform: { rotation: 25, anchorX: .2 }, visual: { flipHorizontal: true, crop: { right: .1 } } } }, factory)
    const first = element(transformed), sequence = titleEditOwner(transformed, target).sequence
    const before = titleElementBounds(first, sequence).points[2], delta = titleResizeDelta(first, 20, 30)
    const resized = planTitleEdit(transformed, target, { kind: 'gesture', ids, mode: 'resize', dx: 20, dy: 30, frame: 0 }, factory)
    const after = titleElementBounds(element(resized), sequence).points[2]
    expect(after.x - before.x).toBeCloseTo(20); expect(after.y - before.y).toBeCloseTo(30)
    expect(Number.isFinite(delta.width)).toBe(true)
  })
})
