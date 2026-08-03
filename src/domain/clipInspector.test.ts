import { describe, expect, test } from 'vitest'
import {
  clipAudioSettingsValidationError,
  clipVisualSettingsValidationError,
  defaultClipAudioSettings,
  defaultClipVisualSettings,
  migrateLegacyClipInspectorSettings,
  stereoBalanceGains,
} from './clipInspector'

describe('clip Inspector document contract', () => {
  test('returns independently owned neutral defaults', () => {
    const left = defaultClipVisualSettings()
    const right = defaultClipVisualSettings()
    expect(left).toEqual({
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      flipHorizontal: false,
      flipVertical: false,
      scaleLocked: true,
    })
    expect(left).not.toBe(right)
    expect(left.crop).not.toBe(right.crop)
    expect(defaultClipAudioSettings()).toEqual({
      enabled: true,
      balance: 0,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    })
  })

  test('rejects empty crop geometry and out-of-range audio settings', () => {
    expect(clipVisualSettingsValidationError({
      ...defaultClipVisualSettings(),
      crop: { left: 0.5, right: 0.5, top: 0, bottom: 0 },
    })).toMatch(/left \+ crop\.right/)
    expect(clipAudioSettingsValidationError({
      ...defaultClipAudioSettings(),
      balance: 1.01,
    }, 30)).toMatch(/balance/)
    expect(clipAudioSettingsValidationError({
      ...defaultClipAudioSettings(),
      fadeOutFrames: 31,
    }, 30)).toMatch(/fadeOutFrames/)
  })

  test('migrates legacy scale signs without changing their magnitudes', () => {
    const migrated = migrateLegacyClipInspectorSettings({
      x: 4,
      y: -2,
      scaleX: -1.5,
      scaleY: 0.75,
      rotation: 15,
      anchorX: 0.4,
      anchorY: 0.6,
    })
    expect(migrated.transform).toMatchObject({ scaleX: 1.5, scaleY: 0.75 })
    expect(migrated.visual).toMatchObject({
      flipHorizontal: true,
      flipVertical: false,
      scaleLocked: false,
    })
    expect(migrated.audio).toEqual(defaultClipAudioSettings())
  })

  test('balances stereo without changing centered channels', () => {
    expect(stereoBalanceGains(-1)).toEqual([1, 0])
    expect(stereoBalanceGains(-0.25)).toEqual([1, 0.75])
    expect(stereoBalanceGains(0)).toEqual([1, 1])
    expect(stereoBalanceGains(0.25)).toEqual([0.75, 1])
    expect(stereoBalanceGains(1)).toEqual([0, 1])
    expect(() => stereoBalanceGains(Number.NaN)).toThrow(/balance/i)
  })
})
