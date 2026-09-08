import { describe, expect, it } from 'vitest'
import { CAPTION_STYLE_LIMITS, combineCaptionStyleOverrides, inspectCaptionStyle } from './captionStyle'
import { utf8ByteLength } from './documentMemory'

describe('bounded semantic caption style intent', () => {
  it('admits each supported primitive without changing normalized values', () => {
    const params = { fontFamily: 'serif', fontSizePermille: 52.5, color: '#ffffffff', outlineColor: '#000000ff',
      backgroundColor: '#000000cc', bold: true, italic: false, outlineEnabled: true, backgroundEnabled: false,
      outlinePermille: 3.5, align: 'right', position: 'top', marginXPermille: 70, marginYPermille: 60 }
    const result = inspectCaptionStyle({ version: 1, params })
    expect(result.kind).toBe('supported')
    if (result.kind !== 'supported') return
    expect(result.params).toEqual(params)
    expect(result.serializedUtf8Bytes).toBe(utf8ByteLength(JSON.stringify({ version: 1, params })))
    expect(Object.isFrozen(result.descriptor)).toBe(true)
    expect(Object.isFrozen(result.params)).toBe(true)
    expect(result.params).not.toBe(params)
  })

  it.each([
    ['fontFamily', 'Arial'], ['fontSizePermille', 7.99], ['fontSizePermille', 150.01],
    ['color', '#ffffff'], ['color', '#FFFFFFFF'], ['outlineColor', 'red'], ['backgroundColor', 'url(x)'],
    ['bold', 'true'], ['italic', 1], ['outlineEnabled', 0], ['backgroundEnabled', 'false'],
    ['outlinePermille', -0.1], ['outlinePermille', 10.1], ['align', 'justify'], ['position', 'baseline'],
    ['marginXPermille', -1], ['marginYPermille', 251],
  ])('rejects unsupported known %s=%s', (key, value) => {
    expect(inspectCaptionStyle({ version: 1, params: { [key]: value } }).kind).toBe('invalid')
  })

  it('preserves an entire unknown version as unavailable and does not mutate its input', () => {
    const original = Object.freeze({ version: 7, params: Object.freeze({ color: 'future-color', extra: 'data', scale: 1.5 }) })
    const result = inspectCaptionStyle(original)
    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.descriptor).toEqual(original)
    expect(result.descriptor).not.toBe(original)
    expect(JSON.parse(JSON.stringify(result.descriptor))).toEqual(original)
  })

  it('bypasses all fields in an unknown-key override and still reports its level', () => {
    const unknown = { version: 1, params: { color: '#ff0000ff', future: true } }
    const combined = combineCaptionStyleOverrides({ version: 1, params: { color: '#ffffffff', bold: true } }, unknown)
    expect(combined.params).toEqual({ color: '#ffffffff', bold: true })
    expect(combined.unavailable).toEqual([{ level: 'cue', reason: 'Caption style fields are unavailable: future' }])
    expect(unknown.params.color).toBe('#ff0000ff')
  })

  it('merges track before cue, and absent overrides do not fabricate preset values', () => {
    expect(combineCaptionStyleOverrides(undefined, undefined)).toEqual({ params: {}, unavailable: [], serializedUtf8Bytes: 0 })
    const track = { version: 1, params: { bold: true, color: '#ffffffff' } }
    const cue = { version: 1, params: { bold: false } }
    expect(combineCaptionStyleOverrides(track, cue).params).toEqual({ bold: false, color: '#ffffffff' })
    expect(track.params.bold).toBe(true)
    expect(() => combineCaptionStyleOverrides({ version: 1, params: { bold: 'invalid' } }, undefined)).toThrow()
  })

  it.each([NaN, Infinity, -Infinity, null, undefined, {}, [], () => 1])('rejects nonportable primitive %s even for future versions', (value) => {
    expect(inspectCaptionStyle({ version: 9, params: { future: value } }).kind).toBe('invalid')
  })

  it('enforces key, string, count and actual serialized UTF-8 limits', () => {
    expect(inspectCaptionStyle({ version: 2, params: { ['x'.repeat(129)]: true } }).kind).toBe('invalid')
    expect(inspectCaptionStyle({ version: 2, params: { x: 'x'.repeat(129) } }).kind).toBe('invalid')
    expect(inspectCaptionStyle({ version: 2, params: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, true])) }).kind).toBe('invalid')
    const large = { version: 2, params: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`k${i}`, '界'.repeat(128)])) }
    expect(inspectCaptionStyle(large).kind).toBe('invalid')
    const escaped = { version: 2, params: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`k${i}`, '\u0001'.repeat(128)])) }
    expect(inspectCaptionStyle(escaped).kind).toBe('invalid')
    expect(CAPTION_STYLE_LIMITS.maxDescriptorBytes).toBe(4_096)
  })

  it('rejects extra envelope fields, invalid versions, symbols, classes and accessors without running them', () => {
    let calls = 0
    const accessor = { version: 1, get params() { calls++; return {} } }
    const getterParams = { version: 1, params: { get color() { calls++; return '#ffffffff' } } }
    for (const value of [accessor, getterParams, { version: 1, params: {}, extra: true },
      { version: 0, params: {} }, { version: 1.5, params: {} }, { version: Infinity, params: {} },
      { version: 1, params: { [Symbol('hidden')]: true } }, new Date(), []]) {
      expect(inspectCaptionStyle(value).kind).toBe('invalid')
    }
    expect(calls).toBe(0)
  })

  it('preserves null-prototype future keys as plain own data without invoking prototype setters', () => {
    const params = Object.create(null) as Record<string, string>
    params.__proto__ = 'future'
    const result = inspectCaptionStyle({ version: 2, params })
    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(Object.hasOwn(result.descriptor.params, '__proto__')).toBe(true)
    expect(result.descriptor.params.__proto__).toBe('future')
    expect(Object.getPrototypeOf(result.descriptor.params)).toBe(Object.prototype)
  })
})
