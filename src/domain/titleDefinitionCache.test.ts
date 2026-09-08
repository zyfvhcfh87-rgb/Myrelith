import { describe, expect, test } from 'vitest'
import { freeze } from 'immer'
import { expandedTitleProject } from '../test/titleOwnerFixtures'
import { createTitleCompositionPlanner } from './titleComposition'
import { createColorAdjustEffect } from './effectStack'
import { titleEffectAnimationParameterSpec } from './titleEffectAnimation'
import { isImmutableTitleDefinition, readTitleDefinitionCached } from './titleDefinitionCache'
import type { TitleDefinition } from './titleElements'

describe('title cache admission', () => {
  test.each([false, true])('revalidates mutable nested elements with frozen outer envelope %s', (outerFrozen) => {
    const source = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const title = JSON.parse(JSON.stringify(source.title)) as { version: number; elements: { text: { fontSizePx: number } }[] }
    const clip = { ...source, title }
    if (outerFrozen) Object.freeze(title)
    const planner = createTitleCompositionPlanner(), color = createColorAdjustEffect('color')
    const fontSize = title.elements[0].text.fontSizePx
    expect(isImmutableTitleDefinition(title)).toBe(false)
    expect(titleEffectAnimationParameterSpec(clip, color, 'exposure')).not.toBeNull()
    expect(planner.plan(clip, 0).elements).toHaveLength(1)
    title.elements[0].text.fontSizePx = -1
    expect(titleEffectAnimationParameterSpec(clip, color, 'exposure')).toBeNull()
    expect(planner.plan(clip, 0).elements).toHaveLength(0)
    title.elements[0].text.fontSizePx = fontSize
    expect(titleEffectAnimationParameterSpec(clip, color, 'exposure')).not.toBeNull()
    expect(planner.plan(clip, 0).elements).toHaveLength(1)
    if (!outerFrozen) {
      title.version = 99
      expect(titleEffectAnimationParameterSpec(clip, color, 'exposure')).toBeNull()
      expect(planner.plan(clip, 0).elements).toHaveLength(0)
      title.version = 1
      expect(titleEffectAnimationParameterSpec(clip, color, 'exposure')).not.toBeNull()
      expect(planner.plan(clip, 0).elements).toHaveLength(1)
    }
  })
  test('reuses a deeply frozen definition and refuses accessor/cyclic cache proofs', () => {
    for (const value of [null, false, 'title', 9]) {
      expect(isImmutableTitleDefinition(value as unknown as TitleDefinition)).toBe(false)
      expect(readTitleDefinitionCached(value as unknown as TitleDefinition).status).toBe('invalid')
    }
    const title = freeze(expandedTitleProject().sequences[0].tracks[0].clips[0].title!, true)
    expect(isImmutableTitleDefinition(title)).toBe(true)
    expect(readTitleDefinitionCached(title)).toBe(readTitleDefinitionCached(title))
    const accessor = Object.freeze({ version: 1, get elements() { throw new Error('Do not execute') } })
    expect(isImmutableTitleDefinition(accessor)).toBe(false)
    expect(readTitleDefinitionCached(accessor).status).toBe('invalid')
    const cycle: { version: number; self?: unknown } = { version: 99 }
    cycle.self = cycle
    Object.freeze(cycle)
    expect(isImmutableTitleDefinition(cycle)).toBe(false)
  })
})
