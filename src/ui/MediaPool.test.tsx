/**
 * ui/MediaPool.test.tsx — Media Pool card presentation.
 *
 * The existing visuals controller generates one full-source filmstrip per
 * video. MediaPool reuses its first tile as a representative thumbnail and
 * keeps import, metadata, removal, and drag-readiness behavior intact.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { importMedia } from '../app/mediaImportController'
import type { MediaAsset } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { INITIAL_MEDIA_IMPORT_STATE, useMediaImportStore } from '../state/mediaImportStore'
import type { AssetVisuals } from '../state/mediaStore'
import { useMediaStore } from '../state/mediaStore'
import MediaPool from './MediaPool'

vi.mock('../app/mediaImportController', () => ({
  importMedia: vi.fn(async () => ({ status: 'imported', assetId: 'mock' })),
  cancelMediaImport: vi.fn(),
  dismissMediaImportError: vi.fn(),
  resolveMediaImportDecision: vi.fn(),
}))

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-9',
    fileName: 'beach.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:video',
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 4_000_000,
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
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
  vi.mocked(importMedia).mockClear()
  useDocumentStore.getState().setDoc({
    ...useDocumentStore.getState().doc,
    frameRate: { num: 30, den: 1 },
  })
})

describe('MediaPool presentation', () => {
  test('renders the Media header and delegates the selected File to the import controller', () => {
    render(<MediaPool />)

    expect(screen.getByRole('heading', { name: 'Media' })).toBeInTheDocument()
    const input = screen.getByLabelText('Import media')
    const file = new File(['video'], 'fresh.mp4', { type: 'video/mp4' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(importMedia).toHaveBeenCalledOnce()
    expect(importMedia).toHaveBeenCalledWith(file)
    expect(useMediaStore.getState().assets.size).toBe(0)
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

  test('formats conformed duration on the document timebase', () => {
    seedAsset(makeAsset({
      durationFrames: 300,
      durationMicroseconds: 10_000_000,
      frameRate: { num: 60, den: 1 },
    }))
    render(<MediaPool />)

    expect(screen.getByText('1920\u00d71080 \u00b7 00:00:10:00')).toBeInTheDocument()
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

  test('shows completed audio metadata instead of an analysis placeholder', () => {
    seedAsset(makeAsset({
      id: 'audio-1',
      fileName: 'dialogue.wav',
      mimeType: 'audio/wav',
      kind: 'audio',
      frameRate: null,
      width: null,
      height: null,
      decoderConfigB64: null,
    }))
    render(<MediaPool />)

    expect(screen.getByText('48 kHz · 00:00:04:00')).toBeInTheDocument()
    expect(screen.queryByText('analyzing…')).not.toBeInTheDocument()
  })

  test('removes an asset from its card control', () => {
    seedAsset(makeAsset())
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', { name: 'remove beach.mp4' }))

    expect(screen.queryByTitle('beach.mp4')).not.toBeInTheDocument()
    expect(useMediaStore.getState().assets.size).toBe(0)
  })

  test('refuses to remove a source that is still used by a timeline clip', () => {
    const asset = makeAsset()
    seedAsset(asset)
    const document = useDocumentStore.getState().doc
    const videoTrack = document.tracks.find((track) => track.kind === 'video')
    if (!videoTrack) throw new Error('video track fixture missing')
    useDocumentStore.getState().setDoc({
      ...document,
      tracks: document.tracks.map((track) => (
        track.id === videoTrack.id
          ? {
              ...track,
              clips: [{
                id: 'clip-used-source',
                assetId: asset.id,
                name: asset.fileName,
                sourceRange: { startFrame: 0, durationFrames: 30 },
                timelineRange: { startFrame: 0, durationFrames: 30 },
                transform: {
                  x: 0,
                  y: 0,
                  scaleX: 1,
                  scaleY: 1,
                  rotation: 0,
                  anchorX: 0.5,
                  anchorY: 0.5,
                },
                opacity: 1,
                volume: 1,
                effects: [],
              }],
            }
          : track
      )),
    })
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', { name: 'remove beach.mp4' }))

    expect(alert).toHaveBeenCalledWith(
      'Remove this media\'s clips from the timeline before removing its source.',
    )
    expect(useMediaStore.getState().assets.get(asset.id)).toBe(asset)
  })
})
