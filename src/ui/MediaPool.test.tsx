/**
 * ui/MediaPool.test.tsx — Media Pool card presentation.
 *
 * The existing visuals controller generates one full-source filmstrip per
 * video. MediaPool reuses its first tile as a representative thumbnail and
 * keeps import, metadata, removal, and drag-readiness behavior intact.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaAsset } from '../domain/schema'
import type { AssetVisuals } from '../state/mediaStore'
import { useMediaStore } from '../state/mediaStore'
import MediaPool from './MediaPool'

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-9',
    fileName: 'beach.mp4',
    objectUrl: 'blob:video',
    kind: 'video',
    durationFrames: 120,
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...overrides,
  }
}

function seedAsset(asset: MediaAsset, assetVisuals?: AssetVisuals): void {
  useMediaStore.setState((state) => {
    const assets = new Map(state.assets)
    assets.set(asset.id, asset)
    const visuals = new Map(state.visuals)
    if (assetVisuals) visuals.set(asset.id, assetVisuals)
    return { assets, visuals }
  })
}

beforeEach(() => {
  let urlCount = 0
  URL.createObjectURL = vi.fn(
    () => `blob:import-${++urlCount}`,
  ) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  useMediaStore.setState({ assets: new Map(), visuals: new Map() })
})

describe('MediaPool presentation', () => {
  test('renders the Media header and imports through the labeled control', () => {
    render(<MediaPool />)

    expect(screen.getByRole('heading', { name: 'Media' })).toBeInTheDocument()
    const input = screen.getByLabelText('Import media')
    const file = new File(['video'], 'fresh.mp4', { type: 'video/mp4' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(screen.getByTitle('fresh.mp4')).toBeInTheDocument()
    expect(useMediaStore.getState().assets.size).toBe(1)
  })

  test('shows a placeholder while preserving ready metadata and drag state', () => {
    seedAsset(makeAsset())
    render(<MediaPool />)

    const card = screen.getByTitle('beach.mp4')
    expect(card).toHaveAttribute('draggable', 'true')
    expect(screen.getByText('1920×1080 · 00:00:04:00')).toBeInTheDocument()
    expect(screen.getByTestId('media-thumbnail-asset-9')).toHaveAttribute(
      'data-state',
      'placeholder',
    )
  })

  test('crops the first tile from the existing filmstrip', () => {
    seedAsset(makeAsset(), {
      filmstrip: {
        url: 'blob:filmstrip',
        tiles: 4,
        tileWidth: 78,
        tileHeight: 44,
      },
      waveform: null,
    })
    render(<MediaPool />)

    const thumbnail = screen.getByTestId('media-thumbnail-asset-9')
    expect(thumbnail).toHaveAttribute('data-state', 'ready')
    expect(thumbnail.getAttribute('style')).toContain('blob:filmstrip')
    expect(thumbnail).toHaveStyle({ backgroundSize: '400% auto' })
  })

  test('removes an asset from its card control', () => {
    seedAsset(makeAsset())
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', { name: 'remove beach.mp4' }))

    expect(screen.queryByTitle('beach.mp4')).not.toBeInTheDocument()
    expect(useMediaStore.getState().assets.size).toBe(0)
  })
})
