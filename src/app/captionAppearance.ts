/** On-demand saved-cue advisory. The temporary measurement surface is app-owned. */
import { activeCaptionItemsAtFrame, findCaptionTrack } from '../domain/captions'
import { captionContrastDiagnostic, captionLayoutDiagnostic } from '../domain/captionDiagnostics'
import { resolveCaptionPaint } from '../domain/captionPaint'
import { textCanvasFont } from '../domain/textLayout'
import { useDocumentStore } from '../state/documentStore'

export function inspectSavedCaptionAppearance(trackId: string, cueId: string): readonly string[] {
  const doc = useDocumentStore.getState().doc, track = findCaptionTrack(doc, trackId)
  const item = track?.items.find(cue => cue.id === cueId)
  if (!track || !item) return ['The saved cue is no longer available.']
  const active = activeCaptionItemsAtFrame(doc, item.range.startFrame)
  const index = active.findIndex(entry => entry.item.id === cueId)
  const resolved = resolveCaptionPaint(doc, track, item, Math.max(0, index), index < 0 ? 1 : active.length)
  if (resolved.unavailable.length) return ['This caption has unavailable style or geometry. Preview uses its supported fallback; burned-in export is blocked. Preserve the original data in the project file.']
  const messages = [track.hidden ? 'Hidden track: checked as a standalone cue.' : `Saved cue at frame ${item.range.startFrame}, with ${active.length} visible caption track(s). Stacking can change later in the cue.`]
  const text = resolved.paint.text, contrast = captionContrastDiagnostic(text)
  messages.push(contrast.kind === 'opaque-color-pair'
    ? `Text/background contrast ${contrast.ratio.toFixed(2)}:1${contrast.belowAdvisory ? ' is below the 4.5:1 advisory' : ' meets the 4.5:1 advisory'}. This compares opaque colors only.`
    : contrast.reason === 'video-background' ? 'Contrast against changing video or a translucent background is unmeasured.' : 'Contrast with a translucent text color is unmeasured.')
  const canvas = document.createElement('canvas')
  canvas.width = 1; canvas.height = 1
  try {
    const context = canvas.getContext('2d')
    if (!context) { messages.push('Layout measurement is unavailable in this browser.'); return messages }
    context.font = textCanvasFont(text)
    if (document.fonts && !document.fonts.check(context.font)) { messages.push('Layout measurement is waiting for the selected local font.'); return messages }
    const layout = captionLayoutDiagnostic(text, value => context.measureText(value).width)
    messages.push(`${layout.observedLines} observed line(s); ${layout.visibleLineCapacity} visible line(s) fit the caption box.`,
      layout.verticalOverflow || layout.horizontalOverflow
        ? `Possible clipping:${layout.verticalOverflow ? ' too many lines' : ''}${layout.horizontalOverflow ? ' text wider than the box' : ''}. Reduce size/text or adjust margins.`
        : 'The measured lines fit the caption box at this frame.',
      'Layout uses the shared painter’s font and line wrapping. Glyph, outline and shadow extents are not measured; inspect the preview.')
    return messages
  } catch { messages.push('Layout measurement is unavailable. Inspect the preview.'); return messages }
  finally { canvas.width = 0; canvas.height = 0 }
}
