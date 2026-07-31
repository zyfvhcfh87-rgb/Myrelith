/**
 * App-layer facade for export capability discovery and pre-start verification.
 * UI callers never import Mediabunny or pipeline modules directly.
 */

import {
  AUTO_EXPORT_PRESET_ORDER,
  EXPORT_PRESETS,
  validateExportProfile,
  type ExportPresetId,
  type ExportProfile,
  type ExportSelectionId,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import {
  checkExportProfileSupport,
  verifyExportProfileSupportFresh,
  type ExportCapabilityResult,
} from '../pipeline/export-capabilities'
import { mediabunnyExportCapabilityProbe } from '../pipeline/export-mediabunny-capabilities'
import { useDocumentStore } from '../state/documentStore'

export interface ExportPresetCapability extends ExportCapabilityResult {
  readonly presetId: ExportPresetId
}

export interface ExportCapabilitySnapshot {
  readonly presets: readonly Readonly<ExportPresetCapability>[]
  readonly autoPresetId: ExportPresetId | null
}

export interface ResolvedExportSelection {
  readonly selectionId: ExportSelectionId
  readonly presetId: ExportPresetId | null
  readonly profile: Readonly<ExportProfile> | null
  readonly reason: string | null
}

export interface ExportCapabilitiesControllerDeps {
  getDocument(): TimelineDoc
  checkProfile(
    doc: TimelineDoc,
    profile: ExportProfile,
  ): Promise<Readonly<ExportCapabilityResult>>
  verifyProfile(
    doc: TimelineDoc,
    profile: ExportProfile,
    signal?: AbortSignal,
  ): Promise<Readonly<ExportCapabilityResult>>
}

const realDeps: ExportCapabilitiesControllerDeps = {
  getDocument: () => useDocumentStore.getState().doc,
  checkProfile: (doc, profile) => checkExportProfileSupport(
    doc,
    profile,
    mediabunnyExportCapabilityProbe,
  ),
  verifyProfile: (doc, profile, signal) => verifyExportProfileSupportFresh(
    doc,
    profile,
    mediabunnyExportCapabilityProbe,
    signal,
  ),
}

/** Probe the documented preset catalog only; capability results are not persisted. */
export async function getExportPresetCapabilities(
  deps: ExportCapabilitiesControllerDeps = realDeps,
): Promise<Readonly<ExportCapabilitySnapshot>> {
  const doc = deps.getDocument()
  const presets = await Promise.all(EXPORT_PRESETS.map(async (preset) => {
    const result = await deps.checkProfile(doc, preset.profile)
    return Object.freeze({
      presetId: preset.id,
      profile: result.profile,
      supported: result.supported,
      reason: result.reason,
    })
  }))
  const autoPresetId = AUTO_EXPORT_PRESET_ORDER.find((presetId) => (
    presets.some((result) => result.presetId === presetId && result.supported)
  )) ?? null
  return Object.freeze({
    presets: Object.freeze(presets),
    autoPresetId,
  })
}

/** Probe one advanced concrete profile against the current project. */
export function checkCurrentExportProfile(
  profile: ExportProfile,
  deps: ExportCapabilitiesControllerDeps = realDeps,
): Promise<Readonly<ExportCapabilityResult>> {
  const validated = validateExportProfile(profile)
  return deps.checkProfile(deps.getDocument(), validated)
}

/**
 * Resolve Auto visibly, or preserve one explicit selection exactly. An
 * unsupported explicit selection never falls through to another preset.
 */
export function resolveExportSelection(
  selectionId: ExportSelectionId,
  snapshot: ExportCapabilitySnapshot,
): Readonly<ResolvedExportSelection> {
  const presetId = selectionId === 'auto'
    ? snapshot.autoPresetId
    : selectionId
  if (presetId === null) {
    return Object.freeze({
      selectionId,
      presetId: null,
      profile: null,
      reason: 'No export profile supports this project in this browser.',
    })
  }

  const result = snapshot.presets.find((candidate) => candidate.presetId === presetId)
  if (!result) {
    throw new Error(`Capability snapshot is missing export preset ${presetId}`)
  }
  return Object.freeze({
    selectionId,
    presetId,
    profile: result.supported ? result.profile : null,
    reason: result.supported ? null : result.reason,
  })
}

/**
 * Fresh authoritative check used by exportController after reserving a run and
 * before creating decoders or encoder output. The controller separately
 * acquires its captured object-URL Blob lease before its first await.
 */
export async function preflightExportProfile(
  doc: TimelineDoc,
  profile: ExportProfile,
  signal?: AbortSignal,
  deps: ExportCapabilitiesControllerDeps = realDeps,
): Promise<void> {
  const validated = validateExportProfile(profile)
  const result = await deps.verifyProfile(doc, validated, signal)
  if (!result.supported) {
    throw new Error(
      result.reason ?? 'The selected export profile is unavailable. No codec was substituted.',
    )
  }
}
