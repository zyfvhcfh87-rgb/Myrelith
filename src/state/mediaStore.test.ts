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
  useMediaStore.setState({ assets: new Map() })
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
})
