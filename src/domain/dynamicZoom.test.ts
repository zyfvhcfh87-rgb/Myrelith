import { describe, expect, test } from 'vitest'
import { defaultClipAnimation, evaluateAnimationTrack } from './clipAnimation'
import { defaultClipVisualSettings } from './clipInspector'
import {
  createDynamicZoomPlan,
  DYNAMIC_ZOOM_PRESETS,
  dynamicZoomAvailabilityReason,
  dynamicZoomRequestFromPreset,
  reverseDynamicZoomRequest,
  type DynamicZoomResolvedFrame,
  type DynamicZoomSourceDimensions,
} from './dynamicZoom'
import type { Clip, TimelineDoc } from './schema'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Dynamic source',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 180 },
    timelineRange: { startFrame: 20, durationFrames: 180 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    ...overrides,
  }
}

function doc(item = clip(), width = 1920, height = 1080): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'doc-dynamic-zoom',
    name: 'Dynamic zoom',
    frameRate: { num: 30, den: 1 },
    width,
    height,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video-1',
      kind: 'video',
      name: 'Video 1',
      clips: [item],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

function expectCanvasCovered(
  document: TimelineDoc,
  item: Clip,
  source: DynamicZoomSourceDimensions,
  frame: DynamicZoomResolvedFrame,
): void {
  const visual = item.visual ?? defaultClipVisualSettings()
  const sourceLeft = visual.crop.left * source.width
  const sourceRight = (1 - visual.crop.right) * source.width
  const sourceTop = visual.crop.top * source.height
  const sourceBottom = (1 - visual.crop.bottom) * source.height
  const anchorX = item.transform.anchorX * source.width
  const anchorY = item.transform.anchorY * source.height
  const canvasAnchorX = (document.width - source.width) / 2 + anchorX + frame.x
  const canvasAnchorY = (document.height - source.height) / 2 + anchorY + frame.y
  const angle = item.transform.rotation * Math.PI / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const flipX = visual.flipHorizontal ? -1 : 1
  const flipY = visual.flipVertical ? -1 : 1

  for (const canvasX of [0, document.width]) {
    for (const canvasY of [0, document.height]) {
      const x = canvasX - canvasAnchorX
      const y = canvasY - canvasAnchorY
      const localX = flipX * (cosine * x + sine * y) / frame.scale + anchorX
      const localY = flipY * (-sine * x + cosine * y) / frame.scale + anchorY
      expect(localX).toBeGreaterThanOrEqual(sourceLeft - 1e-7)
      expect(localX).toBeLessThanOrEqual(sourceRight + 1e-7)
      expect(localY).toBeGreaterThanOrEqual(sourceTop - 1e-7)
      expect(localY).toBeLessThanOrEqual(sourceBottom + 1e-7)
    }
  }
}

describe('dynamic zoom preset planning', () => {
  test('keeps a deliberately small bounded preset catalog', () => {
    expect(DYNAMIC_ZOOM_PRESETS.map(({ id }) => id)).toEqual([
      'gentle-in',
      'gentle-out',
      'reframe-left-right',
      'reframe-top-bottom',
    ])
    for (const preset of DYNAMIC_ZOOM_PRESETS) {
      for (const framing of [preset.start, preset.end]) {
        expect(framing.focusX).toBeGreaterThanOrEqual(-1)
        expect(framing.focusX).toBeLessThanOrEqual(1)
        expect(framing.focusY).toBeGreaterThanOrEqual(-1)
        expect(framing.focusY).toBeLessThanOrEqual(1)
        expect(framing.zoom).toBeGreaterThanOrEqual(1)
        expect(framing.zoom).toBeLessThanOrEqual(4)
      }
    }
  })

  test('emits only ordinary position/scale tracks and clamps a long preset to a short clip', () => {
    const item = clip({ timelineRange: { startFrame: 12, durationFrames: 30 } })
    const request = dynamicZoomRequestFromPreset('gentle-in', 90)
    const result = createDynamicZoomPlan(doc(item), item, { width: 1920, height: 1080 }, request)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.durationFrames).toBe(30)
    expect(result.plan.durationClamped).toBe(true)
    expect(result.plan.tracks.map(({ property }) => property)).toEqual([
      'position-x',
      'position-y',
      'scale-x',
      'scale-y',
    ])
    expect(result.plan.tracks.every(({ keyframes }) => (
      keyframes.length === 2
      && keyframes[0].frame === 0
      && keyframes[1].frame === 29
      && keyframes.every(({ sourceTimeTicks }) => sourceTimeTicks === undefined)
    ))).toBe(true)
  })

  test('keeps horizontal, vertical, square, cropped, anchored, and rotated framing safe', () => {
    const cases = [
      { canvas: [1920, 1080], source: { width: 1080, height: 1920 }, rotation: 0 },
      { canvas: [1080, 1920], source: { width: 3840, height: 2160 }, rotation: 0 },
      { canvas: [1080, 1080], source: { width: 1920, height: 1080 }, rotation: 27 },
      { canvas: [1440, 1800], source: { width: 2048, height: 1536 }, rotation: -73 },
    ] as const
    for (const entry of cases) {
      const item = clip({
        transform: {
          x: 18,
          y: -11,
          scaleX: 0.8,
          scaleY: 0.9,
          rotation: entry.rotation,
          anchorX: 0.2,
          anchorY: 0.8,
        },
        visual: {
          ...defaultClipVisualSettings(),
          crop: { left: 0.12, right: 0.03, top: 0.07, bottom: 0.18 },
        },
      })
      const document = doc(item, entry.canvas[0], entry.canvas[1])
      const request = {
        ...dynamicZoomRequestFromPreset('reframe-left-right', 80),
        start: { focusX: -1, focusY: 0.9, zoom: 1.75 },
        end: { focusX: 1, focusY: -0.9, zoom: 2.25 },
      }
      const result = createDynamicZoomPlan(document, item, entry.source, request)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expectCanvasCovered(document, item, entry.source, result.plan.start)
      expectCanvasCovered(document, item, entry.source, result.plan.end)
      for (const frame of [1, 17, 39, 63, 78]) {
        const [x, y, scaleX, scaleY] = result.plan.tracks.map((track) => (
          evaluateAnimationTrack(track, frame, Number.NaN)
        ))
        expect(scaleY).toBeCloseTo(scaleX, 12)
        expectCanvasCovered(document, item, entry.source, { x, y, scale: scaleX })
      }
    }
  })

  test('keeps off-center horizontal, vertical, and combined flips safe', () => {
    const exact = clip({
      transform: {
        ...clip().transform,
        anchorX: 0.2,
      },
      visual: {
        ...defaultClipVisualSettings(),
        flipHorizontal: true,
      },
    })
    const exactDocument = doc(exact, 1_000, 1_000)
    const exactSource = { width: 1_000, height: 1_000 }
    const exactResult = createDynamicZoomPlan(
      exactDocument,
      exact,
      exactSource,
      dynamicZoomRequestFromPreset('gentle-in', 90),
    )
    expect(exactResult.ok).toBe(true)
    if (!exactResult.ok) return
    expect(exactResult.plan.start.x).toBeCloseTo(600, 12)
    expectCanvasCovered(exactDocument, exact, exactSource, exactResult.plan.start)

    const cases = [
      {
        canvas: [1_400, 900],
        source: { width: 1_920, height: 1_080 },
        anchor: [0.17, 0.76],
        rotation: 0,
        crop: { left: 0, right: 0, top: 0, bottom: 0 },
        flipHorizontal: true,
        flipVertical: false,
      },
      {
        canvas: [900, 1_400],
        source: { width: 1_080, height: 1_920 },
        anchor: [0.78, 0.23],
        rotation: 0,
        crop: { left: 0, right: 0, top: 0, bottom: 0 },
        flipHorizontal: false,
        flipVertical: true,
      },
      {
        canvas: [1_440, 1_080],
        source: { width: 2_048, height: 1_536 },
        anchor: [0.18, 0.82],
        rotation: 31,
        crop: { left: 0.13, right: 0.04, top: 0.08, bottom: 0.17 },
        flipHorizontal: true,
        flipVertical: true,
      },
      {
        canvas: [1_080, 1_080],
        source: { width: 1_920, height: 1_080 },
        anchor: [0.5, 0.5],
        rotation: -27,
        crop: { left: 0.07, right: 0.11, top: 0.03, bottom: 0.16 },
        flipHorizontal: true,
        flipVertical: false,
      },
    ] as const

    for (const entry of cases) {
      const item = clip({
        transform: {
          ...clip().transform,
          rotation: entry.rotation,
          anchorX: entry.anchor[0],
          anchorY: entry.anchor[1],
        },
        visual: {
          ...defaultClipVisualSettings(),
          crop: entry.crop,
          flipHorizontal: entry.flipHorizontal,
          flipVertical: entry.flipVertical,
        },
      })
      const document = doc(item, entry.canvas[0], entry.canvas[1])
      const request = {
        ...dynamicZoomRequestFromPreset('reframe-left-right', 80),
        start: { focusX: -0.9, focusY: 0.75, zoom: 1.6 },
        end: { focusX: 0.85, focusY: -0.8, zoom: 2.1 },
      }
      const result = createDynamicZoomPlan(document, item, entry.source, request)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expectCanvasCovered(document, item, entry.source, result.plan.start)
      expectCanvasCovered(document, item, entry.source, result.plan.end)
      for (const frame of [1, 13, 37, 58, 78]) {
        const [x, y, scaleX, scaleY] = result.plan.tracks.map((track) => (
          evaluateAnimationTrack(track, frame, Number.NaN)
        ))
        expect(scaleY).toBeCloseTo(scaleX, 12)
        expectCanvasCovered(document, item, entry.source, { x, y, scale: scaleX })
      }
    }
  })

  test('reverses endpoints and cubic easing as a true time reversal', () => {
    const original = dynamicZoomRequestFromPreset('reframe-left-right', 60)
    const reversed = reverseDynamicZoomRequest(original)
    expect(reversed.start).toEqual(original.end)
    expect(reversed.end).toEqual(original.start)
    expect(reversed.easing).toEqual({
      type: 'cubic-bezier',
      x1: 0.42000000000000004,
      y1: 0,
      x2: 0.5800000000000001,
      y2: 1,
    })

    const item = clip()
    const source = { width: 3840, height: 2160 }
    const forwardPlan = createDynamicZoomPlan(doc(item), item, source, original)
    const reversePlan = createDynamicZoomPlan(doc(item), item, source, reversed)
    expect(forwardPlan.ok && reversePlan.ok).toBe(true)
    if (!forwardPlan.ok || !reversePlan.ok) return
    expect(reversePlan.plan.start).toEqual(forwardPlan.plan.end)
    expect(reversePlan.plan.end).toEqual(forwardPlan.plan.start)
  })

  test('explains one-frame, text, missing-dimension, and animated-rotation exclusions', () => {
    const source = { width: 1920, height: 1080 }
    const oneFrame = clip({ timelineRange: { startFrame: 0, durationFrames: 1 } })
    expect(dynamicZoomAvailabilityReason(doc(oneFrame), oneFrame, source))
      .toContain('at least 2 frames')

    const text = clip({ text: {} as Clip['text'] })
    expect(dynamicZoomAvailabilityReason(doc(text), text, source))
      .toContain('not available for text overlays')

    expect(dynamicZoomAvailabilityReason(doc(), clip(), null))
      .toContain('known positive source dimensions')

    const rotated = clip({
      animation: {
        tracks: [{
          property: 'rotation',
          keyframes: [
            { frame: 0, value: 0, easing: { type: 'linear' } },
            { frame: 20, value: 45, easing: { type: 'linear' } },
          ],
        }],
        effectTracks: [],
      },
    })
    expect(dynamicZoomAvailabilityReason(doc(rotated), rotated, source))
      .toContain('Reset Rotation animation')
  })
})
