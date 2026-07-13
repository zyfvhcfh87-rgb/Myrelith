/**
 * Authoritative project-creation settings and the pure TimelineDoc factory.
 *
 * This module deliberately owns no id generator: domain/ cannot depend on
 * `crypto` (or any other browser global), so the composition root injects a
 * freshly generated document id when it creates a real project.
 */

import type { FrameRate, TimelineDoc, Track } from './schema'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'

export interface ProjectResolution {
  readonly width: number
  readonly height: number
}

export interface ProjectSettings extends ProjectResolution {
  readonly frameRate: Readonly<FrameRate>
  readonly audioSampleRate: number
}

function freezeResolution(
  width: number,
  height: number,
): Readonly<ProjectResolution> {
  return Object.freeze({ width, height })
}

function freezeFrameRate(num: number, den: number): Readonly<FrameRate> {
  return Object.freeze({ num, den })
}

/** Resolution choices supported by project creation and export. */
export const PROJECT_RESOLUTION_PRESETS = Object.freeze([
  freezeResolution(1280, 720),
  freezeResolution(1920, 1080),
  freezeResolution(2560, 1440),
  freezeResolution(3840, 2160),
])

/**
 * Canonical project rates. Fractional broadcast rates stay exact rationals;
 * equivalent-but-non-canonical pairs (for example 48_000/2_002) are rejected.
 */
export const PROJECT_FRAME_RATE_PRESETS = Object.freeze([
  freezeFrameRate(24_000, 1_001),
  freezeFrameRate(24, 1),
  freezeFrameRate(25, 1),
  freezeFrameRate(30_000, 1_001),
  freezeFrameRate(30, 1),
  freezeFrameRate(50, 1),
  freezeFrameRate(60_000, 1_001),
  freezeFrameRate(60, 1),
])

/** Audio mix/render sample rates supported by project creation and export. */
export const PROJECT_AUDIO_SAMPLE_RATE_PRESETS = Object.freeze([
  44_100,
  48_000,
  96_000,
])

/** The current WebCut default: 1080p, 30 fps, 48 kHz. */
export const DEFAULT_PROJECT_SETTINGS: Readonly<ProjectSettings> = Object.freeze({
  width: 1920,
  height: 1080,
  frameRate: freezeFrameRate(30, 1),
  audioSampleRate: 48_000,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function matchesResolution(width: number, height: number): boolean {
  return PROJECT_RESOLUTION_PRESETS.some(
    (preset) => preset.width === width && preset.height === height,
  )
}

/** True only for one of the exact canonical project-rate presets. */
export function isProjectFrameRatePreset(rate: FrameRate): boolean {
  return PROJECT_FRAME_RATE_PRESETS.some(
    (preset) => preset.num === rate.num && preset.den === rate.den,
  )
}

/**
 * Validate untrusted project-settings data and return a detached, frozen copy.
 * Only the explicit presets above are accepted.
 */
export function validateProjectSettings(value: unknown): Readonly<ProjectSettings> {
  if (!isRecord(value) || !hasExactlyKeys(
    value,
    ['width', 'height', 'frameRate', 'audioSampleRate'],
  )) {
    throw new TypeError(
      'Project settings must contain only width, height, frameRate, and audioSampleRate',
    )
  }

  const { width, height, frameRate, audioSampleRate } = value
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new TypeError('Project width and height must be safe integers')
  }
  if (!matchesResolution(width as number, height as number)) {
    throw new RangeError(`Unsupported project resolution: ${String(width)}x${String(height)}`)
  }

  if (!isRecord(frameRate) || !hasExactlyKeys(frameRate, ['num', 'den'])) {
    throw new TypeError('Project frameRate must contain only num and den')
  }
  const { num, den } = frameRate
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new TypeError('Project frame-rate numerator and denominator must be safe integers')
  }
  if (!isProjectFrameRatePreset({ num: num as number, den: den as number })) {
    throw new RangeError(`Unsupported project frame rate: ${String(num)}/${String(den)}`)
  }

  if (!Number.isSafeInteger(audioSampleRate)) {
    throw new TypeError('Project audio sample rate must be a safe integer')
  }
  if (!PROJECT_AUDIO_SAMPLE_RATE_PRESETS.some((preset) => preset === audioSampleRate)) {
    throw new RangeError(`Unsupported project audio sample rate: ${String(audioSampleRate)}`)
  }

  return Object.freeze({
    width: width as number,
    height: height as number,
    frameRate: freezeFrameRate(num as number, den as number),
    audioSampleRate: audioSampleRate as number,
  })
}

function validateNonEmptyText(
  value: unknown,
  label: string,
  maxCharacters: number,
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
  if (value.length > maxCharacters) {
    throw new RangeError(`${label} must not exceed ${maxCharacters} characters`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new RangeError(`${label} must not be empty`)
  }
  return trimmed
}

function emptyTrack(id: 'V1' | 'A1', kind: Track['kind']): Track {
  return {
    id,
    kind,
    name: id,
    clips: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

/**
 * Create a new empty document. `documentId` is required injection so callers
 * can use their runtime's collision-safe id source without contaminating the
 * pure domain layer with browser APIs.
 */
export function createTimelineDoc(
  name: string,
  settings: ProjectSettings,
  documentId: string,
): TimelineDoc {
  const projectName = validateNonEmptyText(
    name,
    'Project name',
    MAX_PROJECT_NAME_CHARACTERS,
  )
  const id = validateNonEmptyText(
    documentId,
    'Document id',
    MAX_DOCUMENT_ID_CHARACTERS,
  )
  const validated = validateProjectSettings(settings)
  const videoTrack = emptyTrack('V1', 'video')
  const audioTrack = emptyTrack('A1', 'audio')
  const doc: TimelineDoc = {
    schemaVersion: 1,
    id,
    name: projectName,
    frameRate: { ...validated.frameRate },
    width: validated.width,
    height: validated.height,
    audioSampleRate: validated.audioSampleRate,
    tracks: [videoTrack, audioTrack],
  }

  Object.freeze(doc.frameRate)
  Object.freeze(videoTrack.clips)
  Object.freeze(videoTrack.transitions)
  Object.freeze(videoTrack)
  Object.freeze(audioTrack.clips)
  Object.freeze(audioTrack.transitions)
  Object.freeze(audioTrack)
  Object.freeze(doc.tracks)
  return Object.freeze(doc)
}
