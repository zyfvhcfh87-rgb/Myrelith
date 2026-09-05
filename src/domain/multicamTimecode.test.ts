import { describe, expect, test } from 'vitest'
import { alignTimecodes, parseTimecode, type TimecodeEvidence } from './multicamTimecode'

const F30 = { num: 30, den: 1 }
const evidence = (patch: Partial<TimecodeEvidence> = {}): TimecodeEvidence => ({
  format: 'normalized-timecode-v1', label: '01:02:03:04', rate: F30,
  counting: 'non-drop', origin: 'presentation-frame-zero', continuity: 'continuous',
  dayOffset: 0, clockDomain: 'fixture-clock:same-day', ...patch,
})

describe('Issue 194 normalized timecode proof (no metadata adapter)', () => {
  test('counts a declared non-drop label without interpreting wall-clock seconds', () => {
    expect(parseTimecode(evidence())).toMatchObject({ state: 'valid', frameCount: 111_694 })
    expect(parseTimecode(evidence({ rate: { num: 30_000, den: 1_001 } }))).toMatchObject({
      state: 'valid', frameCount: 111_694,
    })
  })

  test('subtracts source origins exactly with the same sign as the audio proposal', () => {
    const ref = evidence()
    const later = evidence({ label: '01:02:05:09' })
    expect(alignTimecodes(ref, later, F30)).toEqual({ state: 'aligned', offsetFrames: 65 })
    expect(alignTimecodes(later, ref, F30)).toEqual({ state: 'aligned', offsetFrames: -65 })
    const ntsc = { num: 30_000, den: 1_001 }
    expect(alignTimecodes(
      evidence({ rate: ntsc }), evidence({ rate: ntsc, label: '01:02:05:09' }), ntsc,
    )).toEqual({ state: 'aligned', offsetFrames: 65 })
  })

  test.each([
    null, [], {}, { ...evidence(), guessed: true },
    { ...evidence(), format: 'container-tag' },
    { ...evidence(), rate: { num: 30, den: 1, approximate: false } },
    { ...evidence(), rate: { num: '30', den: 1 } },
    { ...evidence(), rate: { num: 60, den: 2 } },
    { ...evidence(), rate: { num: 30, den: 0 } },
    { ...evidence(), counting: undefined }, { ...evidence(), counting: 'drop-frame' },
    { ...evidence(), origin: 'unknown' }, { ...evidence(), origin: 'first-decode-sample' },
    { ...evidence(), continuity: 'unknown' }, { ...evidence(), dayOffset: 1 },
    { ...evidence(), clockDomain: '' }, { ...evidence(), clockDomain: 'x'.repeat(129) },
  ])('rejects undeclared, unsupported, or extra semantics: %j', (value) => {
    expect(parseTimecode(value).state).toBe('unavailable')
    expect(alignTimecodes(evidence(), value, F30).state).toBe('unavailable')
  })

  test.each([
    '01:02:03;04', '-01:02:03:04', '24:00:00:00', '01:60:00:00', '01:00:60:00',
    '01:02:03:30', '1:2:3:4', ' 01:02:03:04', '01:02:03:04 ', '01:02:03:04\n',
  ])('rejects unsupported timecode label %j', (label) => {
    expect(parseTimecode(evidence({ label }))).toEqual({ state: 'unavailable', reason: 'invalid-label' })
  })

  test('rejects mismatched clocks, rates, and implicit frame-rate conversion', () => {
    expect(alignTimecodes(evidence(), evidence({ clockDomain: 'unrelated' }), F30)).toMatchObject({ reason: 'different-clocks' })
    expect(alignTimecodes(evidence(), evidence({ rate: { num: 25, den: 1 } }), F30)).toMatchObject({ reason: 'different-rates' })
    expect(alignTimecodes(evidence(), evidence(), { num: 60, den: 1 })).toMatchObject({ reason: 'different-rates' })
  })

  test('copies normalized evidence and does not invent a midnight wrap', () => {
    const source = evidence({ rate: { ...F30 } })
    const parsed = parseTimecode(source)
    expect(parsed.state).toBe('valid')
    if (parsed.state !== 'valid') throw new Error('Expected valid fixture')
    expect(parsed.evidence).not.toBe(source)
    expect(parsed.evidence.rate).not.toBe(source.rate)
    expect(alignTimecodes(
      evidence({ label: '23:59:59:29' }), evidence({ label: '00:00:00:00' }), F30,
    )).toEqual({ state: 'aligned', offsetFrames: -2_591_999 })
  })
})
