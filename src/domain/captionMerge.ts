/** Shared single/batch merge admission: never silently discard styled origin. */
import { captionIntentEqual } from './captionIntent'
import { combineCaptionStyleOverrides } from './captionStyle'
import { mergeCaptionOrigins } from './captionOrigin'
import type { CaptionItem, CaptionTrack } from './schema'

export function mergedCaptionIntent(track: CaptionTrack, left: CaptionItem, right: CaptionItem): Pick<CaptionItem, 'style' | 'origin'> {
  const one = combineCaptionStyleOverrides(track.style, left.style)
  const two = combineCaptionStyleOverrides(track.style, right.style)
  if (one.unavailable.length || two.unavailable.length) {
    if (!captionIntentEqual(left.style, right.style)) throw new RangeError('Merged captions must have equal style')
  } else {
    const keys = new Set([...Object.keys(one.params), ...Object.keys(two.params)])
    if ([...keys].some((key) => one.params[key as keyof typeof one.params] !== two.params[key as keyof typeof two.params])) {
      throw new RangeError('Merged captions must have equal style')
    }
  }
  const origin = mergeCaptionOrigins(left.origin, right.origin)
  return { ...(left.style === undefined ? {} : { style: left.style }), ...(origin === undefined ? {} : { origin }) }
}
