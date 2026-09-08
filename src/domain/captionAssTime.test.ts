import { describe, expect, it } from 'vitest'
import { captionAssRangeToFrames, planCaptionAssTimeExport } from './captionAssTime'
import { CAPTION_LIMITS } from './captions'

describe('ASS centisecond frame boundaries', () => {
  it('preserves coverage with floor starts and ceil exclusive ends at NTSC rates', () => {
    expect(captionAssRangeToFrames('0:00:00.01', '0:00:01.01', { num: 30_000, den: 1_001 }))
      .toEqual({ startFrame: 0, durationFrames: 31 })
    expect(captionAssRangeToFrames('0:00:01.00', '0:00:02.00', { num: 24, den: 1 }))
      .toEqual({ startFrame: 24, durationFrames: 24 })
  })

  it.each([24, 25, 30, 50, 60, 100])('proves exact import/export boundaries at %i fps', (num) => {
    for (const startFrame of [0, 1, 2, 997, CAPTION_LIMITS.maxFrame - 1]) {
      const range = { startFrame, durationFrames: 1 }
      const proposal = planCaptionAssTimeExport(range, { num, den: 1 })
      expect(proposal.kind).toBe('exact')
      if (proposal.kind === 'exact') expect(captionAssRangeToFrames(proposal.start, proposal.end, { num, den: 1 })).toEqual(range)
    }
  })

  it.each([24_000, 30_000, 60_000])('proves or explicitly reports one-frame grid loss for %i/1001', (num) => {
    for (const startFrame of [0, 1, 100, 1_000_001, CAPTION_LIMITS.maxFrame - 2]) {
      const range = { startFrame, durationFrames: 1 }
      const proposal = planCaptionAssTimeExport(range, { num, den: 1_001 })
      expect(proposal.kind).not.toBe('unrepresentable')
      if (proposal.kind === 'exact') expect(proposal.importedRange).toEqual(range)
      else if (proposal.kind === 'coverage-expansion') {
        expect(proposal.importedRange.startFrame).toBeLessThanOrEqual(startFrame)
        expect(proposal.importedRange.startFrame + proposal.importedRange.durationFrames).toBeGreaterThanOrEqual(startFrame + 1)
      }
    }
  })

  it('offers a visibly expanded alternative when the centisecond grid cannot encode one frame', () => {
    const range = Object.freeze({ startFrame: 1, durationFrames: 1 })
    const proposal = planCaptionAssTimeExport(range, { num: 120, den: 1 })
    expect(proposal).toEqual({ kind: 'coverage-expansion', start: '0:00:00.00', end: '0:00:00.02',
      originalRange: range, importedRange: { startFrame: 0, durationFrames: 3 } })
    expect(range).toEqual({ startFrame: 1, durationFrames: 1 })
  })

  it('rejects a coverage alternative that would exceed the document frame ceiling', () => {
    const proposal = planCaptionAssTimeExport({ startFrame: CAPTION_LIMITS.maxFrame - 1, durationFrames: 1 }, { num: 120, den: 1 })
    expect(proposal.kind).toBe('unrepresentable')
  })

  it.each(['-1:00:00.00', '0:60:00.00', '0:00:60.00', '0:00:00.000', '0:0:00.00', '0:00:00,00', ' 0:00:00.00', '1'.repeat(33)])('rejects malformed timestamp %s', (start) => {
    expect(() => captionAssRangeToFrames(start, '1:00:00.00', { num: 25, den: 1 })).toThrow()
  })

  it('rejects equal/reversed ends, out-of-range hours and invalid rational rates', () => {
    expect(() => captionAssRangeToFrames('0:00:01.00', '0:00:01.00', { num: 25, den: 1 })).toThrow(/end/u)
    expect(() => captionAssRangeToFrames('1:00:01.00', '0:00:01.00', { num: 25, den: 1 })).toThrow(/end/u)
    expect(() => captionAssRangeToFrames('99999999999999999999999:00:00.00', '99999999999999999999999:00:01.00', { num: 25, den: 1 })).toThrow(/frames/u)
    for (const rate of [{ num: 0, den: 1 }, { num: 1, den: 0 }, { num: 29.97, den: 1 }, { num: 1, den: Infinity }]) {
      expect(() => captionAssRangeToFrames('0:00:00.00', '0:00:01.00', rate)).toThrow(/rational/u)
      expect(() => planCaptionAssTimeExport({ startFrame: 0, durationFrames: 1 }, rate)).toThrow(/rational/u)
    }
  })

  it('rejects unsafe authored ranges before doing any export math', () => {
    for (const range of [{ startFrame: -1, durationFrames: 1 }, { startFrame: 0, durationFrames: 0 },
      { startFrame: 0.5, durationFrames: 1 }, { startFrame: 0, durationFrames: NaN },
      { startFrame: CAPTION_LIMITS.maxFrame, durationFrames: 1 }]) {
      expect(() => planCaptionAssTimeExport(range, { num: 25, den: 1 })).toThrow(/range/u)
    }
  })
})
