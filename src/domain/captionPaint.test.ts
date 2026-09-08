import { describe, expect, it } from 'vitest'
import { captionPaintFor, createCaptionTrack } from './captions'
import { resolveCaptionPaint } from './captionPaint'
import type { CaptionStyleDescriptor } from './captionStyle'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import type { CaptionStylePreset, TimelineDoc } from './schema'

const presets: CaptionStylePreset[] = ['classic', 'minimal', 'boxed']
const dimensions = [[1920, 1080], [1080, 1920], [320, 180], [1279, 719], [321, 181]] as const
const cue = { id: 'cue', text: 'Caption text', range: { startFrame: 0, durationFrames: 25 } }
function document(width = 1920, height = 1080): TimelineDoc {
  return { ...createTimelineDoc('Paint', DEFAULT_PROJECT_SETTINGS, 'doc'), width, height }
}

describe('caption paint compatibility and style resolution', () => {
  it.each(presets)('preserves complete %s paint inputs for absent, empty and effective no-op styles across canvases and stacks', (stylePreset) => {
    for (const [width, height] of dimensions) for (let count = 1; count <= 8; count++) {
      const doc = document(width, height), track = { ...createCaptionTrack('captions', 'Captions'), stylePreset }
      for (let index = 0; index < count; index++) {
        const legacy = captionPaintFor(doc, track, cue, index, count)
        const equivalentStyles: CaptionStyleDescriptor['params'][] = [{}, { position: 'bottom', marginXPermille: 70, marginYPermille: 60 }, {
          fontFamily: legacy.text.fontFamily, fontSizePermille: legacy.text.fontSizePx * 1_000 / height,
          color: '#ffffffff', outlineColor: '#000000ff', backgroundColor: '#000000cc',
          bold: legacy.text.bold, italic: false, align: 'center',
          backgroundEnabled: legacy.text.backgroundEnabled, outlineEnabled: legacy.text.outlineEnabled,
          outlinePermille: legacy.text.outlineWidthPx * 1_000 / height, shadowEnabled: legacy.text.shadowEnabled,
        }]
        for (const params of equivalentStyles) {
          const result = resolveCaptionPaint(doc, { ...track, style: { version: 1, params } }, cue, index, count)
          expect(result.unavailable).toEqual([])
          expect(result.paint).toEqual(legacy)
          expect(result.changedGeometry).toBe(false)
        }
        expect(resolveCaptionPaint(doc, track, cue, index, count).paint).toEqual(legacy)
      }
    }
  })
  it('merges supported track then cue intent without moving a color/bold/shadow-only caption', () => {
    const doc = document(), track = createCaptionTrack('captions', 'Captions')
    const legacy = captionPaintFor(doc, track, cue, 0, 1)
    const result = resolveCaptionPaint(doc, { ...track, style: { version: 1, params: { color: '#ff0000ff', bold: false } } },
      { ...cue, style: { version: 1, params: { color: '#00ff00ff', shadowEnabled: false } } }, 0, 1)
    expect(result.paint.text).toMatchObject({ color: '#00ff00ff', bold: false, shadowEnabled: false,
      paddingPx: legacy.text.paddingPx, boxWidthPx: legacy.text.boxWidthPx, boxHeightPx: legacy.text.boxHeightPx })
    expect(result.paint.transform).toEqual(legacy.transform)
    expect(result.changedGeometry).toBe(false)
  })
  it('keeps legacy shadow shape even when an explicit font size changes', () => {
    const doc = document(), track = createCaptionTrack('captions', 'Captions')
    const legacy = captionPaintFor(doc, track, cue, 0, 1)
    const result = resolveCaptionPaint(doc, { ...track, style: { version: 1, params: { fontSizePermille: 100 } } }, cue, 0, 1)
    expect(result.paint.text.fontSizePx).toBe(108)
    for (const key of ['shadowColor', 'shadowBlurPx', 'shadowOffsetXPx', 'shadowOffsetYPx'] as const) {
      expect(result.paint.text[key]).toBe(legacy.text[key])
    }
  })
  it.each(['top', 'middle', 'bottom'] as const)('anchors the existing box stack at %s and honors large vertical margins', (position) => {
    const doc = document(2000, 1000), track = { ...createCaptionTrack('captions', 'Captions'),
      style: { version: 1, params: { position, marginYPermille: 250, marginXPermille: 250 } } }
    const boxes = Array.from({ length: 8 }, (_, index) => resolveCaptionPaint(doc, track, cue, index, 8))
    for (const result of boxes) {
      expect(result.unavailable).toEqual([])
      expect(result.paint.text.boxWidthPx).toBe(1000)
      const top = (doc.height - result.paint.text.boxHeightPx) / 2 + result.paint.transform.y
      expect(top).toBeGreaterThanOrEqual(250)
      expect(top + result.paint.text.boxHeightPx).toBeLessThanOrEqual(750)
    }
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index - 1].paint.transform.y - boxes[index].paint.transform.y).toBe(boxes[index].paint.text.boxHeightPx + 8)
    }
  })
  it('ignores an unavailable level whole and keeps supported cue fields with a visible reason', () => {
    const doc = document(), track = { ...createCaptionTrack('captions', 'Captions'),
      style: { version: 99, params: { color: '#ff0000ff', future: true } } }
    const result = resolveCaptionPaint(doc, track, { ...cue, style: { version: 1, params: { italic: true } } }, 0, 1)
    expect(result.unavailable).toEqual([{ level: 'track', reason: 'Caption style version 99 is unavailable' }])
    expect(result.paint.text).toMatchObject({ color: '#ffffff', italic: true })
    expect(track.style.params.future).toBe(true)
  })
  it.each<{ width: number; height: number; params: CaptionStyleDescriptor['params'] }>([
    { width: 64, height: 64, params: { fontSizePermille: 8 } },
    { width: 16384, height: 16384, params: { fontSizePermille: 150 } },
    { width: 16384, height: 16384, params: { outlinePermille: 10 } },
    { width: 32, height: 64, params: { marginXPermille: 250, fontSizePermille: 150 } },
  ])('reports unsupported pixel metrics without clamping authored values: $params', ({ width, height, params }) => {
    const doc = document(width, height), track = { ...createCaptionTrack('captions', 'Captions'), style: { version: 1, params } }
    const result = resolveCaptionPaint(doc, track, cue, 0, 1)
    expect(result.unavailable.some((entry) => entry.level === 'rendering')).toBe(true)
    expect(result.paint).toEqual(captionPaintFor(doc, track, cue, 0, 1))
    expect(track.style.params).toEqual(params)
  })
  it('reports impossible small-canvas stack margins while keeping legacy preview fallback', () => {
    const doc = document(320, 180), track = { ...createCaptionTrack('captions', 'Captions'),
      style: { version: 1, params: { marginYPermille: 250, position: 'top' } } }
    const result = resolveCaptionPaint(doc, track, cue, 0, 8)
    expect(result.unavailable[0].reason).toMatch(/cannot fit/)
    expect(result.paint).toEqual(captionPaintFor(doc, track, cue, 0, 8))
  })
})
