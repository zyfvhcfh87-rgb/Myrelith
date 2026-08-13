import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultClipAnimation } from '../domain/clipAnimation'
import { defaultClipVisualSettings } from '../domain/clipInspector'
import type { MotionTrackingPlan } from '../domain/motionTracking'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from './documentStore'

function clip(id: string): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 20 },
    timelineRange: { startFrame: 0, durationFrames: 20 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function track(id: string, item: Clip): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips: [item],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function document(): TimelineDoc {
  return {
    schemaVersion: 13,
    id: 'tracking-store',
    name: 'Tracking store',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [track('source-track', clip('source')), track('target-track', clip('target'))],
  }
}

const plan: MotionTrackingPlan = {
  sourceClipId: 'source',
  targetClipId: 'target',
  kind: 'point',
  includeScale: false,
  direction: 'forward',
  sampleCount: 2,
  confidenceMinimum: 0.8,
  confidenceMean: 0.9,
  stopped: null,
  replacementRequired: false,
  tracks: [
    {
      property: 'position-x',
      keyframes: [
        { frame: 0, sourceTimeTicks: 0, value: 0, easing: { type: 'linear' } },
        { frame: 1, sourceTimeTicks: 1_000_000, value: 2, easing: { type: 'linear' } },
      ],
    },
    {
      property: 'position-y',
      keyframes: [
        { frame: 0, sourceTimeTicks: 0, value: 0, easing: { type: 'linear' } },
        { frame: 1, sourceTimeTicks: 1_000_000, value: 1, easing: { type: 'linear' } },
      ],
    },
  ],
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useDocumentStore.getState().setDoc(document())
})

afterEach(() => vi.restoreAllMocks())

describe('motion tracking document history', () => {
  test('applies every generated track as one byte-exact undo entry', () => {
    const before = useDocumentStore.getState().doc
    const result = useDocumentStore.getState().applyMotionTracking(plan, false)

    expect(result).toMatchObject({ ok: true, changed: true })
    expect(useDocumentStore.getState().past).toEqual([before])
    const authored = useDocumentStore.getState().doc
    expect(authored).not.toBe(before)

    useDocumentStore.getState().undo()
    expect(useDocumentStore.getState().doc).toBe(before)
    expect(useDocumentStore.getState().future).toEqual([authored])
  })
})
