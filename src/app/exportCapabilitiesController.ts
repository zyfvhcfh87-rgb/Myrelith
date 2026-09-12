/**
 * App-layer facade for export capability discovery and pre-start verification.
 * UI callers never import Mediabunny or pipeline modules directly.
 */

import {
  AUTO_EXPORT_PRESET_ORDER,
  EXPORT_PRESETS,
  exportAudioEncoderSampleRate,
  validateExportProfile,
  type ExportPresetId,
  type ExportProfile,
  type ExportSelectionId,
} from '../domain/exportProfile'
import {
  isAlphaVideoProfile,
  isAudioOnlyProfile,
  isDeliveryProfile,
  isImageSequenceProfile,
  parseExportSettings,
  type AlphaVideoCodec,
  type AudioOnlyProfile,
  type DeliveryProfile,
} from '../domain/deliveryProduct'
import type { TimelineDoc } from '../domain/schema'
import {
  checkExportProfileSupport,
  verifyExportProfileSupportFresh,
  type ExportCapabilityResult,
} from '../pipeline/export-capabilities'
import { mediabunnyExportCapabilityProbe } from '../pipeline/export-mediabunny-capabilities'
import {
  proveAlphaVideoCodec,
  provePngSequenceSupport,
  type AlphaCapabilityResult,
} from '../pipeline/export-alpha-probe'
import { useDocumentStore } from '../state/documentStore'
import type { ExportSettings } from '../pipeline/export'

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

export interface ExportSettingsCapabilityResult {
  readonly settings: Readonly<ExportSettings>
  readonly supported: boolean
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
  provePngSequence?(): Promise<{ readonly supported: boolean; readonly reason: string | null }>
  proveAlphaVideo?(
    codec: AlphaVideoCodec,
    signal?: AbortSignal,
  ): Promise<Readonly<AlphaCapabilityResult>>
  proveCompressedAudio?(
    doc: TimelineDoc,
    profile: AudioOnlyProfile,
    signal?: AbortSignal,
  ): Promise<{ readonly supported: boolean; readonly reason: string | null }>
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

async function defaultCompressedAudioProof(
  doc: TimelineDoc,
  profile: AudioOnlyProfile,
  signal?: AbortSignal,
): Promise<{ readonly supported: boolean; readonly reason: string | null }> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Audio-only proof cancelled', 'AbortError')
  }
  const codec = profile.codec
  if (codec !== 'aac' && codec !== 'opus') {
    return { supported: false, reason: 'Compressed audio-only requires AAC or Opus' }
  }
  const ok = await mediabunnyExportCapabilityProbe.canEncodeAudio(codec, {
    numberOfChannels: profile.audioChannelLayout === 'mono' ? 1 : 2,
    sampleRate: exportAudioEncoderSampleRate(doc.audioSampleRate, codec),
    bitrate: profile.audioBitrate ?? 192_000,
    bitrateMode: profile.audioBitrateMode ?? 'variable',
  })
  return ok
    ? { supported: true, reason: null }
    : {
        supported: false,
        reason: `${codec.toUpperCase()} audio-only encoding is unavailable on this browser. No codec was substituted.`,
      }
}

async function proveDeliverySettings(
  doc: TimelineDoc,
  profile: DeliveryProfile,
  signal: AbortSignal | undefined,
  deps: ExportCapabilitiesControllerDeps,
): Promise<ExportSettingsCapabilityResult> {
  if (isImageSequenceProfile(profile)) {
    const proof = await (deps.provePngSequence ?? provePngSequenceSupport)()
    return {
      settings: profile,
      supported: proof.supported,
      reason: proof.reason,
    }
  }
  if (isAudioOnlyProfile(profile)) {
    if (profile.codec === 'pcm-s16') {
      return { settings: profile, supported: true, reason: null }
    }
    const proof = await (deps.proveCompressedAudio ?? defaultCompressedAudioProof)(
      doc,
      profile,
      signal,
    )
    return { settings: profile, supported: proof.supported, reason: proof.reason }
  }
  if (isAlphaVideoProfile(profile)) {
    const proof = await (deps.proveAlphaVideo ?? proveAlphaVideoCodec)(
      profile.videoCodec,
      signal,
    )
    return { settings: profile, supported: proof.supported, reason: proof.reason }
  }
  return {
    settings: profile,
    supported: false,
    reason: 'This delivery product is not supported.',
  }
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

export async function checkCurrentExportSettings(
  settings: unknown,
  deps: ExportCapabilitiesControllerDeps = realDeps,
): Promise<Readonly<ExportSettingsCapabilityResult>> {
  const parsed = parseExportSettings(settings)
  if (isDeliveryProfile(parsed)) {
    return proveDeliverySettings(deps.getDocument(), parsed, undefined, deps)
  }
  const result = await deps.checkProfile(deps.getDocument(), parsed)
  return Object.freeze({
    settings: result.profile,
    supported: result.supported,
    reason: result.reason,
  })
}

/**
 * Fresh authoritative check used by exportController after reserving a run and
 * before creating decoders or encoder output. The controller separately
 * acquires its captured object-URL Blob lease before its first await.
 */
export async function preflightExportProfile(
  doc: TimelineDoc,
  profile: ExportSettings,
  signal?: AbortSignal,
  deps: ExportCapabilitiesControllerDeps = realDeps,
): Promise<void> {
  const parsed = parseExportSettings(profile)
  if (isDeliveryProfile(parsed)) {
    const result = await proveDeliverySettings(doc, parsed, signal, deps)
    if (!result.supported) {
      throw new Error(
        result.reason ?? 'The selected delivery product is unavailable. No codec was substituted.',
      )
    }
    return
  }
  const result = await deps.verifyProfile(doc, parsed, signal)
  if (!result.supported) {
    throw new Error(
      result.reason ?? 'The selected export profile is unavailable. No codec was substituted.',
    )
  }
}
