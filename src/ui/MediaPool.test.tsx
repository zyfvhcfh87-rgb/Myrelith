/**
 * ui/MediaPool.test.tsx — Media Pool card presentation.
 *
 * The existing visuals controller generates one full-source filmstrip per
 * video. MediaPool reuses its first tile as a representative thumbnail and
 * keeps import, metadata, removal, and drag-readiness behavior intact.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  canRememberImportedMedia,
  chooseMediaForImport,
  forgetImportedMediaHandle,
  importMedia,
} from '../app/mediaImportController'
import {
  canChooseActiveMediaFolder,
  chooseActiveAssetMedia,
  chooseActiveMediaFolder,
  connectActiveAssetMedia,
} from '../app/projectController'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { INITIAL_MEDIA_IMPORT_STATE, useMediaImportStore } from '../state/mediaImportStore'
import type { AssetVisuals } from '../state/mediaStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_ACTIVE_MEDIA_RELINK,
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import MediaPool from './MediaPool'

vi.mock('../app/mediaImportController', () => ({
  canRememberImportedMedia: vi.fn(() => false),
  chooseMediaForImport: vi.fn(async () => ({
    status: 'imported',
    assetId: 'mock',
  })),
  forgetImportedMediaHandle: vi.fn(),
  importMedia: vi.fn(async () => ({ status: 'imported', assetId: 'mock' })),
  cancelMediaImport: vi.fn(),
  dismissMediaImportError: vi.fn(),
  resolveMediaImportDecision: vi.fn(),
}))

vi.mock('../app/projectController', () => ({
  canChooseActiveMediaFolder: vi.fn(() => false),
  chooseActiveAssetMedia: vi.fn(async () => ({ status: 'ready' })),
  chooseActiveMediaFolder: vi.fn(async () => ({ status: 'ready' })),
  connectActiveAssetMedia: vi.fn(async () => ({ status: 'ready' })),
  resolveActiveMediaAmbiguity: vi.fn(async () => ({ status: 'ready' })),
  skipActiveMediaAmbiguity: vi.fn(async () => ({ status: 'ready' })),
  cancelActiveMediaRelink: vi.fn(),
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
    const descriptors = new Map(state.descriptors)
    descriptors.set(asset.id, descriptorFromAsset(asset))
    const assets = new Map(state.assets)
    assets.set(asset.id, asset)
    const visuals = new Map(state.visuals)
    if (assetVisuals) visuals.set(asset.id, assetVisuals)
    return { descriptors, assets, visuals }
  })
}

function descriptorFromAsset(asset: MediaAsset): PortableAssetDescriptor {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    durationMicroseconds: asset.durationMicroseconds,
    nativeFrameRate: asset.frameRate,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
  }
}

function seedOfflineDescriptor(
  descriptor: PortableAssetDescriptor = descriptorFromAsset(makeAsset()),
): void {
  useMediaStore.setState({
    descriptors: new Map([[descriptor.id, descriptor]]),
    assets: new Map(),
    visuals: new Map(),
  })
}

beforeEach(() => {
  let urlCount = 0
  URL.createObjectURL = vi.fn(
    () => `blob:import-${++urlCount}`,
  ) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
  })
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
    activeProjectName: 'Test project',
    activeMediaRelink: INITIAL_ACTIVE_MEDIA_RELINK,
  })
  vi.mocked(importMedia).mockClear()
  vi.mocked(chooseMediaForImport).mockClear()
  vi.mocked(forgetImportedMediaHandle).mockClear()
  vi.mocked(canRememberImportedMedia).mockReturnValue(false)
  vi.mocked(canChooseActiveMediaFolder).mockReset()
  vi.mocked(canChooseActiveMediaFolder).mockReturnValue(false)
  vi.mocked(chooseActiveAssetMedia).mockClear()
  vi.mocked(chooseActiveMediaFolder).mockClear()
  vi.mocked(connectActiveAssetMedia).mockClear()
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

  test('supporting browsers import through the reusable-handle picker', () => {
    vi.mocked(canRememberImportedMedia).mockReturnValue(true)
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(chooseMediaForImport).toHaveBeenCalledOnce()
    expect(screen.queryByLabelText('Import media')).not.toBeInTheDocument()
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

    expect(forgetImportedMediaHandle).toHaveBeenCalledWith('asset-9')
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

  test('keeps an offline descriptor visible, non-draggable, and directly relinkable', () => {
    seedOfflineDescriptor()
    vi.mocked(canRememberImportedMedia).mockReturnValue(true)
    render(<MediaPool />)

    const card = screen.getByTitle('beach.mp4')
    expect(card).toHaveAttribute('data-connection', 'offline')
    expect(card).toHaveAttribute('draggable', 'false')
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.getByTestId('media-thumbnail-asset-9')).toHaveAttribute(
      'data-state',
      'offline',
    )
    const setData = vi.fn()
    fireEvent.dragStart(card, {
      dataTransfer: { setData, effectAllowed: 'none' },
    })
    expect(setData).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Relink beach.mp4' }))
    expect(chooseActiveAssetMedia).toHaveBeenCalledWith('asset-9')
  })

  test('falls back to an ordinary per-source file input', () => {
    seedOfflineDescriptor()
    render(<MediaPool />)
    const file = new File(['source'], 'beach.mp4', { type: 'video/mp4' })

    fireEvent.change(screen.getByLabelText('Relink beach.mp4'), {
      target: { files: [file] },
    })

    expect(connectActiveAssetMedia).toHaveBeenCalledWith('asset-9', file)
  })

  test('offers one folder scan while offline sources exist', () => {
    seedOfflineDescriptor()
    vi.mocked(canChooseActiveMediaFolder).mockReturnValue(true)
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', { name: 'Scan folder' }))

    expect(chooseActiveMediaFolder).toHaveBeenCalledOnce()
  })

  test('shows folder scan progress, completion counts, and errors', () => {
    seedOfflineDescriptor()
    useProjectSessionStore.setState({
      activeMediaRelink: {
        phase: 'scanning',
        scannedFileCount: 3,
        connectedCount: 1,
        skippedCount: 0,
        errors: [],
        ambiguity: null,
      },
    })
    render(<MediaPool />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Scanning 3 source files',
    )

    act(() => {
      useProjectSessionStore.setState({
        activeMediaRelink: {
          phase: 'complete',
          scannedFileCount: 3,
          connectedCount: 2,
          skippedCount: 1,
          errors: ['One source could not be inspected.'],
          ambiguity: null,
        },
      })
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Relink finished · 2 connected · 1 skipped',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'One source could not be inspected.',
    )
  })
})
