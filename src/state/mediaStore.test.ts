/**
 * state/mediaStore.test.ts — Phase 1.3.
 *
 * jsdom does not implement blob URLs, so URL.createObjectURL/revokeObjectURL
 * are stubbed here — which also lets us assert revocation on removal.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useMediaStore } from './mediaStore'

const getState = () => useMediaStore.getState()

let createSpy: ReturnType<typeof vi.fn>
let revokeSpy: ReturnType<typeof vi.fn>
let urlCounter = 0

beforeEach(() => {
  urlCounter = 0
  createSpy = vi.fn(() => `blob:mock-${++urlCounter}`)
  revokeSpy = vi.fn()
  URL.createObjectURL = createSpy as typeof URL.createObjectURL
  URL.revokeObjectURL = revokeSpy as typeof URL.revokeObjectURL
  useMediaStore.setState({ assets: new Map(), visuals: new Map() })
})

describe('mediaStore', () => {
  test('addAsset registers a placeholder with id, name, url and kind', () => {
    const file = new File(['x'], 'holiday.mp4', { type: 'video/mp4' })
    const asset = getState().addAsset(file)

    expect(asset.id).toMatch(/^asset_/)
    expect(asset.fileName).toBe('holiday.mp4')
    expect(asset.objectUrl).toBe('blob:mock-1')
    expect(asset.kind).toBe('video')
    expect(asset.durationFrames).toBe(0) // placeholder until Phase 2
    expect(asset.decoderConfigB64).toBeNull()
    expect(getState().assets.get(asset.id)).toBe(asset)
  })

  test('kind is derived from MIME type', () => {
    expect(
      getState().addAsset(new File([], 'a.mp3', { type: 'audio/mpeg' })).kind,
    ).toBe('audio')
    expect(
      getState().addAsset(new File([], 'b.png', { type: 'image/png' })).kind,
    ).toBe('image')
    expect(getState().addAsset(new File([], 'c.bin')).kind).toBe('video')
  })

  test('updates are immutable: a new Map instance per change', () => {
    const before = getState().assets
    getState().addAsset(new File([], 'a.mp4', { type: 'video/mp4' }))
    expect(getState().assets).not.toBe(before)
  })

  test('removeAsset revokes the object URL and drops the entry', () => {
    const a = getState().addAsset(new File([], 'a.mp4', { type: 'video/mp4' }))
    const b = getState().addAsset(new File([], 'b.mp4', { type: 'video/mp4' }))

    getState().removeAsset(a.id)
    expect(revokeSpy).toHaveBeenCalledWith(a.objectUrl)
    expect(getState().assets.has(a.id)).toBe(false)
    expect(getState().assets.has(b.id)).toBe(true)
  })

  test('removing an unknown id is a safe no-op', () => {
    const before = getState().assets
    getState().removeAsset('asset_nope')
    expect(revokeSpy).not.toHaveBeenCalled()
    expect(getState().assets).toBe(before)
  })

  test('updateAsset merges demux results without touching id/objectUrl', () => {
    const a = getState().addAsset(new File([], 'a.mp4', { type: 'video/mp4' }))
    getState().updateAsset(a.id, {
      durationFrames: 412,
      frameRate: { num: 60, den: 1 },
      width: 1920,
      height: 1080,
    })
    const updated = getState().assets.get(a.id)
    expect(updated).toMatchObject({
      id: a.id,
      objectUrl: a.objectUrl,
      fileName: 'a.mp4',
      durationFrames: 412,
      frameRate: { num: 60, den: 1 },
      width: 1920,
    })
    // New Map identity so subscribers fire.
    expect(getState().assets).not.toBe(new Map())
  })

  test('updateAsset on an unknown id is a safe no-op', () => {
    const before = getState().assets
    getState().updateAsset('asset_nope', { durationFrames: 10 })
    expect(getState().assets).toBe(before)
  })
})

describe('asset visuals (filmstrip/waveform images)', () => {
  const visualsFor = (n: number) => ({
    filmstrip: { url: `blob:strip-${n}`, tiles: 8, tileWidth: 78, tileHeight: 44 },
    waveform: { url: `blob:wave-${n}`, width: 800, height: 44 },
  })

  test('setAssetVisuals stores; removeAsset revokes BOTH image URLs', () => {
    const a = getState().addAsset(new File([], 'a.mp4', { type: 'video/mp4' }))
    getState().setAssetVisuals(a.id, visualsFor(1))
    expect(getState().visuals.get(a.id)?.filmstrip?.url).toBe('blob:strip-1')

    getState().removeAsset(a.id)
    expect(revokeSpy).toHaveBeenCalledWith('blob:strip-1')
    expect(revokeSpy).toHaveBeenCalledWith('blob:wave-1')
    expect(getState().visuals.has(a.id)).toBe(false)
  })

  test('a late result for a removed asset is revoked, never stored', () => {
    getState().setAssetVisuals('asset_gone', visualsFor(2))
    expect(revokeSpy).toHaveBeenCalledWith('blob:strip-2')
    expect(revokeSpy).toHaveBeenCalledWith('blob:wave-2')
    expect(getState().visuals.size).toBe(0)
  })

  test('replacing visuals revokes the previous images', () => {
    const a = getState().addAsset(new File([], 'a.mp4', { type: 'video/mp4' }))
    getState().setAssetVisuals(a.id, visualsFor(3))
    getState().setAssetVisuals(a.id, visualsFor(4))
    expect(revokeSpy).toHaveBeenCalledWith('blob:strip-3')
    expect(revokeSpy).toHaveBeenCalledWith('blob:wave-3')
    expect(getState().visuals.get(a.id)?.waveform?.url).toBe('blob:wave-4')
  })

  test('null halves (audio-only / silent video) revoke nothing extra', () => {
    const a = getState().addAsset(new File([], 'a.mp3', { type: 'audio/mpeg' }))
    getState().setAssetVisuals(a.id, {
      filmstrip: null,
      waveform: { url: 'blob:wave-9', width: 400, height: 44 },
    })
    getState().removeAsset(a.id)
    expect(revokeSpy).toHaveBeenCalledWith('blob:wave-9')
    expect(revokeSpy).toHaveBeenCalledTimes(2) // objectUrl + waveform only
  })
})
