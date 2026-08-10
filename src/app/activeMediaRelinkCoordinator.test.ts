import { describe, expect, test, vi } from 'vitest'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import {
  createActiveMediaRelinkCoordinator,
  type ActiveMediaRelinkCoordinatorDeps,
  type ActiveMediaRelinkSelection,
} from './activeMediaRelinkCoordinator'
import type { LocalMediaFileHandle } from './localMediaHandles'

const EXACT_BOUNDS = {
  status: 'exact' as const,
  firstTimestampUs: 0,
  endTimestampUs: 2_000_000,
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'temporary',
    fileName: 'picked.mp4',
    mimeType: 'video/mp4',
    size: 8,
    lastModified: 111,
    objectUrl: 'blob:relink',
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 2_000_000,
    sourceBounds: { video: EXACT_BOUNDS, audio: EXACT_BOUNDS },
    frameRate: { num: 60, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"fresh"}',
    ...overrides,
  }
}

function descriptor(
  overrides: Partial<PortableAssetDescriptor> = {},
): PortableAssetDescriptor {
  const analyzed = asset()
  return {
    id: 'stable',
    fileName: 'saved.mp4',
    mimeType: 'video/mp4',
    size: analyzed.size,
    lastModified: analyzed.lastModified,
    kind: analyzed.kind,
    durationMicroseconds: analyzed.durationMicroseconds,
    sourceBounds: analyzed.sourceBounds,
    nativeFrameRate: analyzed.frameRate,
    width: analyzed.width,
    height: analyzed.height,
    hasAudio: analyzed.hasAudio,
    audioSampleRate: analyzed.audioSampleRate,
    audioChannels: analyzed.audioChannels,
    ...overrides,
  }
}

function track(
  kind: 'video' | 'audio',
  decodable = true,
): MediaTrackCompatibility {
  return {
    kind,
    number: 1,
    primary: true,
    codec: kind === 'video' ? 'avc' : 'aac',
    codecParameter: kind === 'video' ? 'avc1.64042a' : 'mp4a.40.2',
    internalCodecId: kind === 'video' ? 'avc1' : 'mp4a',
    decoderConfig: null,
    decoderPath: decodable ? 'native' : null,
    decodable,
    reason: decodable ? null : 'unsupported-codec',
    detail: decodable ? null : `${kind} unavailable`,
    width: kind === 'video' ? 1920 : null,
    height: kind === 'video' ? 1080 : null,
    codedWidth: kind === 'video' ? 1920 : null,
    codedHeight: kind === 'video' ? 1080 : null,
    frameRate: kind === 'video' ? { num: 60, den: 1 } : null,
    sampleRate: kind === 'audio' ? 48_000 : null,
    channels: kind === 'audio' ? 2 : null,
    durationMicroseconds: 2_000_000,
    sourceBounds: EXACT_BOUNDS,
  }
}

function report(
  overrides: Partial<MediaCompatibilityReport> = {},
): MediaCompatibilityReport {
  return {
    status: 'ready',
    container: {
      name: 'MP4',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.64042a, mp4a.40.2"',
    },
    durationMicroseconds: 2_000_000,
    tracks: [track('video'), track('audio')],
    reason: null,
    detail: null,
    ...overrides,
  }
}

function readyInspection(): MediaProbeResult {
  return { status: 'ready', asset: asset(), compatibility: report() }
}

function file(): File {
  return new File([new Uint8Array(8)], 'picked.mp4', {
    type: 'video/mp4',
    lastModified: 111,
  })
}

const HANDLE = {
  kind: 'file',
  name: 'picked.mp4',
  getFile: vi.fn(),
} as unknown as LocalMediaFileHandle

function selection(
  overrides: Partial<ActiveMediaRelinkSelection> = {},
): ActiveMediaRelinkSelection {
  return {
    kind: 'individual',
    assetId: 'stable',
    file: file(),
    handle: HANDLE,
    displayPath: 'picked.mp4',
    ...overrides,
  }
}

function checkingItem(
  saved: PortableAssetDescriptor,
  requestId: string,
): MediaCompatibilityItem {
  return {
    id: saved.id,
    requestId,
    fileName: saved.fileName,
    declaredMimeType: saved.mimeType,
    size: saved.size,
    lastModified: saved.lastModified,
    status: 'checking',
    report: null,
  }
}

function harness(
  overrides: Partial<ActiveMediaRelinkCoordinatorDeps> = {},
): {
  deps: ActiveMediaRelinkCoordinatorDeps
  saved: PortableAssetDescriptor
  current: { value: boolean }
  skipped: Array<string | undefined>
  warnings: string[]
} {
  const saved = descriptor()
  const current = { value: true }
  const skipped: Array<string | undefined> = []
  const warnings: string[] = []
  const deps: ActiveMediaRelinkCoordinatorDeps = {
    createCompatibilityRequestId: vi.fn(() => 'request-1'),
    createCheckingItem: vi.fn(checkingItem),
    createFailureReport: vi.fn((fileName, cause): MediaCompatibilityReport => ({
      status: 'error',
      container: null,
      durationMicroseconds: null,
      tracks: [],
      reason: 'decode-failed',
      detail: `Could not check "${fileName}": ${String(cause)}`,
    })),
    inspectMedia: vi.fn(async () => readyInspection()),
    rememberMediaHandle: vi.fn(async () => {}),
    revokeObjectURL: vi.fn(),
    isProbeCancellation: vi.fn(() => false),
    isCurrent: vi.fn(() => current.value),
    claimForCommit: vi.fn(() => true),
    releaseSelection: vi.fn(),
    store: {
      getDescriptor: vi.fn(() => saved),
      hasConnectedAsset: vi.fn(() => false),
      startCompatibility: vi.fn(() => true),
      setCompatibility: vi.fn(() => true),
      rollbackCompatibility: vi.fn(() => true),
      connectAsset: vi.fn(() => true),
    },
    progress: {
      checkingStarted: vi.fn(),
      checkingFinished: vi.fn(),
      connected: vi.fn(),
      skipped: vi.fn((message) => skipped.push(message)),
      warning: vi.fn((message) => warnings.push(message)),
      publishConnected: vi.fn(),
    },
    ...overrides,
  }
  return { deps, saved, current, skipped, warnings }
}

const CONTEXT = {
  projectBindingId: 'local-project:test',
  documentRate: { num: 30, den: 1 },
  signal: new AbortController().signal,
}

describe('active media relink coordinator', () => {
  test('transfers one accepted URL and remembers its handle after commit', async () => {
    const { deps } = harness()
    const coordinator = createActiveMediaRelinkCoordinator(deps)

    await expect(coordinator.connect(selection(), CONTEXT)).resolves.toEqual({
      status: 'connected',
    })

    expect(deps.store.connectAsset).toHaveBeenCalledOnce()
    expect(deps.store.connectAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'stable',
        fileName: 'saved.mp4',
        objectUrl: 'blob:relink',
        durationFrames: 60,
        decoderConfigB64: '{"codec":"fresh"}',
      }),
      expect.objectContaining({
        id: 'stable',
        requestId: 'request-1',
        status: 'ready',
      }),
    )
    expect(deps.revokeObjectURL).not.toHaveBeenCalled()
    expect(deps.progress.checkingStarted).toHaveBeenCalledWith(
      'stable',
      'request-1',
    )
    expect(deps.progress.checkingFinished).toHaveBeenCalledWith('stable')
    expect(deps.progress.connected).toHaveBeenCalledOnce()
    expect(deps.progress.publishConnected).toHaveBeenCalledOnce()
    expect(deps.rememberMediaHandle).toHaveBeenCalledWith(
      'local-project:test',
      'stable',
      HANDLE,
    )
  })

  test('revokes and rolls back when the store rejects the final commit', async () => {
    const { deps, skipped } = harness()
    vi.mocked(deps.store.connectAsset).mockReturnValue(false)

    await expect(createActiveMediaRelinkCoordinator(deps).connect(
      selection(),
      CONTEXT,
    )).resolves.toEqual({
      status: 'failed',
      message: 'Could not reconnect "saved.mp4".',
    })

    expect(deps.revokeObjectURL).toHaveBeenCalledOnce()
    expect(deps.store.rollbackCompatibility).toHaveBeenCalledWith(
      'stable',
      'request-1',
    )
    expect(deps.rememberMediaHandle).not.toHaveBeenCalled()
    expect(skipped).toEqual(['Could not reconnect "saved.mp4".'])
  })

  test('keeps a matching non-Ready report and its actionable detail', async () => {
    const limited = report({
      status: 'limited',
      tracks: [track('video', false), track('audio')],
      reason: 'unsupported-codec',
      detail: 'The selected video profile is unavailable.',
    })
    const { deps, skipped } = harness({
      inspectMedia: vi.fn(async (): Promise<MediaProbeResult> => ({
        status: 'limited',
        asset: asset(),
        compatibility: limited,
      })),
    })

    await expect(createActiveMediaRelinkCoordinator(deps).connect(
      selection(),
      CONTEXT,
    )).resolves.toEqual({
      status: 'failed',
      message: 'The selected video profile is unavailable.',
    })

    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:relink')
    expect(deps.store.setCompatibility).toHaveBeenCalledWith(
      'stable',
      'request-1',
      'limited',
      limited,
    )
    expect(deps.store.rollbackCompatibility).not.toHaveBeenCalled()
    expect(skipped).toEqual(['The selected video profile is unavailable.'])
  })

  test('releases an unclaimed folder candidate without leaking its URL', async () => {
    const { deps, skipped } = harness({
      claimForCommit: vi.fn(() => false),
    })

    await expect(createActiveMediaRelinkCoordinator(deps).connect(
      selection({
        kind: 'folder',
        displayPath: 'nested/picked.mp4',
      }),
      CONTEXT,
    )).resolves.toEqual({
      status: 'failed',
      message: 'Could not safely reconnect "nested/picked.mp4".',
    })

    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:relink')
    expect(deps.releaseSelection).toHaveBeenCalledOnce()
    expect(deps.store.connectAsset).not.toHaveBeenCalled()
    expect(skipped).toEqual([
      'Could not safely reconnect "nested/picked.mp4".',
    ])
  })

  test('revokes late inspection output after project replacement', async () => {
    const { deps, current } = harness({
      inspectMedia: vi.fn(async () => {
        current.value = false
        return readyInspection()
      }),
    })

    await expect(createActiveMediaRelinkCoordinator(deps).connect(
      selection(),
      CONTEXT,
    )).resolves.toEqual({ status: 'cancelled' })

    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:relink')
    expect(deps.claimForCommit).not.toHaveBeenCalled()
    expect(deps.store.connectAsset).not.toHaveBeenCalled()
    expect(deps.rememberMediaHandle).not.toHaveBeenCalled()
  })

  test('never revokes a transferred URL when replacement overtakes handle persistence', async () => {
    const { deps, current } = harness({
      rememberMediaHandle: vi.fn(async () => {
        current.value = false
      }),
    })

    await expect(createActiveMediaRelinkCoordinator(deps).connect(
      selection(),
      CONTEXT,
    )).resolves.toEqual({ status: 'cancelled' })

    expect(deps.store.connectAsset).toHaveBeenCalledOnce()
    expect(deps.revokeObjectURL).not.toHaveBeenCalled()
  })

  test('keeps a successful connection when remembering its handle fails', async () => {
    const { deps, warnings } = harness({
      rememberMediaHandle: vi.fn(async () => {
        throw new Error('IndexedDB unavailable')
      }),
    })

    await expect(createActiveMediaRelinkCoordinator(deps).connect(
      selection(),
      CONTEXT,
    )).resolves.toEqual({ status: 'connected' })

    expect(deps.store.connectAsset).toHaveBeenCalledOnce()
    expect(deps.revokeObjectURL).not.toHaveBeenCalled()
    expect(warnings).toEqual([
      'Reconnected "saved.mp4", but could not remember it: IndexedDB unavailable',
    ])
  })

  test('suppresses folder cancellation noise while publishing the guarded error row', async () => {
    const cancellation = new DOMException('Cancelled', 'AbortError')
    const { deps, skipped } = harness({
      inspectMedia: vi.fn(async () => {
        throw cancellation
      }),
      isProbeCancellation: vi.fn((cause) => cause === cancellation),
    })

    await expect(createActiveMediaRelinkCoordinator(deps).connect(
      selection({ kind: 'folder', displayPath: 'nested/picked.mp4' }),
      CONTEXT,
    )).resolves.toEqual({ status: 'failed' })

    expect(deps.releaseSelection).toHaveBeenCalledOnce()
    expect(deps.store.setCompatibility).toHaveBeenCalledWith(
      'stable',
      'request-1',
      'error',
      expect.objectContaining({ status: 'error' }),
    )
    expect(skipped).toEqual([undefined])
  })
})
