import { describe, expect, test } from 'vitest'
import { expandedTitleProject } from '../test/titleOwnerFixtures'
import { builtInTitleTemplates, captureTitleTemplate, instantiateTitleTemplate, mutateTitleTemplateLibrary, readTitleTemplateLibrary, titleTemplateFromLibrary, readTitleTemplate, titleTemplateConversion } from './titleTemplates'
import { readTitleElement } from './titleElements'
const target = { sequenceId: 'root', clipId: 'root-text' }
const capture = () => captureTitleTemplate(expandedTitleProject(), target, 'saved', 'Saved title')
describe('title templates', () => {
  test('all three builtins instantiate independent copies without media or clip effects', () => {
    let project = expandedTitleProject(), id = 0
    for (const template of builtInTitleTemplates()) project = instantiateTitleTemplate(project, 'root', project.sequences[0].tracks[0].id, 200 + id * 200, template, () => `fresh-${++id}`)
    const clips = project.sequences[0].tracks[0].clips
    expect(clips).toHaveLength(4)
    expect(new Set(clips.flatMap((clip) => clip.title?.version === 1 ? (clip.title.elements as { id: string }[]).map((e) => e.id) : [])).size).toBe(6)
    expect(clips.slice(1).every((clip) => clip.text === undefined && clip.effects.length === 0 && clip.sourceRange.startFrame === 0)).toBe(true)
  })
  test('capture carries editable lanes; fit scales geometry and keys with exact unchanged timing', () => {
    const template = { ...capture(), titleTracks: [{ elementId: 'root-element', property: 'position-x', propertyVersion: 1, keyframes: [{ frame: 5, sourceTimeTicks: 5000000, value: 200, easing: { type: 'linear' as const } }] }] }
    // Use the actual procedural tick constant through source intent normalization in the fixture.
    delete (template.titleTracks[0].keyframes[0] as { sourceTimeTicks?: number }).sourceTimeTicks
    let project = expandedTitleProject(), id = 0
    project = { ...project, sequences: project.sequences.map((sequence) => ({ ...sequence, width: sequence.width / 2, height: sequence.height / 2, frameRate: { num: 24, den: 1 } })) }
    const conversion = titleTemplateConversion(template, project.sequences[0])
    expect(conversion).toMatchObject({ factor: .5, converted: true, rateChanged: true })
    const next = instantiateTitleTemplate(project, 'root', project.sequences[0].tracks[0].id, 200, template, () => `new-${++id}`)
    const clip = next.sequences[0].tracks[0].clips[1]
    expect(clip.timelineRange.durationFrames).toBe(template.durationFrames)
    expect(clip.animation!.titleTracks![0].keyframes[0]).toMatchObject({ frame: 5, value: 100 })
    const parsed = readTitleElement((clip.title!.elements as unknown[])[0]), before = readTitleElement(template.title.elements[0])
    if (parsed.status !== 'supported' || before.status !== 'supported' || parsed.element.kind !== 'text' || before.element.kind !== 'text') throw new Error('Expected text')
    expect(parsed.element.text.fontSizePx).toBe(before.element.text.fontSizePx / 2)
    expect(template.titleTracks[0].keyframes[0].value).toBe(200)
  })
  test('rejects overlap, locked target, and out-of-range conversion without changing the project', () => {
    const project = expandedTitleProject(), template = capture(); let id = 0
    expect(() => instantiateTitleTemplate(project, 'root', project.sequences[0].tracks[0].id, 0, template, () => `id-${++id}`)).toThrow(/cannot fit/)
    expect(() => instantiateTitleTemplate(project, 'root', 'missing', 0, template, () => `id-${++id}`)).toThrow(/unlocked video/)
    const huge = { ...project, sequences: project.sequences.map((sequence) => ({ ...sequence, width: 65535, height: 65535 })) }
    expect(() => instantiateTitleTemplate(huge, 'root', project.sequences[0].tracks[0].id, 200, template, () => `id-${++id}`)).toThrow(/conversion/)
  })
  test('unknown records survive every storage mutation; future envelope is read-only', () => {
    const unknown = { version: 7, id: 'future', name: 'Future', inert: ['retained', 42] }
    const raw = JSON.stringify({ version: 1, templates: [unknown] })
    const saved = mutateTitleTemplateLibrary(raw, { kind: 'save', template: capture() })
    expect(readTitleTemplateLibrary(saved).view).toMatchObject({ templates: [{ id: 'saved' }], unavailable: [{ index: 0 }] })
    expect(titleTemplateFromLibrary(saved, 'saved').title).toEqual(capture().title)
    expect(JSON.parse(mutateTitleTemplateLibrary(saved, { kind: 'delete', id: 'saved' })).templates).toEqual([unknown])
    const future = JSON.stringify({ version: 2, templates: [capture()] })
    expect(readTitleTemplateLibrary(future).view.readOnlyReason).toMatch(/read-only/)
    expect(() => mutateTitleTemplateLibrary(future, { kind: 'save', template: capture() })).toThrow(/read-only/)
  })
  test.each([false, true])('read/delete bind to the supported record with a same-ID future sibling, future-first=%s', (futureFirst) => {
    const template = capture(), future = { version: 8, id: template.id, name: 'Future duplicate ID', future: ['untouched', 73] }
    const raw = JSON.stringify({ version: 1, templates: futureFirst ? [future, template] : [template, future] })
    expect(readTitleTemplateLibrary(raw).view.templates.map((entry) => entry.id)).toEqual([template.id])
    expect(titleTemplateFromLibrary(raw, template.id)).toEqual(template)
    const after = mutateTitleTemplateLibrary(raw, { kind: 'delete', id: template.id })
    expect(after).toBe(JSON.stringify({ version: 1, templates: [future] }))
    expect(() => titleTemplateFromLibrary(after, template.id)).toThrow(/unavailable/)
  })
  test.each([false, true])('lookup/delete use the displayed record after duplicate-name validation, rejected-first=%s', (rejectedFirst) => {
    const base = capture(), first = { ...base, id: 'first', name: 'Duplicate name' }
    const rejected = { ...base, id: 'chosen', name: 'DUPLICATE NAME' }, chosen = { ...base, id: 'chosen', name: 'Valid chosen' }
    const entries = rejectedFirst ? [first, rejected, chosen] : [first, chosen, rejected]
    const raw = JSON.stringify({ version: 1, templates: entries })
    expect(readTitleTemplateLibrary(raw).view.templates.map((template) => template.name)).toEqual(['Duplicate name', 'Valid chosen'])
    expect(titleTemplateFromLibrary(raw, 'chosen')).toEqual(chosen)
    expect(mutateTitleTemplateLibrary(raw, { kind: 'delete', id: 'chosen' })).toBe(JSON.stringify({ version: 1, templates: [first, rejected] }))
  })
  test('bounds raw siblings, duplicate names, corruption, accessors and execution-bearing extra fields', () => {
    const template = capture()
    const raw = JSON.stringify({ version: 1, templates: Array.from({ length: 100 }, (_, i) => ({ version: 9, id: String(i) })) })
    expect(() => mutateTitleTemplateLibrary(raw, { kind: 'save', template })).toThrow(/100/)
    const saved = mutateTitleTemplateLibrary(undefined, { kind: 'save', template })
    expect(() => mutateTitleTemplateLibrary(saved, { kind: 'save', template: { ...template, id: 'different' } })).toThrow(/already uses/)
    expect(readTitleTemplateLibrary('{broken').view.readOnlyReason).toMatch(/corrupt/)
    expect(readTitleTemplateLibrary('x'.repeat(8 * 1024 * 1024 + 1)).view.readOnlyReason).toMatch(/8 MiB/)
    expect(() => readTitleTemplate({ ...template, script: 'inert but forbidden' })).toThrow(/envelope/)
    let invoked = false
    expect(() => readTitleTemplate({ ...template, get title() { invoked = true; return template.title } })).toThrow()
    expect(invoked).toBe(false)
  })
})
