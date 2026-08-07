import { describe, expect, test } from 'vitest'
import type { TimelineDoc } from './schema'
import {
  fullResolutionPresentationProfile,
  presentationProfileMatchesDocument,
  resolvePresentationProfile,
} from './presentationProfile'

const doc = {
  width: 3840,
  height: 2160,
} as TimelineDoc

describe('presentation profiles', () => {
  test('Auto chooses the smallest playback bucket that covers display pixels', () => {
    expect(resolvePresentationProfile(doc, {
      qualityMode: 'auto',
      reason: 'playing',
      viewport: { widthCssPx: 800, heightCssPx: 450, devicePixelRatio: 1 },
    })).toMatchObject({
      resolvedQuality: 'quarter',
      scale: 0.25,
      outputWidth: 960,
      outputHeight: 540,
      devicePixelPolicy: 'match-display',
    })

    expect(resolvePresentationProfile(doc, {
      qualityMode: 'auto',
      reason: 'scrubbing',
      viewport: { widthCssPx: 800, heightCssPx: 450, devicePixelRatio: 2 },
    })).toMatchObject({
      resolvedQuality: 'half',
      scale: 0.5,
      outputWidth: 1920,
      outputHeight: 1080,
    })
  })

  test('Auto returns to Full while paused and fails safe to Full without a viewport', () => {
    for (const reason of ['paused', 'playing'] as const) {
      const profile = resolvePresentationProfile(doc, {
        qualityMode: 'auto',
        reason,
        viewport: null,
      })
      expect(profile).toMatchObject({
        scale: 1,
        outputWidth: 3840,
        outputHeight: 2160,
      })
    }
  })

  test('manual modes remain exact regardless of monitor size', () => {
    const hugeViewport = {
      widthCssPx: 5000,
      heightCssPx: 3000,
      devicePixelRatio: 2,
    }
    expect(resolvePresentationProfile(doc, {
      qualityMode: 'half',
      reason: 'playing',
      viewport: hugeViewport,
    })).toMatchObject({ scale: 0.5, outputWidth: 1920, outputHeight: 1080 })
    expect(resolvePresentationProfile(doc, {
      qualityMode: 'quarter',
      reason: 'paused',
      viewport: hugeViewport,
    })).toMatchObject({ scale: 0.25, outputWidth: 960, outputHeight: 540 })
  })

  test('export is explicitly full resolution even when lower quality was requested', () => {
    expect(resolvePresentationProfile(doc, {
      qualityMode: 'quarter',
      reason: 'export',
      viewport: null,
    })).toEqual(fullResolutionPresentationProfile(doc, 'export'))
  })

  test('profile/document matching rejects a stale project size', () => {
    const profile = fullResolutionPresentationProfile(doc, 'paused')
    expect(presentationProfileMatchesDocument(profile, doc)).toBe(true)
    expect(presentationProfileMatchesDocument(profile, {
      ...doc,
      width: 1920,
      height: 1080,
    })).toBe(false)
  })
})
