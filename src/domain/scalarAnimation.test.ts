/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  animationEasingProgress,
  evaluateAnimationTrack,
  evaluateAnimationTrackAtBoundaryPosition,
  evaluateValidatedAnimationTrackAtBoundaryPosition,
} from './clipAnimation'
import type { ClipAnimationEasing, ClipAnimationKeyframe } from './schema'

interface BaselineFixture {
  commit: string
  fallback: number
  easings: ClipAnimationEasing[]
  tracks: { keyframes: ClipAnimationKeyframe[] }[]
  easingSamples: { easingIndex: number; progress: number; expected: string }[]
  samples: { trackIndex: number; frame: number; integer: string; boundary: string; validated: string }[]
}
const baseline = JSON.parse(readFileSync(
  resolve('src/test/fixtures/animation-scalar-baseline.json'), 'utf8',
)) as BaselineFixture

function bits(value: number): string {
  const bytes = Buffer.alloc(8)
  bytes.writeDoubleBE(value)
  return bytes.toString('hex')
}

describe('scalar animation immutable baseline', () => {
  test('keeps the fixed-bisection easing results bit-identical to ce91074', () => {
    expect(baseline.commit).toBe('ce91074c276ca6892a74addb7dd673b9a19c7eeb')
    for (const sample of baseline.easingSamples) {
      expect(bits(animationEasingProgress(baseline.easings[sample.easingIndex], sample.progress)),
        `easing ${sample.easingIndex} at ${sample.progress}`).toBe(sample.expected)
    }
  })

  test('preserves exact integer and sample-boundary values across signed ranges and hold seams', () => {
    for (const sample of baseline.samples) {
      const track = baseline.tracks[sample.trackIndex]
      const label = `track ${sample.trackIndex} at ${sample.frame}`
      expect(bits(evaluateAnimationTrack(track, sample.frame, baseline.fallback)), label).toBe(sample.integer)
      expect(bits(evaluateAnimationTrackAtBoundaryPosition(track, sample.frame, baseline.fallback)), label)
        .toBe(sample.boundary)
      expect(bits(evaluateValidatedAnimationTrackAtBoundaryPosition(track, sample.frame, baseline.fallback)), label)
        .toBe(sample.validated)
    }
  })

  test('rejects unsafe authored positions and invalid tracks while preserving fallback', () => {
    const track = baseline.tracks[0]
    for (const frame of [Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
      expect(evaluateAnimationTrack(track, frame, baseline.fallback)).toBe(baseline.fallback)
    }
    for (const frame of [Number.NaN, Infinity, -Infinity]) {
      expect(evaluateAnimationTrackAtBoundaryPosition(track, frame, baseline.fallback)).toBe(baseline.fallback)
      expect(evaluateValidatedAnimationTrackAtBoundaryPosition(track, frame, baseline.fallback)).toBe(baseline.fallback)
    }
    const invalid = [
      { keyframes: [] },
      { keyframes: [track.keyframes[0], track.keyframes[0]] },
      { keyframes: [{ ...track.keyframes[0], sourceTimeTicks: 0.5 }] },
      { keyframes: [{ ...track.keyframes[0], value: Infinity }] },
      { keyframes: [{ ...track.keyframes[0], frame: -1_000_000_001 }] },
      { keyframes: [{ ...track.keyframes[0], easing: { type: 'cubic-bezier' as const, x1: 2, x2: 0, y1: 0, y2: 1 } }] },
    ]
    for (const candidate of invalid) {
      expect(evaluateAnimationTrack(candidate, 0, baseline.fallback)).toBe(baseline.fallback)
      expect(evaluateAnimationTrackAtBoundaryPosition(candidate, 0.5, baseline.fallback)).toBe(baseline.fallback)
    }
  })
})
