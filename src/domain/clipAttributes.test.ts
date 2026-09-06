import { describe, expect, test } from 'vitest'
import {
  captureClipAttributes, pasteClipAttributes, resetClipAttributes,
  type AttributePasteOptions, type ClipAttributeTemplate,
} from './clipAttributes'
import { attributeProject, attributeClip } from '../test/clipAttributeFixtures'
import { sourceTicksAtTimelineOffset, sourceTimeRateFromPercent, sourceTimeSpeedRateFromPercent, defaultSourceTimeMap } from './sourceTimeMap'
import { createColorAdjustEffect } from './effectStack'
import { sequenceProjectFromTimeline, type SequenceProject } from './projectSequences'
import { documentAtAggregateEffectBudget } from '../test/effectBudgetFixtures'
import { defaultTextProps } from './textOverlay'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value).forEach(freeze)
  }
  return value
}
function copied(project = attributeProject(), effects?: readonly string[]): ClipAttributeTemplate {
  const result = captureClipAttributes(project.sequences[0].tracks[0].clips[0], 'video', ['transform', 'effects'], effects)
  if (!result.ok) throw new Error(result.reason)
  return result.template
}
function paste(project: SequenceProject, template = copied(project), options: Partial<AttributePasteOptions> = {}) {
  let id = 0
  return pasteClipAttributes(project, project.rootSequenceId, ['first', 'second'], template,
    { groups: ['transform', 'effects'], includeAnimation: true, effectsMode: 'append', ...options }, () => `new-${++id}`)
}

describe('atomic clip attribute edits', () => {
  test('copies ordered unknown intent/default omissions and remaps owned and orphan targets per destination', () => {
    const project = freeze(attributeProject())
    const template = freeze(copied(project))
    const result = paste(project, template)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [source, first, second] = result.project.sequences[0].tracks[0].clips
    expect(source).toBe(project.sequences[0].tracks[0].clips[0])
    expect(first.effects.map((e) => e.id)).toEqual(['new-1', 'new-2'])
    expect(second.effects.map((e) => e.id)).toEqual(['new-4', 'new-5'])
    expect(first.animation?.effectTracks?.map((t) => t.effectId)).toEqual(['new-1', 'new-2', 'new-3'])
    expect(first.effects[0].params).toEqual(source.effects[0].params)
    expect(first.effects[0].params).not.toBe(source.effects[0].params)
    expect(first.effects[1]).toMatchObject({ type: 'future.effect', version: 17, enabled: false, params: { intent: 'keep' } })
    expect(first.animation?.tracks[0].keyframes[1].frame).toBe(75)
    expect(first.timelineRange).toBe(project.sequences[0].tracks[0].clips[1].timelineRange)
    expect(first.sourceTimeMap).toBe(project.sequences[0].tracks[0].clips[1].sourceTimeMap)
  })

  test('selected stack retains source order and excludes unrelated orphan keys', () => {
    const project = attributeProject()
    const result = paste(project, copied(project, ['future', 'color']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clip = result.project.sequences[0].tracks[0].clips[1]
    expect(clip.effects.map((e) => e.type)).toEqual(['builtin.color-adjust', 'future.effect'])
    expect(clip.animation?.effectTracks).toHaveLength(2)
    expect(captureClipAttributes(project.sequences[0].tracks[0].clips[0], 'video', ['effects'], ['missing']).ok).toBe(false)
  })

  test('rebases source ticks through a trimmed destination and preserves out-of-range local keys', () => {
    const project = attributeProject()
    const clip = project.sequences[0].tracks[0].clips[1]
    clip.sourceTimeMap = { ...defaultSourceTimeMap(40, 120), rate: sourceTimeRateFromPercent(200) }
    const result = paste(project)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const changed = result.project.sequences[0].tracks[0].clips[1]
    for (const track of [...changed.animation!.tracks, ...changed.animation!.effectTracks!]) {
      for (const key of track.keyframes) expect(key.sourceTimeTicks)
        .toBe(sourceTicksAtTimelineOffset(clip.sourceTimeMap!, key.frame))
    }
  })

  test('an invalid destination map rejects every target without mutation', () => {
    const project = attributeProject()
    project.sequences[0].tracks[0].clips[2].sourceTimeMap!.sourceStartTicks = Number.MAX_SAFE_INTEGER
    freeze(project)
    expect(paste(project)).toMatchObject({ ok: false })
    expect(project.sequences[0].tracks[0].clips[1].effects).toEqual([])
  })

  test('reserves dormant effect identities and dangling animation targets', () => {
    const project = attributeProject()
    const dormant = structuredClone(project.sequences[0])
    dormant.id = 'dormant'
    dormant.tracks.forEach((track) => { track.id = `dormant-${track.id}`; track.clips = [] })
    dormant.tracks[0].clips = [attributeClip('dormant-clip')]
    project.sequences.push(dormant)
    dormant.tracks[0].clips[0].effects = [createColorAdjustEffect('new-1')]
    dormant.tracks[0].clips[0].animation!.effectTracks = [{
      effectId: 'new-2', parameter: 'exposure', keyframes: [{ frame: 0, value: 0, easing: { type: 'hold' } }],
    }]
    const result = paste(project)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.project.sequences[0].tracks[0].clips[1].effects[0].id).toBe('new-3')
    expect(pasteClipAttributes(project, project.rootSequenceId, ['first'], copied(project),
      { groups: ['effects'], includeAnimation: true, effectsMode: 'append' }, () => 'color'))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/identities/) })
  })

  test('freeze sections and shorter destinations retain exact local keys and canonical source intent', () => {
    const project = attributeProject()
    const target = project.sequences[0].tracks[0].clips[1]
    target.timelineRange.durationFrames = 20
    target.sourceTimeMap = { ...defaultSourceTimeMap(40, 120), speedCurve: {
      originFrame: 0, points: [
        { frame: 0, rate: sourceTimeSpeedRateFromPercent(0), easing: 'hold' },
        { frame: 10, rate: sourceTimeSpeedRateFromPercent(100), easing: 'hold' },
      ],
    } }
    const result = paste(project)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const changed = result.project.sequences[0].tracks[0].clips[1]
    expect(changed.animation?.tracks[0].keyframes.map((key) => key.frame)).toEqual([0, 75])
    expect(changed.animation?.effectTracks?.[0].keyframes[0].sourceTimeTicks).toBe(40_000_000)
    expect(changed.animation?.tracks[0].keyframes[1].sourceTimeTicks).toBe(105_000_000)
  })

  test('replace removes previous effect keys; excluding animation clears chosen properties only', () => {
    const project = attributeProject()
    const clip = project.sequences[0].tracks[0].clips[1]
    clip.effects = [createColorAdjustEffect('old')]
    clip.animation = { tracks: [
      { property: 'position-x', keyframes: [{ frame: 0, value: 7, easing: { type: 'hold' } }] },
      { property: 'opacity', keyframes: [{ frame: 0, value: 0.5, easing: { type: 'hold' } }] },
    ], effectTracks: [{ effectId: 'old', parameter: 'exposure', keyframes: [{ frame: 0, value: 1, easing: { type: 'hold' } }] }] }
    const result = paste(project, copied(project), { effectsMode: 'replace', includeAnimation: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const changed = result.project.sequences[0].tracks[0].clips[1]
    expect(changed.effects).toHaveLength(2)
    expect(changed.animation?.tracks.map((t) => t.property)).toEqual(['opacity'])
    expect(changed.animation?.effectTracks).toEqual([])
  })

  test('lock, missing/duplicate targets, kind mismatch and text animation reject the batch', () => {
    for (const scenario of ['locked', 'missing', 'duplicate', 'audio', 'text']) {
      const project = attributeProject()
      const doc = project.sequences[0]
      if (scenario === 'locked') doc.tracks[0].locked = true
      if (scenario === 'audio') doc.tracks[0].kind = 'audio'
      if (scenario === 'text') doc.tracks[0].clips[2].text = defaultTextProps(doc.width, doc.height, 'Test')
      const ids = scenario === 'missing' ? ['first', 'missing'] : scenario === 'duplicate' ? ['first', 'first'] : ['first', 'second']
      let nextId = 0
      const result = pasteClipAttributes(freeze(project), doc.id, ids, copied(project),
        { groups: ['transform', 'effects'], includeAnimation: true, effectsMode: 'append' }, () => `fresh-${++nextId}`)
      expect(result.ok, scenario).toBe(false)
    }
  })

  test.each(['effects', 'params', 'stringCharacters'] as const)('rejects aggregate %s growth and permits reducing replacement', (budget) => {
    const doc = documentAtAggregateEffectBudget(budget)
    const template = copied()
    const project = sequenceProjectFromTimeline(doc)
    const id = doc.tracks[0].clips[0].id
    let next = 0
    const options = { groups: ['effects'] as const, includeAnimation: false, effectsMode: 'append' as const }
    expect(pasteClipAttributes(project, doc.id, [id], template, options, () => `fresh-${++next}`).ok).toBe(false)
    expect(pasteClipAttributes(project, doc.id, [id], template, { ...options, effectsMode: 'replace' }, () => `fresh-${++next}`).ok).toBe(true)
  })

  test('reset is atomic, preserves unknown keys, removes only reset effect animation and becomes idempotent', () => {
    const project = attributeProject()
    const source = project.sequences[0].tracks[0].clips[0]
    source.effects[0].params.unknown = 'preserve'
    expect(resetClipAttributes(project, project.rootSequenceId, ['source'], ['effects']).ok).toBe(false)
    const result = resetClipAttributes(project, project.rootSequenceId, ['source'], ['effects'], ['color'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clip = result.project.sequences[0].tracks[0].clips[0]
    expect(clip.effects[0].params).toMatchObject({ exposure: 0, unknown: 'preserve' })
    expect(clip.animation?.effectTracks?.map((t) => t.effectId)).toEqual(['future', 'orphan'])
    expect(resetClipAttributes(result.project, project.rootSequenceId, ['source'], ['effects'], ['color']))
      .toEqual({ ok: true, project: result.project })
  })

  test('audio settings reject fades longer than the destination instead of clamping', () => {
    const project = attributeProject()
    const doc = project.sequences[0]
    const source = attributeClip('audio-source')
    source.audio!.fadeInFrames = 60
    doc.tracks[4].clips = [source, { ...attributeClip('audio-target', 100), timelineRange: { startFrame: 100, durationFrames: 30 } }]
    const result = captureClipAttributes(source, 'audio')
    if (!result.ok) throw new Error(result.reason)
    expect(pasteClipAttributes(project, doc.id, ['audio-target'], result.template,
      { groups: ['audio-settings'], includeAnimation: true, effectsMode: 'append' }, () => 'id').ok).toBe(false)
  })
})
