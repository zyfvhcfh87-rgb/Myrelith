import { describe, expect, test, vi } from 'vitest'
import { evaluateAnimationTrack, resolveClipAnimationAtFrame } from './clipAnimation'
import { defaultClipVisualSettings } from './clipInspector'
import { dynamicZoomRequestFromPreset, reverseDynamicZoomRequest } from './dynamicZoom'
import { applyDynamicZoom, resetClipFramingAnimation } from './operations'
import type { Clip, TimelineDoc, Track } from './schema'
import { clipWithAnimationKeyframeCount } from '../test/animationBudgetFixtures'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Framing clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 90 },
    timelineRange: { startFrame: 10, durationFrames: 90 },
    transform: {
      x: 12,
      y: -4,
      scaleX: 0.8,
      scaleY: 0.9,
      rotation: 12,
      anchorX: 0.3,
      anchorY: 0.7,
    },
    opacity: 0.8,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: {
      tracks: [
        {
          property: 'position-x',
          keyframes: [{ frame: 5, value: 90, easing: { type: 'linear' } }],
        },
        {
          property: 'opacity',
          keyframes: [
            { frame: 0, value: 0.2, easing: { type: 'linear' } },
            { frame: 89, value: 0.8, easing: { type: 'linear' } },
          ],
        },
      ],
      effectTracks: [],
    },
    effects: [],
    ...overrides,
  }
}

function track(item: Clip, locked = false): Track {
  return {
    id: 'video-1',
    kind: 'video',
    name: 'Video 1',
    clips: [item],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function doc(item = clip(), locked = false): TimelineDoc {
  return {
    schemaVersion: 17,
    id: 'doc-framing',
    name: 'Framing operation',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [track(item, locked)],
  }
}

function editedClip(document: TimelineDoc): Clip {
  return document.tracks[0].clips[0]
}

describe('dynamic zoom document operations', () => {
  test('atomically replaces four framing tracks with normal source-time-aware keys', () => {
    const original = doc()
    const request = dynamicZoomRequestFromPreset('gentle-in', 60)
    const next = applyDynamicZoom(
      original,
      'clip-1',
      { width: 3840, height: 2160 },
      request,
    )

    expect(next).not.toBe(original)
    expect(editedClip(original).animation?.tracks[0].keyframes[0].frame).toBe(5)
    const animation = editedClip(next).animation
    expect(animation?.tracks.map(({ property }) => property)).toEqual([
      'position-x',
      'position-y',
      'scale-x',
      'scale-y',
      'opacity',
    ])
    for (const track of animation?.tracks.slice(0, 4) ?? []) {
      expect(track.keyframes.map(({ frame }) => frame)).toEqual([0, 59])
      expect(track.keyframes.map(({ sourceTimeTicks }) => sourceTimeTicks))
        .toEqual([0, 59_000_000])
    }
    expect(animation?.tracks.at(-1)).toEqual(editedClip(original).animation?.tracks[1])
    expect(editedClip(next).transform).toEqual(editedClip(original).transform)
    expect(editedClip(next).opacity).toBe(0.8)

    const applied = editedClip(next)
    const interiorLocalFrame = 29
    const resolved = resolveClipAnimationAtFrame(
      applied,
      applied.timelineRange.startFrame + interiorLocalFrame,
    )
    const positionX = animation?.tracks.find(({ property }) => property === 'position-x')
    const scaleX = animation?.tracks.find(({ property }) => property === 'scale-x')
    expect(positionX).toBeDefined()
    expect(scaleX).toBeDefined()
    expect(resolved.transform.x).toBeCloseTo(evaluateAnimationTrack(
      positionX!,
      interiorLocalFrame,
      applied.transform.x,
    ))
    expect(resolved.transform.scaleX).toBeCloseTo(evaluateAnimationTrack(
      scaleX!,
      interiorLocalFrame,
      applied.transform.scaleX,
    ))
    expect(resolved.transform.x).not.toBe(applied.transform.x)
    expect(resolved.transform.scaleX).not.toBe(applied.transform.scaleX)
  })

  test('reverse is a separate ordinary-track edit and an exact repeat is idempotent', () => {
    const original = doc()
    const request = dynamicZoomRequestFromPreset('reframe-left-right', 45)
    const forward = applyDynamicZoom(
      original,
      'clip-1',
      { width: 3840, height: 2160 },
      request,
    )
    const repeated = applyDynamicZoom(
      forward,
      'clip-1',
      { width: 3840, height: 2160 },
      request,
    )
    const reversed = applyDynamicZoom(
      forward,
      'clip-1',
      { width: 3840, height: 2160 },
      reverseDynamicZoomRequest(request),
    )

    expect(repeated).toBe(forward)
    expect(reversed).not.toBe(forward)
    const forwardX = editedClip(forward).animation?.tracks[0].keyframes ?? []
    const reversedX = editedClip(reversed).animation?.tracks[0].keyframes ?? []
    expect(reversedX.map(({ value }) => value))
      .toEqual(forwardX.map(({ value }) => value).reverse())
  })

  test('reset explicitly removes every framing track but preserves unrelated curves and static values', () => {
    const applied = applyDynamicZoom(
      doc(),
      'clip-1',
      { width: 3840, height: 2160 },
      dynamicZoomRequestFromPreset('gentle-in', 60),
    )
    const reset = resetClipFramingAnimation(applied, 'clip-1')
    const item = editedClip(reset)

    expect(item.animation?.tracks.map(({ property }) => property)).toEqual(['opacity'])
    expect(item.transform).toEqual(editedClip(applied).transform)
    expect(item.opacity).toBe(editedClip(applied).opacity)
    expect(resetClipFramingAnimation(reset, 'clip-1')).toBe(reset)
  })

  test('preserves effect tracks through apply and reset', () => {
    const effectTracks = [{
      effectId: 'mask-a',
      parameter: 'x',
      keyframes: [{
        frame: 0,
        sourceTimeTicks: 0,
        value: 0.25,
        easing: { type: 'linear' as const },
      }],
    }]
    const originalClip = clip({
      animation: {
        tracks: clip().animation?.tracks ?? [],
        effectTracks,
      },
    })
    const applied = applyDynamicZoom(
      doc(originalClip),
      originalClip.id,
      { width: 3_840, height: 2_160 },
      dynamicZoomRequestFromPreset('gentle-in', 60),
    )
    const reset = resetClipFramingAnimation(applied, originalClip.id)

    expect(editedClip(applied).animation?.effectTracks).toEqual(effectTracks)
    expect(editedClip(reset).animation?.effectTracks).toEqual(effectTracks)
  })

  test('rejects document-wide key growth before replacing framing tracks', () => {
    const capped = doc(clipWithAnimationKeyframeCount(clip()))
    const next = applyDynamicZoom(
      capped,
      'clip-1',
      { width: 3_840, height: 2_160 },
      dynamicZoomRequestFromPreset('gentle-in', 60),
    )

    expect(next).toBe(capped)
  })

  test('supports stills and rejects text, locked tracks, and animated rotation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const still = clip({
      sourceMode: 'still',
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })
    const request = dynamicZoomRequestFromPreset('gentle-out', 30)
    const stillDocument = doc(still)
    expect(applyDynamicZoom(
      stillDocument,
      still.id,
      { width: 1600, height: 1200 },
      request,
    )).not.toBe(stillDocument)

    const text = clip({ text: {} as Clip['text'] })
    const textDoc = doc(text)
    expect(applyDynamicZoom(textDoc, text.id, { width: 800, height: 400 }, request))
      .toBe(textDoc)

    const locked = doc(clip(), true)
    expect(applyDynamicZoom(locked, 'clip-1', { width: 1920, height: 1080 }, request))
      .toBe(locked)

    const rotating = clip({
      animation: {
        tracks: [{
          property: 'rotation',
          keyframes: [{ frame: 0, value: 0, easing: { type: 'linear' } }],
        }],
        effectTracks: [],
      },
    })
    const rotatingDoc = doc(rotating)
    expect(applyDynamicZoom(
      rotatingDoc,
      rotating.id,
      { width: 1920, height: 1080 },
      request,
    )).toBe(rotatingDoc)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
