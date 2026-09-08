import { describe, expect, it } from 'vitest'
import { CAPTION_ASS_LIMITS, parseCaptionAss } from './captionAss'
import { CAPTION_LIMITS } from './captions'
import { inspectCaptionStyle } from './captionStyle'

const rate = { num: 25, den: 1 }
const styleColumns = 'Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding'
const eventColumns = 'Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
const defaultStyle = { Name: 'Default', Fontname: 'sans-serif', Fontsize: '50', PrimaryColour: '&H000000FF', SecondaryColour: '&H00000000', OutlineColour: '&H8000FF00', BackColour: '&H00000000', Bold: '0', Italic: '-1', Underline: '0', StrikeOut: '0', ScaleX: '100', ScaleY: '100', Spacing: '0', Angle: '0', BorderStyle: '1', Outline: '2', Shadow: '0', Alignment: '2', MarginL: '40', MarginR: '40', MarginV: '20', Encoding: '1' }
function style(values: Partial<typeof defaultStyle> = {}, order = styleColumns): string {
  const record = { ...defaultStyle, ...values }
  return `Style: ${order.split(',').map((key) => record[key as keyof typeof record]).join(',')}`
}
function cue(text = 'Hello', from = '0:00:01.00', to = '0:00:02.00', name = 'Default'): string {
  return `Dialogue: 0,${from},${to},${name},,0,0,0,,${text}`
}
function document(events = [cue()], styles = [style()]): string {
  return ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 2000', 'PlayResY: 1000',
    'WrapStyle: 1', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: None', '[V4+ Styles]',
    `Format: ${styleColumns}`, ...styles, '[Events]', `Format: ${eventColumns}`, ...events].join('\n')
}
const parse = (source = document()) => parseCaptionAss(source, rate, (index) => `cue-${index}`)
function proposal(source = document()) {
  const result = parse(source)
  expect(['ready', 'review']).toContain(result.kind)
  if (result.kind !== 'ready' && result.kind !== 'review') throw new Error(JSON.stringify(result.report))
  return result
}

describe('bounded semantic ASS import', () => {
  it('imports a supported static profile without synthetic media or fabricated preset defaults', () => {
    const result = proposal()
    expect(result.kind).toBe('ready')
    expect(result.report.counts).toEqual({ error: 0, loss: 0, info: 0 })
    expect(result.proposal.stylePreset).toBe('minimal')
    expect(result.proposal.items).toEqual([{ id: 'cue-0', range: { startFrame: 25, durationFrames: 25 }, text: 'Hello' }])
    expect(inspectCaptionStyle(result.proposal.style)).toMatchObject({ kind: 'supported', params: {
      fontFamily: 'sans-serif', fontSizePermille: 50, color: '#ff0000ff', outlineColor: '#00ff007f',
      outlinePermille: 2, outlineEnabled: true, backgroundEnabled: false, shadowEnabled: false, bold: false, italic: true,
      marginXPermille: 20, marginYPermille: 20, align: 'center', position: 'bottom',
    } })
  })

  it('honors column ordering, BOM and CRLF without losing commas or hard line breaks', () => {
    const order = 'Fontname,Name,' + styleColumns.split(',').slice(2).join(',')
    const source = document([cue('Hello, world\\NSecond line')], [style({}, order)])
      .replace(`Format: ${styleColumns}`, `Format: ${order}`)
    const result = proposal('\uFEFF' + source.replaceAll('\n', '\r\n'))
    expect(result.kind).toBe('ready')
    expect(result.proposal.items[0]!.text).toBe('Hello, world\nSecond line')
  })

  it('requires explicit named-font substitutions and reports each substitution', () => {
    const source = document([cue()], [style({ Fontname: 'Example Sans' })])
    const missing = parse(source)
    expect(missing).toMatchObject({ kind: 'needs-fonts', fonts: ['Example Sans'] })
    expect(missing).not.toHaveProperty('proposal')
    const result = parseCaptionAss(source, rate, (i) => `cue-${i}`, { 'Example Sans': 'serif' })
    expect(result).toMatchObject({ kind: 'review', proposal: { style: { params: { fontFamily: 'serif' } } } })
    expect(result.report.details).toContainEqual(expect.objectContaining({ code: 'font-substitution' }))
  })

  it('keeps inherited style on the track and only cue differences on items', () => {
    const result = proposal(document([cue(), cue('Other', '0:00:03.00', '0:00:04.00', 'Other')],
      [style(), style({ Name: 'Other', Bold: '-1', Alignment: '9' })]))
    expect(result.proposal.items[0]).not.toHaveProperty('style')
    expect(result.proposal.items[1]!.style).toEqual({ version: 1, params: { bold: true, align: 'right', position: 'top' } })
  })

  it.each([
    ['1', 'left', 'bottom'], ['2', 'center', 'bottom'], ['3', 'right', 'bottom'],
    ['4', 'left', 'middle'], ['5', 'center', 'middle'], ['6', 'right', 'middle'],
    ['7', 'left', 'top'], ['8', 'center', 'top'], ['9', 'right', 'top'],
  ])('maps ASS numpad alignment %s into semantic caption placement', (value, align, position) => {
    expect(proposal(document([cue()], [style({ Alignment: value })])).proposal.style.params).toMatchObject({ align, position })
  })

  it('applies dialogue margins while zero values inherit the named style', () => {
    const source = document([cue().replace('Default,,0,0,0,,', 'Default,,80,80,0,,')])
    expect(proposal(source).proposal.items[0]!.style).toEqual({ version: 1, params: { marginXPermille: 40 } })
  })

  it('uses exact coverage math and deterministic sorting while preserving generated IDs', () => {
    const result = parseCaptionAss(document([cue('later', '0:00:03.00', '0:00:04.00'), cue('first', '0:00:00.01', '0:00:01.01')]), { num: 30_000, den: 1001 }, (i) => `cue-${i}`)
    expect(result).toMatchObject({ kind: 'ready', proposal: { items: [
      { id: 'cue-1', range: { startFrame: 0, durationFrames: 31 } }, { id: 'cue-0' },
    ] } })
  })

  it('applies only supported prefix tags including color order, alpha and resets', () => {
    const result = proposal(document([cue('{\\b1\\i0\\fs60\\c&H112233&\\3c&H445566&\\bord3\\an7}Hello')]))
    expect(result.kind).toBe('ready')
    expect(result.proposal.items[0]!.style).toEqual({ version: 1, params: {
      fontSizePermille: 60, color: '#332211ff', outlineColor: '#6655447f', bold: true, italic: false,
      outlinePermille: 3, align: 'left', position: 'top',
    } })
    expect(proposal(document([cue('{\\b1\\b\\fs60\\fs\\c&H000000&\\c}Hello')])).proposal.items[0]).not.toHaveProperty('style')
  })

  it('does not apply nested animated or post-text tags as static prefix intent', () => {
    const result = proposal(document([cue('{\\t(0,100,\\b1)}Hello{\\i0}')]))
    expect(result.kind).toBe('review')
    expect(result.proposal.items[0]).not.toHaveProperty('style')
    expect(result.report.details.map((detail) => detail.code)).toEqual(['unsupported-override', 'span-style'])
  })

  it.each(['\\p1', '\\p 1', '\\p01', '\\t(0,100,\\p1)'])('rejects drawing mode %s before exposing vector commands as text', (tag) => {
    const result = parse(document([cue(`{${tag}}m 0 0 l 100 100`)]))
    expect(result.kind).toBe('rejected')
    expect(result.report.details.at(-1)?.code).toBe('unsupported-feature')
  })

  it('reports discarded layers, effects, metadata, font weights, unsupported style and wrapping', () => {
    const source = document([cue().replace('Dialogue: 0,', 'Dialogue: 1,').replace('Default,,0,0,0,,', 'Default,Speaker,0,0,0,Banner,')],
      [style({ Bold: '700', Shadow: '2', MarginR: '80' })]).replace('WrapStyle: 1', 'WrapStyle: 0') + '\n[Fonts]\nfontname: omitted.ttf'
    const result = proposal(source)
    expect(result.kind).toBe('review')
    expect(result.report.details.map((detail) => detail.code)).toEqual(expect.arrayContaining([
      'unsupported-section', 'wrapping-policy', 'asymmetric-margins', 'unsupported-style-field', 'layer-order', 'event-effect', 'actor-metadata',
    ]))
  })

  it('reports whitespace normalization including original trailing spaces and hard spaces', () => {
    const result = proposal(document([cue('  Hello\\hworld  ')]))
    expect(result.kind).toBe('review')
    expect(result.proposal.items[0]!.text).toBe('Hello world')
    expect(result.report.details.map((detail) => detail.code)).toContain('outer-whitespace')
  })

  it.each([
    ['script version', (s: string) => s.replace('v4.00+', 'v4.00')],
    ['missing resolution', (s: string) => s.replace('PlayResY: 1000', '')],
    ['duplicate section', (s: string) => s + '\n[Events]'],
    ['duplicate field', (s: string) => s.replace('PlayResX: 2000', 'PlayResX: 2000\nPlayResX: 2000')],
    ['duplicate column', (s: string) => s.replace('Layer,Start,End', 'Start,Start,End')],
    ['non-final text', (s: string) => s.replace('Effect,Text', 'Text,Effect')],
    ['missing style', (s: string) => s.replace(',Default,,', ',Missing,,')],
    ['malformed time', (s: string) => s.replace('0:00:01.00', '0:00:01.000')],
    ['empty duration', (s: string) => s.replace('0:00:02.00', '0:00:01.00')],
    ['brace mismatch', (s: string) => s.replace('Hello', '{\\b1Hello')],
    ['unsafe markup', (s: string) => s.replace('Hello', '<b>Hello</b>')],
    ['unknown escape', (s: string) => s.replace('Hello', 'Hello\\x')],
  ])('rejects %s with no partial proposal', (_, edit) => {
    const result = parse(edit(document()))
    expect(result.kind).toBe('rejected')
    expect(result).not.toHaveProperty('proposal')
    expect(result.report.counts.error).toBe(1)
  })

  it('rejects simultaneous cue overflow and duplicate caller IDs through shared caption validation', () => {
    expect(parse(document(Array.from({ length: 9 }, () => cue()))).kind).toBe('rejected')
    expect(parseCaptionAss(document([cue(), cue('Later', '0:00:03.00', '0:00:04.00')]), rate, () => 'same').kind).toBe('rejected')
  })

  it('bounds text, source bytes, styles, overrides and diagnostics with a retained terminal error', () => {
    expect(parse(document([cue('a'.repeat(CAPTION_LIMITS.maxItemCharacters + 1))])).kind).toBe('rejected')
    expect(parse('a'.repeat(2_000_001)).kind).toBe('rejected')
    expect(parse('界'.repeat(1_333_334)).kind).toBe('rejected')
    expect(parse(document([cue()], Array.from({ length: 257 }, (_, i) => style({ Name: `Style${i}` })))).kind).toBe('rejected')
    expect(parse(document([cue('{' + '\\b1'.repeat(33) + '}Hello')])).kind).toBe('rejected')
    expect(parse(document([cue('{comment}'.repeat(33) + 'Hello')])).kind).toBe('rejected')
    expect(parse(document([cue('{' + 'x'.repeat(513) + '}Hello')])).kind).toBe('rejected')
    const result = parse(document([cue('<invalid>')]).replace('[Events]', '; comment\n'.repeat(140) + '[Events]'))
    expect(result.report.details).toHaveLength(CAPTION_ASS_LIMITS.maxDiagnostics)
    expect(result.report.counts).toEqual({ error: 1, loss: 0, info: 140 })
    expect(result.report.omittedDetails).toBe(41)
    expect(result.report.details.at(-1)?.severity).toBe('error')
  })
})
