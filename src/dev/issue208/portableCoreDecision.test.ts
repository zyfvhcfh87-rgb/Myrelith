import { describe, expect, test } from 'vitest'
import {
  PORTABLE_CORE_CONTRACT,
  PORTABLE_CORE_SCHEMA_VERSION,
  type PortableCoreFacts,
} from './portableCoreContract'
import { decidePortableCore } from './portableCoreDecision'

function passingFacts(): PortableCoreFacts {
  return {
    contract: PORTABLE_CORE_CONTRACT,
    schemaVersion: PORTABLE_CORE_SCHEMA_VERSION,
    publicSupportClaim: false,
    importStatus: 'ready',
    editUndoEntries: 2,
    clipCountAfterEdit: 2,
    previewFrame: 4,
    previewNonEmpty: true,
    playback: {
      audioContextState: 'running',
      clockAdvanced: true,
      playheadBefore: 4,
      playheadAfter: 9,
    },
    save: {
      downloaded: true,
      extension: '.myrelith',
      liveSaveEnabled: false,
      statusText: 'Copy downloaded · unsaved changes',
      stillDirty: true,
    },
    recoveryRestoredClipCount: 2,
    relinked: true,
    exportResult: {
      destination: 'download',
      autoPreset: 'modern',
      explicitSelectionLeftAtAuto: true,
      reopenedVideo: true,
      fileDestinationDisabled: true,
      fileDestinationReason: 'This browser cannot write an export directly to a chosen file.',
    },
    optional: {
      rememberedProjectFilesOffered: false,
      rememberedMediaImportOffered: false,
      pluginIsolationClaimed: false,
    },
    resources: { samplesOpened: 1, samplesClosed: 1 },
  }
}

describe('portable core decision', () => {
  test('accepts a downloaded edit when pickers and plugins stay off', () => {
    const decision = decidePortableCore(passingFacts())
    expect(decision.core).toBe('go')
    expect(decision.reasons).toEqual([])
    expect(decision.publicSupportClaim).toBe(false)
    expect(decision.autoPreset).toBe('modern')
    expect(JSON.stringify(decision)).not.toMatch(
      /firefox|safari|chrome|webkit|gecko|useragent/i,
    )
  })

  test('accepts Limited media without turning it into a support claim', () => {
    const facts = passingFacts()
    const decision = decidePortableCore({ ...facts, importStatus: 'limited' })
    expect(decision.core).toBe('go')
    expect(decision.publicSupportClaim).toBe(false)
  })

  test.each([
    ['import', { importStatus: 'unsupported' as const }, 'import-not-usable'],
    ['edit', { editUndoEntries: 0 }, 'edit-not-committed'],
    ['preview', { previewNonEmpty: false }, 'preview-empty'],
    ['frame', { previewFrame: 1.5 }, 'preview-frame-not-integer'],
    ['clock', {
      playback: { ...passingFacts().playback, audioContextState: 'suspended' },
    }, 'audio-clock-not-running'],
    ['save', {
      save: { ...passingFacts().save, liveSaveEnabled: true },
    }, 'live-save-left-enabled'],
    ['recovery', { recoveryRestoredClipCount: 0 }, 'recovery-missed'],
    ['export', {
      exportResult: { ...passingFacts().exportResult, destination: 'file' as const },
    }, 'export-not-download'],
    ['plugins', {
      optional: { ...passingFacts().optional, pluginIsolationClaimed: true },
    }, 'plugin-isolation-claimed'],
    ['claim', { publicSupportClaim: true }, 'public-support-claim'],
    ['samples', {
      resources: { samplesOpened: 1, samplesClosed: 0 },
    }, 'resource-leak'],
  ] as const)('rejects a broken %s step', (_label, patch, reason) => {
    const decision = decidePortableCore({ ...passingFacts(), ...patch })
    expect(decision.core).toBe('no-go')
    expect(decision.reasons).toContain(reason)
    expect(decision.publicSupportClaim).toBe(false)
  })
})
