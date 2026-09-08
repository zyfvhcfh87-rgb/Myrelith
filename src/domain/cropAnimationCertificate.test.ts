import { describe, expect, test } from 'vitest'
import { cropInsetsValidationError, MAX_CROP_SUM } from './clipInspector'
import {
  certifyCropAnimation,
  certifyCropAnimations,
  CROP_CERTIFICATE_LIMITS,
  type CropAnimationCertificateRequest,
} from './cropAnimationCertificate'
import { MASK_PATH_ANIMATION_LIMITS } from './maskPathAnimation'
import { evaluateAnimationTrack, MAX_KEYFRAME_FRAME, MAX_KEYFRAMES_PER_TRACK } from './scalarAnimation'
import type { ClipAnimationEasing, ClipAnimationKeyframe } from './schema'

const zero = { left: 0, right: 0, top: 0, bottom: 0 }
const linear: ClipAnimationEasing = { type: 'linear' }
const hold: ClipAnimationEasing = { type: 'hold' }
const easeOut: ClipAnimationEasing = { type: 'cubic-bezier', x1: 0, y1: 1, x2: 0, y2: 1 }
const easeIn: ClipAnimationEasing = { type: 'cubic-bezier', x1: 1, y1: 0, x2: 1, y2: 0 }

function key(frame: number, value: number, easing = linear): ClipAnimationKeyframe {
  return { frame, value, easing }
}

function request(tracks: CropAnimationCertificateRequest['tracks'] = {}, startFrame = 0, endFrame = 20): CropAnimationCertificateRequest {
  return { crop: zero, tracks, startFrame, endFrame }
}

function evaluateCrop(candidate: CropAnimationCertificateRequest, frame: number) {
  const crop = { ...candidate.crop }
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const track = candidate.tracks[edge]
    if (track) crop[edge] = evaluateAnimationTrack(track, frame, crop[edge])
  }
  return crop
}

function nextAbove(value: number): number {
  const bytes = new DataView(new ArrayBuffer(8))
  bytes.setFloat64(0, value)
  bytes.setBigUint64(0, bytes.getBigUint64(0) + 1n)
  return bytes.getFloat64(0)
}

describe('standalone crop animation certificate', () => {
  test('admits static equality at 0.99 over the entire signed frame range in one visit', () => {
    const candidate = { ...request({}, -MAX_KEYFRAME_FRAME, MAX_KEYFRAME_FRAME), crop: { ...zero, left: MAX_CROP_SUM } }
    expect(certifyCropAnimation(candidate)).toEqual({ ok: true, intervals: 1, evaluatedFrames: 0 })
    expect(MASK_PATH_ANIMATION_LIMITS.maximumFrameMagnitude).toBe(MAX_KEYFRAME_FRAME)
  })

  test('does not admit one representable number above 0.99 or a rounded opposing-edge excess', () => {
    expect(certifyCropAnimation({ ...request(), crop: { ...zero, left: nextAbove(MAX_CROP_SUM) } })).toMatchObject({ ok: false, reason: 'invalid-input', intervals: 0 })
    // One step above 0.49 still rounds back to 0.99 when added to 0.5.
    const roundedBoundary = request({ left: { keyframes: [key(0, 0.5, hold)] }, right: { keyframes: [key(0, nextAbove(0.49), hold)] } })
    expect(certifyCropAnimation(roundedBoundary).ok).toBe(true)
    const candidate = request({ left: { keyframes: [key(0, 0.5, hold)] }, right: { keyframes: [key(0, nextAbove(nextAbove(0.49)), hold)] } })
    expect(0.5 + nextAbove(nextAbove(0.49))).toBeGreaterThan(MAX_CROP_SUM)
    const result = certifyCropAnimation(candidate)
    expect(result).toMatchObject({ ok: false, reason: 'unsafe-crop', frame: 0 })
    if (!result.ok && result.frame !== undefined) expect(cropInsetsValidationError(evaluateCrop(candidate, result.frame))).not.toBeNull()
  })

  test('certifies constant cubic and hold tracks without inspecting duration-sized frame sets', () => {
    const candidate = request({
      left: { keyframes: [key(-100, 0.99, easeOut), key(100, 0.99, easeIn)] },
      top: { keyframes: [key(-150, 0.25, hold), key(140, 0.3, hold)] },
      bottom: { keyframes: [key(-140, 0.74, hold), key(140, 0.69, hold)] },
    }, -MAX_KEYFRAME_FRAME, MAX_KEYFRAME_FRAME)
    const result = certifyCropAnimation(candidate)
    expect(result.ok).toBe(true)
    expect(result.intervals).toBeLessThanOrEqual(7)
    expect(result.evaluatedFrames).toBe(0)
  })

  test('finds an unsafe interior even when every opposing pair of endpoints is legal', () => {
    const candidate = request({
      left: { keyframes: [key(0, 0, easeOut), key(20, 0.8)] },
      right: { keyframes: [key(0, 0.8, easeIn), key(20, 0)] },
    })
    expect(cropInsetsValidationError(evaluateCrop(candidate, 0))).toBeNull()
    expect(cropInsetsValidationError(evaluateCrop(candidate, 20))).toBeNull()
    const result = certifyCropAnimation(candidate)
    expect(result).toMatchObject({ ok: false, reason: 'unsafe-crop' })
    if (!result.ok && result.frame !== undefined) {
      expect(result.frame).toBeGreaterThan(0)
      expect(result.frame).toBeLessThan(20)
      expect(cropInsetsValidationError(evaluateCrop(candidate, result.frame))).not.toBeNull()
    }
  })

  test('certifies safe opposing linear animation across two billion frames with bounded work', () => {
    const candidate = request({
      left: { keyframes: [key(-MAX_KEYFRAME_FRAME, 0), key(MAX_KEYFRAME_FRAME, 0.8)] },
      right: { keyframes: [key(-MAX_KEYFRAME_FRAME, 0.8), key(MAX_KEYFRAME_FRAME, 0)] },
    }, -MAX_KEYFRAME_FRAME, MAX_KEYFRAME_FRAME)
    const result = certifyCropAnimation(candidate)
    expect(result.ok).toBe(true)
    expect(result.intervals).toBeLessThan(200)
    expect(result.evaluatedFrames).toBeLessThan(5)
  })

  test('partitions different key boundaries and rejects unsafe exact hold jumps', () => {
    const candidate = request({
      left: { keyframes: [key(-20, 0.2, hold), key(7, 0.7, hold)] },
      right: { keyframes: [key(-9, 0.3, hold), key(8, 0.2, hold)] },
    }, -30, 30)
    expect(certifyCropAnimation(candidate)).toMatchObject({ ok: false, reason: 'unsafe-crop', frame: 7 })
    expect(certifyCropAnimation({ ...candidate, endFrame: 6 }).ok).toBe(true)
    expect(certifyCropAnimation({ ...candidate, startFrame: 8 }).ok).toBe(true)
  })

  test('certifies safe cubic movement across a huge range with crossed and degenerate controls', () => {
    for (const x1 of [0, 1]) for (const x2 of [0, 1]) for (const y1 of [0, 1]) for (const y2 of [0, 1]) {
      const easing: ClipAnimationEasing = { type: 'cubic-bezier', x1, x2, y1, y2 }
      const candidate = request({
        left: { keyframes: [key(-MAX_KEYFRAME_FRAME, 0.1, easing), key(MAX_KEYFRAME_FRAME, 0.4)] },
        right: { keyframes: [key(-MAX_KEYFRAME_FRAME, 0.4, easing), key(MAX_KEYFRAME_FRAME, 0.1)] },
      }, -MAX_KEYFRAME_FRAME, MAX_KEYFRAME_FRAME)
      const result = certifyCropAnimation(candidate)
      expect(result.ok, JSON.stringify(easing)).toBe(true)
      expect(result.intervals).toBeLessThan(300)
    }
  })

  test('uses exact keyed endpoints despite the cubic primitive endpoint approximation', () => {
    const candidate = request({ left: { keyframes: [key(-1, 0.99, easeOut), key(0, 0)] } }, -1, 0)
    expect(certifyCropAnimation(candidate)).toEqual({ ok: true, intervals: 2, evaluatedFrames: 2 })
  })

  test('returns unproven on work exhaustion and never mutates inputs or raises its cap', () => {
    const candidate = request({
      left: { keyframes: [key(0, 0), key(1000, 0.49)] },
      right: { keyframes: [key(0, 0.49), key(1000, 0)] },
    }, 0, 1000)
    const before = JSON.stringify(candidate)
    expect(certifyCropAnimation(candidate, 1)).toMatchObject({ ok: false, reason: 'proof-budget', intervals: 1 })
    expect(certifyCropAnimation(candidate).ok).toBe(true)
    for (const budget of [0, -1, 0.5, Infinity, CROP_CERTIFICATE_LIMITS.intervalsPerClip + 1]) {
      expect(certifyCropAnimation(candidate, budget)).toMatchObject({ ok: false, reason: 'invalid-input', intervals: 0 })
    }
    expect(JSON.stringify(candidate)).toBe(before)
  })

  test('validates signed frame, key, easing and value bounds before proving', () => {
    const valid = key(0, 0.1)
    const candidates = [
      request({}, 1, 0), request({}, 0.5, 10), request({}, -MAX_KEYFRAME_FRAME - 1, 0), request({}, 0, Infinity),
      request({ left: { keyframes: [] } }),
      request({ left: { keyframes: [valid, valid] } }),
      request({ left: { keyframes: [key(MAX_KEYFRAME_FRAME + 1, 0)] } }),
      request({ left: { keyframes: [key(0, nextAbove(0.99))] } }),
      request({ left: { keyframes: [key(0, -Number.MIN_VALUE)] } }),
      request({ left: { keyframes: [key(0, NaN)] } }),
      request({ left: { keyframes: [{ ...valid, sourceTimeTicks: 1.5 }] } }),
      request({ left: { keyframes: [key(0, 0.1, { ...easeOut, x1: 1.01 })] } }),
    ]
    for (const candidate of candidates) expect(certifyCropAnimation(candidate)).toMatchObject({ ok: false, reason: 'invalid-input', intervals: 0 })
    const keys: ClipAnimationKeyframe[] = new Array(MAX_KEYFRAMES_PER_TRACK + 1)
    Object.defineProperty(keys, 0, { get() { throw new Error('oversized payload must not be traversed') } })
    expect(certifyCropAnimation(request({ left: { keyframes: keys } }))).toMatchObject({ ok: false, reason: 'invalid-input', intervals: 0 })
  })

  test('matches exhaustive integer-frame oracles across all cubic control corners and edge values', () => {
    const easings: ClipAnimationEasing[] = [hold, linear]
    for (const x1 of [0, 1]) for (const x2 of [0, 1]) for (const y1 of [0, 1]) for (const y2 of [0, 1]) {
      easings.push({ type: 'cubic-bezier', x1, x2, y1, y2 })
    }
    let accepted = 0, rejected = 0
    for (const easing of easings) for (const first of [0, Number.MIN_VALUE, 0.2, 0.49, 0.99]) {
      for (const second of [0, Number.MIN_VALUE, 0.2, 0.49, 0.99]) {
        const candidate = request({
          left: { keyframes: [key(-7, first, easing), key(9, second)] },
          right: { keyframes: [key(-6, second, easing), key(8, first)] },
        }, -10, 12)
        const invalidFrames = []
        for (let frame = candidate.startFrame; frame <= candidate.endFrame; frame++) {
          if (cropInsetsValidationError(evaluateCrop(candidate, frame))) invalidFrames.push(frame)
        }
        const result = certifyCropAnimation(candidate)
        if (!result.ok) expect(result.reason, JSON.stringify(candidate)).not.toBe('proof-budget')
        if (result.ok) {
          accepted++
          expect(invalidFrames, JSON.stringify(candidate)).toEqual([])
        } else {
          rejected++
          expect(result.reason).toBe('unsafe-crop')
          expect(invalidFrames).toContain(result.frame)
        }
      }
    }
    expect(accepted).toBeGreaterThan(100)
    expect(rejected).toBeGreaterThan(100)
  })

  test('matches deterministic mixed-track exhaustive oracles without relying on samples for admission', () => {
    let seed = 0x199c0fee
    function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000 }
    for (let sample = 0; sample < 250; sample++) {
      const tracks: Partial<Record<'left' | 'right' | 'top' | 'bottom', { keyframes: ClipAnimationKeyframe[] }>> = {}
      for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
        if (random() < 0.2) continue
        tracks[edge] = { keyframes: [-13, -2, 4, 19].map((frame) => key(frame, random() * 0.99, random() < 0.2 ? hold : {
          type: 'cubic-bezier', x1: random(), x2: random(), y1: random(), y2: random(),
        })) }
      }
      const candidate = request(tracks, -17, 23)
      const result = certifyCropAnimation(candidate)
      const invalidFrames = []
      for (let frame = -17; frame <= 23; frame++) if (cropInsetsValidationError(evaluateCrop(candidate, frame))) invalidFrames.push(frame)
      if (result.ok) expect(invalidFrames).toEqual([])
      else {
        expect(result.reason).toBe('unsafe-crop')
        expect(invalidFrames).toContain(result.frame)
      }
    }
  })
})

describe('whole-project crop proof budgets', () => {
  test('aggregates successful work and identifies an unsafe candidate without partial approval', () => {
    const safe = request()
    const unsafe = request({ left: { keyframes: [key(0, 0.9)] }, right: { keyframes: [key(0, 0.2)] } })
    expect(certifyCropAnimations([safe, safe])).toMatchObject({ ok: true, requests: 2, intervals: 2, keyVisits: 0 })
    expect(certifyCropAnimations([safe, unsafe])).toMatchObject({ ok: false, reason: 'unsafe-crop', requests: 1, requestIndex: 1, frame: 0, keyVisits: 2 })
    expect(certifyCropAnimations([])).toMatchObject({ ok: true, requests: 0, intervals: 0 })
  })

  test('enforces aggregate remaining visits and rejects oversized requests before payload traversal', () => {
    const animated = request({ left: { keyframes: [key(0, 0), key(20, 0.5)] } })
    expect(certifyCropAnimations([request(), animated], 2)).toMatchObject({ ok: false, reason: 'proof-budget', intervals: 2, requestIndex: 1 })
    const oversized: CropAnimationCertificateRequest[] = new Array(2)
    Object.defineProperty(oversized, 0, { get() { throw new Error('oversized requests must not be traversed') } })
    expect(certifyCropAnimations(oversized, 1)).toMatchObject({ ok: false, reason: 'proof-budget', intervals: 0 })
    expect(certifyCropAnimations([], CROP_CERTIFICATE_LIMITS.intervalsPerProject + 1)).toMatchObject({ ok: false, reason: 'invalid-input' })
  })

  test('counts retained off-range keys toward a separate aggregate traversal cap', () => {
    const keyframes = Array.from({ length: MAX_KEYFRAMES_PER_TRACK }, (_, index) => key(index, 0))
    const candidate = request({ left: { keyframes } }, 2000, 2001)
    const result = certifyCropAnimations(Array.from({ length: 100 }, () => candidate))
    expect(result).toMatchObject({ ok: false, reason: 'proof-budget', requestIndex: 97, intervals: 97, keyVisits: 99_328 })
    expect(result.keyVisits).toBeLessThanOrEqual(CROP_CERTIFICATE_LIMITS.keyVisitsPerProject)
  })
})
