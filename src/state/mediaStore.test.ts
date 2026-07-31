import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
} from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import { useMediaStore } from './mediaStore'

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const asset: MediaAsset = {
    id: 'asset-1',
    fileName: 'holiday.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:asset-1',
    kind: 'video',
    durationFrames: 300,
    durationMicroseconds: 10_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
    },
    frameRate: { num: 60, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...overrides,
  }
  if (overrides.sourceBounds !== undefined) return asset
  if (asset.kind === 'image') {
    return { ...asset, sourceBounds: { video: null, audio: null } }
  }
  const exact = {
    status: 'exact' as const,
    firstTimestampUs: 0,
    endTimestampUs: asset.durationMicroseconds,
  }
  return {
    ...asset,
    sourceBounds: {
      video: asset.kind === 'video' ? exact : null,
      audio: asset.hasAudio ? exact : null,
    },
  }
}

function descriptorFor(asset: MediaAsset): PortableAssetDescriptor {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    ...(asset.partialTrackSelection === undefined
      ? {}
      : { partialTrackSelection: asset.partialTrackSelection }),
    durationMicroseconds: asset.durationMicroseconds,
    sourceBounds: asset.sourceBounds,
    nativeFrameRate: asset.frameRate,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
  }
}

function makeCompatibilityReport(): MediaCompatibilityReport {
  return {
    status: 'ready',
    container: {
      name: 'MPEG-4',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    },
    durationMicroseconds: 10_000_000,
    tracks: [],
    reason: null,
    detail: null,
  }
}

function makeCompatibilityItem(
  overrides: Partial<MediaCompatibilityItem> = {},
): MediaCompatibilityItem {
  return {
    id: 'candidate-1',
    requestId: 'request-1',
    fileName: 'candidate.mp4',
    declaredMimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    status: 'checking',
    report: null,
    ...overrides,
  }
}

function compatibilityForAsset(
  asset: MediaAsset,
  status: MediaCompatibilityItem['status'] = 'ready',
  report: MediaCompatibilityReport | null = makeCompatibilityReport(),
  requestId = 'asset-request',
): MediaCompatibilityItem {
  return {
    id: asset.id,
    requestId,
    fileName: asset.fileName,
    declaredMimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    status,
    report,
  }
}

const getState = () => useMediaStore.getState()

beforeEach(() => {
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
})

describe('mediaStore', () => {
  test('compatibility results are guarded by the current request generation', () => {
    const first = makeCompatibilityItem()
    expect(getState().startCompatibility(first)).toBe(true)

    const checking = getState().compatibility
    expect(getState().setCompatibility(
      first.id,
      'stale-request',
      'ready',
      makeCompatibilityReport(),
    )).toBe(false)
    expect(getState().compatibility).toBe(checking)
    expect(getState().compatibility.get(first.id)).toBe(first)

    getState().removeCompatibility(first.id)
    const second = makeCompatibilityItem({ requestId: 'request-2' })
    expect(getState().startCompatibility(second)).toBe(true)
    expect(getState().setCompatibility(
      first.id,
      first.requestId,
      'ready',
      makeCompatibilityReport(),
    )).toBe(false)
    expect(getState().compatibility.get(first.id)).toBe(second)

    const report = makeCompatibilityReport()
    expect(getState().setCompatibility(
      second.id,
      second.requestId,
      'ready',
      report,
    )).toBe(true)
    expect(getState().compatibility.get(second.id)).toEqual({
      ...second,
      status: 'ready',
      report,
    })
  })

  test('does not replace an active check or start one for a connected id', () => {
    const first = makeCompatibilityItem()
    expect(getState().startCompatibility(first)).toBe(true)
    const active = getState().compatibility

    expect(getState().startCompatibility(makeCompatibilityItem({
      requestId: 'request-2',
    }))).toBe(false)
    expect(getState().compatibility).toBe(active)
    expect(getState().compatibility.get(first.id)).toBe(first)

    getState().removeCompatibility(first.id)
    const asset = makeAsset({ id: first.id })
    expect(getState().addAsset(asset)).toBe(true)
    const committed = getState().compatibility
    expect(getState().startCompatibility(makeCompatibilityItem({
      requestId: 'request-3',
    }))).toBe(false)
    expect(getState().compatibility).toBe(committed)

    getState().disconnectAsset(asset.id)
    expect(getState().assets.has(asset.id)).toBe(false)
    expect(getState().descriptors.has(asset.id)).toBe(true)
    const disconnected = getState().compatibility
    const relink = compatibilityForAsset(
      asset,
      'checking',
      null,
      'request-4',
    )
    expect(getState().startCompatibility(relink)).toBe(true)
    expect(getState().compatibility).not.toBe(disconnected)
    expect(getState().compatibility.get(asset.id)).toBe(relink)
  })

  test('descriptor-backed checks require exact identity and preserve the settled report', () => {
    const asset = makeAsset()
    expect(getState().addAsset(asset)).toBe(true)
    getState().disconnectAsset(asset.id)

    const mismatched = compatibilityForAsset(
      { ...asset, fileName: 'different.mp4' },
      'checking',
      null,
      'mismatched-request',
    )
    const beforeMismatch = getState().compatibility
    expect(getState().startCompatibility(mismatched)).toBe(false)
    expect(getState().compatibility).toBe(beforeMismatch)

    const previousReport: MediaCompatibilityReport = {
      ...makeCompatibilityReport(),
      status: 'error',
      reason: 'decode-failed',
      detail: 'Preview failed after the initial probe.',
    }
    const previousCheck = compatibilityForAsset(
      asset,
      'checking',
      null,
      'previous-request',
    )
    expect(getState().startCompatibility(previousCheck)).toBe(true)
    expect(getState().setCompatibility(
      asset.id,
      previousCheck.requestId,
      'error',
      previousReport,
    )).toBe(true)

    const relink = compatibilityForAsset(
      asset,
      'checking',
      null,
      'relink-request',
    )
    expect(getState().startCompatibility(relink)).toBe(true)
    expect(getState().compatibility.get(asset.id)).toEqual({
      ...relink,
      report: previousReport,
    })
    expect(getState().compatibility.get(asset.id)?.report).toBe(previousReport)
  })

  test('descriptor-backed results require matching status and connection parity', () => {
    const asset = makeAsset()
    expect(getState().addAsset(asset)).toBe(true)
    getState().disconnectAsset(asset.id)
    const checking = compatibilityForAsset(
      asset,
      'checking',
      null,
      'descriptor-request',
    )
    expect(getState().startCompatibility(checking)).toBe(true)

    const before = getState().compatibility
    const readyReport = makeCompatibilityReport()
    expect(getState().setCompatibility(
      asset.id,
      checking.requestId,
      'ready',
      readyReport,
    )).toBe(false)
    expect(getState().compatibility).toBe(before)
    expect(getState().compatibility.get(asset.id)).toBe(checking)

    expect(getState().setCompatibility(
      asset.id,
      checking.requestId,
      'error',
      readyReport,
    )).toBe(false)
    expect(getState().compatibility).toBe(before)

    const errorReport: MediaCompatibilityReport = {
      ...readyReport,
      status: 'error',
      reason: 'decode-failed',
      detail: 'The decoder stopped.',
    }
    expect(getState().setCompatibility(
      asset.id,
      checking.requestId,
      'error',
      errorReport,
    )).toBe(true)
    expect(getState().compatibility.get(asset.id)).toEqual({
      ...checking,
      status: 'error',
      report: errorReport,
    })
  })

  test('removeCompatibility drops a compatibility-only item', () => {
    const item = makeCompatibilityItem()
    expect(getState().startCompatibility(item)).toBe(true)

    getState().removeCompatibility(item.id)

    expect(getState().compatibility.has(item.id)).toBe(false)
    expect(getState().descriptors.size).toBe(0)
    expect(getState().assets.size).toBe(0)
  })

  test('request-guarded removal cannot erase a newer relink generation', () => {
    const item = makeCompatibilityItem()
    expect(getState().startCompatibility(item)).toBe(true)

    expect(getState().removeCompatibility(item.id, 'stale-request')).toBe(false)
    expect(getState().compatibility.get(item.id)).toBe(item)
    expect(getState().removeCompatibility(item.id, item.requestId)).toBe(true)
    expect(getState().compatibility.has(item.id)).toBe(false)
  })

  test('disconnect, remove, replace, and clear discard session compatibility', () => {
    const start = (requestId: string) => {
      expect(getState().startCompatibility(makeCompatibilityItem({ requestId }))).toBe(true)
      expect(getState().compatibility.size).toBe(1)
    }

    start('disconnect-request')
    getState().disconnectAsset('candidate-1')
    expect(getState().compatibility.size).toBe(0)

    start('remove-request')
    getState().removeAsset('candidate-1')
    expect(getState().compatibility.size).toBe(0)

    start('replace-request')
    expect(getState().replaceAssets([], [])).toBe(true)
    expect(getState().compatibility.size).toBe(0)

    start('clear-request')
    getState().clearAssets()
    expect(getState().compatibility.size).toBe(0)
  })

  test('commits only complete analyzed assets and rejects duplicate ids', () => {
    const asset = makeAsset()

    expect(getState().addAsset(asset)).toBe(true)
    expect(getState().assets.get(asset.id)).toBe(asset)
    const before = getState().assets

    expect(getState().addAsset({ ...asset, objectUrl: 'blob:duplicate' })).toBe(false)
    expect(getState().assets).toBe(before)
    expect(getState().assets.get(asset.id)).toBe(asset)
  })

  test('committing an asset replaces the Map immutably', () => {
    const before = getState().assets
    getState().addAsset(makeAsset())
    expect(getState().assets).not.toBe(before)
  })

  test('disconnect keeps the durable descriptor and reconnect takes new ownership', () => {
    const first = makeAsset()
    expect(getState().addAsset(first)).toBe(true)

    getState().disconnectAsset(first.id)

    expect(getState().descriptors.get(first.id)).toEqual(descriptorFor(first))
    expect(getState().assets.has(first.id)).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first.objectUrl)

    const reconnected = { ...first, objectUrl: 'blob:reconnected' }
    expect(getState().connectAsset(reconnected)).toBe(true)
    expect(getState().assets.get(first.id)).toBe(reconnected)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(reconnected.objectUrl)
  })

  test('relink upgrades legacy unknown bounds without weakening exact matching', () => {
    const analyzed = makeAsset({ objectUrl: 'blob:analyzed' })
    const legacy = {
      ...descriptorFor(analyzed),
      sourceBounds: {
        video: { status: 'unknown' as const },
        audio: { status: 'unknown' as const },
      },
    }
    expect(getState().replaceAssets([legacy], [])).toBe(true)

    expect(getState().connectAsset({
      ...analyzed,
      sourceBounds: legacy.sourceBounds,
    })).toBe(false)

    expect(getState().connectAsset(analyzed)).toBe(true)
    expect(getState().descriptors.get(analyzed.id)?.sourceBounds).toEqual(
      analyzed.sourceBounds,
    )

    getState().disconnectAsset(analyzed.id)
    const changed = {
      ...analyzed,
      objectUrl: 'blob:changed-bounds',
      sourceBounds: {
        ...analyzed.sourceBounds,
        video: {
          status: 'exact' as const,
          firstTimestampUs: 1,
          endTimestampUs: 10_000_000,
        },
      },
    }
    expect(getState().connectAsset(changed)).toBe(false)
  })

  test('rejects a mismatched connection without taking its URL', () => {
    const first = makeAsset()
    getState().addAsset(first)
    getState().disconnectAsset(first.id)
    vi.mocked(URL.revokeObjectURL).mockClear()

    const mismatch = {
      ...first,
      objectUrl: 'blob:mismatch',
      size: first.size + 1,
    }
    expect(getState().connectAsset(mismatch)).toBe(false)
    expect(getState().assets.has(first.id)).toBe(false)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  test('keeps partial selection identical across descriptor, asset, and Ready report', () => {
    const projected = makeAsset({
      partialTrackSelection: 'video-only',
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    })
    expect(getState().addAsset(projected)).toBe(true)
    expect(getState().descriptors.get(projected.id)).toMatchObject({
      partialTrackSelection: 'video-only',
      hasAudio: false,
    })
    getState().disconnectAsset(projected.id)
    vi.mocked(URL.revokeObjectURL).mockClear()

    const restoredRawTracks = {
      ...projected,
      objectUrl: 'blob:restored-raw-tracks',
      partialTrackSelection: undefined,
      hasAudio: true,
      audioSampleRate: 48_000,
      audioChannels: 2,
    }
    expect(getState().connectAsset(restoredRawTracks)).toBe(false)

    const missingChoice = compatibilityForAsset(projected)
    expect(getState().connectAsset(projected, missingChoice)).toBe(false)

    const acceptedReport: MediaCompatibilityReport = {
      ...makeCompatibilityReport(),
      partialImport: { selection: 'video-only' },
    }
    const accepted = compatibilityForAsset(
      projected,
      'ready',
      acceptedReport,
    )
    expect(getState().connectAsset(projected, accepted)).toBe(true)
    expect(getState().compatibility.get(projected.id)).toBe(accepted)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  test('atomically replaces the catalog and connected subset', () => {
    const outgoing = makeAsset()
    getState().addAsset(outgoing)
    getState().setAssetVisuals(outgoing.id, {
      filmstrip: { url: 'blob:old-film', tiles: 1, tileWidth: 80, tileHeight: 45 },
      waveform: null,
    })
    const incoming = makeAsset({
      id: 'asset-2',
      fileName: 'camera.mp4',
      objectUrl: 'blob:incoming',
    })

    expect(getState().replaceAssets(
      [descriptorFor(incoming), descriptorFor(makeAsset({ id: 'offline' }))],
      [incoming],
    )).toBe(true)

    expect([...getState().descriptors.keys()]).toEqual(['asset-2', 'offline'])
    expect([...getState().assets.keys()]).toEqual(['asset-2'])
    expect(getState().visuals.size).toBe(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(outgoing.objectUrl)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-film')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(incoming.objectUrl)
  })

  test('atomically installs Resume compatibility for online and offline sources', () => {
    const online = makeAsset({ id: 'online' })
    const offline = makeAsset({ id: 'offline', fileName: 'offline.mov' })
    const ready = compatibilityForAsset(online)
    const unsupportedReport: MediaCompatibilityReport = {
      ...makeCompatibilityReport(),
      status: 'unsupported',
      reason: 'unsupported-codec',
      detail: 'ProRes is not supported natively.',
    }
    const unsupported = compatibilityForAsset(
      offline,
      'unsupported',
      unsupportedReport,
      'offline-request',
    )

    expect(getState().replaceAssets(
      [descriptorFor(online), descriptorFor(offline)],
      [online],
      [ready, unsupported],
    )).toBe(true)
    expect(getState().compatibility).toEqual(new Map([
      [online.id, ready],
      [offline.id, unsupported],
    ]))

    const before = getState()
    expect(getState().replaceAssets(
      [descriptorFor(online), descriptorFor(offline)],
      [online],
      [{ ...unsupported, status: 'ready', report: makeCompatibilityReport() }],
    )).toBe(false)
    expect(getState().descriptors).toBe(before.descriptors)
    expect(getState().assets).toBe(before.assets)
    expect(getState().compatibility).toBe(before.compatibility)
  })

  test('keeps connected Ready and offline Limited parity for a partial descriptor', () => {
    const partial = makeAsset({
      partialTrackSelection: 'audio-only',
      kind: 'audio',
      frameRate: null,
      width: null,
      height: null,
      decoderConfigB64: null,
    })
    const descriptor = descriptorFor(partial)
    const acceptedReport: MediaCompatibilityReport = {
      ...makeCompatibilityReport(),
      partialImport: { selection: 'audio-only' },
    }
    const ready = compatibilityForAsset(partial, 'ready', acceptedReport)

    expect(getState().replaceAssets([descriptor], [partial], [ready])).toBe(true)
    const connectedState = getState()
    expect(getState().replaceAssets([descriptor], [], [ready])).toBe(false)
    expect(getState().assets).toBe(connectedState.assets)
    expect(getState().compatibility).toBe(connectedState.compatibility)

    const limitedReport: MediaCompatibilityReport = {
      ...makeCompatibilityReport(),
      status: 'limited',
      reason: 'unsupported-codec',
      detail: 'The selected audio track cannot decode in this browser.',
    }
    const limited = compatibilityForAsset(
      partial,
      'limited',
      limitedReport,
      'partial-limited',
    )
    expect(getState().replaceAssets([descriptor], [], [limited])).toBe(true)
    expect(getState().assets.has(partial.id)).toBe(false)
    expect(getState().compatibility.get(partial.id)).toBe(limited)
    expect(getState().compatibility.get(partial.id)?.status).not.toBe('checking')
  })

  test('runtime failure disconnects only the exact URL and report generation', () => {
    const asset = makeAsset()
    const ready = compatibilityForAsset(asset)
    expect(getState().addAsset(asset)).toBe(true)
    expect(getState().setCompatibility(
      asset.id,
      ready.requestId,
      'ready',
      ready.report,
    )).toBe(false)
    // Install a Ready generation through the atomic reconnect seam.
    getState().disconnectAsset(asset.id)
    expect(getState().connectAsset(asset, ready)).toBe(true)
    vi.mocked(URL.revokeObjectURL).mockClear()

    const failureReport: MediaCompatibilityReport = {
      ...makeCompatibilityReport(),
      status: 'error',
      reason: 'decode-failed',
      detail: 'Preview failed: decoder stopped.',
    }
    const failed = compatibilityForAsset(
      asset,
      'error',
      failureReport,
      ready.requestId,
    )

    expect(getState().failAssetCompatibility(
      asset.id,
      'blob:stale',
      ready.requestId,
      failed,
    )).toBe(false)
    expect(getState().failAssetCompatibility(
      asset.id,
      asset.objectUrl,
      'stale-request',
      failed,
    )).toBe(false)
    expect(getState().assets.get(asset.id)).toBe(asset)

    expect(getState().failAssetCompatibility(
      asset.id,
      asset.objectUrl,
      ready.requestId,
      failed,
    )).toBe(true)
    expect(getState().assets.has(asset.id)).toBe(false)
    expect(getState().descriptors.get(asset.id)).toEqual(descriptorFor(asset))
    expect(getState().compatibility.get(asset.id)).toBe(failed)
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(asset.objectUrl)
    expect(getState().failAssetCompatibility(
      asset.id,
      asset.objectUrl,
      ready.requestId,
      failed,
    )).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  test('invalid replacement is a no-op and leaves incoming ownership with caller', () => {
    const outgoing = makeAsset()
    getState().addAsset(outgoing)
    const beforeDescriptors = getState().descriptors
    const beforeAssets = getState().assets
    const incoming = makeAsset({ id: 'incoming', objectUrl: 'blob:incoming' })

    expect(getState().replaceAssets([], [incoming])).toBe(false)

    expect(getState().descriptors).toBe(beforeDescriptors)
    expect(getState().assets).toBe(beforeAssets)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(incoming.objectUrl)
  })

  test('reconforms every asset from canonical duration and preserves no-op identity', () => {
    getState().addAsset(makeAsset())
    getState().addAsset(makeAsset({
      id: 'asset-2',
      objectUrl: 'blob:asset-2',
      durationFrames: 150,
      durationMicroseconds: 5_000_000,
    }))
    getState().addAsset(makeAsset({
      id: 'asset-short',
      objectUrl: 'blob:asset-short',
      durationFrames: 1,
      durationMicroseconds: 1,
    }))

    getState().reconformAssets({ num: 60, den: 1 })
    expect(getState().assets.get('asset-1')?.durationFrames).toBe(600)
    expect(getState().assets.get('asset-2')?.durationFrames).toBe(300)
    expect(getState().assets.get('asset-short')?.durationFrames).toBe(1)

    const conformed = getState().assets
    getState().reconformAssets({ num: 60, den: 1 })
    expect(getState().assets).toBe(conformed)
  })

  test('removeAsset revokes the source URL and drops the entry', () => {
    const asset = makeAsset()
    getState().addAsset(asset)
    getState().removeAsset(asset.id)

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(asset.objectUrl)
    expect(getState().assets.has(asset.id)).toBe(false)
  })

  test('clearAssets revokes every source and visual exactly once', () => {
    const first = makeAsset()
    const second = makeAsset({
      id: 'asset-2',
      objectUrl: 'blob:asset-2',
    })
    getState().addAsset(first)
    getState().addAsset(second)
    getState().setAssetVisuals(first.id, {
      filmstrip: { url: 'blob:film', tiles: 3, tileWidth: 80, tileHeight: 45 },
      waveform: { url: 'blob:wave', width: 1000, height: 64 },
    })

    getState().clearAssets()

    expect(getState().assets.size).toBe(0)
    expect(getState().visuals.size).toBe(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:asset-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:asset-2')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:film')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:wave')
  })

  test('clearAssets preserves empty-state identity', () => {
    const assets = getState().assets
    const visuals = getState().visuals
    getState().clearAssets()
    expect(getState().assets).toBe(assets)
    expect(getState().visuals).toBe(visuals)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  test('removing an unknown id is a safe no-op', () => {
    const before = getState().assets
    getState().removeAsset('missing')
    expect(getState().assets).toBe(before)
  })

  test('setAssetVisuals stores; removeAsset revokes both generated URLs', () => {
    const asset = makeAsset()
    getState().addAsset(asset)
    getState().setAssetVisuals(asset.id, {
      filmstrip: { url: 'blob:film', tiles: 3, tileWidth: 80, tileHeight: 45 },
      waveform: { url: 'blob:wave', width: 1000, height: 64 },
    })

    expect(getState().visuals.has(asset.id)).toBe(true)
    getState().removeAsset(asset.id)

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:film')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:wave')
    expect(getState().visuals.has(asset.id)).toBe(false)
  })

  test('a late visual result for a removed asset is revoked, never stored', () => {
    getState().setAssetVisuals('gone', {
      filmstrip: { url: 'blob:late-film', tiles: 1, tileWidth: 80, tileHeight: 45 },
      waveform: { url: 'blob:late-wave', width: 100, height: 40 },
    })

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-film')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-wave')
    expect(getState().visuals.size).toBe(0)
  })

  test('replacing visuals revokes the previous images', () => {
    const asset = makeAsset()
    getState().addAsset(asset)
    getState().setAssetVisuals(asset.id, {
      filmstrip: { url: 'blob:old-film', tiles: 1, tileWidth: 80, tileHeight: 45 },
      waveform: null,
    })
    getState().setAssetVisuals(asset.id, {
      filmstrip: { url: 'blob:new-film', tiles: 1, tileWidth: 80, tileHeight: 45 },
      waveform: null,
    })

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-film')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:new-film')
  })

  test('null visual halves revoke nothing extra', () => {
    const asset = makeAsset({ kind: 'audio', frameRate: null, width: null, height: null })
    getState().addAsset(asset)
    getState().setAssetVisuals(asset.id, { filmstrip: null, waveform: null })
    getState().removeAsset(asset.id)

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(asset.objectUrl)
  })
})
