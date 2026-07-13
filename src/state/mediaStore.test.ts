import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaAsset } from '../domain/schema'
import { useMediaStore } from './mediaStore'

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    fileName: 'holiday.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:asset-1',
    kind: 'video',
    durationFrames: 300,
    durationMicroseconds: 10_000_000,
    frameRate: { num: 60, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...overrides,
  }
}

const getState = () => useMediaStore.getState()

beforeEach(() => {
  useMediaStore.setState({ assets: new Map(), visuals: new Map() })
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
})

describe('mediaStore', () => {
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

  test('reconforms every asset from canonical duration and preserves no-op identity', () => {
    getState().addAsset(makeAsset())
    getState().addAsset(makeAsset({
      id: 'asset-2',
      objectUrl: 'blob:asset-2',
      durationFrames: 150,
      durationMicroseconds: 5_000_000,
    }))

    getState().reconformAssets({ num: 60, den: 1 })
    expect(getState().assets.get('asset-1')?.durationFrames).toBe(600)
    expect(getState().assets.get('asset-2')?.durationFrames).toBe(300)

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
