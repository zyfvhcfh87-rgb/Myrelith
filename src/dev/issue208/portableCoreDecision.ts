import type {
  PortableCoreDecision,
  PortableCoreFacts,
  PortableCoreReason,
} from './portableCoreContract'

const DOWNLOADED_COPY_STATUS = 'Copy downloaded · unsaved changes'
const AUTO_PRESETS = new Set(['modern', 'web', 'compatibility'])

function integerFrame(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Classify one portable import/edit/preview/save/export run.
 * Missing pickers, Recents, and live save stay optional and must not be
 * offered on this surface. This never reads a user-agent string.
 */
export function decidePortableCore(facts: PortableCoreFacts): PortableCoreDecision {
  const reasons: PortableCoreReason[] = []
  const playback = facts.playback
  const save = facts.save
  const exported = facts.exportResult

  if (facts.importStatus !== 'ready' && facts.importStatus !== 'limited') {
    reasons.push('import-not-usable')
  }
  if (facts.editUndoEntries < 1 || facts.clipCountAfterEdit < 2) {
    reasons.push('edit-not-committed')
  }
  if (!integerFrame(facts.previewFrame)) reasons.push('preview-frame-not-integer')
  if (!facts.previewNonEmpty) reasons.push('preview-empty')
  if (playback.audioContextState !== 'running') reasons.push('audio-clock-not-running')
  if (!playback.clockAdvanced) reasons.push('audio-clock-did-not-advance')
  if (
    !integerFrame(playback.playheadBefore)
    || !integerFrame(playback.playheadAfter)
    || playback.playheadAfter <= playback.playheadBefore
  ) {
    reasons.push('playhead-did-not-advance')
  }
  if (!save.downloaded) reasons.push('save-not-downloaded')
  if (save.extension !== '.myrelith') reasons.push('save-not-portable-project')
  if (save.liveSaveEnabled) reasons.push('live-save-left-enabled')
  if (!save.stillDirty) reasons.push('save-cleared-dirty-state')
  if (save.statusText !== DOWNLOADED_COPY_STATUS) {
    reasons.push('save-status-not-downloaded-copy')
  }
  if (facts.recoveryRestoredClipCount !== facts.clipCountAfterEdit) {
    reasons.push('recovery-missed')
  }
  if (!facts.relinked) reasons.push('relink-missed')
  if (exported.destination !== 'download') reasons.push('export-not-download')
  if (exported.autoPreset === null || !AUTO_PRESETS.has(exported.autoPreset)) {
    reasons.push('export-auto-missing')
  }
  if (!exported.explicitSelectionLeftAtAuto) reasons.push('explicit-export-selection')
  if (!exported.reopenedVideo) reasons.push('export-did-not-reopen')
  if (!exported.fileDestinationDisabled) reasons.push('file-destination-not-disabled')
  if (!exported.fileDestinationReason) reasons.push('file-destination-reason-missing')
  if (facts.optional.rememberedProjectFilesOffered) {
    reasons.push('remembered-project-files-offered')
  }
  if (facts.optional.rememberedMediaImportOffered) {
    reasons.push('remembered-media-import-offered')
  }
  if (facts.optional.pluginIsolationClaimed) reasons.push('plugin-isolation-claimed')
  if (facts.publicSupportClaim !== false) reasons.push('public-support-claim')
  if (
    facts.resources.samplesOpened < 1
    || facts.resources.samplesOpened !== facts.resources.samplesClosed
  ) {
    reasons.push('resource-leak')
  }

  return Object.freeze({
    core: reasons.length === 0 ? 'go' : 'no-go',
    reasons: Object.freeze([...reasons]),
    publicSupportClaim: false,
    autoPreset: exported.autoPreset,
  })
}
