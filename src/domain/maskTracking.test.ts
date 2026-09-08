import { describe, expect, test } from 'vitest'
import { defaultClipAnimation, MAX_TOTAL_ANIMATION_KEYFRAMES, resolveClipAnimationAtFrame } from './clipAnimation'
import { defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { DEFAULT_MASK_PARAMS } from './effectStack'
import { DEFAULT_MANUAL_LENS_CORRECTION } from './lensCorrection'
import { createMaskTrackingPlan, type MaskTrackingPlan, type MaskTrackingRequest } from './maskTracking'
import { createMotionTrackingPlan, type MotionTrackingBoxAnalysis, type MotionTrackingPointAnalysis } from './motionTracking'
import { applyMaskTrackingWithResult } from './operations/maskTracking'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import type { Clip, ClipAnimationKeyframe, EffectAnimationTrack, TimelineDoc } from './schema'
import { clipSourceTimeMap, sourceTicksAtTimelineOffset } from './sourceTimeMap'

function key(frame: number, value: number): ClipAnimationKeyframe {
  return { frame, value, sourceTimeTicks: frame * 1_000_000, easing: { type: 'linear' } }
}
function scalar(parameter: string, values = [[0, 0.2], [20, 0.4]], effectId = 'mask'): EffectAnimationTrack {
  return { effectId, parameter, keyframes: values.map(([frame, value]) => key(frame, value)) }
}
function clip(id: string, startFrame: number, durationFrames: number): Clip {
  return { id, assetId: `asset-${id}`, name: id, sourceMode: 'timed', sourceRange: { startFrame: 0, durationFrames }, timelineRange: { startFrame, durationFrames }, transform: defaultClipTransform(), visual: defaultClipVisualSettings(), animation: defaultClipAnimation(), opacity: 1, volume: 1,
    effects: [{ id: 'mask', type: 'builtin.mask', version: 1, enabled: true, params: { ...DEFAULT_MASK_PARAMS, x: 0.4, y: 0.3, width: 0.2, height: 0.1 } }],
  }
}
function fixture() {
  const source = clip('source', 10, 20), target = clip('target', 8, 30)
  const doc: TimelineDoc = { schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION, id: 'sequence', name: 'Mask tracking', frameRate: { num: 30, den: 1 }, width: 1000, height: 600, audioSampleRate: 48_000,
    tracks: [source, target].map((item, index) => ({ id: `video-${index}`, kind: 'video', name: item.name, clips: [item], transitions: [], hidden: false, muted: false, solo: false, locked: false })),
  }
  const analysis: MotionTrackingPointAnalysis = { version: 1, kind: 'point', direction: 'forward', selectionLocalFrame: 2, width: 200, height: 100, failure: null,
    samples: [2, 4, 6].map((localFrame, index) => ({ localFrame, sourceTimeTicks: localFrame * 1_000_000, timestampUs: localFrame * 33_333, x: 100 + 10 * index, y: 25 + 5 * index, confidence: 1 - index * 0.1 })),
  }
  const request: MaskTrackingRequest = { sourceClipId: source.id, source: { width: 200, height: 100, firstTimestampUs: 0, frameRate: doc.frameRate }, analysis, selectionGlobalFrame: 12, target: { kind: 'mask-effect', clipId: target.id, effectId: 'mask' }, includeSize: false }
  return { doc, source, target, analysis, request }
}
function plan(doc: TimelineDoc, request: MaskTrackingRequest): MaskTrackingPlan {
  const result = createMaskTrackingPlan(doc, request)
  if (!result.ok) throw new Error(result.reason)
  return result.plan
}
function values(result: MaskTrackingPlan, parameter: string): number[] {
  return result.tracks.find((track) => track.parameter === parameter)!.keyframes.map((key) => key.value)
}
function near(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 10))
}
function boxRequest(request: MaskTrackingRequest): MaskTrackingRequest {
  const analysis: MotionTrackingBoxAnalysis = { ...request.analysis, kind: 'box', samples: request.analysis.samples.map((sample, index) => ({ ...sample, x: 80 - index * 10, y: 30 - index * 5, width: 40 + index * 20, height: 20 + index * 10 })) }
  return { ...request, analysis, includeSize: true }
}

describe('mask tracking project-space planning', () => {
  test('retains every accepted point with target-local frames and ordinary scalar interpolation', () => {
    const { doc, request, analysis } = fixture(), before = JSON.stringify(doc)
    const result = plan(doc, request)
    expect(result.tracks.map((track) => track.parameter)).toEqual(['x', 'y'])
    expect(result.tracks[0]!.keyframes.map((key) => [key.frame, key.sourceTimeTicks])).toEqual([[4, 4_000_000], [6, 6_000_000], [8, 8_000_000]])
    near(values(result, 'x'), [0.4, 0.41, 0.42]); near(values(result, 'y'), [0.3, 0.3 + 5 / 600, 0.3 + 10 / 600])
    expect(result).toMatchObject({ firstAcceptedGlobalFrame: 12, lastAcceptedGlobalFrame: 16, sampleCount: 3, confidenceMinimum: 0.8, confidenceMean: 0.9, replacementRequired: false })
    const applied = applyMaskTrackingWithResult(doc, result, null)
    expect(applied.ok).toBe(true)
    const target = applied.doc.tracks[1]!.clips[0]!
    expect(resolveClipAnimationAtFrame(target, 13).effects[0]!.params.x).toBeCloseTo(0.405)
    expect(resolveClipAnimationAtFrame(target, 20).effects[0]!.params.x).toBeCloseTo(0.42)
    expect(JSON.stringify(doc)).toBe(before)
    expect(request.analysis).toBe(analysis)
  })

  test('allows the source mask while the existing clip-transform planner still refuses self-attachment', () => {
    const { doc, request, source, analysis } = fixture()
    source.animation!.tracks = [{ property: 'position-x', keyframes: [key(2, 0), key(6, 40)] }]
    const result = plan(doc, { ...request, target: { ...request.target, clipId: source.id } })
    near(values(result, 'x'), [0.4, 0.43, 0.46])
    const applied = applyMaskTrackingWithResult(doc, result, null)
    expect(applied.ok).toBe(true)
    expect(applied.doc.tracks[0]!.clips[0]!.animation!.tracks).toBe(source.animation!.tracks)
    expect(applied.doc.tracks[0]!.clips[0]!.transform).toBe(source.transform)
    expect(createMotionTrackingPlan(doc, source, source, request.source, request.source, analysis, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/separate/) })
  })

  test('anchors backward results to the exact selected mask value before sorting', () => {
    const { doc, target, request, analysis } = fixture()
    target.animation!.effectTracks = [scalar('x', [[0, 0.2], [10, 0.6]])]
    const backward = { ...analysis, direction: 'backward' as const, selectionLocalFrame: 6, samples: [...analysis.samples].reverse() }
    const result = plan(doc, { ...request, analysis: backward, selectionGlobalFrame: 16 })
    near(values(result, 'x'), [0.5, 0.51, 0.52])
    expect(result.tracks[0]!.keyframes.map((key) => key.frame)).toEqual([4, 6, 8])
    expect(result.replacementRequired).toBe(true)
    expect(result.selectionGlobalFrame).toBe(16)
    expect(backward.samples.map((sample) => sample.localFrame)).toEqual([6, 4, 2])
  })

  test('uses independent cropped, anchored, flipped, nonuniform quarter-turn geometry and fresh source motion', () => {
    const { doc, source, target, request, analysis } = fixture()
    source.transform = { x: 30, y: -10, scaleX: 2, scaleY: 3, anchorX: 0.25, anchorY: 0.8, rotation: 90 }
    source.visual = { ...defaultClipVisualSettings(), flipHorizontal: true, crop: { left: 0.1, right: 0.2, top: 0.05, bottom: 0.15 } }
    source.animation!.tracks = [{ property: 'position-x', keyframes: [key(2, 30), key(6, 50)] }]
    const modified = { ...analysis, samples: analysis.samples.map((sample, index) => ({ ...sample, y: 25 + index * 10 })) }
    // C0=(645,220). Each raw (+10,+10) becomes (-30,-20), plus source (+10,0).
    const result = plan(doc, { ...request, analysis: modified })
    near(values(result, 'x'), [0.4, 0.38, 0.36]); near(values(result, 'y'), [0.3, 0.3 - 20 / 600, 0.3 - 40 / 600])
    target.transform = { x: 800, y: -700, scaleX: -4, scaleY: 0.5, anchorX: 0.9, anchorY: 0.1, rotation: 137 }
    target.visual = { ...defaultClipVisualSettings(), flipVertical: true, crop: { left: 0.3, right: 0, top: 0.2, bottom: 0 } }
    target.animation!.tracks = [{ property: 'rotation', keyframes: [key(0, -90), key(20, 270)] }]
    expect(plan(doc, { ...request, analysis: modified }).tracks).toEqual(result.tracks)
  })

  test('normalizes bounded decode samples by their admitted dimensions, then projects original source pixels', () => {
    const { doc, request, analysis } = fixture()
    const scaled = { ...analysis, width: 320, height: 180, samples: analysis.samples.map((sample, index) => ({ ...sample, x: 160 + index * 5, y: 90 + index * 2.5 })) }
    const result = plan(doc, { ...request, source: { ...request.source, width: 1920, height: 1080 }, analysis: scaled })
    near(values(result, 'x'), [0.4, 0.43, 0.46]); near(values(result, 'y'), [0.3, 0.325, 0.35])
  })

  test('box position-only preserves size lanes, while box size follows project AABB extents without rotation', () => {
    const { doc, request, target } = fixture(), box = boxRequest(request)
    const width = scalar('width', [[0, 0.2], [20, 0.8]]), height = scalar('height', [[0, 0.1], [20, 0.3]])
    target.animation!.effectTracks = [width, height]
    const positionOnly = plan(doc, { ...box, includeSize: false })
    near(values(positionOnly, 'x'), [0.4, 0.4, 0.4]); near(values(positionOnly, 'y'), [0.3, 0.3, 0.3])
    expect(positionOnly.replacementRequired).toBe(false)
    const applied = applyMaskTrackingWithResult(doc, positionOnly, null)
    expect(applied.doc.tracks[1]!.clips[0]!.animation!.effectTracks!.slice(0, 2)).toEqual([width, height])
    expect(applied.doc.tracks[1]!.clips[0]!.animation!.effectTracks![0]).toBe(width)
    const sized = plan(doc, box)
    // Box stays centered at (500,290). Selected mask origin=(400,180), resolved size=(320,140).
    near(values(sized, 'x'), [0.4, 0.35, 0.3]); near(values(sized, 'y'), [0.3, 125 / 600, 70 / 600])
    near(values(sized, 'width'), [0.32, 0.48, 0.64]); near(values(sized, 'height'), [0.14, 0.21, 0.28])
    expect(sized.tracks.map((track) => track.parameter)).toEqual(['x', 'y', 'width', 'height'])
  })

  test('source rotation changes box AABB width and height, with no target rotation lane', () => {
    const { doc, source, request } = fixture()
    source.animation!.tracks = [{ property: 'rotation', keyframes: [key(2, 0), key(4, 90), key(6, 180)] }]
    const box = boxRequest(request)
    const analysis: MotionTrackingBoxAnalysis = { ...box.analysis as MotionTrackingBoxAnalysis, samples: box.analysis.samples.map((sample) => ({ ...sample, x: 80, y: 40, width: 40, height: 20 })) }
    const result = plan(doc, { ...box, analysis })
    near(values(result, 'width'), [0.2, 0.1, 0.2]); near(values(result, 'height'), [0.1, 0.2, 0.1])
  })

  test('maps keys only through the target source time map, preserving original analysis and loss', () => {
    const { doc, source, target, request, analysis } = fixture()
    source.sourceTimeMap = { sourceStartTicks: 100_000_000, sourceDurationTicks: 40_000_000, rate: { numerator: 2, denominator: 1 } }
    target.sourceTimeMap = { sourceStartTicks: 500_000_000, sourceDurationTicks: 15_000_000, rate: { numerator: 1, denominator: 2 } }
    const failure = { localFrame: 8, code: 'lost-point' as const, detail: 'First rejected analysis pair.' }
    const accepted = { ...analysis, samples: analysis.samples.map((sample) => ({ ...sample, sourceTimeTicks: sourceTicksAtTimelineOffset(clipSourceTimeMap(source), sample.localFrame) })), failure }
    const result = plan(doc, { ...request, analysis: accepted })
    expect(result.tracks[0]!.keyframes.map((key) => key.sourceTimeTicks)).toEqual([502_000_000, 503_000_000, 504_000_000])
    expect(result.stopped).toBe(failure)
    expect(accepted.samples.map((sample) => sample.sourceTimeTicks)).toEqual([104_000_000, 108_000_000, 112_000_000])
  })
})

describe('whole-proposal refusal', () => {
  test.each(['forward', 'backward'] as const)('refuses first, interior and final loss caused by animated source crop in %s order', (direction) => {
    for (const kind of ['point', 'box'] as const) for (const badIndex of [0, 1, 2]) {
      const { doc, source, request } = fixture()
      const selected = kind === 'box' ? boxRequest(request) : request
      const samples = direction === 'forward' ? [...selected.analysis.samples] : [...selected.analysis.samples].reverse()
      source.animation!.tracks = [{ property: 'crop-left', keyframes: [...samples].sort((a, b) => a.localFrame - b.localFrame).map((sample) => key(sample.localFrame, sample === samples[badIndex] ? sample.x / selected.analysis.width + 0.01 : 0)) }]
      const analysis = { ...selected.analysis, direction, samples, selectionLocalFrame: samples[0]!.localFrame } as typeof selected.analysis
      const before = JSON.stringify({ doc, analysis })
      expect(createMaskTrackingPlan(doc, { ...selected, analysis, selectionGlobalFrame: 10 + samples[0]!.localFrame })).toMatchObject({ ok: false, reason: expect.stringContaining(`frame ${10 + samples[badIndex]!.localFrame}`) })
      expect(JSON.stringify({ doc, analysis })).toBe(before)
    }
  })

  test.each(['forward', 'backward'] as const)('rejects first, interior and final cropped box corners in %s order without changing analysis', (direction) => {
    for (const badIndex of [0, 1, 2]) {
      const { doc, source, request } = fixture(), box = boxRequest(request)
      source.visual!.crop = { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2 }
      const ordered = direction === 'forward' ? box.analysis.samples : [...box.analysis.samples].reverse()
      const samples = ordered.map((sample, index) => ({ ...sample, x: index === badIndex ? 30 : 80, y: 30, width: 40, height: 20 }))
      const analysis: MotionTrackingBoxAnalysis = { ...box.analysis as MotionTrackingBoxAnalysis, direction, selectionLocalFrame: samples[0]!.localFrame, samples }
      const before = JSON.stringify(analysis), globalFrame = 10 + samples[badIndex]!.localFrame
      expect(createMaskTrackingPlan(doc, { ...box, analysis, selectionGlobalFrame: 10 + samples[0]!.localFrame })).toEqual({ ok: false, reason: expect.stringContaining(`frame ${globalFrame} is not wholly inside`) })
      expect(JSON.stringify(analysis)).toBe(before)
    }
  })

  test('accepts inclusive crop edges but refuses point loss from freshly animated crop', () => {
    const { doc, source, request, analysis } = fixture()
    source.visual!.crop = { left: 0.5, right: 0.3, top: 0.25, bottom: 0.5 }
    expect(createMaskTrackingPlan(doc, request).ok).toBe(true)
    source.animation!.tracks = [{ property: 'crop-left', keyframes: [key(2, 0.5), key(4, 0.56), key(6, 0.6)] }]
    expect(createMaskTrackingPlan(doc, request)).toEqual({ ok: false, reason: expect.stringContaining('frame 14 is outside the resolved source crop') })
    expect(analysis.samples).toHaveLength(3)
    source.animation!.tracks = []
    const box = boxRequest(request)
    source.visual!.crop = { left: 0.3, right: 0.3, top: 0.2, bottom: 0.2 }
    expect(createMaskTrackingPlan(doc, box).ok).toBe(true)
  })

  test('validates original direction and the exact reference, never sorting invalid input into validity', () => {
    const { doc, request, analysis } = fixture()
    const candidates = [
      { ...analysis, samples: analysis.samples.slice(1) },
      { ...analysis, samples: [analysis.samples[0]!, analysis.samples[2]!, analysis.samples[1]!] },
      { ...analysis, samples: [analysis.samples[0]!, analysis.samples[1]!, analysis.samples[1]!] },
      { ...analysis, selectionLocalFrame: 3 },
      { ...analysis, samples: [analysis.samples[0]!] },
      { ...analysis, direction: 'backward' as const },
      { ...analysis, samples: analysis.samples.map((sample, index) => index === 1 ? { ...sample, timestampUs: -1 } : sample) },
      { ...analysis, samples: analysis.samples.map((sample, index) => index === 1 ? { ...sample, sourceTimeTicks: 123 } : sample) },
    ]
    for (const candidate of candidates) expect(createMaskTrackingPlan(doc, { ...request, analysis: candidate }).ok).toBe(false)
  })

  test('refuses incomplete target overlap including half-open final and absent selection', () => {
    for (const [startFrame, durationFrames] of [[12, 4], [13, 20], [8, 7]]) {
      const { doc, target, request } = fixture()
      target.timelineRange = { startFrame, durationFrames }
      expect(createMaskTrackingPlan(doc, request).ok).toBe(false)
    }
    const { doc, target, request } = fixture()
    target.timelineRange = { startFrame: 12, durationFrames: 5 }
    expect(createMaskTrackingPlan(doc, request).ok).toBe(true)
  })

  test('refuses unavailable geometry and values without clamping', () => {
    const cases: ((f: ReturnType<typeof fixture>) => void)[] = [
      ({ source }) => { source.lensCorrection = { ...DEFAULT_MANUAL_LENS_CORRECTION } },
      ({ source }) => { source.transform.scaleX = 0 },
      ({ source }) => { source.transform.x = Number.POSITIVE_INFINITY },
      ({ source }) => { source.animation!.tracks = [{ property: 'rotation', propertyVersion: 2, keyframes: [key(0, 10)] }] },
      ({ source }) => { source.animation!.tracks = [{ property: 'position-x', keyframes: [key(2, 0), key(4, 10_000)] }] },
      ({ target }) => { target.effects[0]!.params.width = 0 },
      ({ target }) => { target.effects[0]!.version = 2 },
      ({ target }) => { target.effects[0]!.enabled = false },
      ({ target }) => { target.effects[0]!.type = 'future.mask' },
      ({ doc }) => { doc.tracks[1]!.locked = true },
      ({ doc }) => { doc.tracks[1]!.hidden = true },
      ({ doc }) => { doc.tracks[1]!.kind = 'audio' },
      ({ request }) => { (request as { includeSize: boolean }).includeSize = true },
      ({ target }) => { target.animation!.effectTracks = [scalar('width', [[0, 20]])] },
    ]
    for (const mutate of cases) {
      const f = fixture(); mutate(f)
      const before = JSON.stringify(f.doc)
      expect(createMaskTrackingPlan(f.doc, f.request).ok).toBe(false)
      expect(JSON.stringify(f.doc)).toBe(before)
    }
  })

  test('rejects opaque competing scalar/path identities but preserves unrelated intent', () => {
    const { doc, target, request } = fixture()
    const futurePath = { effectId: 'mask', parameter: 'x', valueType: 'future-shape', valueVersion: 2, keyframes: [{ frame: 0, sourceTimeTicks: 0, value: '?', easing: { type: 'hold' as const } }] }
    target.animation!.effectPathTracks = [futurePath]
    expect(createMaskTrackingPlan(doc, request)).toMatchObject({ ok: false, reason: expect.stringMatching(/Preserved path intent/) })
    futurePath.effectId = 'unrelated'
    expect(plan(doc, request).tracks).toHaveLength(2)
    target.animation!.effectTracks = [{ ...scalar('x'), parameterIdentity: { version: 2, effectType: 'builtin.mask', descriptorVersion: 1, contributionId: 'future-owner', contributionVersion: 1, packageDigest: 'future-digest' } }]
    expect(createMaskTrackingPlan(doc, request)).toMatchObject({ ok: false, reason: expect.stringMatching(/parameter or version is unavailable/) })
  })
})

describe('mask tracking atomic operation and budgets', () => {
  test('replaces only explicitly confirmed complete owned lanes, preserving off-range siblings and fallback', () => {
    const { doc, target, request } = fixture()
    const x = scalar('x', [[-10, 0.1], [100, 0.9]]), width = scalar('width'), sibling = scalar('x', [[1, 0.7]], 'other-effect')
    target.animation!.effectTracks = [x, width, sibling]
    target.animation!.tracks = [{ property: 'future-property', propertyVersion: 4, keyframes: [key(5, 9)] }]
    target.animation!.effectPathTracks = [{ effectId: 'unrelated', parameter: 'path', valueType: 'future-path', valueVersion: 9, keyframes: [{ frame: 2, sourceTimeTicks: 2_000_000, value: '?', easing: { type: 'hold' } }] }]
    const result = plan(doc, request), before = JSON.stringify(doc)
    expect(applyMaskTrackingWithResult(doc, result, null)).toMatchObject({ ok: false, doc, reason: expect.stringMatching(/confirmation/) })
    const applied = applyMaskTrackingWithResult(doc, result, result.reviewKey)
    expect(applied).toMatchObject({ ok: true, changed: true })
    const changed = applied.doc.tracks[1]!.clips[0]!
    expect(changed.animation!.tracks).toBe(target.animation!.tracks)
    expect(changed.animation!.effectPathTracks).toBe(target.animation!.effectPathTracks)
    expect(changed.effects).toBe(target.effects)
    expect(changed.sourceTimeMap).toBe(target.sourceTimeMap)
    expect(changed.animation!.effectTracks!.slice(0, 2)).toEqual([width, sibling])
    expect(changed.animation!.effectTracks!.at(-2)!.keyframes.map((key) => key.frame)).toEqual([4, 6, 8])
    expect(JSON.stringify(doc)).toBe(before)
    // No secret tracking ownership: repeating an identical reviewed result is a no-op.
    const nextPlan = plan(applied.doc, request)
    expect(applyMaskTrackingWithResult(applied.doc, nextPlan, nextPlan.reviewKey)).toMatchObject({ ok: true, changed: false })
  })

  test('consent expires when the candidate, target effect, owned set or complete owned content changes', () => {
    const { doc, target, request, analysis } = fixture()
    target.animation!.effectTracks = [scalar('x')]
    const original = plan(doc, request)
    const variants: MaskTrackingRequest[] = [
      { ...request, analysis: { ...analysis, samples: analysis.samples.map((sample, index) => ({ ...sample, x: sample.x + index })) } },
      boxRequest(request),
      { ...request, target: { ...request.target, effectId: 'another' } },
    ]
    target.effects.push({ ...target.effects[0]!, id: 'another' })
    target.animation!.effectTracks.push(scalar('x', undefined, 'another'))
    for (const variant of variants) {
      const changed = plan(doc, variant)
      expect(changed.reviewKey).not.toBe(original.reviewKey)
      expect(applyMaskTrackingWithResult(doc, changed, original.reviewKey).ok).toBe(false)
    }
    target.animation!.effectTracks[0]!.keyframes.push(key(200, 0.5))
    const changed = plan(doc, request)
    expect(applyMaskTrackingWithResult(doc, changed, original.reviewKey).ok).toBe(false)
  })

  test('independently rejects stale targets, identity/version/track-set changes and unsafe keys', () => {
    const mutators: ((p: MaskTrackingPlan, f: ReturnType<typeof fixture>) => MaskTrackingPlan)[] = [
      (p, { target }) => { target.effects[0]!.enabled = false; return p },
      (p, { target }) => { target.effects[0]!.version = 2; return p },
      (p, { target }) => { target.effects[0]!.params.x = 0.5; return p },
      (p, { doc }) => { doc.tracks[1]!.locked = true; return p },
      (p) => ({ ...p, sequenceId: 'other' }),
      (p) => ({ ...p, tracks: p.tracks.slice(1) }),
      (p) => ({ ...p, tracks: [p.tracks[0]!, p.tracks[0]!] }),
      (p) => ({ ...p, tracks: p.tracks.map((track, index) => index === 0 ? { ...track, effectId: 'other' } : track) }),
      (p) => ({ ...p, tracks: p.tracks.map((track, index) => index === 0 ? { ...track, parameter: 'rotation' } : track) }),
      (p) => ({ ...p, tracks: p.tracks.map((track) => ({ ...track, keyframes: track.keyframes.map((key, index) => index === 1 ? { ...key, sourceTimeTicks: 1 } : key) })) }),
      (p) => ({ ...p, tracks: p.tracks.map((track) => ({ ...track, keyframes: track.keyframes.map((key, index) => index === 1 ? { ...key, value: 100 } : key) })) }),
      (p) => ({ ...p, tracks: p.tracks.map((track) => ({ ...track, keyframes: track.keyframes.map((key) => ({ ...key, easing: { type: 'hold' } })) })) }),
      (p) => ({ ...p, sampleCount: p.sampleCount - 1 }),
      (p) => ({ ...p, selectionGlobalFrame: p.selectionGlobalFrame + 1 }),
    ]
    for (const mutate of mutators) {
      const f = fixture(), candidate = mutate(plan(f.doc, f.request), f), before = JSON.stringify(f.doc)
      expect(applyMaskTrackingWithResult(f.doc, candidate, candidate.reviewKey)).toMatchObject({ ok: false, changed: false, doc: f.doc })
      expect(JSON.stringify(f.doc)).toBe(before)
    }
  })

  test('accepts 1,024 retained equal-valued samples and refuses 1,025', () => {
    const { doc, source, target, request, analysis } = fixture()
    source.timelineRange.durationFrames = 1100; source.sourceRange.durationFrames = 1100
    target.timelineRange.durationFrames = 1200; target.sourceRange.durationFrames = 1200
    const samples = Array.from({ length: 1024 }, (_, index) => ({ ...analysis.samples[0]!, localFrame: index + 2, timestampUs: (index + 2) * 33_333, sourceTimeTicks: (index + 2) * 1_000_000 }))
    const result = plan(doc, { ...request, analysis: { ...analysis, samples } })
    expect(result.tracks.every((track) => track.keyframes.length === 1024)).toBe(true)
    expect(new Set(values(result, 'x')).size).toBe(1)
    expect(createMaskTrackingPlan(doc, { ...request, analysis: { ...analysis, samples: [...samples, { ...samples.at(-1)!, localFrame: 1026 }] } }).ok).toBe(false)
  })

  test('the shared document aggregate budget admits equal-sized replacement and rejects growth', () => {
    const { doc, request, target } = fixture()
    const targetKeys = [scalar('x', [[0, 0.2], [4, 0.2], [8, 0.2]]), scalar('y', [[0, 0.3], [4, 0.3], [8, 0.3]])]
    target.animation!.effectTracks = targetKeys
    const filler = clip('filler', 0, 2000)
    let remaining = MAX_TOTAL_ANIMATION_KEYFRAMES - 6
    while (remaining) {
      const count = Math.min(1024, remaining)
      filler.animation!.effectTracks!.push({ effectId: `opaque-${remaining}`, parameter: 'future', keyframes: Array.from({ length: count }, (_, frame) => key(frame, 1)) })
      remaining -= count
    }
    doc.tracks.push({ ...doc.tracks[0]!, id: 'filler-track', clips: [filler] })
    const replacement = plan(doc, request)
    expect(applyMaskTrackingWithResult(doc, replacement, replacement.reviewKey).ok).toBe(true)
    target.animation!.effectTracks = []
    // The document now has room for exactly six keys, so this also remains legal.
    const admitted = plan(doc, request)
    filler.animation!.effectTracks!.at(-1)!.keyframes.push(key(1023, 1))
    expect(createMaskTrackingPlan(doc, request)).toMatchObject({ ok: false, reason: expect.stringMatching(/document keyframe budget/) })
    expect(applyMaskTrackingWithResult(doc, admitted, null)).toMatchObject({ ok: false, doc, reason: expect.stringMatching(/document keyframe budget/) })
  })
})
