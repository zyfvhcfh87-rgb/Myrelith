/** Pure contracts and validation for procedural text-overlay clips. */

import type { ClipId, TextFontFamily, TextProps } from './schema'

export const TEXT_FONT_FAMILIES = Object.freeze([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
] as const satisfies readonly TextFontFamily[])

export const TEXT_OVERLAY_LIMITS = Object.freeze({
  maxCharacters: 20_000,
  minFontSizePx: 8,
  maxFontSizePx: 1_024,
  minBoxSizePx: 16,
  maxBoxSizePx: 65_535,
  maxPaddingPx: 1_024,
  maxOutlineWidthPx: 64,
  maxShadowBlurPx: 128,
  maxShadowOffsetPx: 512,
})

const TEXT_ASSET_PREFIX = '__webcut_text__:'
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function proceduralTextAssetId(clipId: ClipId): string {
  return `${TEXT_ASSET_PREFIX}${clipId}`
}

export function isProceduralTextAssetId(assetId: string): boolean {
  return assetId.startsWith(TEXT_ASSET_PREFIX) && assetId.length > TEXT_ASSET_PREFIX.length
}

export function isSupportedTextFontFamily(value: unknown): value is TextFontFamily {
  return typeof value === 'string'
    && (TEXT_FONT_FAMILIES as readonly string[]).includes(value)
}

export function isSupportedTextColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

function finiteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
}

/** Return one user-facing reason instead of silently repairing an edit. */
export function textPropsValidationError(value: TextProps): string | null {
  if (typeof value.content !== 'string') return 'Text content must be a string.'
  if (value.content.length > TEXT_OVERLAY_LIMITS.maxCharacters) {
    return `Text content cannot exceed ${TEXT_OVERLAY_LIMITS.maxCharacters.toLocaleString()} characters.`
  }
  if (!isSupportedTextFontFamily(value.fontFamily)) {
    return `Unsupported font family "${String(value.fontFamily)}".`
  }
  if (!finiteInRange(
    value.fontSizePx,
    TEXT_OVERLAY_LIMITS.minFontSizePx,
    TEXT_OVERLAY_LIMITS.maxFontSizePx,
  )) {
    return `Font size must be from ${TEXT_OVERLAY_LIMITS.minFontSizePx} to ${TEXT_OVERLAY_LIMITS.maxFontSizePx} pixels.`
  }
  if (!isSupportedTextColor(value.color)) return 'Text color must be a hexadecimal CSS color.'
  if (value.align !== 'left' && value.align !== 'center' && value.align !== 'right') {
    return 'Text alignment must be left, center, or right.'
  }
  if (typeof value.bold !== 'boolean') return 'Bold must be enabled or disabled.'
  if (typeof value.italic !== 'boolean') return 'Italic must be enabled or disabled.'
  if (!finiteInRange(
    value.boxWidthPx,
    TEXT_OVERLAY_LIMITS.minBoxSizePx,
    TEXT_OVERLAY_LIMITS.maxBoxSizePx,
  )) {
    return `Text-box width must be from ${TEXT_OVERLAY_LIMITS.minBoxSizePx} to ${TEXT_OVERLAY_LIMITS.maxBoxSizePx} pixels.`
  }
  if (!finiteInRange(
    value.boxHeightPx,
    TEXT_OVERLAY_LIMITS.minBoxSizePx,
    TEXT_OVERLAY_LIMITS.maxBoxSizePx,
  )) {
    return `Text-box height must be from ${TEXT_OVERLAY_LIMITS.minBoxSizePx} to ${TEXT_OVERLAY_LIMITS.maxBoxSizePx} pixels.`
  }
  if (!finiteInRange(value.paddingPx, 0, TEXT_OVERLAY_LIMITS.maxPaddingPx)) {
    return `Text-box padding must be from 0 to ${TEXT_OVERLAY_LIMITS.maxPaddingPx} pixels.`
  }
  if (value.paddingPx * 2 >= value.boxWidthPx || value.paddingPx * 2 >= value.boxHeightPx) {
    return 'Text-box padding must leave a positive inner width and height.'
  }
  if (typeof value.backgroundEnabled !== 'boolean') {
    return 'Text background must be enabled or disabled.'
  }
  if (!isSupportedTextColor(value.backgroundColor)) {
    return 'Text background color must be a hexadecimal CSS color.'
  }
  if (typeof value.outlineEnabled !== 'boolean') {
    return 'Text outline must be enabled or disabled.'
  }
  if (!isSupportedTextColor(value.outlineColor)) {
    return 'Text outline color must be a hexadecimal CSS color.'
  }
  if (!finiteInRange(value.outlineWidthPx, 0, TEXT_OVERLAY_LIMITS.maxOutlineWidthPx)) {
    return `Text outline width must be from 0 to ${TEXT_OVERLAY_LIMITS.maxOutlineWidthPx} pixels.`
  }
  if (typeof value.shadowEnabled !== 'boolean') {
    return 'Text shadow must be enabled or disabled.'
  }
  if (!isSupportedTextColor(value.shadowColor)) {
    return 'Text shadow color must be a hexadecimal CSS color.'
  }
  if (!finiteInRange(value.shadowBlurPx, 0, TEXT_OVERLAY_LIMITS.maxShadowBlurPx)) {
    return `Text shadow blur must be from 0 to ${TEXT_OVERLAY_LIMITS.maxShadowBlurPx} pixels.`
  }
  if (!finiteInRange(
    value.shadowOffsetXPx,
    -TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
    TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
  )) {
    return `Horizontal shadow offset must be within ±${TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} pixels.`
  }
  if (!finiteInRange(
    value.shadowOffsetYPx,
    -TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
    TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
  )) {
    return `Vertical shadow offset must be within ±${TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} pixels.`
  }
  return null
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Stable, canvas-relative defaults for a newly authored overlay. */
export function defaultTextProps(
  canvasWidth: number,
  canvasHeight: number,
  content = 'Your text',
): TextProps {
  const fontSizePx = bounded(
    Math.round(canvasHeight * 0.067),
    24,
    256,
  )
  const boxWidthPx = bounded(
    Math.round(canvasWidth * 0.65),
    320,
    TEXT_OVERLAY_LIMITS.maxBoxSizePx,
  )
  const boxHeightPx = bounded(
    Math.round(canvasHeight * 0.22),
    120,
    TEXT_OVERLAY_LIMITS.maxBoxSizePx,
  )
  const paddingPx = Math.min(
    Math.round(fontSizePx * 0.25),
    Math.floor((Math.min(boxWidthPx, boxHeightPx) - 1) / 2),
  )
  return {
    content,
    fontFamily: 'sans-serif',
    fontSizePx,
    color: '#ffffff',
    align: 'center',
    bold: true,
    italic: false,
    boxWidthPx,
    boxHeightPx,
    paddingPx,
    backgroundEnabled: false,
    backgroundColor: '#000000',
    outlineEnabled: true,
    outlineColor: '#000000',
    outlineWidthPx: Math.max(1, Math.round(fontSizePx / 32)),
    shadowEnabled: true,
    shadowColor: '#000000',
    shadowBlurPx: Math.max(2, Math.round(fontSizePx / 18)),
    shadowOffsetXPx: Math.max(1, Math.round(fontSizePx / 36)),
    shadowOffsetYPx: Math.max(1, Math.round(fontSizePx / 36)),
  }
}

/** Short timeline/Inspector label derived from content without storing HTML. */
export function textOverlayName(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine.length === 0) return 'Text overlay'
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`
}
