/** Bounded descriptions of supported intent; opaque descriptors stay private. */
import { inspectCaptionStyle, type CaptionStyleDescriptor, type CaptionStyleV1 } from '../domain/captionStyle'

export const CAPTION_STYLE_LABELS: Readonly<Record<keyof CaptionStyleV1, string>> = Object.freeze({
  fontFamily: 'Font', fontSizePermille: 'Font size', color: 'Text color', outlineColor: 'Outline color',
  backgroundColor: 'Background color', bold: 'Bold', italic: 'Italic', backgroundEnabled: 'Background',
  shadowEnabled: 'Shadow', outlineEnabled: 'Outline', outlinePermille: 'Outline width', align: 'Text alignment',
  position: 'Caption box position', marginXPermille: 'Horizontal margin', marginYPermille: 'Vertical margin',
})
export function captionStyleValueLabel(key: keyof CaptionStyleV1, value: CaptionStyleV1[keyof CaptionStyleV1]): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'number') {
    const axis = key === 'marginXPermille' ? 'width' : 'height'
    return `${value / 10}% of canvas ${axis}`
  }
  return value
}
export function captionStyleSummary(style: CaptionStyleDescriptor | undefined, inheritance: string): string {
  if (style === undefined) return `No override; all fields inherit ${inheritance}.`
  const inspected = inspectCaptionStyle(style)
  if (inspected.kind !== 'supported') return 'Unavailable style override; its stored settings cannot be displayed or edited as individual fields.'
  const entries = (Object.keys(CAPTION_STYLE_LABELS) as (keyof CaptionStyleV1)[]).flatMap(key => {
    const value = inspected.params[key]
    return value === undefined ? [] : [`${CAPTION_STYLE_LABELS[key]}: ${captionStyleValueLabel(key, value)}`]
  })
  return entries.length ? `${entries.join('; ')}.${entries.length === Object.keys(CAPTION_STYLE_LABELS).length ? '' : ` Other fields inherit ${inheritance}.`}`
    : `Explicit empty override; all fields inherit ${inheritance}.`
}

export interface CaptionStylePreviewRow {
  readonly target: string
  readonly before: string
  readonly after: string
  readonly inheritance: string
}
