import { afterEach, beforeEach, expect, test } from 'vitest'
import { beginColorGradingEdit, addGradingEffect } from './colorGradingController'
import { attributeClip } from '../test/clipAttributeFixtures'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { DEFAULT_COLOR_WHEELS, COLOR_WHEELS_TYPE } from '../domain/colorWheels'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { MAX_KEYFRAMES_PER_TRACK } from '../domain/clipAnimation'
import { createAdjustmentItem } from '../domain/adjustmentItems'

const target = { kind: 'clip', sequenceId: 'grading', clipId: 'clip' } as const
beforeEach(() => {
  const doc = structuredClone(createTimelineDoc('Grading', DEFAULT_PROJECT_SETTINGS, 'grading'))
  const clip = attributeClip('clip')
  clip.effects = [{ id: 'grade', type: COLOR_WHEELS_TYPE, version: 1, enabled: true, params: { ...DEFAULT_COLOR_WHEELS } }]
  doc.tracks[0].clips = [clip]
  useDocumentStore.getState().setProject(sequenceProjectFromTimeline(doc))
  useTransportStore.getState().resetTransport()
  useTransportStore.getState().setSelectedClip('clip')
})
afterEach(() => useTransportStore.getState().resetTransport())

test('many preview patches leave the document untouched, then one release creates one history entry', () => {
  const before = useDocumentStore.getState().project, edit = beginColorGradingEdit(target, 'grade')
  for (let i = 1; i <= 20; i++) expect(edit.preview({ liftR: i / 100 })).toBeNull()
  expect(useDocumentStore.getState().project).toBe(before)
  expect(useDocumentStore.getState().past).toEqual([])
  expect(useTransportStore.getState().colorGradingPreview?.document.tracks[0].clips[0].effects[0].params.liftR).toBe(0.2)
  expect(edit.commit({ liftR: 0.2 })).toBeNull()
  expect(useDocumentStore.getState().past).toEqual([before])
  expect(useTransportStore.getState().colorGradingPreview).toBeNull()
  useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toBe(before)
  useDocumentStore.getState().redo(); expect(useDocumentStore.getState().doc.tracks[0].clips[0].effects[0].params.liftR).toBe(0.2)
})

test.each(['cancel', 'project', 'selection', 'adjustment-selection', 'playhead', 'reset'] as const)('%s discards the temporary correction and a late release cannot mutate history', (action) => {
  const edit = beginColorGradingEdit(target, 'grade')
  edit.preview({ gammaR: 2 })
  if (action === 'cancel') edit.cancel()
  if (action === 'project') useDocumentStore.getState().setProject(structuredClone(useDocumentStore.getState().project))
  if (action === 'selection') useTransportStore.getState().setSelectedClip(null)
  if (action === 'adjustment-selection') useTransportStore.getState().setSelectedAdjustment('other')
  if (action === 'playhead') useTransportStore.getState().setPlayheadFrame(2)
  if (action === 'reset') useTransportStore.getState().resetTransport()
  expect(useTransportStore.getState().colorGradingPreview).toBeNull()
  expect(edit.commit({ gammaR: 2 })).toMatch(/changed/)
  expect(useDocumentStore.getState().past).toEqual([])
})

test('animated scalar gestures preview and commit keys at the captured frame, without changing static channels', () => {
  useDocumentStore.getState().setEffectKeyframe('clip', 'grade', 'gainR', { frame: 0, value: 1, easing: { type: 'linear' } })
  useTransportStore.getState().setPlayheadFrame(15)
  const before = useDocumentStore.getState(), edit = beginColorGradingEdit(target, 'grade')
  edit.preview({ gainR: 1.5, gainG: 1.2 })
  expect(useDocumentStore.getState().project).toBe(before.project)
  expect(edit.commit({ gainR: 1.5, gainG: 1.2 })).toBeNull()
  const clip = useDocumentStore.getState().doc.tracks[0].clips[0]
  expect(clip.effects[0].params).toMatchObject({ gainR: 1, gainG: 1.2 })
  expect(clip.animation!.effectTracks![0].keyframes.at(-1)).toMatchObject({ frame: 15, value: 1.5 })
  expect(useDocumentStore.getState().past).toHaveLength(before.past.length + 1)
})

test('locked targets and invalid parameters reject without changing undo or redo', () => {
  const edit = beginColorGradingEdit(target, 'grade'), before = useDocumentStore.getState().project
  expect(edit.commit({ gammaG: 0 })).toMatch(/between/)
  expect(useDocumentStore.getState().project).toBe(before)
  const doc = structuredClone(useDocumentStore.getState().doc); doc.tracks[0].locked = true
  useDocumentStore.getState().setDoc(doc)
  expect(() => beginColorGradingEdit(target, 'grade')).toThrow(/locked/)
  expect(addGradingEffect(target, COLOR_WHEELS_TYPE)).toMatch(/locked/)
})

test.each(['clip', 'adjustment'] as const)('a full %s keyframe lane rejects the whole gesture and preserves redo', (kind) => {
  const doc = structuredClone(useDocumentStore.getState().doc), clip = doc.tracks[0].clips[0]
  const item = kind === 'clip' ? clip : createAdjustmentItem(0, 60, 'Grade')
  item.effects = clip.effects
  item.animation = { tracks: [], effectTracks: [{ effectId: 'grade', parameter: 'gainR', keyframes: Array.from({ length: MAX_KEYFRAMES_PER_TRACK }, (_, index) => ({ frame: index * 2, value: 1, easing: { type: 'linear' as const } })) }] }
  if (kind === 'adjustment') { item.id = 'adjustment'; clip.effects = []; doc.tracks[0].adjustments = [item as ReturnType<typeof createAdjustmentItem>] }
  useDocumentStore.getState().setDoc(doc)
  const project = useDocumentStore.getState().project
  useDocumentStore.setState({ future: [project] })
  useTransportStore.getState().setPlayheadFrame(1)
  const editTarget = kind === 'clip' ? target : { kind: 'adjustment' as const, sequenceId: target.sequenceId, adjustmentId: 'adjustment' }
  const edit = beginColorGradingEdit(editTarget, 'grade')
  expect(edit.preview({ gainR: 2, gainG: 2 })).toMatch(/keyframe budget/)
  expect(useTransportStore.getState().colorGradingPreview).toBeNull()
  expect(useDocumentStore.getState()).toMatchObject({ project, past: [], future: [project] })
  // Updating an existing key at capacity is still a valid, single edit.
  useTransportStore.getState().setPlayheadFrame(2)
  expect(beginColorGradingEdit(editTarget, 'grade').commit({ gainR: 2, gainG: 2 })).toBeNull()
  expect(useDocumentStore.getState().past).toEqual([project])
})
