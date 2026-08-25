/**
 * Source Monitor open facade: catalog lookup, no project mutation, and
 * Media Pool selection for the command/shortcut path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'
import type { MediaAsset } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'
import {
  clearSelectedPoolAssetId,
  getSelectedPoolAssetId,
  openSelectedSource,
  openSourceAsset,
  setSelectedPoolAssetId,
  sourceMonitorOpenRejectionMessage,
  sourceOpenDisabledReason,
} from './sourceMonitorController'

function makeAsset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-source',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 300,
    durationMicroseconds: 10_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...over,
  }
}

function compatibility(
  over: Partial<MediaCompatibilityItem> = {},
): MediaCompatibilityItem {
  return {
    id: 'asset-source',
    requestId: 'req-source',
    fileName: 'clip.mp4',
    declaredMimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    status: 'ready',
    report: null,
    ...over,
  }
}

function seed(asset: MediaAsset, item?: MediaCompatibilityItem): void {
  useMediaStore.setState({
    descriptors: new Map([[asset.id, {
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.size,
      lastModified: asset.lastModified,
      kind: asset.kind,
      durationMicroseconds: asset.durationMicroseconds,
      sourceBounds: asset.sourceBounds,
      nativeFrameRate: asset.frameRate,
      width: asset.width,
      height: asset.height,
      hasAudio: asset.hasAudio,
      audioSampleRate: asset.audioSampleRate,
      audioChannels: asset.audioChannels,
    }]]),
    assets: new Map([[asset.id, asset]]),
    visuals: new Map(),
    compatibility: item ? new Map([[asset.id, item]]) : new Map(),
  })
}

beforeEach(() => {
  clearSelectedPoolAssetId()
  useSourceMonitorStore.getState().resetSourceMonitor()
  useTransportStore.getState().resetTransport()
  useTransportStore.getState().setPlayheadFrame(48)
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
})

afterEach(() => {
  clearSelectedPoolAssetId()
  useSourceMonitorStore.getState().resetSourceMonitor()
})

describe('sourceMonitorController', () => {
  test('opens a connected ready asset without seeking Program or mutating the document', () => {
    const asset = makeAsset()
    seed(asset, compatibility())
    const document = useDocumentStore.getState().doc

    const result = openSourceAsset(asset.id)

    expect(result.status).toBe('ok')
    expect(useSourceMonitorStore.getState().session?.source).toMatchObject({
      assetId: 'asset-source',
      fileName: 'clip.mp4',
      durationFrames: 300,
    })
    expect(useSourceMonitorStore.getState().lastOpenRejection).toBeNull()
    expect(useTransportStore.getState().playheadFrame).toBe(48)
    expect(useDocumentStore.getState().doc).toBe(document)
  })

  test('opens the selected Media Pool asset through the command seam', () => {
    const asset = makeAsset()
    seed(asset, compatibility())
    setSelectedPoolAssetId(asset.id)
    expect(getSelectedPoolAssetId()).toBe(asset.id)
    expect(sourceOpenDisabledReason()).toBeNull()

    const result = openSelectedSource()

    expect(result.status).toBe('ok')
    expect(useSourceMonitorStore.getState().session?.source.assetId).toBe(asset.id)
  })

  test('rejects offline, incompatible, and missing selection with existing remediation copy', () => {
    expect(sourceOpenDisabledReason()).toBe('Select a Media Pool asset first.')
    expect(openSelectedSource().status).toBe('rejected')

    const offline = makeAsset()
    useMediaStore.setState({
      descriptors: new Map([[offline.id, {
        id: offline.id,
        fileName: offline.fileName,
        mimeType: offline.mimeType,
        size: offline.size,
        lastModified: offline.lastModified,
        kind: offline.kind,
        durationMicroseconds: offline.durationMicroseconds,
        sourceBounds: offline.sourceBounds,
        nativeFrameRate: offline.frameRate,
        width: offline.width,
        height: offline.height,
        hasAudio: offline.hasAudio,
        audioSampleRate: offline.audioSampleRate,
        audioChannels: offline.audioChannels,
      }]]),
      assets: new Map(),
      visuals: new Map(),
      compatibility: new Map(),
    })
    expect(sourceOpenDisabledReason(offline.id)).toBe(
      sourceMonitorOpenRejectionMessage('offline'),
    )
    expect(openSourceAsset(offline.id)).toMatchObject({
      status: 'rejected',
      reason: 'offline',
    })
    expect(useSourceMonitorStore.getState().lastOpenRejection).toBe('offline')
    expect(useTransportStore.getState().playheadFrame).toBe(48)

    seed(makeAsset(), compatibility({ status: 'unsupported' }))
    expect(sourceOpenDisabledReason('asset-source')).toBe(
      sourceMonitorOpenRejectionMessage('incompatible'),
    )
    expect(openSourceAsset('asset-source')).toMatchObject({
      status: 'rejected',
      reason: 'incompatible',
    })
    expect(useSourceMonitorStore.getState().session).toBeNull()
  })
})
