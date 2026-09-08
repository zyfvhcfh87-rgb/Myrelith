import { describe, expect, test } from 'vitest'
import { defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { defaultTextProps, TEXT_FONT_FAMILIES } from './textOverlay'
import {
  applyTitleAnimationValues, readTitleAnimationProperty, readTitleDefinition, readTitleElement,
  resolveTitleFont, titleAnimationPropertySpec, titleDefinitionValidationError, titleElementValidationError,
  titleFontValidationError, TITLE_ANIMATION_PROPERTIES,
  type TitleElement, type TitleShapeElementV1, type TitleTextElementV1,
} from './titleElements'

function textElement(id = 'title-text'): TitleTextElementV1 {
  const { fontFamily, ...text } = defaultTextProps(1920, 1080, 'Hello\n世界 😀 e\u0301')
  return {
    id, version: 1, kind: 'text', name: 'Text', enabled: true,
    transform: defaultClipTransform(), visual: defaultClipVisualSettings(), opacity: 1,
    text, font: { family: fontFamily, fallbackFamily: null },
  }
}
function shapeElement(kind: TitleShapeElementV1['kind'] = 'rectangle'): TitleShapeElementV1 {
  return {
    id: `title-${kind}`, version: 1, kind, name: 'Shape', enabled: true,
    transform: defaultClipTransform(), visual: defaultClipVisualSettings(), opacity: 1,
    shape: { boxWidthPx: 320, boxHeightPx: 120, fillColor: '#abc8', outlineEnabled: true, outlineColor: '#001122ff', outlineWidthPx: 2 },
  }
}
function value(property: string, amount: number, propertyVersion = 1) {
  return { property, value: amount, propertyVersion }
}

describe('title element and definition boundaries', () => {
  test('preserves every legacy style value and static transform through the pure text adapter', () => {
    const original = textElement()
    const element: TitleTextElementV1 = {
      ...original, enabled: false, opacity: 0.375,
      transform: { x: 12.25, y: -18.5, scaleX: 0, scaleY: 0.125, rotation: -33.75, anchorX: 0, anchorY: 1 },
      visual: { crop: { left: 0.125, right: 0.5, top: 0.2, bottom: 0.3 }, flipHorizontal: true, flipVertical: true, scaleLocked: false },
      text: { ...original.text, content: '\r\n  A  B\n😀 e\u0301\u0000', fontSizePx: 8.25, boxWidthPx: 16.5, boxHeightPx: 30.125, paddingPx: 8.249, shadowOffsetXPx: -512, shadowOffsetYPx: 512 },
    }
    const result = readTitleElement(element)
    expect(result).toEqual({ status: 'supported', element })
    if (result.status !== 'supported') throw new Error('Expected supported fixture')
    expect(result.element).not.toBe(element)
    expect(result.element.transform).not.toBe(element.transform)
    expect(result.element.visual.crop).not.toBe(element.visual.crop)
    expect(titleElementValidationError({ ...element, text: { ...element.text, paddingPx: 8.25 } })).toMatch(/positive inner/)
  })

  test('validates both bounded shape kinds and rejects unknown current fields', () => {
    for (const kind of ['rectangle', 'ellipse'] as const) {
      const element = shapeElement(kind)
      expect(readTitleElement(element)).toEqual({ status: 'supported', element })
      expect(titleElementValidationError({ ...element, text: {} })).toMatch(/unknown fields/)
      expect(titleElementValidationError({ ...element, shape: { ...element.shape, boxWidthPx: 15.99 } })).not.toBeNull()
      expect(titleElementValidationError({ ...element, shape: { ...element.shape, outlineWidthPx: 64.001 } })).not.toBeNull()
      expect(titleElementValidationError({ ...element, shape: { ...element.shape, fillColor: 'url(x)' } })).not.toBeNull()
    }
  })

  test('rejects each missing text field, unsafe numeric values and coupled crop', () => {
    const element = textElement()
    for (const key of Object.keys(element.text)) {
      const broken: Record<string, unknown> = { ...element.text }
      delete broken[key]
      expect(titleElementValidationError({ ...element, text: broken })).not.toBeNull()
    }
    for (const x of [NaN, Infinity, -Infinity, 1e9 + 1, '12']) {
      expect(titleElementValidationError({ ...element, transform: { ...element.transform, x } })).not.toBeNull()
    }
    expect(titleElementValidationError({ ...element, opacity: 1.0001 })).not.toBeNull()
    expect(titleElementValidationError({ ...element, transform: { ...element.transform, scaleY: -0.01 } })).not.toBeNull()
    expect(titleElementValidationError({ ...element, transform: { ...element.transform, anchorX: 1.01 } })).not.toBeNull()
    expect(titleElementValidationError({ ...element, visual: { ...element.visual, crop: { left: 0.6, right: 0.4, top: 0, bottom: 0 } } })).toMatch(/at most 0.99/)
    expect(titleElementValidationError({ ...element, text: { ...element.text, content: 'A'.repeat(20_001) } })).not.toBeNull()
    expect(titleElementValidationError({ ...element, id: 'x'.repeat(257) })).not.toBeNull()
    expect(titleElementValidationError({ ...element, name: 'x'.repeat(81) })).not.toBeNull()
  })

  test('bounds ordered elements, duplicate identities and aggregate text including disabled content', () => {
    const sixteen = Array.from({ length: 16 }, (_, index) => textElement(`element-${index}`))
    expect(titleDefinitionValidationError({ version: 1, elements: sixteen })).toBeNull()
    expect(titleDefinitionValidationError({ version: 1, elements: [] })).toMatch(/1 to 16/)
    expect(titleDefinitionValidationError({ version: 1, elements: [...sixteen, textElement('extra')] })).not.toBeNull()
    expect(titleDefinitionValidationError({ version: 1, elements: [textElement(), textElement()] })).toMatch(/Duplicate/)
    const large = Array.from({ length: 4 }, (_, index) => {
      const element = textElement(`large-${index}`)
      return { ...element, enabled: false, text: { ...element.text, content: 'A'.repeat(20_000) } }
    })
    expect(titleDefinitionValidationError({ version: 1, elements: large })).toBeNull()
    expect(titleDefinitionValidationError({ version: 1, elements: [...large, textElement('over')] })).toMatch(/80,000/)
  })

  test('preserves bounded future definitions/elements without interpreting them as v1', () => {
    const future = { version: 2, different: { points: [1, 2], label: 'Future intent', amount: 1e200 } }
    const read = readTitleDefinition(future)
    expect(read.status).toBe('unsupported')
    if (read.status !== 'unsupported') throw new Error('Expected future intent')
    expect(read.title).toBe(future)
    expect(JSON.stringify(read.title)).toBe(JSON.stringify(future))
    const element = { id: 'future', version: 2, kind: 'text', name: 'Future', enabled: false, payload: ['preserved'] }
    expect(readTitleElement(element)).toMatchObject({ status: 'unsupported', element })
    const unknownKind = { ...element, version: 1, kind: 'future-shape' }
    expect(readTitleElement(unknownKind).status).toBe('unsupported')
    expect(readTitleDefinition({ version: 1, elements: [shapeElement(), element, unknownKind] }).status).toBe('invalid')
    expect(readTitleDefinition({ version: 1, elements: [shapeElement(), element] }).status).toBe('supported')
    expect(readTitleElement({ ...element, version: 0 }).status).toBe('invalid')
    expect(readTitleElement({ ...element, version: 1.5 }).status).toBe('invalid')
  })

  test('bounds future depth, entries and serialized UTF-8 bytes without calling accessors', () => {
    let nested: unknown = 1
    for (let index = 0; index < 9; index++) nested = { next: nested }
    expect(titleDefinitionValidationError({ version: 2, nested })).toMatch(/nested levels/)
    expect(titleDefinitionValidationError({ version: 2, entries: Array(4097).fill(null) })).toMatch(/4,096/)
    // Each payload is 20,000 code units, but escaping expands the JSON byte size.
    expect(titleDefinitionValidationError({ version: 2, chunks: Array(9).fill('\u0000'.repeat(20_000)) })).toMatch(/1 MiB/)
    expect(titleDefinitionValidationError({ version: 2, chunks: Array(18).fill('界'.repeat(20_000)) })).toMatch(/1 MiB/)
    expect(titleDefinitionValidationError({ version: 2, chunks: Array(9).fill('界'.repeat(20_000)) })).toBeNull()
    let called = false
    const accessor = Object.defineProperty({ version: 2 }, 'payload', { enumerable: true, get() { called = true; throw new Error('Do not call') } })
    expect(titleDefinitionValidationError(accessor)).toMatch(/accessors/)
    expect(called).toBe(false)
  })

  test('rejects non-JSON shapes, hidden properties, sparse arrays, symbols, cycles and dangerous keys', () => {
    const cycle: Record<string, unknown> = { version: 2 }
    cycle.self = cycle
    const hidden = Object.defineProperty({ version: 2 }, 'hidden', { value: 'secret' })
    const extraArray = Object.assign([1], { extra: 2 })
    const sparse = [0, 1]
    delete sparse[0]
    for (const bad of [cycle, hidden, { version: 2, payload: sparse }, { version: 2, payload: extraArray },
      { version: 2, [Symbol('x')]: 1 }, { version: 2, payload: new Date() }, { version: 2, payload: undefined },
      { version: 2, toJSON() { throw new Error('Must not execute') } },
      JSON.parse('{"version":2,"__proto__":{"x":1}}'),
      { version: 2, ["x".repeat(129)]: 1 },
    ]) expect(titleDefinitionValidationError(bad)).not.toBeNull()
  })
})

describe('explicit font intent', () => {
  test('retains all six generic families with platform-dependent status', () => {
    for (const family of TEXT_FONT_FAMILIES) {
      expect(titleFontValidationError({ family, fallbackFamily: null })).toBeNull()
      expect(resolveTitleFont({ family, fallbackFamily: null })).toEqual({ status: 'platform-generic', family, requestedFamily: family, usesFallback: false })
    }
  })
  test('does not silently replace a missing font or upgrade an explicit fallback', () => {
    const missing = Object.freeze({ family: 'Absent Family', fallbackFamily: null })
    expect(titleFontValidationError(missing)).toBeNull()
    expect(resolveTitleFont(missing)).toMatchObject({ status: 'unavailable', requestedFamily: 'Absent Family' })
    const explicit = Object.freeze({ family: 'Absent Family', fallbackFamily: 'serif' } as const)
    expect(resolveTitleFont(explicit)).toEqual({ status: 'platform-generic', family: 'serif', requestedFamily: 'Absent Family', usesFallback: true })
    expect(explicit.family).toBe('Absent Family')
    expect(resolveTitleFont({ family: 'sans-serif', fallbackFamily: 'serif' })).toMatchObject({ family: 'serif' })
  })
  test('rejects executable/source syntax, implicit lists and malformed fallback fields', () => {
    for (const family of ['', ' serif', 'serif ', 'a,b', 'url(a)', 'https://fonts.test/font', 'Font/Name', '"Font"', 'A; color:red', 'x'.repeat(129)]) {
      expect(titleFontValidationError({ family, fallbackFamily: null })).not.toBeNull()
    }
    expect(titleFontValidationError({ family: 'Other', fallbackFamily: 'Missing fallback' })).not.toBeNull()
    expect(titleFontValidationError({ family: 'serif' })).not.toBeNull()
    expect(titleFontValidationError({ family: 'serif', fallbackFamily: null, url: 'x' })).not.toBeNull()
    expect(titleFontValidationError({ family: '日本語 Font-1', fallbackFamily: null })).toBeNull()
  })
})

describe('title scalar adapters for the unified animation authority', () => {
  test('declares the reviewed vocabulary and reads exact authored fallbacks, not defaults', () => {
    expect(TITLE_ANIMATION_PROPERTIES).toHaveLength(13)
    const element = textElement()
    const changed: TitleTextElementV1 = { ...element, transform: { ...element.transform, x: 77.125 }, text: { ...element.text, fontSizePx: 123.456 } }
    expect(readTitleAnimationProperty(changed, 1, 'position-x')).toEqual({ status: 'available', value: 77.125 })
    expect(readTitleAnimationProperty(changed, 1, 'font-size')).toEqual({ status: 'available', value: 123.456 })
    expect(titleAnimationPropertySpec(changed, 2, 'position-x')).toEqual({ status: 'unavailable', reason: 'unsupported-property-version' })
    expect(titleAnimationPropertySpec(changed, 1, 'transform.x')).toEqual({ status: 'unavailable', reason: 'unknown-property' })
    expect(titleAnimationPropertySpec(shapeElement(), 1, 'font-size')).toEqual({ status: 'unavailable', reason: 'ineligible-element-kind' })
  })

  test('atomically maps all safe scalar fields without quantization or changing the authored original', () => {
    const element = textElement()
    const original = JSON.stringify(element)
    Object.freeze(element)
    Object.freeze(element.transform)
    Object.freeze(element.text)
    const result = applyTitleAnimationValues(element, [
      value('position-x', 12.125), value('position-y', -45.125), value('scale-x', 0.1234), value('scale-y', 99.125),
      value('rotation', 360.25), value('opacity', 0.123456), value('box-width', 900.125), value('box-height', 300.5),
      value('font-size', 80.25), value('outline-width', 3.125), value('shadow-blur', 17.75),
      value('shadow-offset-x', -5.125), value('shadow-offset-y', 6.25),
    ])
    expect(result).toMatchObject({ status: 'applied', element: {
      transform: { x: 12.125, y: -45.125, scaleX: 0.1234, scaleY: 99.125, rotation: 360.25 }, opacity: 0.123456,
      text: { boxWidthPx: 900.125, boxHeightPx: 300.5, fontSizePx: 80.25, outlineWidthPx: 3.125, shadowBlurPx: 17.75, shadowOffsetXPx: -5.125, shadowOffsetYPx: 6.25 },
    } })
    if (result.status !== 'applied') throw new Error('Expected valid application')
    expect(titleElementValidationError(result.element)).toBeNull()
    expect(JSON.stringify(element)).toBe(original)
    expect(result.element.visual).toBe(element.visual)
  })

  test('keeps no-op identity and shape fields separate from text-only styles', () => {
    for (const element of [textElement(), shapeElement(), shapeElement('ellipse')]) {
      expect(applyTitleAnimationValues(element, []).status).toBe('applied')
      const result = applyTitleAnimationValues(element, [value('opacity', 1)])
      if (result.status !== 'applied') throw new Error('Expected no-op')
      expect(result.element).toBe(element)
    }
    const shape = shapeElement()
    expect(applyTitleAnimationValues(shape, [value('box-width', 16), value('box-height', 65_535), value('outline-width', 64)])).toMatchObject({ status: 'applied', element: { shape: { boxWidthPx: 16, boxHeightPx: 65_535, outlineWidthPx: 64 } } })
    expect(applyTitleAnimationValues(shape, [value('shadow-blur', 5)]).status).toBe('rejected')
  })

  test('exposes strict padding bounds and rejects a whole batch with invalid geometry', () => {
    const base = textElement()
    const element: TitleTextElementV1 = { ...base, text: { ...base.text, paddingPx: 32.125 } }
    expect(titleAnimationPropertySpec(element, 1, 'box-width')).toMatchObject({ status: 'available', spec: { min: 64.25, minExclusive: true, max: 65_535 } })
    expect(applyTitleAnimationValues(element, [value('opacity', 0.5), value('box-width', 64.25)]).status).toBe('rejected')
    expect(element.opacity).toBe(1)
    const accepted = applyTitleAnimationValues(element, [value('box-width', 64.250001), value('box-height', 64.250001)])
    expect(accepted.status).toBe('applied')
    if (accepted.status === 'applied') expect(titleElementValidationError(accepted.element)).toBeNull()
    const minimum: TitleTextElementV1 = { ...base, text: { ...base.text, paddingPx: 0 } }
    expect(titleAnimationPropertySpec(minimum, 1, 'box-width')).toMatchObject({ spec: { min: 16, minExclusive: false } })
    expect(applyTitleAnimationValues(minimum, [value('box-width', 16)]).status).toBe('applied')
  })

  test('rejects mixed-version competing writers before interpreting values', () => {
    const element = textElement()
    expect(applyTitleAnimationValues(element, [value('opacity', 0.5, 2), value('opacity', 0.25, 1)])).toEqual({ status: 'rejected', reason: 'Duplicate semantic title property, regardless of version.' })
    expect(applyTitleAnimationValues(element, [value('opacity', 0.5, 2)])).toEqual({ status: 'rejected', reason: 'unsupported-property-version' })
    expect(element.opacity).toBe(1)
  })

  test('rejects every out-of-range scalar, unknown property and nonfinite value', () => {
    const element: TitleElement = textElement()
    const cases = [value('position-x', 1e9 + 1), value('position-y', -1e9 - 1), value('scale-x', -0.1), value('scale-y', 100.1), value('rotation', Infinity),
      value('opacity', NaN), value('opacity', 1.01), value('box-height', 65_536), value('font-size', 7.99), value('outline-width', 64.01),
      value('shadow-blur', 128.01), value('shadow-offset-x', -512.01), value('shadow-offset-y', 512.01), value('padding', 3)]
    for (const candidate of cases) expect(applyTitleAnimationValues(element, [candidate]).status).toBe('rejected')
  })
})
