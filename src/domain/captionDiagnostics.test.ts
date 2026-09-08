import { describe, expect, it } from 'vitest'
import { captionPaintFor, createCaptionTrack } from './captions'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import type { TextProps } from './schema'
import { captionContrastDiagnostic, captionLayoutDiagnostic } from './captionDiagnostics'

function paint(overrides: Partial<TextProps> = {}): TextProps {
  const doc = createTimelineDoc('Diagnostics', DEFAULT_PROJECT_SETTINGS, 'doc')
  return { ...captionPaintFor(doc, createCaptionTrack('captions', 'Captions'),
    { id: 'cue', text: 'A', range: { startFrame: 0, durationFrames: 25 } }, 0, 1).text,
    fontSizePx: 10, boxWidthPx: 30, boxHeightPx: 28, paddingPx: 2, ...overrides }
}
const measure = (value: string) => [...value].length * 8

describe('staged shared-painter diagnostics', () => {
  it('reports two fitting lines without claiming glyph or painted extents', () => {
    expect(captionLayoutDiagnostic(paint({ content: 'ABC\nDEF' }), measure)).toEqual({
      visibleLineCapacity: 2, observedLines: 2, verticalOverflow: false,
      horizontalOverflow: false, basis: 'shared-wrapper-line-boxes' })
  })
  it('observes only one extra line of a long cue', () => {
    const result = captionLayoutDiagnostic(paint({ content: 'A\n'.repeat(1999) }), measure)
    expect(result).toMatchObject({ visibleLineCapacity: 2, observedLines: 3, verticalOverflow: true })
  })
  it('counts hard blank lines in the same way as the painter', () => {
    expect(captionLayoutDiagnostic(paint({ content: 'A\n\nB' }), measure).verticalOverflow).toBe(true)
  })
  it('detects a single glyph wider than the available line', () => {
    expect(captionLayoutDiagnostic(paint({ content: '👨' }), () => 100).horizontalOverflow).toBe(true)
  })
  it('detects a line clipped by the one-line painter minimum', () => {
    expect(captionLayoutDiagnostic(paint({ fontSizePx: 50, boxHeightPx: 16 }), measure))
      .toMatchObject({ visibleLineCapacity: 1, observedLines: 1, verticalOverflow: true })
  })
  it('honors the existing 512-line rendering limit on a tall canvas', () => {
    expect(captionLayoutDiagnostic(paint({ content: 'A\n'.repeat(600), boxHeightPx: 65535 }), measure))
      .toMatchObject({ visibleLineCapacity: 512, observedLines: 513, verticalOverflow: true })
  })
  it.each([NaN, Infinity, -1])('rejects invalid measurement %s', (width) => {
    expect(() => captionLayoutDiagnostic(paint(), () => width)).toThrow('measurement')
  })
  it('rejects invalid paint inputs rather than silently clamping diagnostics', () => {
    expect(() => captionLayoutDiagnostic(paint({ fontSizePx: 2048 }), measure)).toThrow('Font size')
  })
})

describe('staged conservative color-pair advisory', () => {
  it('anchors black/white at 21 and equal colors at 1', () => {
    expect(captionContrastDiagnostic(paint({ color: '#fff', backgroundEnabled: true, backgroundColor: '#000f' })))
      .toEqual({ kind: 'opaque-color-pair', ratio: 21, belowAdvisory: false, advisory: 4.5 })
    expect(captionContrastDiagnostic(paint({ color: '#777777ff', backgroundEnabled: true, backgroundColor: '#777777' })))
      .toMatchObject({ ratio: 1, belowAdvisory: true })
  })
  it('uses the unrounded threshold for near-boundary gray', () => {
    const below = captionContrastDiagnostic(paint({ color: '#777', backgroundEnabled: true, backgroundColor: '#fff' }))
    expect(below).toMatchObject({ kind: 'opaque-color-pair', belowAdvisory: true })
    if (below.kind === 'opaque-color-pair') expect(below.ratio).toBeCloseTo(4.478089453577214, 10)
    expect(captionContrastDiagnostic(paint({ color: '#767676', backgroundEnabled: true, backgroundColor: '#fff' })))
      .toMatchObject({ belowAdvisory: false })
  })
  it.each([{ backgroundEnabled: false, backgroundColor: '#000000ff' },
    { backgroundEnabled: true, backgroundColor: '#000000cc' }])('does not guess changing video contrast %s', (overrides) => {
    expect(captionContrastDiagnostic(paint(overrides))).toEqual({ kind: 'unmeasured', reason: 'video-background' })
  })
  it('does not claim a foreground-alpha or shadow/outline measurement', () => {
    expect(captionContrastDiagnostic(paint({ color: '#ffffff80', backgroundEnabled: true, backgroundColor: '#000',
      shadowEnabled: true, outlineEnabled: true }))).toEqual({ kind: 'unmeasured', reason: 'transparent-foreground' })
  })
})
