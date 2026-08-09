/** Browser-free SRT/WebVTT parsing, validation, and serialization. */

import {
  CAPTION_LIMITS,
  captionTrackValidationError,
  compareCaptionItems,
  normalizeCaptionText,
} from './captions'
import type { CaptionItem, CaptionItemId, CaptionTrack, FrameRate } from './schema'
import { rangeEnd } from './time'

export type CaptionFileFormat = 'srt' | 'vtt'

export type CaptionFileErrorCode =
  | 'file-too-large'
  | 'malformed-header'
  | 'malformed-cue'
  | 'unsupported-markup'
  | 'unsupported-feature'
  | 'timing'
  | 'resource-limit'

export class CaptionFileError extends Error {
  readonly code: CaptionFileErrorCode
  readonly line: number | null

  constructor(code: CaptionFileErrorCode, message: string, line: number | null = null) {
    super(line === null ? message : `Line ${line}: ${message}`)
    this.name = 'CaptionFileError'
    this.code = code
    this.line = line
  }
}

export const MAX_CAPTION_FILE_CHARACTERS = 2_000_000

interface ParsedCue {
  sourceId: string | null
  startMilliseconds: number
  endMilliseconds: number
  text: string
  line: number
}

const MARKUP = /<[^>\n]+>/u

function assertFrameRate(rate: FrameRate): void {
  if (
    !Number.isSafeInteger(rate.num)
    || !Number.isSafeInteger(rate.den)
    || rate.num <= 0
    || rate.den <= 0
  ) {
    throw new CaptionFileError('timing', 'Document frame rate must use positive safe integers')
  }
}

function divideFloor(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator
}

function divideCeil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

/** Import start timestamps toward negative infinity so the first covered frame survives. */
export function captionStartMillisecondsToFrame(
  milliseconds: number,
  rate: FrameRate,
): number {
  assertFrameRate(rate)
  return Number(divideFloor(
    BigInt(milliseconds) * BigInt(rate.num),
    1_000n * BigInt(rate.den),
  ))
}

/** Import end timestamps toward positive infinity so the final covered frame survives. */
export function captionEndMillisecondsToFrame(
  milliseconds: number,
  rate: FrameRate,
): number {
  assertFrameRate(rate)
  return Number(divideCeil(
    BigInt(milliseconds) * BigInt(rate.num),
    1_000n * BigInt(rate.den),
  ))
}

/** Export starts to the first millisecond that maps back to this exact frame. */
export function captionStartFrameToMilliseconds(frame: number, rate: FrameRate): number {
  assertFrameRate(rate)
  return Number(divideCeil(
    BigInt(frame) * 1_000n * BigInt(rate.den),
    BigInt(rate.num),
  ))
}

/** Export ends to the last boundary millisecond that maps back to this exact end frame. */
export function captionEndFrameToMilliseconds(frame: number, rate: FrameRate): number {
  assertFrameRate(rate)
  return Number(divideFloor(
    BigInt(frame) * 1_000n * BigInt(rate.den),
    BigInt(rate.num),
  ))
}

function parseTimestamp(
  value: string,
  separator: ',' | '.',
  allowShortHours: boolean,
  line: number,
): number {
  const escaped = separator === '.' ? '\\.' : ','
  const hoursPattern = allowShortHours ? '(?:(\\d{2,}):)?' : '(\\d{2,}):'
  const match = new RegExp(
    `^${hoursPattern}(\\d{2}):(\\d{2})${escaped}(\\d{3})$`,
    'u',
  ).exec(value)
  if (!match) {
    throw new CaptionFileError('timing', `Invalid timestamp: ${value}`, line)
  }
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const milliseconds = Number(match[4])
  if (minutes > 59 || seconds > 59) {
    throw new CaptionFileError('timing', `Timestamp component is out of range: ${value}`, line)
  }
  const total = (((hours * 60) + minutes) * 60 + seconds) * 1_000 + milliseconds
  if (!Number.isSafeInteger(total)) {
    throw new CaptionFileError('timing', `Timestamp is outside the supported range: ${value}`, line)
  }
  return total
}

function validateCueText(text: string, line: number): string {
  const normalized = normalizeCaptionText(text)
  if (normalized.length === 0) {
    throw new CaptionFileError('malformed-cue', 'Caption text must not be empty', line)
  }
  if (normalized.length > CAPTION_LIMITS.maxItemCharacters) {
    throw new CaptionFileError(
      'resource-limit',
      `Caption text exceeds ${CAPTION_LIMITS.maxItemCharacters} characters`,
      line,
    )
  }
  if (MARKUP.test(normalized)) {
    throw new CaptionFileError(
      'unsupported-markup',
      'Caption markup is unsupported; import plain text instead',
      line,
    )
  }
  return normalized
}

function parseTimingLine(
  value: string,
  format: CaptionFileFormat,
  line: number,
): { startMilliseconds: number; endMilliseconds: number } {
  const parts = value.split(/\s+-->\s+/u)
  if (parts.length !== 2) {
    throw new CaptionFileError('malformed-cue', 'Expected a start --> end timing line', line)
  }
  const endParts = parts[1]!.trim().split(/\s+/u)
  if (endParts.length !== 1) {
    throw new CaptionFileError(
      'unsupported-feature',
      'Cue settings and positioned regions are unsupported',
      line,
    )
  }
  const separator = format === 'srt' ? ',' : '.'
  const allowShortHours = format === 'vtt'
  const startMilliseconds = parseTimestamp(parts[0]!.trim(), separator, allowShortHours, line)
  const endMilliseconds = parseTimestamp(endParts[0]!, separator, allowShortHours, line)
  if (endMilliseconds <= startMilliseconds) {
    throw new CaptionFileError('timing', 'Caption end must be after its start', line)
  }
  return { startMilliseconds, endMilliseconds }
}

function normalizeSource(source: string): string[] {
  if (source.length > MAX_CAPTION_FILE_CHARACTERS) {
    throw new CaptionFileError(
      'file-too-large',
      `Caption file exceeds ${MAX_CAPTION_FILE_CHARACTERS} characters`,
    )
  }
  return source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n')
}

function parseSrt(source: string): ParsedCue[] {
  const lines = normalizeSource(source)
  const cues: ParsedCue[] = []
  let index = 0
  while (index < lines.length) {
    while (index < lines.length && lines[index]!.trim() === '') index += 1
    if (index >= lines.length) break
    const numberLine = index + 1
    const sequence = lines[index]!.trim()
    if (!/^[1-9]\d*$/u.test(sequence)) {
      throw new CaptionFileError('malformed-cue', 'Expected a positive numeric cue index', numberLine)
    }
    index += 1
    if (index >= lines.length) {
      throw new CaptionFileError('malformed-cue', 'Cue is missing its timing line', numberLine)
    }
    const timingLine = index + 1
    const timing = parseTimingLine(lines[index]!, 'srt', timingLine)
    index += 1
    const textLine = index + 1
    const textLines: string[] = []
    while (index < lines.length && lines[index]!.trim() !== '') {
      textLines.push(lines[index]!)
      index += 1
    }
    cues.push({
      sourceId: sequence,
      ...timing,
      text: validateCueText(textLines.join('\n'), textLine),
      line: numberLine,
    })
    if (cues.length > CAPTION_LIMITS.maxItemsPerTrack) {
      throw new CaptionFileError(
        'resource-limit',
        `Caption file exceeds ${CAPTION_LIMITS.maxItemsPerTrack} cues`,
        numberLine,
      )
    }
  }
  if (cues.length === 0) {
    throw new CaptionFileError('malformed-header', 'SRT file contains no caption cues')
  }
  return cues
}

function parseVtt(source: string): ParsedCue[] {
  const lines = normalizeSource(source)
  const signature = lines[0] ?? ''
  if (!/^WEBVTT(?:[\t ].*)?$/u.test(signature) || signature.includes('-->')) {
    throw new CaptionFileError('malformed-header', 'WebVTT file must begin with WEBVTT', 1)
  }
  const cues: ParsedCue[] = []
  let index = 1
  while (index < lines.length && lines[index]!.trim() !== '') {
    if (/X-TIMESTAMP-MAP/iu.test(lines[index]!)) {
      throw new CaptionFileError(
        'unsupported-feature',
        'X-TIMESTAMP-MAP is unsupported',
        index + 1,
      )
    }
    index += 1
  }
  while (index < lines.length) {
    while (index < lines.length && lines[index]!.trim() === '') index += 1
    if (index >= lines.length) break
    const blockLine = index + 1
    const first = lines[index]!.trim()
    if (/^(STYLE|REGION)(?:\s|$)/u.test(first)) {
      throw new CaptionFileError(
        'unsupported-feature',
        `${first.split(/\s+/u)[0]} blocks are unsupported`,
        blockLine,
      )
    }
    if (/^NOTE(?:\s|$)/u.test(first)) {
      while (index < lines.length && lines[index]!.trim() !== '') index += 1
      continue
    }

    let sourceId: string | null = null
    let timingValue = first
    let timingLine = blockLine
    if (!first.includes('-->')) {
      sourceId = first
      if (sourceId.length === 0 || sourceId.includes('-->')) {
        throw new CaptionFileError('malformed-cue', 'Invalid WebVTT cue identifier', blockLine)
      }
      index += 1
      if (index >= lines.length) {
        throw new CaptionFileError('malformed-cue', 'Cue is missing its timing line', blockLine)
      }
      timingValue = lines[index]!.trim()
      timingLine = index + 1
    }
    const timing = parseTimingLine(timingValue, 'vtt', timingLine)
    index += 1
    const textLine = index + 1
    const textLines: string[] = []
    while (index < lines.length && lines[index]!.trim() !== '') {
      textLines.push(lines[index]!)
      index += 1
    }
    cues.push({
      sourceId,
      ...timing,
      text: validateCueText(textLines.join('\n'), textLine),
      line: blockLine,
    })
    if (cues.length > CAPTION_LIMITS.maxItemsPerTrack) {
      throw new CaptionFileError(
        'resource-limit',
        `Caption file exceeds ${CAPTION_LIMITS.maxItemsPerTrack} cues`,
        blockLine,
      )
    }
  }
  if (cues.length === 0) {
    throw new CaptionFileError('malformed-header', 'WebVTT file contains no caption cues')
  }
  return cues
}

/**
 * Parse the entire source before returning. Callers commit only after success,
 * so malformed files can never partially mutate a project.
 */
export function parseCaptionFile(
  source: string,
  format: CaptionFileFormat,
  rate: FrameRate,
  createItemId: (cueIndex: number, sourceId: string | null) => CaptionItemId,
): CaptionItem[] {
  assertFrameRate(rate)
  const cues = format === 'srt' ? parseSrt(source) : parseVtt(source)
  const items = cues.map((cue, cueIndex): CaptionItem => {
    const startFrame = captionStartMillisecondsToFrame(cue.startMilliseconds, rate)
    const endFrame = captionEndMillisecondsToFrame(cue.endMilliseconds, rate)
    if (startFrame < 0 || endFrame > CAPTION_LIMITS.maxFrame) {
      throw new CaptionFileError(
        'timing',
        `Caption timing must fit frames 0 through ${CAPTION_LIMITS.maxFrame}`,
        cue.line,
      )
    }
    return {
      id: createItemId(cueIndex, cue.sourceId),
      range: { startFrame, durationFrames: endFrame - startFrame },
      text: cue.text,
    }
  }).sort(compareCaptionItems)

  const validationTrack: CaptionTrack = {
    id: 'caption_import_validation',
    name: 'Imported captions',
    language: 'und',
    role: 'captions',
    stylePreset: 'classic',
    hidden: false,
    items,
  }
  const error = captionTrackValidationError(validationTrack)
  if (error) throw new CaptionFileError('malformed-cue', error)
  return items
}

function formatTimestamp(milliseconds: number, separator: ',' | '.'): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  const fraction = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(fraction).padStart(3, '0')}`
}

/** Serialize a validated track with stable frame -> file -> frame timing. */
export function serializeCaptionTrack(
  track: CaptionTrack,
  format: CaptionFileFormat,
  rate: FrameRate,
): string {
  assertFrameRate(rate)
  const error = captionTrackValidationError(track)
  if (error) throw new CaptionFileError('malformed-cue', error)
  const separator = format === 'srt' ? ',' : '.'
  const blocks = track.items.map((item, index) => {
    const start = captionStartFrameToMilliseconds(item.range.startFrame, rate)
    const end = captionEndFrameToMilliseconds(rangeEnd(item.range), rate)
    if (end <= start) {
      throw new CaptionFileError(
        'timing',
        `Caption ${item.id} is shorter than the target millisecond timebase`,
      )
    }
    const timing = `${formatTimestamp(start, separator)} --> ${formatTimestamp(end, separator)}`
    return format === 'srt'
      ? `${index + 1}\n${timing}\n${item.text}`
      : `${item.id}\n${timing}\n${item.text}`
  })
  const body = blocks.join('\n\n')
  return format === 'srt' ? `${body}\n` : `WEBVTT\n\n${body}\n`
}
