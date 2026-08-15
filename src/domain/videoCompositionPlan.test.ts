import { describe, expect, test } from 'vitest'
import type {
  Clip,
  MediaSourceBounds,
  TimelineDoc,
  Track,
  Transition,
} from './schema'
import type { SourceBoundsCatalog } from './crossfadePlan'
import { defaultTextProps } from './textOverlay'
import { createPluginVideoEffectContributionSnapshot } from './pluginVideoEffectStagePlan'
import {
  createVideoCompositionPlanner,
  videoCompositionRequests,
} from './videoCompositionPlan'

function clip(
  id: string,
  assetId: string,
  timelineStart: number,
  sourceStart: number,
  opacity = 1,
  sourceMode: Clip['sourceMode'] = 'timed',
  blendMode?: string,
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode,
    sourceRange: sourceMode === 'still'
      ? { startFrame: 0, durationFrames: 1 }
      : { startFrame: sourceStart, durationFrames: 10 },
    timelineRange: { startFrame: timelineStart, durationFrames: 10 },
    transform: {
      x: id === 'to' ? 7 : 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity,
    ...(blendMode === undefined ? {} : { blendMode }),
    volume: 1,
    effects: [],
  }
}

function crossfade(
  fromClipId: string,
  toClipId: string,
  durationFrames = 4,
): Transition {
  return {
    id: 'xfade',
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { enabled: false, curve: 'equal-power' },
  }
}

function track(
  id: string,
  clips: Clip[],
  transitions: Transition[] = [],
  hidden = false,
): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions,
    hidden,
    muted: false,
    solo: false,
    locked: false,
  }
}

function doc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'visual-plan',
    name: 'Visual plan',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
  }
}

function exact(endFrames = 200): MediaSourceBounds {
  return {
    video: {
      status: 'exact',
      firstTimestampUs: 0,
      endTimestampUs: Math.ceil(endFrames * 1_000_000 / 30),
    },
    audio: null,
  }
}

function catalog(
  entries: Array<[string, MediaSourceBounds]>,
): SourceBoundsCatalog {
  return new Map(entries)
}

const PLUGIN_EFFECT_TYPE = 'plugin:com.example.sparkle/sparkle'

function pluginEffect(id: string, strength = 0.25): Clip['effects'][number] {
  return {
    id,
    type: PLUGIN_EFFECT_TYPE,
    version: 1,
    enabled: true,
    params: { strength },
  }
}

function pluginSnapshot() {
  return createPluginVideoEffectContributionSnapshot(4, [{
    signerFingerprint: `sha256:${'1'.repeat(64)}`,
    packageDigest: `sha256:${'2'.repeat(64)}`,
    pluginId: 'com.example.sparkle',
    pluginVersion: '1.0.0',
    kind: 'video-effect',
    contributionVersion: 1,
    contributionId: 'sparkle',
    contributionName: 'Sparkle',
    descriptorVersion: 1,
    entrypoint: 'myrelith_effect_sparkle',
    parameters: [{
      key: 'strength',
      name: 'Strength',
      kind: 'number',
      default: 0,
      min: 0,
      max: 1,
      step: 0.1,
      animatable: true,
    }],
    availability: 'ready',
    detail: 'Ready to render.',
  }])
}

describe('video composition plan', () => {
  test('keeps semantic captions explicit, topmost, half-open, and media-free', () => {
    const document = doc([track('V1', [clip('video', 'asset', 0, 0)])])
    document.captionTracks = [{
      id: 'captions-en',
      name: 'English',
      language: 'en',
      role: 'captions',
      stylePreset: 'boxed',
      hidden: false,
      items: [{
        id: 'cue-1',
        range: { startFrame: 2, durationFrames: 3 },
        text: 'Same frame everywhere',
      }],
    }]
    const planner = createVideoCompositionPlanner(document, new Map())
    const active = planner.planFrame(2)

    expect(active.items.map((item) => item.kind)).toEqual(['clip', 'caption'])
    expect(active.items[1]).toMatchObject({
      kind: 'caption',
      trackId: 'captions-en',
      frame: 2,
      paint: { id: 'cue-1', text: { content: 'Same frame everywhere' } },
    })
    expect(videoCompositionRequests(active)).toHaveLength(1)
    expect(planner.planFrame(5).items.map((item) => item.kind)).toEqual(['clip'])
  })

  test('plans ordinary clips in bottom-to-top track order', () => {
    const lower = clip('lower', 'lower-asset', 0, 30)
    const upper = clip('upper', 'upper-asset', 0, 80)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [lower]), track('V2', [upper])]),
      new Map(),
    )

    const plan = planner.planFrame(4)
    expect(plan.items.map((item) => item.kind === 'clip'
      ? `${item.trackId}:${item.request.clip.id}@${item.request.sourceFrame}`
      : item.kind)).toEqual(['V1:lower@34', 'V2:upper@84'])
  })

  test('uses the shared rational source-time map for ordinary frame requests', () => {
    const retimed = {
      ...clip('retimed', 'retimed-asset', 10, 20),
      sourceRange: { startFrame: 20, durationFrames: 11 },
      timelineRange: { startFrame: 10, durationFrames: 5 },
      sourceTimeMap: {
        sourceStartTicks: 20_500_000,
        sourceDurationTicks: 10_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    }
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [retimed])]),
      new Map(),
    )

    expect(videoCompositionRequests(planner.planFrame(10))[0].sourceFrame).toBe(20)
    expect(videoCompositionRequests(planner.planFrame(14))[0].sourceFrame).toBe(28)
  })

  test('uses the same ramp and freeze requests for preview and export composition', () => {
    const ramped = {
      ...clip('ramped', 'ramped-asset', 10, 20),
      sourceTimeMap: {
        sourceStartTicks: 20_000_000,
        sourceDurationTicks: 10_000_000,
        rate: { numerator: 1, denominator: 1 },
        speedCurve: {
          originFrame: 0,
          points: [
            { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' as const },
            { frame: 2, rate: { numerator: 0, denominator: 1 }, easing: 'hold' as const },
            { frame: 5, rate: { numerator: 2, denominator: 1 }, easing: 'linear' as const },
            { frame: 7, rate: { numerator: 1, denominator: 1 }, easing: 'hold' as const },
          ],
        },
      },
    }
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [ramped])]),
      new Map(),
    )

    expect(Array.from({ length: 10 }, (_value, offset) =>
      videoCompositionRequests(planner.planFrame(10 + offset))[0].sourceFrame,
    )).toEqual([20, 21, 22, 22, 22, 22, 23, 25, 26, 27])
  })

  test('emits one explicit group with genuine timed handle requests', () => {
    const from = clip('from', 'from-asset', 0, 20)
    const to = clip('to', 'to-asset', 10, 60, 0.6)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([
        ['from-asset', exact()],
        ['to-asset', exact()],
      ]),
    )

    const plan = planner.planFrame(11)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]).toMatchObject({
      kind: 'crossfade',
      trackId: 'V1',
      transitionId: 'xfade',
      frame: 11,
      requests: [
        { role: 'from', sourceFrame: 31, opacity: 1 },
        { role: 'to', sourceFrame: 61, opacity: 0.6 },
      ],
    })
    if (plan.items[0].kind !== 'crossfade') return
    expect(plan.items[0].requests[0].weight).toBeCloseTo(0.2)
    expect(plan.items[0].requests[1].weight).toBeCloseTo(0.8)
    expect(plan.items[0].kind === 'crossfade'
      ? plan.items[0].requests[1].clip.transform.x
      : null).toBe(7)
  })

  test('makes ordinary and transition-group blend resolution explicit', () => {
    const ordinary = clip('ordinary', 'ordinary-asset', 0, 0, 1, 'timed', 'overlay')
    const ordinaryItem = createVideoCompositionPlanner(
      doc([track('V1', [ordinary])]),
      new Map(),
    ).planFrame(1).items[0]
    expect(ordinaryItem).toMatchObject({
      kind: 'clip',
      blendMode: { intent: 'overlay', effective: 'overlay', status: 'supported' },
    })

    const from = clip('from', 'from-asset', 0, 20, 1, 'timed', 'screen')
    const to = clip('to', 'to-asset', 10, 60, 1, 'timed', 'screen')
    const matchingGroup = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([['from-asset', exact()], ['to-asset', exact()]]),
    ).planFrame(11).items[0]
    expect(matchingGroup).toMatchObject({
      kind: 'crossfade',
      blendMode: { effective: 'screen', status: 'supported' },
    })

    to.blendMode = 'future-soft-light'
    const compatibilityGroup = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([['from-asset', exact()], ['to-asset', exact()]]),
    ).planFrame(11).items[0]
    expect(compatibilityGroup).toMatchObject({
      kind: 'crossfade',
      blendMode: { effective: 'normal', status: 'compatibility-fallback' },
      requests: [{ clip: { blendMode: 'screen' } }, { clip: { blendMode: 'future-soft-light' } }],
    })
  })

  test('falls back to a hard cut when exact source handles are insufficient', () => {
    const from = clip('from', 'from-asset', 0, 0)
    const to = clip('to', 'to-asset', 10, 10)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([
        ['from-asset', exact(10)],
        ['to-asset', exact(20)],
      ]),
    )

    expect(planner.planFrame(9).items).toMatchObject([
      { kind: 'clip', request: { clip: { id: 'from' }, sourceFrame: 9 } },
    ])
    expect(planner.planFrame(10).items).toMatchObject([
      { kind: 'clip', request: { clip: { id: 'to' }, sourceFrame: 10 } },
    ])
  })

  test('repeats still frame zero while retaining the explicit group', () => {
    const from = clip('from', 'still', 0, 0, 1, 'still')
    const to = clip('to', 'video', 10, 20)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([['video', exact()]]),
    )

    expect(videoCompositionRequests(planner.planFrame(11)).map(
      (request) => `${request.clip.id}@${request.sourceFrame}`,
    )).toEqual(['from@0', 'to@21'])
  })

  test('does not request fully transparent legs or hidden tracks', () => {
    const from = clip('from', 'shared', 0, 20, 0)
    const to = clip('to', 'shared', 10, 60)
    const hidden = clip('hidden', 'hidden', 0, 0)
    const planner = createVideoCompositionPlanner(
      doc([
        track('V1', [from, to], [crossfade(from.id, to.id)]),
        track('V2', [hidden], [], true),
      ]),
      catalog([['shared', exact()], ['hidden', exact()]]),
    )

    const plan = planner.planFrame(10)
    expect(plan.items).toHaveLength(1)
    expect(videoCompositionRequests(plan).map((request) => request.clip.id))
      .toEqual(['to'])
  })

  test('keeps two same-asset legs as ordered clip-keyed requests', () => {
    const from = clip('from', 'shared', 0, 20)
    const to = clip('to', 'shared', 10, 60)
    const planner = createVideoCompositionPlanner(
      doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
      catalog([['shared', exact()]]),
    )

    expect(videoCompositionRequests(planner.planFrame(10)).map(
      (request) => `${request.clip.id}@${request.sourceFrame}`,
    )).toEqual(['from@30', 'to@60'])
  })

  test('resolves the same keyframed clip values for ordinary and crossfade requests', () => {
    const ordinary = clip('ordinary', 'ordinary-asset', 0, 0)
    ordinary.animation = {
      tracks: [
        {
          property: 'position-x',
          keyframes: [
            { frame: 0, value: 0, easing: { type: 'linear' } },
            { frame: 10, value: 100, easing: { type: 'linear' } },
          ],
        },
        {
          property: 'opacity',
          keyframes: [
            { frame: 0, value: 1, easing: { type: 'linear' } },
            { frame: 10, value: 0, easing: { type: 'linear' } },
          ],
        },
      ],
    }
    const ordinaryRequest = videoCompositionRequests(
      createVideoCompositionPlanner(doc([track('V1', [ordinary])]), new Map())
        .planFrame(5),
    )[0]

    expect(ordinaryRequest.clip.transform.x).toBe(50)
    expect(ordinaryRequest.opacity).toBe(0.5)

    const from = clip('from', 'shared', 0, 20)
    const to = clip('to', 'shared', 10, 60)
    from.animation = {
      tracks: [{
        property: 'rotation',
        keyframes: [
          { frame: 10, value: 10, easing: { type: 'linear' } },
          { frame: 12, value: 30, easing: { type: 'linear' } },
        ],
      }],
    }
    to.animation = {
      tracks: [{
        property: 'position-y',
        keyframes: [
          { frame: 0, value: -20, easing: { type: 'linear' } },
          { frame: 2, value: 20, easing: { type: 'linear' } },
        ],
      }],
    }
    const requests = videoCompositionRequests(
      createVideoCompositionPlanner(
        doc([track('V1', [from, to], [crossfade(from.id, to.id)])]),
        catalog([['shared', exact()]]),
      ).planFrame(11),
    )

    expect(requests[0].clip.transform.rotation).toBe(20)
    expect(requests[1].clip.transform.y).toBe(0)
  })

  test('keeps the exact no-plugin plan shape with an empty plugin catalog', () => {
    const ordinary = clip('ordinary', 'asset', 0, 0)
    const document = doc([track('V1', [ordinary])])
    const original = createVideoCompositionPlanner(document, new Map()).planFrame(2)
    const withEmptyCatalog = createVideoCompositionPlanner(
      document,
      new Map(),
      createPluginVideoEffectContributionSnapshot(1, []),
    ).planFrame(2)

    expect(withEmptyCatalog).toEqual(original)
    expect(JSON.stringify(withEmptyCatalog)).toBe(JSON.stringify(original))
    expect(withEmptyCatalog.items[0]).not.toHaveProperty('effectStagePlan')
    expect(withEmptyCatalog.items[0]).not.toHaveProperty('request.effectStagePlan')
  })

  test('attaches plugin stages to ordinary media and text without creating text requests', () => {
    const media = clip('media', 'media-asset', 0, 0)
    media.effects = [pluginEffect('media-plugin')]
    const text = clip('text', '__myrelith_text__:title', 0, 0, 1, 'still')
    text.text = defaultTextProps(1920, 1080, 'Title')
    text.effects = [pluginEffect('text-plugin')]
    const plan = createVideoCompositionPlanner(
      doc([track('V1', [media]), track('V2', [text])]),
      new Map(),
      pluginSnapshot(),
    ).planFrame(2)

    expect(plan.items).toHaveLength(2)
    expect(plan.items[0]).toMatchObject({
      kind: 'clip',
      request: {
        effectStagePlan: {
          requiresOrderedPixelPath: true,
          stages: [{ kind: 'plugin', effect: { id: 'media-plugin' }, status: 'ready' }],
        },
      },
    })
    expect(plan.items[1]).toMatchObject({
      kind: 'text',
      effectStagePlan: {
        requiresOrderedPixelPath: true,
        stages: [{ kind: 'plugin', effect: { id: 'text-plugin' }, status: 'ready' }],
      },
    })
    expect(videoCompositionRequests(plan).map((request) => request.clip.id))
      .toEqual(['media'])
  })

  test('plans animated plugin parameters independently on both crossfade legs', () => {
    const from = clip('from', 'from-asset', 0, 20)
    const to = clip('to', 'to-asset', 10, 60)
    from.effects = [pluginEffect('from-plugin', 0)]
    to.effects = [pluginEffect('to-plugin', 0)]
    from.animation = {
      tracks: [],
      effectTracks: [{
        effectId: 'from-plugin',
        parameter: 'strength',
        keyframes: [
          { frame: 10, value: 0, easing: { type: 'linear' } },
          { frame: 12, value: 1, easing: { type: 'linear' } },
        ],
      }],
    }
    to.animation = {
      tracks: [],
      effectTracks: [{
        effectId: 'to-plugin',
        parameter: 'strength',
        keyframes: [
          { frame: 0, value: 0, easing: { type: 'linear' } },
          { frame: 2, value: 1, easing: { type: 'linear' } },
        ],
      }],
    }
    const document = doc([track('V1', [from, to], [crossfade(from.id, to.id)])])
    const sources = catalog([['from-asset', exact()], ['to-asset', exact()]])
    const baselineRequests = videoCompositionRequests(
      createVideoCompositionPlanner(document, sources).planFrame(11),
    )
    const planned = createVideoCompositionPlanner(
      document,
      sources,
      pluginSnapshot(),
    ).planFrame(11)

    expect(planned.items[0]).toMatchObject({
      kind: 'crossfade',
      requests: [
        {
          effectStagePlan: {
            stages: [{
              kind: 'plugin',
              execution: { canonicalParameterJson: '{"strength":0.5}' },
            }],
          },
        },
        {
          effectStagePlan: {
            stages: [{
              kind: 'plugin',
              execution: { canonicalParameterJson: '{"strength":0.5}' },
            }],
          },
        },
      ],
    })
    const decodeRequests = videoCompositionRequests(planned)
    expect(decodeRequests).toEqual(baselineRequests)
    expect(decodeRequests.every((request) => !Object.prototype.hasOwnProperty.call(
      request,
      'effectStagePlan',
    ))).toBe(true)
  })
})
