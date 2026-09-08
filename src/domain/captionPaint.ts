/** Caption-only style resolution into the existing shared painter's inputs. */
import { captionPaintFor, type CaptionPaint } from './captions'
import { combineCaptionStyleOverrides, type CaptionStyleV1 } from './captionStyle'
import type { CaptionItem, CaptionTrack, TimelineDoc } from './schema'
import { textPropsValidationError } from './textOverlay'

export interface ResolvedCaptionPaint {
  readonly paint: CaptionPaint
  readonly unavailable: readonly { readonly level: 'track' | 'cue' | 'rendering'; readonly reason: string }[]
  /** Positions anchor the existing caption boxes, not a measured glyph block. */
  readonly geometry: 'caption-boxes'
  readonly changedGeometry: boolean
}

function color(value: string | undefined, inherited: string): string {
  if (value === undefined) return inherited
  const canonical = inherited.length === 7 ? `${inherited}ff` : inherited
  return value === canonical ? inherited : value
}

/**
 * Keep the legacy paint authority intact. Supported track overrides precede cue
 * overrides; unavailable descriptors are ignored whole with explicit reasons.
 *
 * The existing full stack of caption boxes is anchored at top/middle/bottom.
 * Horizontal margins size the centered box. Vertical margins inset the stack;
 * larger margins can reduce box height but never silently reduce an authored
 * font. Text stays top-aligned within each box, as in the shared text painter.
 * Each cue may choose its own anchor, so mixed anchors are not collision layout.
 */
export function resolveCaptionPaint(doc: TimelineDoc, track: CaptionTrack, item: CaptionItem,
  stackIndex: number, stackSize: number): ResolvedCaptionPaint {
  if (!Number.isInteger(stackSize) || stackSize < 1 || stackSize > 8
    || !Number.isInteger(stackIndex) || stackIndex < 0 || stackIndex >= stackSize) {
    throw new RangeError('Caption painting requires a valid stack of one to eight cues.')
  }
  const inherited = captionPaintFor(doc, track, item, stackIndex, stackSize)
  const overrides = combineCaptionStyleOverrides(track.style, item.style)
  const params: Readonly<Partial<CaptionStyleV1>> = overrides.params
  const original = inherited.text
  const fontSizePx = params.fontSizePermille === undefined ? original.fontSizePx
    : Math.round(doc.height * params.fontSizePermille / 1_000)
  const boxWidthPx = params.marginXPermille === undefined ? original.boxWidthPx
    : Math.round(doc.width * (1 - 2 * params.marginXPermille / 1_000))
  const margin = params.marginYPermille === undefined ? Math.round(doc.height * 0.06)
    : Math.round(doc.height * params.marginYPermille / 1_000)
  const position = params.position ?? 'bottom'
  const gap = Math.max(4, Math.round(doc.height * 0.008))
  const availableHeight = Math.min(doc.height * 0.78, doc.height - 2 * margin)
  const boxHeightPx = Math.max(44, Math.floor((availableHeight - gap * (stackSize - 1)) / stackSize))
  const stackHeight = boxHeightPx * stackSize + gap * (stackSize - 1)
  const top = position === 'bottom'
    ? doc.height - margin - boxHeightPx * (stackIndex + 1) - gap * stackIndex
    : (position === 'top' ? margin : (doc.height - stackHeight) / 2)
      + (stackSize - 1 - stackIndex) * (boxHeightPx + gap)
  const y = top - (doc.height - boxHeightPx) / 2
  const verticalChanged = boxHeightPx !== original.boxHeightPx || y !== inherited.transform.y
  const changedGeometry = verticalChanged || boxWidthPx !== original.boxWidthPx
  const candidate: CaptionPaint = {
    ...inherited,
    transform: y === inherited.transform.y ? inherited.transform : { ...inherited.transform, y },
    text: { ...original,
      fontFamily: params.fontFamily ?? original.fontFamily,
      fontSizePx,
      paddingPx: fontSizePx === original.fontSizePx ? original.paddingPx : Math.max(8, Math.round(fontSizePx * 0.28)),
      color: color(params.color, original.color),
      outlineColor: color(params.outlineColor, original.outlineColor),
      backgroundColor: color(params.backgroundColor, original.backgroundColor),
      bold: params.bold ?? original.bold,
      italic: params.italic ?? original.italic,
      align: params.align ?? original.align,
      backgroundEnabled: params.backgroundEnabled ?? original.backgroundEnabled,
      outlineEnabled: params.outlineEnabled ?? original.outlineEnabled,
      outlineWidthPx: params.outlinePermille === undefined ? original.outlineWidthPx
        : Math.round(doc.height * params.outlinePermille / 1_000),
      shadowEnabled: params.shadowEnabled ?? original.shadowEnabled,
      boxWidthPx,
      boxHeightPx,
    },
  }
  const error = verticalChanged && stackHeight > doc.height - margin * 2
    ? 'These caption boxes cannot fit the selected vertical margins on this canvas.'
    : textPropsValidationError(candidate.text)
  if (error) return { paint: inherited, unavailable: [...overrides.unavailable, { level: 'rendering', reason: error }],
    geometry: 'caption-boxes', changedGeometry: false }
  // Stable legacy inputs include original equivalent color spellings and
  // rounded metrics. Descriptor presence alone cannot switch geometry.
  return { paint: candidate, unavailable: overrides.unavailable, geometry: 'caption-boxes', changedGeometry }
}
