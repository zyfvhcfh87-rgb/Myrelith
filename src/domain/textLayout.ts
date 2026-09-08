/** Pure bounded line wrapping with injected text measurement. */

import type { TextProps } from './schema'

export const MAX_RENDERED_TEXT_LINES = 512

/** Shared painter capacity, including its historical one-line minimum. */
export function textLayoutMetrics(text: Pick<TextProps, 'fontSizePx' | 'boxWidthPx' | 'boxHeightPx' | 'paddingPx'>) {
  const lineHeight = Math.ceil(text.fontSizePx * 1.2)
  const innerWidth = text.boxWidthPx - text.paddingPx * 2
  const innerHeight = text.boxHeightPx - text.paddingPx * 2
  const nominalCapacity = Math.floor(innerHeight / lineHeight)
  const maxLines = Math.max(1, Math.min(MAX_RENDERED_TEXT_LINES, nominalCapacity))
  return { lineHeight, innerWidth, innerHeight, nominalCapacity, maxLines }
}

export type MeasureTextWidth = (text: string) => number

function fittingPrefixLength(
  characters: readonly string[],
  maxWidth: number,
  measure: MeasureTextWidth,
): number {
  let low = 1
  let high = characters.length
  let best = 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (measure(characters.slice(0, middle).join('')) <= maxWidth) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/**
 * Wrap explicit paragraphs greedily and break a single overlong word by
 * Unicode code point. Work stops as soon as the visible line budget is full.
 */
export function wrapTextLines(
  content: string,
  maxWidth: number,
  maxLines: number,
  measure: MeasureTextWidth,
): string[] {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0 || maxLines < 1) return []
  const lines: string[] = []
  const push = (line: string): boolean => {
    lines.push(line)
    return lines.length >= maxLines
  }

  for (const paragraph of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (lines.length >= maxLines) break
    const words = paragraph.trim().length === 0
      ? []
      : paragraph.trim().split(/\s+/u)
    if (words.length === 0) {
      if (push('')) break
      continue
    }

    let line = ''
    for (const rawWord of words) {
      let word = rawWord
      const candidate = line.length === 0 ? word : `${line} ${word}`
      if (measure(candidate) <= maxWidth) {
        line = candidate
        continue
      }
      if (line.length > 0) {
        if (push(line)) return lines
        line = ''
      }
      while (word.length > 0 && measure(word) > maxWidth) {
        const characters = Array.from(word)
        const count = fittingPrefixLength(characters, maxWidth, measure)
        if (push(characters.slice(0, count).join(''))) return lines
        word = characters.slice(count).join('')
      }
      line = word
    }
    if (line.length > 0 && push(line)) break
  }
  return lines
}
