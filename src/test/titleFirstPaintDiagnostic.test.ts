import { describe, expect, test } from 'vitest'
import { firstPaintFixtures, matchesPresentation, pixelDifference, requireGlyphControl, wireOf, type Owner, type Presentation, type Target } from '../../tests/diagnostics/issue200/first-paint-model'
import { parseProjectFile } from '../domain/projectFile'
import { projectTitleExportError } from '../domain/titleExport'

const owner: Owner = { generation: 4, sequenceId: 'root', clipId: 'root-text', frame: 0, canvasId: 3, connected: true, screen: 'editor', phase: 'idle' }
const target: Target = { label: 'reopen', startedAt: 100, owner }
const presented: Presentation = { kind: 'presentation', owner, diagnostic: { frame: 0, requestedAt: 101, result: { status: 'drawn', drawnClipIds: ['root-text'], missingClipIds: [] } } }

describe('first-paint admission cannot accept stale or empty evidence', () => {
  test('admits only matching current-owner presentation, never worker completion alone', () => {
    expect(matchesPresentation(presented, target)).toBe(true)
    expect(matchesPresentation({ ...presented, kind: 'completion' }, target)).toBe(false)
    expect(matchesPresentation({ ...presented, diagnostic: undefined }, target)).toBe(false)
    expect(matchesPresentation({ ...presented, diagnostic: { ...presented.diagnostic!, requestedAt: 99 } }, target)).toBe(false)
  })
  test.each([
    { generation: 3 }, { sequenceId: 'other' }, { clipId: 'old-title' }, { frame: 1 }, { canvasId: 2 },
    { canvasId: null }, { connected: false }, { screen: 'home' }, { phase: 'activating' },
  ])('rejects mismatched owner evidence %j', (patch) => {
    expect(matchesPresentation({ ...presented, owner: { ...owner, ...patch } }, target)).toBe(false)
  })
  test('rejects superseded/error, wrong-frame and missing-title draws', () => {
    for (const result of [
      { status: 'superseded', drawnClipIds: ['root-text'], missingClipIds: [] },
      { status: 'error', drawnClipIds: ['root-text'], missingClipIds: [] },
      { status: 'drawn', drawnClipIds: ['other'], missingClipIds: [] },
      { status: 'drawn', drawnClipIds: ['root-text'], missingClipIds: ['root-text'] },
    ]) expect(matchesPresentation({ ...presented, diagnostic: { ...presented.diagnostic!, result } }, target)).toBe(false)
    expect(matchesPresentation({ ...presented, diagnostic: { ...presented.diagnostic!, frame: 1 } }, target)).toBe(false)
  })
  test('two identical blank images cannot pass the independent glyph control', () => {
    const empty = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255])
    expect(pixelDifference(empty, empty, 2, 1).differingBytes).toBe(0)
    expect(() => requireGlyphControl(empty, empty, 2, 1)).toThrow('no independent glyph pixels')
    const glyph = empty.slice(); glyph[4] = 2; glyph[5] = 3
    expect(requireGlyphControl(glyph, empty, 2, 1)).toEqual({ differingBytes: 2, maximumDelta: 3, changedPixels: 1,
      firstCoordinates: [{ x: 1, y: 0 }], mask: new Uint8Array([0, 1]) })
    expect(pixelDifference(glyph, empty, 2, 1).differingBytes).not.toBe(0)
  })
  test('refuses shape/length mismatches and oversized readback', () => {
    expect(() => pixelDifference(new Uint8ClampedArray(4), new Uint8ClampedArray(8), 1, 1)).toThrow('dimensions/byte lengths')
    expect(() => pixelDifference(new Uint8ClampedArray(4), new Uint8ClampedArray(4), 0.5, 2)).toThrow('dimensions/byte lengths')
    expect(() => pixelDifference(new Uint8ClampedArray(0), new Uint8ClampedArray(0), 3840, 2160)).toThrow('dimensions/byte lengths')
  })
  test('all control fixtures pass the actual portable boundary and explicit title eligibility', () => {
    const fixtures = firstPaintFixtures()
    for (const project of Object.values(fixtures)) expect(parseProjectFile(wireOf(project)).sequences).toHaveLength(2)
    expect(projectTitleExportError(fixtures.unavailable, 'root')).toContain('choose an explicit fallback')
    for (const project of [fixtures.initial, fixtures.fallback, fixtures.serif, fixtures.empty]) expect(projectTitleExportError(project, 'root')).toBeNull()
    expect(wireOf(fixtures.initial)).not.toContain('Missing G3 Face')
    for (const [project, fallbackFamily] of [[fixtures.fallback, 'serif'], [fixtures.unavailable, null]] as const) {
      expect(parseProjectFile(wireOf(project)).sequences[0].tracks[0].clips[0].title).toMatchObject({
        elements: [{ font: { family: 'Missing G3 Face', fallbackFamily } }],
      })
    }
  })
})
