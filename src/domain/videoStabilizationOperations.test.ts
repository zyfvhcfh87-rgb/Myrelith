import { describe, expect, test, vi } from 'vitest'
import { defaultClipVisualSettings } from './clipInspector'
import {
  applyVideoStabilizationWithResult,
  resetVideoStabilizationWithResult,
} from './operations'
import type { Clip, TimelineDoc } from './schema'
import type { VideoStabilizationPlan } from './videoStabilization'

function clip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Stabilize me',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 0, durationFrames: 30 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: {
      tracks: [{
        property: 'rotation',
        keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 2, easing: { type: 'linear' } }],
      }, {
        property: 'opacity',
        keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 0.8, easing: { type: 'linear' } }],
      }],
      effectTracks: [],
    },
    effects: [],
  }
}

function doc(item = clip(), locked = false): TimelineDoc {
  return {
    schemaVersion: 17,
    id: 'doc',
    name: 'Doc',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video',
      kind: 'video',
      name: 'Video',
      clips: [item],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked,
    }],
  }
}

function plan(): VideoStabilizationPlan {
  const properties = ['position-x', 'position-y', 'rotation', 'scale-x', 'scale-y'] as const
  return {
    settings: { strengthPercent: 50, smoothingRadiusFrames: 4 },
    safeZoom: 1.05,
    requiredCropRatio: 1 - 1 / 1.05,
    sampleCount: 30,
    retainedKeyframeCount: 2,
    replacementRequired: true,
    jitterReductionRatio: 0.5,
    frames: [],
    tracks: properties.map((property) => ({
      property,
      keyframes: [0, 29].map((frame) => ({
        frame,
        sourceTimeTicks: frame * 1_000_000,
        value: property.startsWith('scale') ? 1.05 : 0,
        easing: { type: 'linear' as const },
      })),
    })),
  }
}

describe('video stabilization document operation', () => {
  test('requires confirmation, then replaces only five owned tracks atomically', () => {
    const original = doc()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rejected = applyVideoStabilizationWithResult(original, 'clip-1', plan(), false)
    expect(rejected.ok).toBe(false)
    expect(rejected.doc).toBe(original)

    const applied = applyVideoStabilizationWithResult(original, 'clip-1', plan(), true)
    expect(applied.ok).toBe(true)
    expect(applied.doc).not.toBe(original)
    expect(applied.doc.tracks[0]!.clips[0]!.animation?.tracks.map((track) => track.property))
      .toEqual(['position-x', 'position-y', 'scale-x', 'scale-y', 'rotation', 'opacity'])
    expect(original.tracks[0]!.clips[0]!.animation?.tracks).toHaveLength(2)
    warn.mockRestore()
  })

  test('reset removes all five owned properties and preserves unrelated animation', () => {
    const applied = applyVideoStabilizationWithResult(doc(), 'clip-1', plan(), true)
    expect(applied.ok).toBe(true)
    const reset = resetVideoStabilizationWithResult(applied.doc, 'clip-1')
    expect(reset.ok).toBe(true)
    expect(reset.doc.tracks[0]!.clips[0]!.animation?.tracks.map((track) => track.property))
      .toEqual(['opacity'])
  })

  test('locked tracks reject without changing the document', () => {
    const original = doc(clip(), true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = applyVideoStabilizationWithResult(original, 'clip-1', plan(), true)
    expect(result.ok).toBe(false)
    expect(result.doc).toBe(original)
    warn.mockRestore()
  })

  test('rechecks the document-wide keyframe budget at the immutable operation boundary', () => {
    const item = clip()
    const filler = {
      ...clip(),
      id: 'clip-filler',
      timelineRange: { startFrame: 40, durationFrames: 30 },
      animation: {
        tracks: [{
          property: 'opacity' as const,
          keyframes: Array.from({ length: 99_990 }, (_, frame) => ({
            frame: frame % 30,
            sourceTimeTicks: frame % 30 * 1_000_000,
            value: 1,
            easing: { type: 'linear' as const },
          })),
        }],
        effectTracks: [],
      },
    }
    const crowded = doc(item)
    crowded.tracks[0]!.clips.push(filler)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = applyVideoStabilizationWithResult(crowded, 'clip-1', plan(), true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('document keyframe budget')
    expect(result.doc).toBe(crowded)
    warn.mockRestore()
  })
})
