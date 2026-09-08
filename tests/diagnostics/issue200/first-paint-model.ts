/** Evidence-only predicates: no scheduling, app mutation or browser owners. */
import { expandedTitleProject } from '../../../src/test/titleOwnerFixtures'
import { readTitleDefinition, type TitleFontIntent } from '../../../src/domain/titleElements'
import type { SequenceProject } from '../../../src/domain/projectSequences'
import { createProjectFileSnapshot, serializeProjectFile } from '../../../src/domain/projectFile'

export const CHECKPOINTS = ['initial-generic', 'unavailable', 'fallback-before-reopen', 'reopened-at-notice', 'reopened-presented', 'reopened-stable'] as const
export type Checkpoint = typeof CHECKPOINTS[number]
export const MAX_EVENTS = 256
export const MAX_PIXELS = 1920 * 1080

export function wireOf(project: SequenceProject): string {
  return serializeProjectFile(createProjectFileSnapshot(project, [], []))
}

export function withFont(project: SequenceProject, font: TitleFontIntent, empty = false): SequenceProject {
  const next = structuredClone(project), clip = next.sequences[0].tracks[0].clips[0]
  const parsed = readTitleDefinition(clip.title)
  if (parsed.status !== 'supported' || parsed.title.elements.length !== 1 || parsed.title.elements[0].kind !== 'text') {
    throw new Error('The diagnostic requires the unchanged one-text-element fixture')
  }
  clip.title = { version: 1, elements: parsed.title.elements.map((element) => {
    if (element.kind !== 'text' || element.version !== 1) throw new Error('Unsupported diagnostic element')
    return { ...element, font, ...(empty ? { text: { ...(element.text as object), content: '' } } : {}) }
  }) }
  return next
}

export function firstPaintFixtures() {
  const initial = expandedTitleProject()
  const unavailable = withFont(initial, { family: 'Missing G3 Face', fallbackFamily: null })
  const fallback = withFont(initial, { family: 'Missing G3 Face', fallbackFamily: 'serif' })
  const serif = withFont(initial, { family: 'serif', fallbackFamily: null })
  return { initial, unavailable, fallback, serif, empty: withFont(serif, { family: 'serif', fallbackFamily: null }, true) }
}

export interface Owner {
  generation: number
  sequenceId: string
  clipId: string | null
  frame: number
  canvasId: number | null
  connected: boolean
  screen: string
  phase: string
}
export interface Target { label: string; startedAt: number; owner: Owner }
export interface Presentation {
  kind: string
  owner: Owner
  diagnostic?: { frame: number; requestedAt: number; result: { status: string; drawnClipIds: string[]; missingClipIds: string[] } }
}

export function sameOwner(left: Owner, right: Owner): boolean {
  return left.generation === right.generation && left.sequenceId === right.sequenceId
    && left.clipId === right.clipId && left.frame === right.frame && left.canvasId === right.canvasId
    && left.canvasId !== null && left.connected && right.connected
    && left.screen === 'editor' && right.screen === 'editor' && left.phase === 'idle' && right.phase === 'idle'
}

export function matchesPresentation(event: Presentation, target: Target): boolean {
  const d = event.diagnostic
  return event.kind === 'presentation' && sameOwner(event.owner, target.owner) && d !== undefined
    && d.requestedAt >= target.startedAt && d.frame === target.owner.frame && d.result.status === 'drawn'
    && d.result.missingClipIds.length === 0 && target.owner.clipId !== null
    && d.result.drawnClipIds.includes(target.owner.clipId)
}

export function pixelDifference(actual: Uint8ClampedArray, expected: Uint8ClampedArray, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width * height > MAX_PIXELS || actual.length !== width * height * 4 || expected.length !== actual.length) {
    throw new Error('Compared canvas dimensions/byte lengths are invalid')
  }
  let differingBytes = 0, maximumDelta = 0, changedPixels = 0
  const mask = new Uint8Array(width * height)
  const firstCoordinates: Array<{ x: number; y: number }> = []
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i])
    if (!delta) continue
    differingBytes++; maximumDelta = Math.max(maximumDelta, delta)
    const pixel = Math.floor(i / 4)
    if (mask[pixel]) continue
    mask[pixel] = 1; changedPixels++
    if (firstCoordinates.length < 32) firstCoordinates.push({ x: pixel % width, y: Math.floor(pixel / width) })
  }
  return { differingBytes, maximumDelta, changedPixels, firstCoordinates, mask }
}

export function requireGlyphControl(reference: Uint8ClampedArray, empty: Uint8ClampedArray, width: number, height: number) {
  const difference = pixelDifference(reference, empty, width, height)
  if (difference.changedPixels === 0) throw new Error('The text reference is blank: no independent glyph pixels')
  return difference
}
