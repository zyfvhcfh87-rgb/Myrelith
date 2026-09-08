import { describe, expect, test } from 'vitest'
import { createTitleCompositionPlanner, titleCompositionError } from './titleComposition'
import { createVideoCompositionPlanner, videoCompositionRequests } from './videoCompositionPlan'
import { expandedTitleProject, replaceFirstTitleClip } from '../test/titleOwnerFixtures'
import { readTitleDefinition, type TitleElementIntent } from './titleElements'
import { scalarKey } from '../test/animationFoundationFixtures'
import { projectTitleExportError } from './titleExport'
import { defaultSourceTimeMap } from './sourceTimeMap'
import { createProjectVideoCompositionPlanner } from './projectVideoCompositionPlan'
import { createMaskEffect } from './effectStack'
import type { Clip } from './schema'

function withElements(clip: Clip, patch: (elements: readonly TitleElementIntent[]) => readonly TitleElementIntent[]): Clip {
  const parsed = readTitleDefinition(clip.title)
  if (parsed.status !== 'supported') throw new Error('Expected supported title fixture')
  return { ...clip, title: { version: 1, elements: patch(parsed.title.elements) } }
}

describe('canonical title composition planning', () => {
  test('counts repeated nested title elements before any rendering work', () => {
    const project = expandedTitleProject(), root = project.sequences[0], child = project.sequences[1]
    const source = root.tracks[0].clips[0]
    child.tracks[0].clips = [withElements(source, (elements) => Array.from({ length: 16 }, (_, index) => ({ ...elements[0], id: `element-${index}` })))]
    root.tracks = Array.from({ length: 257 }, (_, index) => ({ ...root.tracks[0], id: `track-${index}`, clips: [], sequenceInstances: [
      { kind: 'sequence', id: `instance-${index}`, name: 'Repeated title', sequenceId: child.id, sourceStartFrame: 0, timelineRange: { startFrame: index === 256 ? 50 : 0, durationFrames: 50 } },
    ] }))
    const planner = createProjectVideoCompositionPlanner(project, root.id, new Map())
    expect(planner.planFrame(0).items.filter((item) => item.kind === 'title')).toHaveLength(256)
    const overlapping = { ...project, sequences: [{ ...root, tracks: root.tracks.map((track) => ({ ...track,
      sequenceInstances: track.sequenceInstances!.map((instance) => ({ ...instance, timelineRange: { startFrame: 0, durationFrames: 50 } })),
    })) }, child] }
    expect(() => createProjectVideoCompositionPlanner(overlapping, root.id, new Map()).planFrame(0)).toThrow(/4,096/)
  })
  test('unavailable title, ordinary and effect lanes stay visible as export blockers while disabled elements remain inert', () => {
    const source = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const planner = createTitleCompositionPlanner()
    for (const animation of [
      { tracks: [], titleTracks: [{ elementId: 'missing', property: 'opacity', propertyVersion: 1, keyframes: [scalarKey(0, 0.5)] }] },
      { tracks: [{ property: 'future-opacity', propertyVersion: 99, keyframes: [scalarKey(0, 0.5)] }] },
      { tracks: [], effectTracks: [{ effectId: 'mask', parameter: 'x', keyframes: [scalarKey(0, 0.5)] }] },
    ]) expect(titleCompositionError(planner.plan({ ...source, effects: [createMaskEffect('mask', 'rectangle')], animation }, 0))).not.toBeNull()
    const disabled = withElements(source, (elements) => elements.map((element) => ({ ...element, enabled: false })))
    expect(titleCompositionError(planner.plan({ ...disabled, animation: { tracks: [], titleTracks: [
      { elementId: 'root-element', property: 'future', propertyVersion: 99, keyframes: [scalarKey(0, 0.5)] },
    ] } }, 0))).toBeNull()
  })
  test('emits a resource-free title at exact frames with shared scalar evaluation and arbitrary seeks', () => {
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, opacity: 0.5, animation: { ...clip.animation!, titleTracks: [
      { elementId: 'root-element', propertyVersion: 1, property: 'position-x', keyframes: [scalarKey(0, 0), scalarKey(10, 100)] },
    ] } }))
    const original = JSON.stringify(project)
    const planner = createVideoCompositionPlanner(project.sequences[0], new Map())
    const sequential = new Map(Array.from({ length: 16 }, (_, frame) => [frame, planner.planFrame(frame)]))
    for (const frame of [15, 2, 0, 10, 5, 1, 9]) expect(planner.planFrame(frame)).toEqual(sequential.get(frame))
    const plan = planner.planFrame(5), item = plan.items[0]
    expect(item.kind).toBe('title')
    if (item.kind !== 'title') return
    expect(item.title.elements[0].element.transform.x).toBe(50)
    expect(item.opacity).toBe(0.5)
    expect(item.title.notices[0]).toMatchObject({ kind: 'notice', detail: expect.stringContaining('platform') })
    expect(titleCompositionError(item.title)).toBeNull()
    expect(videoCompositionRequests(plan)).toEqual([])
    expect(JSON.stringify(project)).toBe(original)
  })

  test('preserves ordering and disables opaque elements without interpreting their payload', () => {
    const source = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const clip = withElements(source, (elements) => [
      { id: 'disabled', name: 'Future off', version: 9, kind: 'future', enabled: false, payload: { nested: 'inert' } },
      elements[0],
      { id: 'unknown', name: 'Future on', version: 9, kind: 'future', enabled: true, payload: { nested: 'inert' } },
      { id: 'rectangle', name: 'Card', version: 1, kind: 'rectangle', enabled: true, opacity: 0.5,
        transform: source.transform, visual: source.visual!, shape: { boxWidthPx: 100, boxHeightPx: 80, fillColor: '#112233', outlineEnabled: true, outlineWidthPx: 2, outlineColor: '#ffffff' } },
    ])
    const result = createTitleCompositionPlanner().plan(clip, 5)
    expect(result.elements.map((paint) => paint.element.id)).toEqual(['root-element', 'rectangle'])
    expect(result.notices.filter((notice) => notice.kind === 'unavailable')).toEqual([expect.objectContaining({ elementId: 'unknown', name: 'Future on' })])
    expect(titleCompositionError(result)).toMatch(/Future on/)
    expect(titleCompositionError(createTitleCompositionPlanner().plan({ ...source, title: { version: 99, unknown: ['intent'] } }, 0))).toMatch(/version/i)
  })

  test('requires an explicit generic fallback and never rewrites named font intent', () => {
    const source = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const named = withElements(source, (elements) => elements.map((element) => ({ ...element, font: { family: 'Unknown Named Font', fallbackFamily: null } })))
    const planner = createTitleCompositionPlanner()
    expect(planner.plan(named, 0).elements).toEqual([])
    expect(titleCompositionError(planner.plan(named, 0))).toMatch(/explicit fallback/)
    const fallback = withElements(named, (elements) => elements.map((element) => ({ ...element, font: { family: 'Unknown Named Font', fallbackFamily: 'serif' } })))
    const result = planner.plan(fallback, 0)
    expect(result.elements[0]).toMatchObject({ kind: 'text', text: { fontFamily: 'serif' }, element: { font: { family: 'Unknown Named Font' } } })
    expect(titleCompositionError(result)).toBeNull()
    expect(result.notices[0].detail).toContain('explicit serif fallback')
    expect(planner.plan(named, 0).elements).toEqual([])
  })

  test('invalid definitions cannot reach paint and unknown animation stays inactive with a notice', () => {
    const source = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const invalid = { ...source, title: { version: 1, elements: Array(17).fill({ version: 99 }) } }
    const planner = createTitleCompositionPlanner()
    expect(planner.plan(invalid, 0).elements).toEqual([])
    expect(titleCompositionError(planner.plan(invalid, 0))).not.toBeNull()
    const unknown = { ...source, animation: { ...source.animation!, titleTracks: [
      { elementId: 'root-element', propertyVersion: 99, property: 'position-x', keyframes: [scalarKey(0, 999)] },
    ] } }
    const result = planner.plan(unknown, 0)
    expect(result.elements[0].element.transform.x).toBe(0)
    expect(result.notices.some((notice) => notice.kind === 'unavailable' && notice.detail.includes('version'))).toBe(true)
    expect(titleCompositionError(result)).not.toBeNull()
  })
})

describe('title export preflight', () => {
  test('ignores unavailable owners whose supported opacity is zero for every consumed integer frame', () => {
    const project = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, title: { version: 99 }, animation: { tracks: [
      { property: 'opacity', keyframes: [scalarKey(0, 0), scalarKey(99, 0)] },
    ] } }))
    expect(projectTitleExportError(project, 'root')).toBeNull()
    const pulse = replaceFirstTitleClip(project, (clip) => ({ ...clip, animation: { tracks: [
      { property: 'opacity', keyframes: [scalarKey(0, 0), scalarKey(50, 1), scalarKey(99, 0)] },
    ] } }))
    expect(projectTitleExportError(pulse, 'root')).not.toBeNull()
  })
  test('blocks enabled unsupported root content while ignoring disabled elements and hidden tracks', () => {
    const bad = replaceFirstTitleClip(expandedTitleProject(), (clip) => ({ ...clip, title: { version: 9 } }))
    expect(projectTitleExportError(bad, 'root')).not.toBeNull()
    expect(projectTitleExportError(bad, 'dormant')).toBeNull()
    const hidden = { ...bad, sequences: bad.sequences.map((sequence) => ({ ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, hidden: true })) })) }
    expect(projectTitleExportError(hidden, 'root')).toBeNull()
    const disabled = replaceFirstTitleClip(expandedTitleProject(), (clip) => withElements(clip, () => [
      { id: 'future', version: 9, kind: 'future', name: 'Disabled', enabled: false },
    ]))
    expect(projectTitleExportError(disabled, 'root')).toBeNull()
  })

  test('checks exact consumed child ranges and retains gaps between repeated nested instances', () => {
    const project = expandedTitleProject()
    const root = project.sequences[0], child = project.sequences[1]
    const title = { ...root.tracks[0].clips[0], title: { version: 9 }, sourceRange: { startFrame: 0, durationFrames: 10 }, sourceTimeMap: defaultSourceTimeMap(0, 10), timelineRange: { startFrame: 50, durationFrames: 10 } }
    child.tracks[0].clips = [title]
    root.tracks[0].clips = []
    root.tracks[0].sequenceInstances = [
      { kind: 'sequence', id: 'early', name: 'Early', sequenceId: child.id, sourceStartFrame: 0, timelineRange: { startFrame: 0, durationFrames: 40 } },
      { kind: 'sequence', id: 'late', name: 'Late', sequenceId: child.id, sourceStartFrame: 70, timelineRange: { startFrame: 40, durationFrames: 40 } },
    ]
    expect(projectTitleExportError(project, 'root')).toBeNull()
    root.tracks[0].sequenceInstances[1].sourceStartFrame = 45
    expect(projectTitleExportError(project, 'root')).not.toBeNull()
  })
})
