/** Bounded caption diagnostics using the shared text painter capacity. */
import type { TextProps } from './schema'
import { textPropsValidationError } from './textOverlay'
import { MAX_RENDERED_TEXT_LINES, textLayoutMetrics, wrapTextLines, type MeasureTextWidth } from './textLayout'

export interface CaptionLayoutDiagnostic {
  readonly visibleLineCapacity: number
  readonly observedLines: number
  readonly verticalOverflow: boolean
  readonly horizontalOverflow: boolean
  /** Nominal line-box fit, not actual glyph, outline, or shadow extents. */
  readonly basis: 'shared-wrapper-line-boxes'
}

/** Caller supplies a measure function configured with the exact painter font.
 * Ask for at most one line beyond the painter budget, never an unbounded layout.
 * A single glyph wider than the box can overflow despite the wrapper splitting.
 */
export function captionLayoutDiagnostic(text: TextProps, measure: MeasureTextWidth): CaptionLayoutDiagnostic {
  const invalid = textPropsValidationError(text)
  if (invalid) throw new RangeError(invalid)
  const { innerWidth, nominalCapacity, maxLines: painterCapacity } = textLayoutMetrics(text)
  const checkedMeasure: MeasureTextWidth = (value) => {
    const width = measure(value)
    if (!Number.isFinite(width) || width < 0) throw new RangeError('Caption measurement must be finite and non-negative.')
    return width
  }
  const observed = wrapTextLines(text.content, innerWidth, painterCapacity + 1, checkedMeasure)
  return { visibleLineCapacity: painterCapacity, observedLines: observed.length,
    verticalOverflow: observed.length > Math.min(MAX_RENDERED_TEXT_LINES, nominalCapacity),
    horizontalOverflow: observed.slice(0, painterCapacity).some((line) => checkedMeasure(line) > innerWidth),
    basis: 'shared-wrapper-line-boxes' }
}

type Rgba = readonly [number, number, number, number]
function rgba(color: string): Rgba {
  let hex = color.slice(1)
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((character) => character + character).join('')
  if (hex.length === 6) hex += 'ff'
  const channel = (offset: number) => parseInt(hex.slice(offset, offset + 2), 16) / 255
  return [channel(0), channel(2), channel(4), channel(6)]
}
function luminance(color: Rgba): number {
  const linear = color.slice(0, 3).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

export type CaptionContrastDiagnostic =
  | { readonly kind: 'unmeasured'; readonly reason: 'video-background' | 'transparent-foreground' }
  | { readonly kind: 'opaque-color-pair'; readonly ratio: number; readonly belowAdvisory: boolean; readonly advisory: 4.5 }

/** WCAG relative-luminance color-pair math, used only as a caption advisory.
 * https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
 * No large-text exemption or WCAG-conformance claim: display size is unknown.
 * Outline/shadow and changing video pixels are not measured by this function.
 */
export function captionContrastDiagnostic(text: TextProps): CaptionContrastDiagnostic {
  const invalid = textPropsValidationError(text)
  if (invalid) throw new RangeError(invalid)
  const foreground = rgba(text.color), background = rgba(text.backgroundColor)
  if (!text.backgroundEnabled || background[3] !== 1) return { kind: 'unmeasured', reason: 'video-background' }
  if (foreground[3] !== 1) return { kind: 'unmeasured', reason: 'transparent-foreground' }
  const left = luminance(foreground), right = luminance(background)
  const ratio = (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
  return { kind: 'opaque-color-pair', ratio, belowAdvisory: ratio < 4.5, advisory: 4.5 }
}
