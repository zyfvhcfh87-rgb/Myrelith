import { describe, expect, test } from 'vitest'
import type {
  CompatibilityInventoryFacts,
  ExportProfileInventory,
  NativeCodecProbe,
  SupportProbe,
} from './compatibilityInventoryContract'
import { decideCompatibilityInventory } from './compatibilityInventoryDecision'

const ok: SupportProbe = Object.freeze({ supported: true, reason: null })
const missing: SupportProbe = Object.freeze({
  supported: false,
  reason: 'unsupported',
})

function codec(id: string, supported = true): NativeCodecProbe {
  return Object.freeze({
    id,
    codec: id,
    isConfigSupported: supported ? ok : missing,
    roundTrip: supported ? ok : missing,
  })
}

function profile(
  id: ExportProfileInventory['id'],
  autoCandidate: boolean,
  supported: boolean,
): ExportProfileInventory {
  return Object.freeze({
    id,
    autoCandidate,
    canEncode: supported ? ok : missing,
    freshEncode: supported ? ok : missing,
  })
}

function present(value = true): { readonly present: boolean } {
  return Object.freeze({ present: value })
}

function coreFacts(
  overrides: Partial<CompatibilityInventoryFacts> = {},
): CompatibilityInventoryFacts {
  return {
    secureContext: true,
    webCodecs: {
      VideoDecoder: present(),
      VideoEncoder: present(),
      AudioDecoder: present(),
      AudioEncoder: present(),
      ImageDecoder: present(),
      VideoFrame: present(),
      AudioData: present(),
    },
    videoCodecs: [codec('vp9')],
    audioCodecs: [codec('opus')],
    stillImages: {
      imageDecoder: ok,
      createImageBitmap: ok,
    },
    exportProfiles: [
      profile('modern', true, true),
      profile('web', true, true),
      profile('compatibility', true, false),
      profile('hevc', false, false),
    ],
    fileSystem: {
      showOpenFilePicker: false,
      showSaveFilePicker: false,
      showDirectoryPicker: false,
      rememberedMediaHandles: false,
      rememberedProjectFiles: false,
      liveSaveAvailable: false,
      directFileExportAvailable: false,
      folderExportAvailable: false,
      liveSaveReason: 'This browser cannot write an export directly to a chosen file.',
      folderExportReason: 'This browser cannot write an image sequence into a chosen folder.',
    },
    storage: {
      indexedDB: true,
      cacheStorage: true,
      opfsGetDirectory: true,
      opfsCreateWritable: ok,
      persisted: false,
    },
    audioContext: {
      constructed: true,
      initialState: 'running',
      resumeAttempted: true,
      stateAfterResume: 'running',
      closed: true,
      reason: null,
    },
    graphics: {
      offscreenCanvas: true,
      offscreenCanvas2d: true,
      transferControlToOffscreen: true,
    },
    worker: {
      moduleWorker: true,
      offscreenCanvas2d: true,
      transferredCanvas2d: true,
      webgl2: false,
      videoDecoderPresent: true,
      videoDecoderConfigSupported: true,
      reason: null,
    },
    plugins: {
      srcdocSandboxCreated: true,
      wasmUnsafeEvalInSrcdoc: true,
      opaqueOrigin: true,
      networkFetchBlocked: true,
      networkXhrBlocked: true,
      networkWebSocketBlocked: true,
      sendBeaconBlocked: true,
      indexedDbBlocked: true,
      cacheStorageBlocked: true,
      opfsBlocked: true,
      parentDomUnavailable: true,
      isolationProven: false,
      reason: 'nested-worker-not-blocked',
    },
    ...overrides,
  }
}

describe('decideCompatibilityInventory', () => {
  test('records a portable-core go when WebCodecs, workers, audio clock, and one download profile exist', () => {
    const decision = decideCompatibilityInventory(coreFacts())
    expect(decision.core).toBe('go')
    expect(decision.reasons).toEqual([])
    expect(decision.autoPreset).toBe('modern')
    expect(decision.optional['remembered-media-handles']).toBe(false)
    expect(decision.optional['live-save']).toBe(false)
    expect(decision.optional['direct-file-export']).toBe(false)
    expect(decision.optional['plugin-isolation']).toBe(false)
    expect(decision.optional['opfs-derived-caches']).toBe(true)
    expect(decision.optional['worker-webgl2']).toBe(false)
  })

  test('keeps File System Access, plugins, and WebGL optional instead of core no-go', () => {
    const decision = decideCompatibilityInventory(coreFacts())
    expect(decision.reasons).not.toContain('missing-video-decoder')
    expect(JSON.stringify(decision.reasons)).not.toMatch(/firefox|safari|chrome|webkit|gecko/i)
  })

  test('is a core no-go when AudioEncoder is missing', () => {
    const facts = coreFacts({
      webCodecs: {
        ...coreFacts().webCodecs,
        AudioEncoder: present(false),
      },
    })
    const decision = decideCompatibilityInventory(facts)
    expect(decision.core).toBe('no-go')
    expect(decision.reasons).toEqual(['missing-audio-encoder'])
  })

  test('is a core no-go when module workers cannot see VideoDecoder', () => {
    const facts = coreFacts({
      worker: {
        ...coreFacts().worker,
        videoDecoderPresent: false,
      },
    })
    expect(decideCompatibilityInventory(facts).reasons).toEqual([
      'module-worker-decode-unavailable',
    ])
  })

  test('does not double-count a missing window VideoDecoder as a worker-only failure', () => {
    const facts = coreFacts({
      webCodecs: {
        ...coreFacts().webCodecs,
        VideoDecoder: present(false),
      },
      worker: {
        ...coreFacts().worker,
        videoDecoderPresent: false,
      },
    })
    expect(decideCompatibilityInventory(facts).reasons).toEqual([
      'missing-video-decoder',
    ])
  })

  test('is a core no-go when no honest download profile encodes', () => {
    const facts = coreFacts({
      exportProfiles: [
        profile('modern', true, false),
        profile('web', true, false),
        profile('compatibility', true, false),
        profile('hevc', false, false),
      ],
    })
    const decision = decideCompatibilityInventory(facts)
    expect(decision.core).toBe('no-go')
    expect(decision.reasons).toEqual(['no-honest-download-profile'])
    expect(decision.autoPreset).toBeNull()
  })

  test('treats explicit HEVC as an honest download profile without selecting it for Auto', () => {
    const facts = coreFacts({
      exportProfiles: [
        profile('modern', true, false),
        profile('web', true, false),
        profile('compatibility', true, false),
        profile('hevc', false, true),
      ],
    })
    const decision = decideCompatibilityInventory(facts)
    expect(decision.core).toBe('go')
    expect(decision.autoPreset).toBeNull()
  })

  test('prefers Auto Modern then Web then Compatibility from measured support', () => {
    const webOnly = coreFacts({
      exportProfiles: [
        profile('modern', true, false),
        profile('web', true, true),
        profile('compatibility', true, true),
        profile('hevc', false, true),
      ],
    })
    expect(decideCompatibilityInventory(webOnly).autoPreset).toBe('web')
  })

  test('is a core no-go when transferControlToOffscreen fails', () => {
    const facts = coreFacts({
      graphics: {
        offscreenCanvas: true,
        offscreenCanvas2d: true,
        transferControlToOffscreen: false,
      },
    })
    expect(decideCompatibilityInventory(facts).reasons).toEqual([
      'transfer-control-to-offscreen-failed',
    ])
  })

  test('is a core no-go when AudioContext cannot be constructed', () => {
    const facts = coreFacts({
      audioContext: {
        constructed: false,
        initialState: null,
        resumeAttempted: false,
        stateAfterResume: null,
        closed: false,
        reason: 'AudioContext is not defined',
      },
    })
    expect(decideCompatibilityInventory(facts).reasons).toEqual([
      'audio-context-construct-failed',
    ])
  })

  test('stays a core go when AudioContext constructs but resume times out', () => {
    const facts = coreFacts({
      audioContext: {
        constructed: true,
        initialState: 'suspended',
        resumeAttempted: true,
        stateAfterResume: 'suspended',
        closed: true,
        reason: 'audio-context-resume-timeout',
      },
    })
    expect(decideCompatibilityInventory(facts)).toMatchObject({
      core: 'go',
      reasons: [],
    })
  })
})
