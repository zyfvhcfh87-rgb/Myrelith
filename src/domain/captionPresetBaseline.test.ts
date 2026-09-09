import { describe, expect, it } from 'vitest'
import { captionPaintFor, createCaptionTrack } from './captions'
import { combineCaptionStyleOverrides } from './captionStyle'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import type { CaptionStylePreset, TimelineDoc } from './schema'

const doc: TimelineDoc = { schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION, id: 'doc', name: 'Legacy caption baseline',
  frameRate: { num: 25, den: 1 }, width: 1920, height: 1080, audioSampleRate: 48000, tracks: [], markers: [] }
const cue = { id: 'cue', range: { startFrame: 0, durationFrames: 25 }, text: 'Legacy caption' }

// Golden paint inputs precede any custom-style resolver. These are not browser
// pixels; the later renderer gate must compare actual preview/export output.
describe('legacy caption preset paint baseline', () => {
  it.each<{ preset: CaptionStylePreset; size: number; padding: number; bold: boolean; background: boolean; outline: boolean; width: number; shadow: boolean; blur: number; offset: number }>([
    { preset: 'classic', size: 56, padding: 16, bold: true, background: false, outline: true, width: 4, shadow: true, blur: 7, offset: 4 },
    { preset: 'minimal', size: 46, padding: 13, bold: false, background: false, outline: false, width: 3, shadow: true, blur: 6, offset: 3 },
    { preset: 'boxed', size: 56, padding: 16, bold: true, background: true, outline: false, width: 4, shadow: false, blur: 7, offset: 4 },
  ])('anchors complete $preset paint and absent/empty shadow intent', (baseline) => {
    const track = { ...createCaptionTrack('track', 'Captions'), stylePreset: baseline.preset }
    const paint = captionPaintFor(doc, track, cue, 0, 1)
    expect(paint).toEqual({ id: 'cue', opacity: 1,
      visual: { crop: { left: 0, right: 0, top: 0, bottom: 0 }, flipHorizontal: false, flipVertical: false, scaleLocked: true },
      transform: { x: 0, y: 54, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      text: { content: 'Legacy caption', fontFamily: 'sans-serif', fontSizePx: baseline.size,
        color: '#ffffff', align: 'center', bold: baseline.bold, italic: false,
        boxWidthPx: 1651, boxHeightPx: 842, paddingPx: baseline.padding,
        backgroundEnabled: baseline.background, backgroundColor: '#000000cc',
        outlineEnabled: baseline.outline, outlineColor: '#000000', outlineWidthPx: baseline.width,
        shadowEnabled: baseline.shadow, shadowColor: '#000000', shadowBlurPx: baseline.blur,
        shadowOffsetXPx: 0, shadowOffsetYPx: baseline.offset } })
    expect(combineCaptionStyleOverrides(undefined, undefined).params).not.toHaveProperty('shadowEnabled')
    expect(combineCaptionStyleOverrides({ version: 1, params: {} }, { version: 1, params: {} }).params).not.toHaveProperty('shadowEnabled')
  })

  it('anchors the existing eight-caption layout and preserves enabled minimal shadow', () => {
    const track = { ...createCaptionTrack('track', 'Captions'), stylePreset: 'minimal' as const }
    const paint = captionPaintFor(doc, track, cue, 7, 8)
    expect(paint.text).toMatchObject({ fontSizePx: 40, boxHeightPx: 97, paddingPx: 11,
      shadowEnabled: true, shadowBlurPx: 5, shadowOffsetYPx: 3 })
    expect(paint.transform.y).toBe(-315.5)
  })
})
