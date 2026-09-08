import { describe, expect, test } from 'vitest'
import { applyOrderedPixelEffectsToRgba } from './effectPixels'
import { createMaskEffect, DEFAULT_MASK_BEZIER_PATH, maskParams } from './effectStack'
import {
  cloneEffectPathAnimationTrack, effectPathAnimationTrackBoundsError, effectPathAnimationTracksBoundsError,
  evaluatePreparedEffectPathAnimationTrack, maskPathAnimationRetentionError,
  maskPathAnimationSnapshotBudget, prepareEffectPathAnimationTrack,
  type EffectPathAnimationTrack, type MaskPathAnimationRetention, type MaskPathAnimationSnapshot,
} from './maskPathAnimation'

const otherPath = 'M 0 0 C 1 0 1 1 0 0 Z'
function track(id = 'mask', count = 2, value = DEFAULT_MASK_BEZIER_PATH): EffectPathAnimationTrack {
  return { effectId: id, parameter: 'path', valueType: 'mask-bezier-path', valueVersion: 1,
    keyframes: Array.from({ length: count }, (_, frame) => ({ frame: frame * 10, sourceTimeTicks: frame * 10_000_000, value, easing: { type: 'hold' } })),
  }
}
function largeSnapshot(): MaskPathAnimationSnapshot {
  // Deliberately malformed geometry remains portable and consumes its full budget.
  return { tracks: [track('a', 256, 'x'.repeat(2048)), track('b', 256, 'x'.repeat(2048))] }
}
const empty = (): MaskPathAnimationSnapshot => ({ tracks: [] })

describe('typed held path value authority', () => {
  test('holds at boundaries and changes whole topology only on the exact key frame', () => {
    const authored = track()
    authored.keyframes[0].frame = -5
    authored.keyframes[1].value = otherPath
    const prepared = prepareEffectPathAnimationTrack(authored, createMaskEffect('mask', 'bezier'))
    expect(prepared.ok).toBe(true)
    for (const frame of [-100, -5, 0, 9]) expect(evaluatePreparedEffectPathAnimationTrack(prepared, frame, '')).toBe(DEFAULT_MASK_BEZIER_PATH)
    for (const frame of [10, 11, 1_000_000_000]) expect(evaluatePreparedEffectPathAnimationTrack(prepared, frame, '')).toBe(otherPath)
    expect(evaluatePreparedEffectPathAnimationTrack(prepared, 9.5, 'fallback')).toBe('fallback')
  })

  test('prepared values are immutable and unaffected by later caller edits', () => {
    const authored = track(), prepared = prepareEffectPathAnimationTrack(authored, createMaskEffect('mask', 'bezier'))
    authored.keyframes[0].value = otherPath
    authored.keyframes[1].frame = 0
    expect(evaluatePreparedEffectPathAnimationTrack(prepared, 0, '')).toBe(DEFAULT_MASK_BEZIER_PATH)
    if (prepared.ok) {
      expect(Object.isFrozen(prepared.keyframes)).toBe(true)
      expect(Object.isFrozen(prepared.keyframes[0])).toBe(true)
    }
  })

  test('clone preserves future values and absent source intent without sharing mutable keys', () => {
    const authored = { ...track('mask', 2, 'future opaque'), valueVersion: 99 }
    delete authored.keyframes[0].sourceTimeTicks
    const before = JSON.stringify(authored), cloned = cloneEffectPathAnimationTrack(authored)
    expect(cloned).toEqual(authored)
    expect(Object.hasOwn(cloned.keyframes[0], 'sourceTimeTicks')).toBe(false)
    cloned.keyframes[0].frame = -10
    cloned.keyframes[0].value = 'changed'
    expect(cloned.keyframes[0].easing).not.toBe(authored.keyframes[0].easing)
    expect(JSON.stringify(authored)).toBe(before)
  })

  test('preserves unknown versions, dangling targets and malformed paths while visibly unavailable', () => {
    const effect = createMaskEffect('mask', 'bezier')
    const variants = [
      { ...track(), valueVersion: 2 }, { ...track(), valueType: 'future' },
      { ...track(), parameter: 'future-path' }, track('missing'), track('mask', 2, 'future\u0000malformed💛'),
    ]
    for (const value of variants) {
      const before = JSON.stringify(value)
      expect(effectPathAnimationTrackBoundsError(value, true)).toBeNull()
      const prepared = prepareEffectPathAnimationTrack(value, effect)
      expect(prepared.ok).toBe(false)
      expect(evaluatePreparedEffectPathAnimationTrack(prepared, 10, 'static')).toBe('static')
      expect(JSON.stringify(value)).toBe(before)
      expect(maskPathAnimationSnapshotBudget({ tracks: [value] }).ok).toBe(true)
    }
    expect(prepareEffectPathAnimationTrack(track(), createMaskEffect('mask', 'rectangle')).ok).toBe(false)
    expect(prepareEffectPathAnimationTrack(track(), { ...effect, version: 2 }).ok).toBe(false)
  })

  test('one malformed key bypasses the complete track, even before that key', () => {
    const authored = track()
    authored.keyframes[1].value = 'bad'
    expect(prepareEffectPathAnimationTrack(authored, createMaskEffect('mask', 'bezier')).ok).toBe(false)
  })

  test('keeps known fields exact and bounds counts/times/strings before value interpretation', () => {
    const good = track()
    const invalid: unknown[] = [null, { ...good, extra: 1 }, { ...good, parameter: '__proto__' },
      { ...good, valueVersion: 0 }, { ...good, effectId: 'a'.repeat(257) }, track('mask', 257),
      track('mask', 2, 'x'.repeat(2049)), { ...good, keyframes: [] }]
    for (const value of invalid) expect(effectPathAnimationTrackBoundsError(value)).not.toBeNull()
    for (const replacement of [
      { frame: 0.5 }, { frame: 1_000_000_001 }, { frame: Number.NaN },
      { sourceTimeTicks: Number.POSITIVE_INFINITY }, { easing: { type: 'linear' } },
      { easing: { type: 'hold', future: 2 } }, { extra: 1 },
    ]) {
      expect(effectPathAnimationTrackBoundsError({ ...good, keyframes: [{ ...good.keyframes[0], ...replacement }] })).not.toBeNull()
    }
    const noTicks = { ...good, keyframes: [{ frame: 0, value: otherPath, easing: { type: 'hold' } }] }
    expect(effectPathAnimationTrackBoundsError(noTicks)).toBeNull()
    expect(effectPathAnimationTrackBoundsError(noTicks, true)).not.toBeNull()
    expect(effectPathAnimationTrackBoundsError({ ...good, keyframes: [good.keyframes[0], good.keyframes[0]] })).not.toBeNull()
  })

  test('rejects conflicting versions without delimiter collisions in opaque identities', () => {
    expect(effectPathAnimationTracksBoundsError([track(), { ...track(), valueVersion: 2 }])).toContain('Duplicate')
    expect(effectPathAnimationTracksBoundsError([
      { ...track('a\u0000b'), parameter: 'c' }, { ...track('a'), parameter: 'b\u0000c' },
    ])).toBeNull()
    expect(effectPathAnimationTracksBoundsError(Array.from({ length: 257 }, (_, i) => track(String(i))))).not.toBeNull()
  })

  test('resolved held paths have exact reference pixels through the unchanged mask stage', () => {
    const authored = track(), effect = createMaskEffect('mask', 'bezier')
    authored.keyframes[1].value = otherPath
    const prepared = prepareEffectPathAnimationTrack(authored, effect)
    const geometry = { projectWidth: 32, projectHeight: 18, surfaceWidth: 32, surfaceHeight: 18 }
    for (const frame of [0, 9, 10, 20]) {
      const rgba = new Uint8ClampedArray(32 * 18 * 4).fill(255), reference = rgba.slice()
      const path = evaluatePreparedEffectPathAnimationTrack(prepared, frame, effect.params.path as string)
      applyOrderedPixelEffectsToRgba(rgba, [{ kind: 'mask', params: { ...maskParams(effect), path } }], geometry)
      applyOrderedPixelEffectsToRgba(reference, [{ kind: 'mask', params: { ...maskParams(effect), path: frame < 10 ? DEFAULT_MASK_BEZIER_PATH : otherPath } }], geometry)
      expect(rgba).toEqual(reference)
    }
  })
})

describe('aggregate path bytes and retention admission', () => {
  test('accepts exact path-key and character caps and rejects one extra', () => {
    const keys = { tracks: Array.from({ length: 16 }, (_, i) => track(String(i), 256, 'x')) }
    expect(maskPathAnimationSnapshotBudget(keys).ok).toBe(true)
    expect(maskPathAnimationSnapshotBudget({ tracks: [...keys.tracks, track('extra', 1, 'x')] }).ok).toBe(false)
    const characters = largeSnapshot(), budget = maskPathAnimationSnapshotBudget(characters)
    expect(budget.ok).toBe(true)
    if (budget.ok) {
      expect(budget.usage.valueCharacters).toBe(1_048_576)
      expect(budget.usage.keys).toBe(512)
      expect(budget.usage.retainedBytes).toBe(2 * 1_048_576 + 512 * 128 + 2 * (128 + 2 * (1 + 4 + 16)))
    }
    expect(maskPathAnimationSnapshotBudget({ tracks: [...characters.tracks, track('extra', 1, 'x')] }).ok).toBe(false)
  })

  test('counts UTF-16 payload and opaque identity lengths rather than only valid paths', () => {
    const value = { ...track('long-id', 1, '💛'), valueType: 'future' }
    const result = maskPathAnimationSnapshotBudget({ tracks: [value] })
    expect(result).toEqual({ ok: true, usage: { keys: 1, valueCharacters: 2,
      retainedBytes: 128 + 2 * ('long-id'.length + 'path'.length + 'future'.length) + 128 + 4 } })
  })

  test('preflights aggregate key counts before reading any key payload', () => {
    const keys = new Array(256)
    Object.defineProperty(keys, 0, { get() { throw new Error('Unbounded payload was read') } })
    const snapshot = { tracks: Array.from({ length: 17 }, (_, i) => ({ ...track(String(i)), keyframes: keys })) }
    expect(maskPathAnimationSnapshotBudget(snapshot).ok).toBe(false)
  })

  test('includes candidate, current, past, future and both clipboards before clearing redo', () => {
    const retention: MaskPathAnimationRetention = {
      candidate: largeSnapshot(), current: largeSnapshot(), past: Array.from({ length: 11 }, largeSnapshot),
      future: [largeSnapshot()], attributeClipboard: largeSnapshot(), keyClipboard: largeSnapshot(),
    }
    Object.freeze(retention.future)
    const before = retention.future[0]
    expect(maskPathAnimationRetentionError(retention)).toContain('32 MiB')
    for (const patch of [
      { candidate: empty() }, { current: empty() }, { past: retention.past.slice(1) },
      { future: [] }, { attributeClipboard: null }, { keyClipboard: null },
    ]) expect(maskPathAnimationRetentionError({ ...retention, ...patch })).toBeNull()
    expect(retention.future).toHaveLength(1)
    expect(retention.future[0]).toBe(before)
  })

  test('deduplicates identical immutable snapshot objects, never equal strings in distinct snapshots', () => {
    const same = largeSnapshot()
    const retention: MaskPathAnimationRetention = { candidate: same, current: same, past: Array(100).fill(same), future: Array(100).fill(same), attributeClipboard: same, keyClipboard: same }
    expect(maskPathAnimationRetentionError(retention)).toBeNull()
    expect(maskPathAnimationRetentionError({ ...retention, past: Array(101).fill(same) })).not.toBeNull()
  })

  test('shared immutable survivors permit removal without discarding either history branch', () => {
    const current = largeSnapshot()
    const retention: MaskPathAnimationRetention = {
      candidate: { tracks: current.tracks.slice(1) }, current,
      past: Array.from({ length: 100 }, () => ({ tracks: [...current.tracks] })),
      future: Array.from({ length: 100 }, () => ({ tracks: [...current.tracks] })),
      attributeClipboard: { tracks: current.tracks }, keyClipboard: null,
    }
    expect(maskPathAnimationRetentionError(retention)).toBeNull()
    expect(retention.past).toHaveLength(100)
    expect(retention.future).toHaveLength(100)
  })
})
