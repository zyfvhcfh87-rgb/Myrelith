import { describe, expect, test } from 'vitest'
import { attributeClip } from '../test/clipAttributeFixtures'
import { expandedTitleProject } from '../test/titleOwnerFixtures'
import { createAdjustmentItem } from './adjustmentItems'
import { COLOR_LUT_LIMITS } from './colorLut'
import { COLOR_CURVES_TYPE, DEFAULT_COLOR_CURVES } from './colorCurves'
import { createMaskEffect, DEFAULT_MASK_BEZIER_PATH } from './effectStack'
import { peakPixelStackWork } from './pixelWorkBudget'
import { createPluginVideoEffectContributionSnapshot } from './pluginVideoEffectStagePlan'
import { createProjectVideoCompositionPlanner } from './projectVideoCompositionPlan'
import { sequenceProjectFromTimeline } from './projectSequences'
import { spatialEffectScratchBytes } from './spatialEffectPixels'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import { MAX_RENDER_AGGREGATE_SURFACE_BYTES, lensRemapSurfaceBudget, renderSurfaceBudget, renderWorkSurfaceBudget } from './renderSurfaceBudget'
import type { EffectDescriptor } from './schema'
import { videoCompositionPlanAtFrame } from './videoCompositionPlan'
import { documentPixelWorkBudget, videoPixelWorkBudget } from './videoPixelWorkBudget'

const UHD = { surfaceWidth: 3840, surfaceHeight: 2160, projectWidth: 3840, projectHeight: 2160 }
const PIXELS = 3840 * 2160
const BOUNDS = new Map([['asset', { video: { status: 'exact' as const, firstTimestampUs: 0, endTimestampUs: 10_000_000 }, audio: null }]])
const CURVE: EffectDescriptor = { id: 'curve', type: COLOR_CURVES_TYPE, version: 1, enabled: true,
  params: { ...DEFAULT_COLOR_CURVES, master: '[[0,0],[1,0.8]]', strength: 1 } }
function fixture() {
  const doc = structuredClone(createTimelineDoc('Pixel work', DEFAULT_PROJECT_SETTINGS, 'work'))
  doc.width = 3840; doc.height = 2160
  const clip = attributeClip('mask-source'), mask = createMaskEffect('mask', 'bezier')
  mask.params = { ...mask.params, x: 0, y: 0, width: 1, height: 1, feather: 0.05 }
  clip.effects = [mask]; doc.tracks[0].clips = [clip]
  return { doc, clip, mask }
}

describe('shared frame and document pixel admission', () => {
  test.each([
    ['box-blur', 'radius', 0, 32, {}], ['outline', 'width', 0, 32, {}],
    ['drop-shadow', 'opacity', 0, 1, {}], ['sharpen', 'amount', 0, 2, {}],
    ['vignette', 'strength', 0, 1, {}], ['outline', 'width', 1, 32, {}],
    ['drop-shadow', 'radius', 1, 32, { opacity: 1 }],
    ['drop-shadow', 'offsetY', 1, -64, { opacity: 1 }],
  ] as const)('reserves animated %s %s growth for clips, expanded titles and adjustments', (kind, parameter, start, end, other) => {
    for (const owner of ['clip', 'title', 'adjustment']) {
      const doc = owner === 'title' ? expandedTitleProject().sequences[0] : fixture().doc
      doc.width = 3840; doc.height = 2160
      const effect = { id: 'animated', type: `builtin.${kind}`, version: 1, enabled: true, params: { ...other, [parameter]: start } }
      const animation = { tracks: [], effectTracks: [{ effectId: effect.id, parameter, keyframes: [
        { frame: 0, sourceTimeTicks: 0, value: start, easing: { type: 'linear' as const } },
        { frame: 30, sourceTimeTicks: 30_000_000, value: end, easing: { type: 'linear' as const } },
      ] }] }
      if (owner === 'adjustment') {
        const adjustment = createAdjustmentItem(0, 60)
        adjustment.effects = [effect]; adjustment.animation = { tracks: [], effectTracks: animation.effectTracks.map((track) => ({
          ...track, keyframes: track.keyframes.map(({ frame, value, easing }) => ({ frame, value, easing })),
        })) }
        doc.tracks[0].clips = []; doc.tracks[0].adjustments = [adjustment]
      } else {
        doc.tracks[0].clips[0].effects = [effect]; doc.tracks[0].clips[0].animation = animation
      }
      const before = JSON.stringify(doc)
      const actual = videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 30, BOUNDS), UHD)
      expect(actual.peakAdditionalBytes, owner).toBeGreaterThanOrEqual(PIXELS * 4)
      expect(documentPixelWorkBudget(doc, UHD).peakAdditionalBytes, owner).toBeGreaterThanOrEqual(actual.peakAdditionalBytes)
      expect(JSON.stringify(doc)).toBe(before)
    }
  })
  test('closes the real 4K plain-mask/lens gap and preserves source-size-aware allowed cases', () => {
    const { doc } = fixture(), before = JSON.stringify(doc)
    const work = videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD)
    expect(work.peakAdditionalBytes).toBe(PIXELS * 9)
    expect(lensRemapSurfaceBudget(3840, 2160, 3840, 2160, false, work.peakAdditionalBytes))
      .toMatchObject({ allowed: false, aggregateBytes: 273_715_200 })
    expect(renderWorkSurfaceBudget(3840, 2160, { additionalOwnedBytes: work.peakAdditionalBytes }))
      .toMatchObject({ allowed: true, aggregateBytes: 207_360_000 })
    expect(lensRemapSurfaceBudget(3840, 2160, 1920, 1080, false, work.peakAdditionalBytes))
      .toMatchObject({ allowed: true, aggregateBytes: 223_948_800 })
    expect(JSON.stringify(doc)).toBe(before)
  })
  test('small clipped masks with a 4K source stay admitted at full preview resolution', () => {
    const { doc, mask } = fixture()
    mask.params.width = 0.25; mask.params.height = 0.25
    const work = videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD)
    expect(work.maskInsideBytes).toBe(PIXELS / 16)
    expect(lensRemapSurfaceBudget(3840, 2160, 3840, 2160, false, work.peakAdditionalBytes).allowed).toBe(true)
  })
  test.each([false, true])('the inclusive aggregate cap is exact with export readback=%s', (includeExportReadback) => {
    const base = renderWorkSurfaceBudget(3840, 2160, { additionalOwnedBytes: 0, lensReusableBytes: PIXELS * 8, includeExportReadback })
    const remaining = MAX_RENDER_AGGREGATE_SURFACE_BYTES - base.aggregateBytes
    expect(renderWorkSurfaceBudget(3840, 2160, { additionalOwnedBytes: remaining, lensReusableBytes: PIXELS * 8, includeExportReadback }).allowed).toBe(true)
    expect(renderWorkSurfaceBudget(3840, 2160, { additionalOwnedBytes: remaining + 1, lensReusableBytes: PIXELS * 8, includeExportReadback }).allowed).toBe(false)
  })
  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])('unsafe extra/retained bytes %s cannot pass admission', (bytes) => {
    expect(renderWorkSurfaceBudget(1, 1, { additionalOwnedBytes: bytes }).allowed).toBe(false)
    expect(renderWorkSurfaceBudget(1, 1, { additionalOwnedBytes: 0, lensReusableBytes: bytes }).allowed).toBe(false)
  })
  test('actual flattened child masks enter the root frame budget', () => {
    const { doc: child } = fixture(); child.id = 'child'
    const root = structuredClone(child); root.id = 'root'; root.tracks[0].clips = []
    root.tracks.forEach((track, index) => { track.id = `root-${index}` })
    root.tracks[0].sequenceInstances = [{ kind: 'sequence', id: 'instance', name: 'Child', sequenceId: child.id,
      sourceStartFrame: 0, timelineRange: { startFrame: 0, durationFrames: 60 } }]
    const project = sequenceProjectFromTimeline(root); project.sequences.push(child)
    const plan = createProjectVideoCompositionPlanner(project, root.id, BOUNDS).planFrame(0)
    expect(plan.items.some((item) => item.kind === 'clip' && item.request.clip.id === 'mask-source')).toBe(true)
    expect(videoPixelWorkBudget(plan, UHD).peakAdditionalBytes).toBe(PIXELS * 9)
  })
  test('document reservation includes future held paths while frame admission uses the current value', () => {
    const { doc, clip, mask } = fixture()
    const small = 'M 0 0 C 0 0 0.25 0 0.25 0 C 0.25 0 0.25 0.25 0.25 0.25 C 0.25 0.25 0 0.25 0 0.25 C 0 0.25 0 0 0 0 Z'
    mask.params.path = small
    clip.animation!.effectPathTracks = [{ effectId: mask.id, parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1,
      keyframes: [{ frame: 0, sourceTimeTicks: 0, value: small, easing: { type: 'hold' } },
        { frame: 30, sourceTimeTicks: 30_000_000, value: DEFAULT_MASK_BEZIER_PATH, easing: { type: 'hold' } }] }]
    const before = JSON.stringify(doc)
    expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD).maskInsideBytes).toBe(PIXELS / 16)
    expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 30, BOUNDS), UHD).maskInsideBytes).toBe(PIXELS)
    expect(documentPixelWorkBudget(doc, UHD).maskInsideBytes).toBe(PIXELS)
    expect(JSON.stringify(doc)).toBe(before)
  })
  test('document geometry animation reserves growth before the playhead reaches it', () => {
    const { doc, clip, mask } = fixture(); mask.params.width = 0.1
    clip.animation!.effectTracks = [{ effectId: mask.id, parameter: 'width', keyframes: [
      { frame: 0, sourceTimeTicks: 0, value: 0.1, easing: { type: 'linear' } },
      { frame: 30, sourceTimeTicks: 30_000_000, value: 1, easing: { type: 'linear' } },
    ] }]
    expect(documentPixelWorkBudget(doc, UHD).maskInsideBytes).toBe(PIXELS)
    expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD).maskInsideBytes).toBeLessThan(PIXELS)
  })
  test('grading uses isolated built-ins and retains one cache across separate clip stacks', () => {
    const { doc } = fixture()
    const other = attributeClip('grading'); other.effects = [CURVE]
    doc.tracks[1].clips = [other]
    expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD).peakAdditionalBytes)
      .toBe(PIXELS * 9 + COLOR_LUT_LIMITS.runtimeBytes)
    const { doc: plain } = fixture(), gradeOnly = structuredClone(plain)
    gradeOnly.tracks[0].clips[0].effects = [CURVE]
    expect(peakPixelStackWork([documentPixelWorkBudget(plain, UHD), documentPixelWorkBudget(gradeOnly, UHD)]).peakAdditionalBytes)
      .toBe(PIXELS * 9 + COLOR_LUT_LIMITS.runtimeBytes)
  })
  test('grading in a sibling stack does not shorten the shared mask-then-spatial lifetime', () => {
    const { doc, clip } = fixture()
    const outline = { id: 'outline', type: 'builtin.outline', version: 1, enabled: true,
      params: { width: 32, opacity: 1, color: '#000000' } }
    clip.effects.push(outline)
    const other = attributeClip('grading'); other.effects = [CURVE]; doc.tracks[1].clips = [other]
    const scratch = spatialEffectScratchBytes({ kind: 'outline', params: outline.params }, UHD)
    expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD).peakAdditionalBytes)
      .toBe(PIXELS * 9 + scratch + COLOR_LUT_LIMITS.runtimeBytes)
    clip.effects.push(CURVE); doc.tracks[1].clips = []
    expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD).peakAdditionalBytes)
      .toBe(PIXELS * 9 + COLOR_LUT_LIMITS.runtimeBytes)
  })
  test('ready plugin stages use the transactional peak and finite export adds its distinct readback', () => {
    const { doc, clip } = fixture()
    clip.effects.push({ id: 'plugin', type: 'plugin:com.example.fixture/fixture', version: 1, enabled: true, params: {} })
    const contributions = createPluginVideoEffectContributionSnapshot(1, [{ signerFingerprint: `sha256:${'1'.repeat(64)}`,
      packageDigest: `sha256:${'2'.repeat(64)}`, pluginId: 'com.example.fixture', pluginVersion: '1.0.0',
      kind: 'video-effect', contributionVersion: 1, contributionId: 'fixture', contributionName: 'Fixture',
      descriptorVersion: 1, entrypoint: 'fixture', parameters: [], availability: 'ready', detail: 'Ready.' }])
    const work = videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS, contributions), UHD)
    expect(work.peakAdditionalBytes).toBe(PIXELS * 16)
    expect(renderWorkSurfaceBudget(3840, 2160, { additionalOwnedBytes: work.peakAdditionalBytes }).allowed).toBe(true)
    expect(renderWorkSurfaceBudget(3840, 2160, { additionalOwnedBytes: work.peakAdditionalBytes, includeExportReadback: true }).allowed).toBe(false)
    expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD).peakAdditionalBytes).toBe(PIXELS * 9)
  })
  test('disabled, invalid and future masks keep their descriptors and allocate no mask work', () => {
    for (const patch of [{ enabled: false }, { version: 99 }, { params: { shape: 'bezier', width: 'invalid' } }]) {
      const { doc, clip, mask } = fixture(); clip.effects = [{ ...mask, ...patch }]
      const before = JSON.stringify(doc)
      expect(videoPixelWorkBudget(videoCompositionPlanAtFrame(doc, 0, BOUNDS), UHD).peakAdditionalBytes).toBe(0)
      expect(JSON.stringify(doc)).toBe(before)
    }
    expect(renderSurfaceBudget(4096, 4096).allowed).toBe(true)
  })
})
