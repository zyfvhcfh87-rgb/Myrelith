import { describe, expect, test } from 'vitest'
import { DEFAULT_EXPORT_PROFILE, updateExportProfile } from './exportProfile'
import {
  MAX_EXPORT_DURATION_SECONDS,
  MAX_EXPORT_FRAME_COUNT,
  assertExportWorkBudget,
  exportWorkBudget,
} from './exportWorkBudget'

describe('export work budget', () => {
  test('accepts a normal long-form direct-file export', () => {
    const profile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    expect(exportWorkBudget(
      30 * 60 * 60,
      { num: 30, den: 1 },
      profile,
    ).allowed).toBe(true)
  })

  test('rejects a billion-frame job before resource acquisition', () => {
    expect(() => assertExportWorkBudget(
      1_000_000_000,
      { num: 30, den: 1 },
      DEFAULT_EXPORT_PROFILE,
    )).toThrow(/export.*limit/i)
  })

  test('enforces exact frame and duration ceilings at fractional rates', () => {
    const profile = updateExportProfile(DEFAULT_EXPORT_PROFILE, {
      destination: 'file',
    })
    expect(exportWorkBudget(
      MAX_EXPORT_FRAME_COUNT,
      { num: 60_000, den: 1_001 },
      profile,
    ).allowed).toBe(true)
    expect(exportWorkBudget(
      MAX_EXPORT_DURATION_SECONDS * 30_000 / 1_001 + 1,
      { num: 30_000, den: 1_001 },
      profile,
    ).allowed).toBe(false)
  })

  test('uses a stricter output estimate for memory-buffered downloads', () => {
    const frames = 3 * 60 * 60 * 30
    expect(exportWorkBudget(
      frames,
      { num: 30, den: 1 },
      DEFAULT_EXPORT_PROFILE,
    ).allowed).toBe(false)
    expect(exportWorkBudget(
      frames,
      { num: 30, den: 1 },
      updateExportProfile(DEFAULT_EXPORT_PROFILE, { destination: 'file' }),
    ).allowed).toBe(true)
  })
})
