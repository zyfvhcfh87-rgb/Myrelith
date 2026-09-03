/**
 * Pure policy decisions for the media-import composition root.
 *
 * This module never owns Files, object URLs, cancellation, stores, or browser
 * capabilities. mediaImportController remains the exact resource and mutation
 * owner; these helpers only make its partial-track and frame-rate decisions
 * explicit and directly testable.
 */

import {
  reapplyPartialTrackImport,
  type MediaCompatibilityItem,
  type MediaCompatibilityReport,
  type MediaCompatibilityStatus,
} from '../domain/mediaCompatibility'
import { isProjectFrameRatePreset } from '../domain/projectSettings'
import type {
  FrameRate,
  MediaAsset,
  PartialTrackImportSelection,
  TimelineDoc,
} from '../domain/schema'
import { rateEquals } from '../domain/time'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import type { MediaImportPrompt } from '../state/mediaImportStore'

export type MediaImportDecision =
  | 'keep-project-rate'
  | 'match-source-rate'
  | 'cancel'

export type MediaImportCommitDecision = Exclude<
  MediaImportDecision,
  'cancel'
>

function cloneRate(rate: FrameRate): FrameRate {
  return { num: rate.num, den: rate.den }
}

function timelinesHaveTimedContent(documents: readonly TimelineDoc[]): boolean {
  return documents.some((document) => (
    document.tracks.some((track) => track.clips.length > 0)
    || (document.markers?.length ?? 0) > 0
    || (document.captionTracks ?? []).some((track) => track.items.length > 0)
  ))
}

export function createMediaImportPrompt(
  fileName: string,
  document: TimelineDoc,
  sourceRate: FrameRate,
  projectSequences: readonly TimelineDoc[] = [document],
): MediaImportPrompt {
  let matchUnavailableReason: string | null = null
  if (!isProjectFrameRatePreset(sourceRate)) {
    matchUnavailableReason =
      'This source rate is not one of the supported project presets.'
  } else if (timelinesHaveTimedContent(projectSequences)) {
    matchUnavailableReason =
      'Matching is unavailable after timed content has been added to any sequence.'
  }
  return {
    fileName,
    projectRate: cloneRate(document.frameRate),
    sourceRate: cloneRate(sourceRate),
    canMatchSource: matchUnavailableReason === null,
    matchUnavailableReason,
  }
}

export function requiresMediaImportRateDecision(
  projectRate: FrameRate,
  sourceRate: FrameRate | null,
): sourceRate is FrameRate {
  return sourceRate !== null && !rateEquals(sourceRate, projectRate)
}

export type PartialTrackImportDecision =
  | { kind: 'not-requested' }
  | {
      kind: 'accepted'
      asset: MediaAsset
      compatibility: MediaCompatibilityReport
    }
  | {
      kind: 'unavailable'
      fallbackStatus: MediaCompatibilityStatus
      fallbackReport: MediaCompatibilityReport
      message: string
    }

/** Resolve a previously confirmed partial-track choice after the fresh probe. */
export function resolvePartialTrackImportDecision(
  inspection: MediaProbeResult,
  requestedSelection: PartialTrackImportSelection | undefined,
  cancelFallback: MediaCompatibilityItem | null,
): PartialTrackImportDecision {
  if (!requestedSelection) return { kind: 'not-requested' }

  const accepted = inspection.asset
    ? reapplyPartialTrackImport(
        inspection.asset,
        inspection.compatibility,
        requestedSelection,
      )
    : null
  if (accepted) return { kind: 'accepted', ...accepted }

  return {
    kind: 'unavailable',
    fallbackStatus: inspection.status === 'ready'
      ? cancelFallback?.status ?? 'limited'
      : inspection.status,
    fallbackReport: inspection.status === 'ready'
      ? cancelFallback?.report ?? inspection.compatibility
      : inspection.compatibility,
    message: `The confirmed ${requestedSelection} choice is no longer available after rechecking the file. Review the updated compatibility details.`,
  }
}

export type MediaImportCommitValidation =
  | { kind: 'current' }
  | { kind: 'stale-project-settings' }

/** Check the document identity and rate captured before the decision wait. */
export function validateMediaImportCommitDocument(
  document: TimelineDoc,
  expectedDocumentId: string,
  expectedRate: FrameRate,
): MediaImportCommitValidation {
  if (
    document.id !== expectedDocumentId
    || !rateEquals(document.frameRate, expectedRate)
  ) {
    return { kind: 'stale-project-settings' }
  }
  return { kind: 'current' }
}

export type MediaImportRateDecision =
  | { kind: 'accepted'; finalRate: FrameRate }
  | {
      kind: 'rejected'
      reason: 'missing-source-rate' | 'source-rate-unavailable'
      message: string
    }

/** Revalidate a Keep/Match choice against the current, still-matching doc. */
export function resolveMediaImportCommitRate(
  fileName: string,
  document: TimelineDoc,
  sourceRate: FrameRate | null,
  decision: MediaImportCommitDecision,
  projectSequences: readonly TimelineDoc[] = [document],
): MediaImportRateDecision {
  if (decision === 'keep-project-rate') {
    return { kind: 'accepted', finalRate: document.frameRate }
  }
  if (!sourceRate) {
    return {
      kind: 'rejected',
      reason: 'missing-source-rate',
      message: 'this source has no video frame rate to match',
    }
  }

  const prompt = createMediaImportPrompt(
    fileName,
    document,
    sourceRate,
    projectSequences,
  )
  if (!prompt.canMatchSource) {
    return {
      kind: 'rejected',
      reason: 'source-rate-unavailable',
      message: prompt.matchUnavailableReason
        ?? 'the source frame rate cannot be used for this project',
    }
  }
  return { kind: 'accepted', finalRate: sourceRate }
}
