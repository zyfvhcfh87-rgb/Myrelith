import { expect, test } from 'vitest'
import { attributeProject } from '../test/clipAttributeFixtures'
import { createColorAdjustEffect, createMaskEffect } from './effectStack'
import { editVideoBus, type VideoBusTarget } from './videoBusEffects'
import { documentEffectBudgetUsage } from './effectBounds'
import { duplicateProjectSequence, sequenceProjectWithinEditBudget } from './projectSequences'
import { resolveVideoBusEffects, videoBusAdditionalBytes, videoBusRenderBudgetError } from './videoBusStage'
import { lensRemapSurfaceBudget } from './renderSurfaceBudget'

const make = () => {
  const project = attributeProject(), sequence = project.sequences[0]
  const target: VideoBusTarget = { sequenceId: sequence.id, kind: 'track', trackId: sequence.tracks[0].id }
  return { project, target, sequence }
}
test('bus apply mints ids against clips, orphan targets and dormant bus stacks; duplication remints all buses', () => {
  const { project, target, sequence } = make()
  const dormant = structuredClone(sequence); dormant.id = 'dormant'; dormant.tracks = []; dormant.masterVideoEffects = [createColorAdjustEffect('reserved-bus')]
  project.sequences.push(dormant)
  const attempts = ['color', 'orphan', 'reserved-bus', 'track-copy', 'master-copy']
  const nextId = () => attempts.shift() ?? 'fresh-id'
  const first = editVideoBus(project, target, { kind: 'apply', effects: [createColorAdjustEffect('template')], mode: 'append' }, nextId)
  expect(first.ok).toBe(true); if (!first.ok) return
  expect(first.project.sequences[0].tracks[0].videoEffects?.[0].id).toBe('track-copy')
  const second = editVideoBus(first.project, { kind: 'master', sequenceId: sequence.id }, { kind: 'apply', effects: [createColorAdjustEffect('template')], mode: 'append' }, nextId)
  expect(second.ok).toBe(true); if (!second.ok) return
  expect(documentEffectBudgetUsage(second.project.sequences[0]).effects).toBe(4)
  let counter = 0
  const duplicate = duplicateProjectSequence(second.project, sequence.id, 'Copy', () => `duplicated-${++counter}`)
  expect(duplicate.failure).toBeNull()
  expect(sequenceProjectWithinEditBudget(duplicate.project)).toBe(true)
  const copy = duplicate.project.sequences.at(-1)!
  expect(copy.masterVideoEffects?.[0].id).not.toBe('master-copy')
  expect(copy.tracks[0].videoEffects?.[0].id).not.toBe('track-copy')
  expect(sequence.tracks[0].videoEffects ?? []).toEqual([])
})
test('locks, wrong stages, unknown presets and oversized render allocations reject atomically', () => {
  const { project, target, sequence } = make(), effects = [createColorAdjustEffect('safe'), createMaskEffect('source-only', 'rectangle')]
  const saved = JSON.stringify(project)
  expect(editVideoBus(project, target, { kind: 'apply', effects, mode: 'replace' }, () => 'copy').ok).toBe(false)
  expect(JSON.stringify(project)).toBe(saved)
  effects.pop(); sequence.tracks[0].locked = true
  expect(editVideoBus(project, target, { kind: 'apply', effects, mode: 'append' }, () => 'copy').ok).toBe(false)
  sequence.tracks[0].locked = false; sequence.width = 4096; sequence.height = 4096
  expect(editVideoBus(project, target, { kind: 'apply', effects, mode: 'append' }, () => 'copy').ok).toBe(false)
  expect(videoBusRenderBudgetError(3840, 2160)).toBeNull()
  const baseline = lensRemapSurfaceBudget(3840, 2160, 4096, 3200, false)
  expect(baseline.allowed).toBe(true)
  expect(lensRemapSurfaceBudget(3840, 2160, 4096, 3200, false, videoBusAdditionalBytes(3840, 2160)).allowed).toBe(false)
})
test('reset keeps unknown parameters, no-op stays identical, and preserved wrong-stage descriptors bypass', () => {
  const { project, target, sequence } = make(), effect = createColorAdjustEffect('existing')
  effect.params.exposure = 1; effect.params.future = 'keep'
  sequence.tracks[0].videoEffects = [effect]
  const reset = editVideoBus(project, target, { kind: 'reset', effectId: effect.id }, () => 'unused')
  expect(reset.ok).toBe(true); if (!reset.ok) return
  expect(reset.project.sequences[0].tracks[0].videoEffects?.[0].params.future).toBe('keep')
  const again = editVideoBus(reset.project, target, { kind: 'reset', effectId: effect.id }, () => 'unused')
  expect(again).toEqual({ ok: true, project: reset.project })
  const wrong = createMaskEffect('wrong', 'rectangle')
  const unknown = { ...effect, id: 'unknown', type: 'future.bus', version: 999 }
  const resolved = resolveVideoBusEffects([wrong, unknown], true)
  expect(resolved.pixelEffects).toEqual([])
  expect(resolved.effects.map((effect) => effect.status)).toEqual(['unsupported', 'unsupported'])
  expect(resolveVideoBusEffects([effect], false).effects[0].status).toBe('unsupported')
})
