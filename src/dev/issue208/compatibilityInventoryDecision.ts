import type {
  CompatibilityInventoryCoreReason,
  CompatibilityInventoryDecision,
  CompatibilityInventoryFacts,
  CompatibilityInventoryOptionalFeatureId,
  ExportProfileInventory,
} from './compatibilityInventoryContract'

const OPTIONAL_FALSE: Readonly<
  Record<CompatibilityInventoryOptionalFeatureId, boolean>
> = Object.freeze({
  'remembered-media-handles': false,
  'remembered-project-files': false,
  'live-save': false,
  'direct-file-export': false,
  'folder-png-export': false,
  'opfs-derived-caches': false,
  'worker-webgl2': false,
  'plugin-isolation': false,
})

function profileSupported(profile: ExportProfileInventory): boolean {
  return profile.freshEncode.supported || profile.canEncode.supported
}

function firstAutoPreset(
  profiles: readonly ExportProfileInventory[],
): CompatibilityInventoryDecision['autoPreset'] {
  const order = ['modern', 'web', 'compatibility'] as const
  for (const id of order) {
    const profile = profiles.find((entry) => entry.id === id)
    if (profile && profileSupported(profile)) return id
  }
  return null
}

/**
 * Classify recorded capability facts. Never reads a user-agent string.
 * Missing File System Access, OPFS, WebGL2, or plugin isolation is optional.
 */
export function decideCompatibilityInventory(
  facts: CompatibilityInventoryFacts,
): CompatibilityInventoryDecision {
  const reasons: CompatibilityInventoryCoreReason[] = []
  if (!facts.webCodecs.VideoDecoder.present) reasons.push('missing-video-decoder')
  if (!facts.webCodecs.VideoEncoder.present) reasons.push('missing-video-encoder')
  if (!facts.webCodecs.AudioDecoder.present) reasons.push('missing-audio-decoder')
  if (!facts.webCodecs.AudioEncoder.present) reasons.push('missing-audio-encoder')
  if (!facts.graphics.offscreenCanvas2d) reasons.push('missing-offscreencanvas-2d')
  if (!facts.graphics.transferControlToOffscreen) {
    reasons.push('transfer-control-to-offscreen-failed')
  }
  if (!facts.worker.moduleWorker) reasons.push('missing-module-dedicated-worker')
  if (
    facts.webCodecs.VideoDecoder.present
    && facts.worker.moduleWorker
    && !facts.worker.videoDecoderPresent
  ) {
    reasons.push('module-worker-decode-unavailable')
  }
  if (!facts.audioContext.constructed) reasons.push('audio-context-construct-failed')
  if (!facts.exportProfiles.some(profileSupported)) {
    reasons.push('no-honest-download-profile')
  }

  return Object.freeze({
    core: reasons.length === 0 ? 'go' : 'no-go',
    reasons: Object.freeze([...reasons]),
    autoPreset: firstAutoPreset(facts.exportProfiles),
    optional: Object.freeze({
      ...OPTIONAL_FALSE,
      'remembered-media-handles': facts.fileSystem.rememberedMediaHandles,
      'remembered-project-files': facts.fileSystem.rememberedProjectFiles,
      'live-save': facts.fileSystem.liveSaveAvailable,
      'direct-file-export': facts.fileSystem.directFileExportAvailable,
      'folder-png-export': facts.fileSystem.folderExportAvailable,
      'opfs-derived-caches': facts.storage.opfsCreateWritable.supported,
      'worker-webgl2': facts.worker.webgl2,
      'plugin-isolation': facts.plugins.isolationProven,
    }),
  })
}
