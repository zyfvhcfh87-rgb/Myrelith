import { describe, expect, test } from 'vitest'
import type { Clip } from '../../domain/schema'
import type { AssetVisuals } from '../../state/mediaStore'
import type { EditPreview } from '../../state/transportStore'
import {
  planClipPresentation,
  type ClipPresentationPlanInput,
} from './clipVisualPlan'

function makeClip(
  id = 'clip-1',
  timelineStart = 0,
  durationFrames = 100,
  sourceStart = 0,
): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: sourceStart, durationFrames },
    timelineRange: { startFrame: timelineStart, durationFrames },
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
    effects: [],
  }
}

const visuals: AssetVisuals = {
  filmstrip: {
    url: 'blob:strip',
    tiles: 5,
    tileWidth: 78,
    tileHeight: 44,
  },
  waveform: { url: 'blob:wave', width: 1_000, height: 44 },
}

function plan(
  overrides: Partial<ClipPresentationPlanInput> = {},
) {
  return planClipPresentation({
    clip: makeClip(),
    trackKind: 'video',
    zoom: 2,
    tool: 'select',
    movePreviewDelta: null,
    editPreview: null,
    ownsLiveGesture: false,
    timelineOriginFrame: 0,
    timelineWindowEndFrame: 1_000,
    assetDurationFrames: 300,
    visuals,
    ...overrides,
  })
}

describe('planClipPresentation', () => {
  test('maps an ordinary timed clip into bounded filmstrip tiles', () => {
    const result = plan({ clip: makeClip('clip-1', 25, 100, 60) })

    expect(result).toMatchObject({
      hasVisibleSlice: true,
      displayedStartFrame: 25,
      displayedEndFrame: 125,
      displayedDurationFrames: 100,
      localStartPx: 50,
      showStartEdge: true,
      showEndEdge: true,
      accessibleKind: 'video',
    })
    expect(result?.visual).toEqual({
      kind: 'filmstrip',
      source: visuals.filmstrip,
      tiles: [
        { index: 1, leftPx: 0, widthPx: 120, patternX: -0, spriteX: -78 },
        { index: 2, leftPx: 120, widthPx: 80, patternX: -0, spriteX: -156 },
      ],
    })
  })

  test('maps retimed filmstrips and waveforms through the same source interval', () => {
    const clip: Clip = {
      ...makeClip('retimed', 25, 50, 60),
      sourceRange: { startFrame: 60, durationFrames: 100 },
      sourceTimeMap: {
        sourceStartTicks: 60_000_000,
        sourceDurationTicks: 100_000_000,
        rate: { numerator: 2, denominator: 1 },
      },
    }
    const filmstrip = plan({ clip })
    const waveform = plan({ clip, trackKind: 'audio' })

    expect(filmstrip?.visual).toEqual({
      kind: 'filmstrip',
      source: visuals.filmstrip,
      tiles: [
        { index: 0, leftPx: 0, widthPx: 40, patternX: -60, spriteX: -0 },
        { index: 1, leftPx: 40, widthPx: 60, patternX: -0, spriteX: -156 },
      ],
    })
    expect(waveform?.visual).toMatchObject({
      kind: 'waveform',
      viewBox: `${60 / 300} 0 ${100 / 300} 1`,
    })
  })

  test.each<{
    kind: EditPreview['kind']
    displayedStartFrame: number
    displayedEndFrame: number
    sourceStartFraction: number
  }>([
    {
      kind: 'trim-start',
      displayedStartFrame: 10,
      displayedEndFrame: 100,
      sourceStartFraction: 10 / 300,
    },
    {
      kind: 'ripple-start',
      displayedStartFrame: 0,
      displayedEndFrame: 90,
      sourceStartFraction: 10 / 300,
    },
    {
      kind: 'trim-end',
      displayedStartFrame: 0,
      displayedEndFrame: 110,
      sourceStartFraction: 0,
    },
    {
      kind: 'ripple-end',
      displayedStartFrame: 0,
      displayedEndFrame: 110,
      sourceStartFraction: 0,
    },
    {
      kind: 'slide',
      displayedStartFrame: 10,
      displayedEndFrame: 110,
      sourceStartFraction: 0,
    },
    {
      kind: 'slip',
      displayedStartFrame: 0,
      displayedEndFrame: 100,
      sourceStartFraction: 10 / 300,
    },
  ])(
    'projects a $kind preview without mutating committed geometry',
    ({
      kind,
      displayedStartFrame,
      displayedEndFrame,
      sourceStartFraction,
    }) => {
      const result = plan({
        trackKind: 'audio',
        editPreview: {
          clipId: 'clip-1',
          kind,
          deltaFrames: 10,
        },
      })

      expect(result).toMatchObject({
        dragging: true,
        badge: `${kind} +10`,
        displayedStartFrame,
        displayedEndFrame,
      })
      expect(result?.visual).toMatchObject({
        kind: 'waveform',
        viewBox:
          `${sourceStartFraction} 0 `
          + `${(displayedEndFrame - displayedStartFrame) / 300} 1`,
      })
    },
  )

  test('keeps a rebased long-window slice aligned in source time', () => {
    const result = plan({
      clip: makeClip('long', 0, 2_000_000),
      trackKind: 'audio',
      timelineOriginFrame: 1_000_000,
      timelineWindowEndFrame: 1_100_000,
      assetDurationFrames: 2_000_000,
    })

    expect(result).toMatchObject({
      displayedStartFrame: 1_000_000,
      displayedEndFrame: 1_100_000,
      displayedDurationFrames: 100_000,
      localStartPx: 0,
      showStartEdge: false,
      showEndEdge: false,
    })
    expect(result?.visual).toMatchObject({
      kind: 'waveform',
      viewBox: '0.5 0 0.05 1',
    })
  })

  test('retains only a non-visual edge host for an offscreen live gesture', () => {
    const input = {
      clip: makeClip('offscreen', 0, 100),
      timelineOriginFrame: 200,
      timelineWindowEndFrame: 300,
    }

    expect(plan(input)).toBeNull()
    expect(plan({ ...input, ownsLiveGesture: true })).toMatchObject({
      hasVisibleSlice: false,
      displayedStartFrame: 200,
      displayedEndFrame: 200,
      displayedDurationFrames: 0,
      localStartPx: 0,
      visual: null,
    })
  })

  test('repeats one still tile across an extended timeline duration', () => {
    const still: Clip = {
      ...makeClip('still', 0, 150),
      sourceMode: 'still',
      sourceRange: { startFrame: 0, durationFrames: 1 },
    }
    const result = plan({
      clip: still,
      assetDurationFrames: 1,
      visuals: {
        filmstrip: {
          url: 'blob:still',
          tiles: 1,
          tileWidth: 78,
          tileHeight: 44,
        },
        waveform: null,
      },
      editPreview: {
        clipId: still.id,
        kind: 'trim-end',
        deltaFrames: 150,
      },
    })

    expect(result).toMatchObject({
      isStillSource: true,
      displayedDurationFrames: 300,
      accessibleKind: 'still image',
    })
    expect(result?.visual).toMatchObject({
      kind: 'filmstrip',
      tiles: [{ index: 0, leftPx: 0, widthPx: 600 }],
    })
    expect(plan({ clip: still, tool: 'slip' })?.interactionTitle).toBe(
      'Still images always show their single source frame, so Slip is unavailable.',
    )
  })
})
