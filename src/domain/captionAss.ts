/** Bounded ASS v4+ semantic import; unsupported appearance always needs review. */
import { captionAssRangeToFrames } from './captionAssTime'
import { CaptionFileError, MAX_CAPTION_FILE_CHARACTERS } from './captionFiles'
import { CAPTION_LIMITS, captionTracksValidationError, compareCaptionItems, normalizeCaptionText } from './captions'
import { CAPTION_STYLE_LIMITS, inspectCaptionStyle, type CaptionStyleDescriptor, type CaptionStyleV1 } from './captionStyle'
import { utf8ByteLength } from './documentMemory'
import type { CaptionItem, CaptionStylePreset, CaptionTrack, FrameRate, TextFontFamily } from './schema'
import { isSupportedTextFontFamily } from './textOverlay'

export const CAPTION_ASS_LIMITS = Object.freeze({ maxFileBytes: 4_000_000, maxStyles: 256,
  maxStyleNameCharacters: 256, maxStyleRecordBytes: 4_096, maxDiagnostics: 100,
  maxDetailCharacters: 256, maxOverrideBlocks: 32, maxOverrideTags: 32, maxOverrideBlockCharacters: 512 })

export interface CaptionAssDiagnostic {
  readonly severity: 'error' | 'loss' | 'info'
  readonly code: string
  readonly line: number | null
  readonly detail: string
}
export interface CaptionAssReport {
  readonly details: readonly CaptionAssDiagnostic[]
  readonly counts: Readonly<Record<'error' | 'loss' | 'info', number>>
  readonly omittedDetails: number
}
export interface CaptionAssItem extends CaptionItem { style?: CaptionStyleDescriptor }
export interface CaptionAssProposal {
  /** ASS's supported no-shadow profile uses minimal; full imported values override it. */
  readonly stylePreset: CaptionStylePreset
  readonly style: CaptionStyleDescriptor
  readonly items: CaptionAssItem[]
  readonly scriptWidth: number
  readonly scriptHeight: number
}
export type CaptionAssImport =
  | { readonly kind: 'ready'; readonly proposal: CaptionAssProposal; readonly report: CaptionAssReport }
  | { readonly kind: 'review'; readonly proposal: CaptionAssProposal; readonly report: CaptionAssReport }
  | { readonly kind: 'needs-fonts'; readonly fonts: readonly string[]; readonly report: CaptionAssReport }
  | { readonly kind: 'rejected'; readonly report: CaptionAssReport }

const STYLE_COLUMNS = 'Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding'.toLowerCase().split(',')
const EVENT_COLUMNS = 'Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'.toLowerCase().split(',')
const INFO_FIELDS = new Set(['title', 'original script', 'original translation', 'original editing', 'original timing', 'synch point', 'script updated by', 'update details'])

class Report {
  readonly details: CaptionAssDiagnostic[] = []
  readonly counts = { error: 0, loss: 0, info: 0 }
  add(severity: CaptionAssDiagnostic['severity'], code: string, line: number | null, detail: string): void {
    this.counts[severity]++
    const entry = { severity, code, line, detail: detail.slice(0, CAPTION_ASS_LIMITS.maxDetailCharacters) }
    if (this.details.length < CAPTION_ASS_LIMITS.maxDiagnostics) this.details.push(entry)
    else if (severity === 'error') this.details[this.details.length - 1] = entry
  }
  finish(): CaptionAssReport {
    return { details: this.details, counts: this.counts,
      omittedDetails: this.counts.error + this.counts.loss + this.counts.info - this.details.length }
  }
}
function reject(message: string, line: number | null, code: 'resource-limit' | 'malformed-header' | 'malformed-cue' | 'unsupported-feature' = 'malformed-cue'): never {
  throw new CaptionFileError(code, message, line)
}
function decimal(value: string, line: number): number {
  if (value.length > 64 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) reject('Expected a bounded decimal ASS value', line)
  const result = Number(value)
  if (!Number.isFinite(result)) reject('ASS numeric value must be finite', line)
  return result
}
function positiveResolution(value: string | undefined, line: number | null): number {
  if (!value || !/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 65_535) reject('ASS requires explicit PlayResX/PlayResY from 1 to 65535', line, 'malformed-header')
  return Number(value)
}
function columns(value: string, expected: readonly string[], line: number): string[] {
  const names = value.split(',').map((name) => name.trim().toLowerCase())
  if (names.length !== expected.length || new Set(names).size !== names.length || expected.some((name) => !names.includes(name))) reject('ASS Format must contain each supported column exactly once', line, 'malformed-header')
  if (names.includes('text') && names.at(-1) !== 'text') reject('ASS Text must be the final event column', line, 'malformed-header')
  return names
}
function fields(value: string, names: readonly string[], line: number, textLast: boolean): Record<string, string> {
  const values: string[] = []
  let start = 0
  for (let index = 0; index < names.length - 1; index++) {
    const comma = value.indexOf(',', start)
    if (comma < 0) reject('ASS record is missing columns', line)
    values.push(value.slice(start, comma).trim())
    start = comma + 1
  }
  const last = value.slice(start)
  if (!textLast && last.includes(',')) reject('ASS style has extra columns', line)
  values.push(textLast ? last : last.trim())
  return Object.fromEntries(names.map((name, index) => [name, values[index]!]))
}
function styleColor(value: string, line: number): string {
  const match = /^&H([0-9a-f]{1,8})&?$/iu.exec(value)
  if (!match) reject('ASS style colors must use hexadecimal &HAABBGGRR', line, 'unsupported-feature')
  const hex = match[1]!.padStart(8, '0').toLowerCase()
  const opacity = (255 - Number.parseInt(hex.slice(0, 2), 16)).toString(16).padStart(2, '0')
  return `#${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}${opacity}`
}
function alignment(value: number, line: number): Pick<CaptionStyleV1, 'align' | 'position'> {
  if (!Number.isInteger(value) || value < 1 || value > 9) reject('ASS alignment must use 1–9', line)
  return { align: (['left', 'center', 'right'] as const)[(value - 1) % 3]!,
    position: (['bottom', 'middle', 'top'] as const)[Math.floor((value - 1) / 3)]! }
}
function descriptor(params: Partial<CaptionStyleV1>, line: number): CaptionStyleDescriptor {
  const result = inspectCaptionStyle({ version: 1, params })
  if (result.kind !== 'supported') reject(result.kind === 'invalid' ? result.reason : 'Unsupported ASS style', line, 'unsupported-feature')
  return result.descriptor
}

interface RawRecord { line: number; values: Record<string, string> }
interface CompiledStyle { params: CaptionStyleV1; marginLeft: number; marginRight: number; marginVertical: number }
function compileStyle(raw: RawRecord, width: number, height: number, substitutions: Readonly<Record<string, TextFontFamily>>,
  fonts: Set<string>, report: Report): CompiledStyle {
  const { values: v, line } = raw
  const font = v.fontname!
  let fontFamily: TextFontFamily = 'sans-serif'
  if (isSupportedTextFontFamily(font)) fontFamily = font
  else if (Object.hasOwn(substitutions, font) && isSupportedTextFontFamily(substitutions[font])) {
    fontFamily = substitutions[font]!
    report.add('loss', 'font-substitution', line, `Named font ${font} maps to explicitly selected ${fontFamily}`)
  } else fonts.add(font)
  const n = (key: string) => decimal(v[key]!, line)
  const booleanStyle = (key: string): boolean => {
    const value = n(key)
    if (![0, 1, -1].includes(value)) report.add('loss', 'unsupported-style-field', line, `${key}=${v[key]} becomes a boolean style`)
    return value !== 0
  }
  const marginLeft = n('marginl'); const marginRight = n('marginr'); const marginVertical = n('marginv')
  if ([marginLeft, marginRight, marginVertical].some((margin) => !Number.isInteger(margin) || margin < 0)) reject('ASS margins must be nonnegative integers', line)
  if (marginLeft !== marginRight) report.add('loss', 'asymmetric-margins', line, 'Unequal left/right margins become the larger symmetric margin')
  for (const [key, expected] of [['underline', 0], ['strikeout', 0], ['scalex', 100], ['scaley', 100], ['spacing', 0], ['angle', 0], ['borderstyle', 1], ['shadow', 0], ['encoding', 1]] as const) {
    if (n(key) !== expected) report.add('loss', 'unsupported-style-field', line, `${key}=${v[key]} is not preserved; supported value is ${expected}`)
  }
  // Secondary color is not used when karaoke is absent; validate its syntax anyway.
  styleColor(v.secondarycolour!, line)
  const outline = n('outline')
  const params: CaptionStyleV1 = { fontFamily, fontSizePermille: n('fontsize') * 1_000 / height,
    color: styleColor(v.primarycolour!, line), outlineColor: styleColor(v.outlinecolour!, line),
    backgroundColor: '#00000000', bold: booleanStyle('bold'), italic: booleanStyle('italic'),
    backgroundEnabled: false, outlineEnabled: outline > 0, outlinePermille: outline * 1_000 / height,
    ...alignment(n('alignment'), line), marginXPermille: Math.max(marginLeft, marginRight) * 1_000 / width,
    marginYPermille: marginVertical * 1_000 / height }
  styleColor(v.backcolour!, line)
  descriptor(params, line)
  return { params, marginLeft, marginRight, marginVertical }
}

/** Parse all source data before exposing a ready/review proposal; never commit. */
export function parseCaptionAss(source: string, rate: FrameRate, createItemId: (index: number) => string,
  substitutions: Readonly<Record<string, TextFontFamily>> = {}): CaptionAssImport {
  const report = new Report()
  try {
    if (source.length > MAX_CAPTION_FILE_CHARACTERS || utf8ByteLength(source) > CAPTION_ASS_LIMITS.maxFileBytes) reject('ASS exceeds the caption file budget', null, 'resource-limit')
    const lines = source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n')
    const info = new Map<string, string>()
    const styles = new Map<string, RawRecord>()
    const events: RawRecord[] = []
    const sections = new Set<string>()
    let section = ''
    let styleColumns: string[] | null = null
    let eventColumns: string[] | null = null
    for (let index = 0; index < lines.length; index++) {
      const line = index + 1
      const value = lines[index]!.trimStart()
      if (!value.trim()) continue
      if (value.startsWith(';')) { report.add('info', 'comment', line, 'ASS comment omitted'); continue }
      if (value.startsWith('[') && value.trimEnd().endsWith(']')) {
        section = value.trimEnd().slice(1, -1).toLowerCase()
        if (sections.has(section)) reject('Duplicate ASS section', line, 'malformed-header')
        sections.add(section)
        if (!['script info', 'v4+ styles', 'events', 'aegisub project garbage'].includes(section)) report.add('loss', 'unsupported-section', line, `Section ${section} is omitted`)
        if (section === 'aegisub project garbage') report.add('info', 'editor-metadata', line, 'Aegisub editor metadata omitted')
        continue
      }
      if (!section) reject('ASS must begin with a section header', line, 'malformed-header')
      if (!['script info', 'v4+ styles', 'events'].includes(section)) continue
      const colon = value.indexOf(':')
      if (colon < 1) reject('ASS record is missing its field separator', line)
      const key = value.slice(0, colon).trim().toLowerCase()
      const body = value.slice(colon + 1).trimStart()
      if (section === 'script info') {
        if (info.has(key)) reject('Duplicate ASS script field', line, 'malformed-header')
        info.set(key, body.trim())
        if (INFO_FIELDS.has(key)) report.add('info', 'script-metadata', line, `Script metadata ${key} omitted`)
        else if (!['scripttype', 'playresx', 'playresy', 'wrapstyle', 'scaledborderandshadow', 'ycbcr matrix'].includes(key)) report.add('loss', 'unsupported-script-field', line, `Script field ${key} is omitted; raw cue timestamps are used`)
      } else if (key === 'format') {
        if (section === 'v4+ styles') {
          if (styleColumns) reject('Duplicate ASS style Format', line, 'malformed-header')
          styleColumns = columns(body, STYLE_COLUMNS, line)
        } else {
          if (eventColumns) reject('Duplicate ASS event Format', line, 'malformed-header')
          eventColumns = columns(body, EVENT_COLUMNS, line)
        }
      } else if (section === 'v4+ styles' && key === 'style') {
        if (!styleColumns) reject('ASS styles require Format first', line, 'malformed-header')
        if (utf8ByteLength(body) > CAPTION_ASS_LIMITS.maxStyleRecordBytes) reject('ASS style record exceeds 4 KiB', line, 'resource-limit')
        const values = fields(body, styleColumns, line, false)
        if (!values.name || values.name.length > CAPTION_ASS_LIMITS.maxStyleNameCharacters || !values.fontname || values.fontname.length > 256) reject('ASS style/font name must be nonempty and bounded', line)
        if (styles.has(values.name)) reject('Duplicate ASS style name', line)
        if (styles.size >= CAPTION_ASS_LIMITS.maxStyles) reject('ASS exceeds 256 styles', line, 'resource-limit')
        styles.set(values.name, { line, values })
      } else if (section === 'events' && key === 'dialogue') {
        if (!eventColumns) reject('ASS events require Format first', line, 'malformed-header')
        if (body.length > 24_000) reject('ASS dialogue exceeds its bounded record size', line, 'resource-limit')
        if (events.length >= CAPTION_LIMITS.maxItemsPerTrack) reject('ASS exceeds its cue count budget', line, 'resource-limit')
        events.push({ line, values: fields(body, eventColumns, line, true) })
      } else if (section === 'events' && key === 'comment') report.add('info', 'event-comment', line, 'ASS event comment omitted')
      else report.add('loss', 'unsupported-record', line, `Unsupported ${section} record ${key} omitted`)
    }
    if (info.get('scripttype')?.toLowerCase() !== 'v4.00+' || !sections.has('v4+ styles') || !sections.has('events') || !styles.size || !events.length) reject('ASS requires v4.00+, styles and dialogue events', null, 'malformed-header')
    const width = positiveResolution(info.get('playresx'), null)
    const height = positiveResolution(info.get('playresy'), null)
    if (info.get('wrapstyle') !== '1') report.add('loss', 'wrapping-policy', null, 'ASS wrapping becomes end-of-line wrapping (WrapStyle 1)')
    if (info.get('scaledborderandshadow')?.toLowerCase() !== 'yes') report.add('loss', 'border-scaling', null, 'ASS outline width is interpreted in the declared script resolution')
    if (info.get('ycbcr matrix')?.toLowerCase() !== 'none') report.add('loss', 'color-matrix', null, 'ASS colors are interpreted as direct RGB; source video-matrix behavior is not preserved')
    const fonts = new Set<string>()
    const compiled = new Map([...styles].map(([name, raw]) => [name, compileStyle(raw, width, height, substitutions, fonts, report)]))
    if (fonts.size) return { kind: 'needs-fonts', fonts: [...fonts].sort(), report: report.finish() }
    const base = compiled.get('Default') ?? compiled.values().next().value!
    const trackStyle = descriptor(base.params, 1)
    let styleBytes = utf8ByteLength(JSON.stringify(trackStyle))
    const items = events.map(({ line, values: v }, index): CaptionAssItem => {
      const style = compiled.get(v.style!)
      if (!style) reject(`Missing ASS style ${v.style}`, line)
      if (decimal(v.layer!, line) !== 0) report.add('loss', 'layer-order', line, 'ASS layer ordering is not preserved')
      if (v.effect) report.add('loss', 'event-effect', line, `ASS effect ${v.effect} is omitted`)
      if (v.name) report.add('info', 'actor-metadata', line, 'ASS actor metadata omitted')
      const params = { ...style.params }
      const margins = [v.marginl!, v.marginr!, v.marginv!].map((value) => decimal(value, line))
      if (margins.some((margin) => !Number.isInteger(margin) || margin < 0)) reject('ASS cue margins must be nonnegative integers', line)
      const left = margins[0] || style.marginLeft; const right = margins[1] || style.marginRight
      if (left !== right) report.add('loss', 'asymmetric-margins', line, 'Cue left/right margins become the larger symmetric margin')
      params.marginXPermille = Math.max(left, right) * 1_000 / width
      params.marginYPermille = (margins[2] || style.marginVertical) * 1_000 / height
      const text = parseAssText(v.text!, params, style.params, height, line, report)
      const partial = Object.fromEntries(Object.entries(params).filter(([key, value]) => value !== base.params[key as keyof CaptionStyleV1]))
      const override = Object.keys(partial).length ? descriptor(partial, line) : undefined
      if (override) styleBytes += utf8ByteLength(JSON.stringify(override))
      if (styleBytes > CAPTION_STYLE_LIMITS.maxProjectIntentBytes) reject('ASS style intent exceeds the project payload budget', line, 'resource-limit')
      let range
      try { range = captionAssRangeToFrames(v.start!, v.end!, rate) }
      catch (error) { if (error instanceof CaptionFileError) reject(error.message, line); throw error }
      return { id: createItemId(index), range, text, ...(override ? { style: override } : {}) }
    }).sort(compareCaptionItems)
    const track: CaptionTrack = { id: 'ass-validation', name: 'ASS captions', language: 'und', role: 'captions', stylePreset: 'minimal', hidden: false, items }
    const validation = captionTracksValidationError([track])
    if (validation) reject(validation, null)
    const proposal: CaptionAssProposal = { stylePreset: 'minimal', style: trackStyle, items, scriptWidth: width, scriptHeight: height }
    return { kind: report.counts.loss ? 'review' : 'ready', proposal, report: report.finish() }
  } catch (error) {
    if (!(error instanceof CaptionFileError)) throw error
    report.add('error', error.code, error.line, error.message)
    return { kind: 'rejected', report: report.finish() }
  }
}

function parseAssText(source: string, params: CaptionStyleV1, base: CaptionStyleV1, height: number,
  line: number, report: Report): string {
  let text = ''
  let blocks = 0
  let tags = 0
  for (let index = 0; index < source.length;) {
    if (source[index] === '{') {
      const close = source.indexOf('}', index + 1)
      if (close < 0 || source.slice(index + 1, close).includes('{')) reject('Malformed ASS override block', line)
      if (++blocks > CAPTION_ASS_LIMITS.maxOverrideBlocks || close - index + 1 > CAPTION_ASS_LIMITS.maxOverrideBlockCharacters) reject('ASS override block budget exceeded', line, 'resource-limit')
      const block = source.slice(index + 1, close)
      // Even an unsupported nested transform must never turn drawing commands
      // into visible text. Reject drawing-mode tags conservatively, including
      // unsupported numeric spellings; only an exact mode-zero reset is safe.
      for (const drawing of block.matchAll(/\\p(?![a-z])([^\\)]*)/giu)) {
        if (drawing[1]!.trim() !== '0') reject('ASS vector drawing cannot become semantic caption text', line, 'unsupported-feature')
      }
      const tokens: string[] = []
      let start = 0
      let depth = 0
      for (let cursor = 0; cursor <= block.length; cursor++) {
        const character = block[cursor]
        if (character === '(') depth++
        if (character === ')' && --depth < 0) reject('Malformed ASS override parentheses', line)
        if ((character === '\\' && depth === 0) || cursor === block.length) {
          const token = block.slice(start, cursor).trim()
          if (token) tokens.push(token)
          start = cursor
        }
      }
      if (depth !== 0) reject('Malformed ASS override parentheses', line)
      for (const token of tokens) {
        if (!token.startsWith('\\')) { report.add('info', 'inline-comment', line, 'ASS override comment omitted'); continue }
        if (++tags > CAPTION_ASS_LIMITS.maxOverrideTags) reject('ASS cue has too many override tags', line, 'resource-limit')
        if (text.length > 0) { report.add('loss', 'span-style', line, 'Styling changes after visible text are omitted'); continue }
        applyPrefixTag(token, params, base, height, line, report)
      }
      index = close + 1
    } else if (source[index] === '}') reject('Unmatched ASS closing brace', line)
    else if (source[index] === '\\') {
      const escape = source[index + 1]
      if (escape === 'N') text += '\n'
      else if (escape === 'n' || escape === 'h') { text += ' '; report.add('loss', 'text-spacing', line, `ASS \\${escape} becomes an ordinary space`) }
      else reject('Unsupported or ambiguous ASS text escape', line, 'unsupported-feature')
      index += 2
    } else { text += source[index]!; index++ }
    if (text.length > CAPTION_LIMITS.maxItemCharacters) reject('ASS cue text exceeds its character budget', line, 'resource-limit')
  }
  const normalized = normalizeCaptionText(text)
  if (normalized !== text) report.add('loss', 'outer-whitespace', line, 'Outer caption whitespace is trimmed')
  descriptor(params, line)
  return normalized
}

function applyPrefixTag(token: string, params: CaptionStyleV1, base: CaptionStyleV1, height: number,
  line: number, report: Report): void {
  const match = /^\\([1-4]?[a-z]+)(.*)$/iu.exec(token)
  if (!match) reject('Malformed ASS override tag', line)
  const tag = match[1]!; const value = match[2]!
  if (tag === 'b' || tag === 'i') {
    const key = tag === 'b' ? 'bold' : 'italic'
    if (value === '') params[key] = base[key]
    else if (value === '0' || value === '1') params[key] = value === '1'
    else report.add('loss', 'unsupported-override', line, `${token} is omitted`)
  } else if (tag === 'fs') {
    if (!value) params.fontSizePermille = base.fontSizePermille
    else if (/^[1-9][0-9]*$/u.test(value)) params.fontSizePermille = decimal(value, line) * 1_000 / height
    else report.add('loss', 'unsupported-override', line, `${token} is omitted`)
  } else if (tag === 'bord') {
    params.outlinePermille = value === '' ? base.outlinePermille : decimal(value, line) * 1_000 / height
    params.outlineEnabled = params.outlinePermille > 0
  } else if (tag === 'an') Object.assign(params, value === '' ? { align: base.align, position: base.position } : alignment(decimal(value, line), line))
  else if (tag === 'c' || tag === '1c' || tag === '3c') {
    const key = tag === '3c' ? 'outlineColor' : 'color'
    if (value === '') params[key] = base[key]
    else {
      const color = /^&H([0-9a-f]{1,6})&$/iu.exec(value)
      if (!color) reject('ASS RGB overrides require &HBBGGRR&', line)
      const rgb = styleColor(`&H${color[1]!.padStart(8, '0')}`, line)
      params[key] = rgb.slice(0, 7) + params[key].slice(7)
    }
  } else report.add('loss', 'unsupported-override', line, `${token} is omitted`)
}
