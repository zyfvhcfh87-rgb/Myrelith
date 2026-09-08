import { describe, expect, it } from 'vitest'
import { CAPTION_ASS_LIMITS, parseCaptionAss, planCaptionAssExport, type CaptionAssProposal } from './captionAss'
import { CAPTION_LIMITS } from './captions'
import type { CaptionStyleDescriptor, CaptionStyleV1 } from './captionStyle'
import type { FrameRate } from './schema'

const rate = { num: 25, den: 1 }
const params: CaptionStyleV1 = { fontFamily: 'sans-serif', fontSizePermille: 50,
  color: '#12345680', outlineColor: '#abcdef00', backgroundColor: '#00000000',
  bold: true, italic: false, backgroundEnabled: false, outlineEnabled: true,
  outlinePermille: 2, align: 'center', position: 'bottom', marginXPermille: 20, marginYPermille: 20 }
const style = (overrides: Partial<CaptionStyleV1> = {}): CaptionStyleDescriptor => ({ version: 1, params: { ...params, ...overrides } })
function proposal(overrides: Partial<CaptionAssProposal> = {}): CaptionAssProposal {
  return { stylePreset: 'minimal', style: style(), scriptWidth: 2000, scriptHeight: 1000,
    items: [{ id: 'cue', range: { startFrame: 25, durationFrames: 25 }, text: 'Hello, world\nFrançais 😀' }], ...overrides }
}
function ready(input = proposal(), fps = rate) {
  const result = planCaptionAssExport(input, fps)
  expect(result.kind, JSON.stringify(result.report)).toBe('ready')
  if (result.kind === 'rejected') throw new Error('Rejected fixture')
  return result
}
function reimport(text: string, fps = rate) {
  const result = parseCaptionAss(text, fps, (i) => `imported-${i}`)
  expect(result.kind, JSON.stringify(result.report)).toBe('ready')
  if (result.kind !== 'ready') throw new Error('Rejected fixture')
  return result.proposal
}

describe('semantic ASS export proposals', () => {
  it('round-trips complete style, alpha/BGR, text and frames without changing the source', () => {
    const input = proposal(); const before = JSON.stringify(input)
    const exported = ready(input)
    expect(exported.text).toContain('&H7F563412')
    expect(exported.text).toContain('Hello, world\\NFrançais 😀')
    const imported = reimport(exported.text)
    expect(imported.style).toEqual(input.style)
    expect(imported.items[0]).toEqual({ ...input.items[0], id: 'imported-0' })
    expect(exported.report.counts).toEqual({ error: 0, loss: 0, info: 0 })
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each<FrameRate>([{ num: 24, den: 1 }, rate, { num: 30, den: 1 }, { num: 50, den: 1 },
    { num: 60, den: 1 }, { num: 24000, den: 1001 }, { num: 30000, den: 1001 }, { num: 60000, den: 1001 }])('proves exact ranges at rational rate %j', (fps) => {
    const input = proposal({ items: [{ id: 'cue', range: { startFrame: 5, durationFrames: 100 }, text: 'Exact' }] })
    const exported = ready(input, fps)
    expect(reimport(exported.text, fps).items[0]!.range).toEqual(input.items[0]!.range)
  })

  it('deduplicates semantic styles and gives stable names/order independent of source array and key order', () => {
    const a = { id: 'a', range: { startFrame: 0, durationFrames: 25 }, text: 'A', style: { version: 1, params: { color: '#ffffffff', bold: false } } }
    const b = { id: 'b', range: { startFrame: 25, durationFrames: 25 }, text: 'B', style: { version: 1, params: { bold: false, color: '#ffffffff' } } }
    const c = { id: 'c', range: { startFrame: 50, durationFrames: 25 }, text: 'C', style: { version: 1, params: { align: 'left', position: 'top' } } }
    const text = ready(proposal({ items: [c, b, a] })).text
    expect(text).toBe(ready(proposal({ items: [a, b, c] })).text)
    expect(text.match(/^Style:/gmu)).toHaveLength(3)
    const imported = reimport(text)
    expect(imported.items.map((item) => item.text)).toEqual(['A', 'B', 'C'])
    expect(imported.items[0]!.style).toEqual(imported.items[1]!.style)
    expect(imported.items[2]!.style?.params).toEqual({ align: 'left', position: 'top' })
  })

  it('keeps normalized decimal values exact at non-round script dimensions', () => {
    const input = proposal({ scriptWidth: 1920, scriptHeight: 1080, style: style({
      fontSizePermille: 53 * 1000 / 1080, outlinePermille: 2.125 * 1000 / 1080,
      marginXPermille: 41 * 1000 / 1920, marginYPermille: 33 * 1000 / 1080 }) })
    expect(reimport(ready(input).text).style).toEqual(input.style)
  })

  it('makes noninteger margins and inactive/background style losses visible', () => {
    const input = proposal({ scriptWidth: 1920, scriptHeight: 1080,
      style: style({ marginXPermille: 20.12345, outlineEnabled: false, backgroundEnabled: true, backgroundColor: '#ff0000ff' }) })
    const result = planCaptionAssExport(input, rate)
    expect(result.kind).toBe('review')
    expect(result.report.counts.error).toBe(0)
    for (const key of ['marginXPermille', 'outlinePermille', 'backgroundEnabled', 'backgroundColor']) {
      expect(result.report.details.some((entry) => entry.detail.includes(key))).toBe(true)
    }
  })

  it('reports tiny outline quantization without scientific notation or silent zeroing', () => {
    const result = planCaptionAssExport(proposal({ style: style({ outlinePermille: 1e-22 }) }), rate)
    expect(result.kind).toBe('review')
    expect(result.report.details.some((entry) => entry.detail.includes('outlinePermille'))).toBe(true)
  })

  it('requires review for outward one-frame NTSC coverage and reports exact changed frames', () => {
    const result = planCaptionAssExport(proposal({ items: [{ id: 'cue', range: { startFrame: 3, durationFrames: 1 }, text: 'Short' }] }), { num: 60000, den: 1001 })
    expect(result.kind).toBe('review')
    expect(result.report.details.some((entry) => entry.code === 'timing-coverage' && entry.detail.includes('frames 3+1 become'))).toBe(true)
  })

  it('rejects coverage expansion that creates nine simultaneous visible cues', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ id: `cue-${i}`, text: 'Short', range: { startFrame: i, durationFrames: 1 } }))
    const result = planCaptionAssExport(proposal({ items }), { num: 1000, den: 1 })
    expect(result.kind).toBe('rejected')
    expect(result.report.counts.error).toBe(1)
    expect('text' in result).toBe(false)
  })

  it.each(['brace {text}', 'brace }text', 'path\\name', 'text\u0000', 'text\ud800', 'tab\ttext'])('rejects unrepresentable text %j without a partial file', (text) => {
    const result = planCaptionAssExport(proposal({ items: [{ id: 'cue', text, range: { startFrame: 0, durationFrames: 25 } }] }), rate)
    expect(result.kind).toBe('rejected'); expect('text' in result).toBe(false)
  })

  it('rejects unresolved presets and partial, invalid or unavailable track/cue styles', () => {
    for (const input of [proposal({ stylePreset: 'classic' }), proposal({ stylePreset: 'boxed' }),
      proposal({ style: { version: 1, params: { color: '#ffffffff' } } }),
      proposal({ style: { version: 2, params: {} } }), proposal({ style: style({ fontSizePermille: 0 }) }),
      proposal({ items: [{ id: 'cue', text: 'Unknown', range: { startFrame: 0, durationFrames: 25 }, style: { version: 1, params: { future: true } } }] })]) {
      expect(planCaptionAssExport(input, rate).kind).toBe('rejected')
    }
  })

  it('validates identities, dimensions, rational rate and input limits before returning a file', () => {
    const item = proposal().items[0]!
    for (const input of [proposal({ items: [] }), proposal({ items: [item, item] }),
      proposal({ scriptWidth: 0 }), proposal({ scriptHeight: 65536 }),
      proposal({ items: Array(CAPTION_LIMITS.maxItemsPerTrack + 1).fill(item) })]) {
      expect(planCaptionAssExport(input, rate).kind).toBe('rejected')
    }
    expect(planCaptionAssExport(proposal(), { num: 25.5, den: 1 }).kind).toBe('rejected')
    expect(ready(proposal({ items: [{ ...item, id: 'ass-export-validation' }] })).kind).toBe('ready')
  })

  it('bounds distinct styles after semantic deduplication', () => {
    const items = Array.from({ length: 256 }, (_, i) => ({ id: `cue-${i}`, text: 'Style', range: { startFrame: i * 25, durationFrames: 25 },
      style: { version: 1, params: { color: `#${i.toString(16).padStart(6, '0')}ff` } } }))
    expect(planCaptionAssExport(proposal({ items }), rate).kind).toBe('rejected')
    expect(ready(proposal({ items: items.slice(1) })).text.match(/^Style:/gmu)).toHaveLength(256)
  })

  it('bounds exact loss counts/details and retains the final blocking error', () => {
    const items = Array.from({ length: 110 }, (_, i) => ({ id: `cue-${i}`, text: 'Short', range: { startFrame: i, durationFrames: 1 } }))
    const result = planCaptionAssExport(proposal({ items }), { num: 1000, den: 1 })
    expect(result.kind).toBe('rejected')
    expect(result.report.details).toHaveLength(CAPTION_ASS_LIMITS.maxDiagnostics)
    expect(result.report.counts.loss).toBe(110)
    expect(result.report.omittedDetails).toBe(11)
    expect(result.report.details.at(-1)!.severity).toBe('error')
  })

  it('checks complete output characters and UTF-8 bytes, including format overhead', () => {
    for (const text of ['a'.repeat(4000), '界'.repeat(3999)]) {
      const items = Array.from({ length: 500 }, (_, i) => ({ id: `cue-${i}`, text, range: { startFrame: i * 25, durationFrames: 25 } }))
      const result = planCaptionAssExport(proposal({ items }), rate)
      expect(result.kind).toBe('rejected'); expect(result.report.details.at(-1)!.code).toBe('resource-limit')
    }
  })
})
