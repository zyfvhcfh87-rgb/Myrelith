/**
 * Browser-free presentation sizing for preview and export hosts.
 *
 * Authored geometry always stays in project pixels. A PresentationProfile
 * only tells a host how large its disposable output surfaces should be and
 * why that presentation was requested.
 */

import type { TimelineDoc } from './schema'

export const PRESENTATION_QUALITY_MODES = [
  'auto',
  'full',
  'half',
  'quarter',
] as const

export type PresentationQualityMode =
  (typeof PRESENTATION_QUALITY_MODES)[number]

export type PresentationResolvedQuality = Exclude<
  PresentationQualityMode,
  'auto'
>

export type PresentationScale = 1 | 0.5 | 0.25

export type PresentationReason =
  | 'playing'
  | 'paused'
  | 'scrubbing'
  | 'export'

export type PresentationDevicePixelPolicy =
  | 'match-display'
  | 'fixed-project-scale'
  | 'project-resolution'

export interface PresentationViewport {
  /** Displayed Program Monitor width, excluding surrounding panel chrome. */
  readonly widthCssPx: number
  /** Displayed Program Monitor height, excluding surrounding panel chrome. */
  readonly heightCssPx: number
  /** Browser device-pixel ratio captured with this viewport measurement. */
  readonly devicePixelRatio: number
}

export interface PresentationProfile {
  /** User-selected policy. Auto remains visible even when it resolves lower. */
  readonly qualityMode: PresentationQualityMode
  /** Concrete bucket used for this presentation. */
  readonly resolvedQuality: PresentationResolvedQuality
  /** Uniform project-space scale requested by the presentation host. */
  readonly scale: PresentationScale
  /** Disposable visible/scratch/transition surface width. */
  readonly outputWidth: number
  /** Disposable visible/scratch/transition surface height. */
  readonly outputHeight: number
  readonly devicePixelPolicy: PresentationDevicePixelPolicy
  readonly reason: PresentationReason
}

export interface ResolvePresentationProfileOptions {
  readonly qualityMode: PresentationQualityMode
  readonly reason: PresentationReason
  readonly viewport: PresentationViewport | null
}

const QUALITY_SCALE: Readonly<Record<PresentationResolvedQuality, PresentationScale>> = {
  full: 1,
  half: 0.5,
  quarter: 0.25,
}

function outputDimension(value: number, scale: PresentationScale): number {
  return Math.max(1, Math.round(value * scale))
}

function resolvedQuality(scale: PresentationScale): PresentationResolvedQuality {
  if (scale === 1) return 'full'
  if (scale === 0.5) return 'half'
  return 'quarter'
}

function validViewport(viewport: PresentationViewport | null): viewport is PresentationViewport {
  return viewport !== null
    && Number.isFinite(viewport.widthCssPx)
    && viewport.widthCssPx > 0
    && Number.isFinite(viewport.heightCssPx)
    && viewport.heightCssPx > 0
    && Number.isFinite(viewport.devicePixelRatio)
    && viewport.devicePixelRatio > 0
}

function autoScale(doc: TimelineDoc, viewport: PresentationViewport | null): PresentationScale {
  if (!validViewport(viewport)) return 1
  const requiredScale = Math.max(
    viewport.widthCssPx * viewport.devicePixelRatio / doc.width,
    viewport.heightCssPx * viewport.devicePixelRatio / doc.height,
  )
  if (requiredScale <= 0.25) return 0.25
  if (requiredScale <= 0.5) return 0.5
  return 1
}

/** Resolve one immutable, serializable presentation decision. */
export function resolvePresentationProfile(
  doc: TimelineDoc,
  options: ResolvePresentationProfileOptions,
): PresentationProfile {
  const { qualityMode, reason, viewport } = options
  const isExport = reason === 'export'
  // Auto returns to a full-resolution paused frame. Playback and scrubbing
  // choose the smallest bucket that still covers the monitor's device pixels.
  const scale: PresentationScale = isExport || (qualityMode === 'auto' && reason === 'paused')
    ? 1
    : qualityMode === 'auto'
      ? autoScale(doc, viewport)
      : QUALITY_SCALE[qualityMode]

  return Object.freeze({
    qualityMode: isExport ? 'full' : qualityMode,
    resolvedQuality: resolvedQuality(scale),
    scale,
    outputWidth: outputDimension(doc.width, scale),
    outputHeight: outputDimension(doc.height, scale),
    devicePixelPolicy: isExport || (qualityMode === 'auto' && reason === 'paused')
      ? 'project-resolution'
      : qualityMode === 'auto'
        ? 'match-display'
        : 'fixed-project-scale',
    reason,
  })
}

export function fullResolutionPresentationProfile(
  doc: TimelineDoc,
  reason: Extract<PresentationReason, 'paused' | 'export'>,
): PresentationProfile {
  return resolvePresentationProfile(doc, {
    qualityMode: 'full',
    reason,
    viewport: null,
  })
}

/** Reject stale profiles after a project-dimension replacement. */
export function presentationProfileMatchesDocument(
  profile: PresentationProfile,
  doc: TimelineDoc,
): boolean {
  return profile.outputWidth === outputDimension(doc.width, profile.scale)
    && profile.outputHeight === outputDimension(doc.height, profile.scale)
}

/** Whether a worker can keep its current disposable surface allocation. */
export function presentationSurfacesMatch(
  left: PresentationProfile | null,
  right: PresentationProfile,
): boolean {
  return left !== null
    && left.scale === right.scale
    && left.outputWidth === right.outputWidth
    && left.outputHeight === right.outputHeight
}
