/**
 * ui/MediaPool.test.tsx — Media Pool card presentation.
 *
 * The existing visuals controller generates one full-source filmstrip per
 * video. MediaPool reuses its first tile as a representative thumbnail and
 * keeps import, metadata, removal, and drag-readiness behavior intact.
 */

import {
  Profiler,
  type ProfilerOnRenderCallback,
} from 'react'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  acceptPartialMediaImport,
  canRememberImportedMedia,
  chooseMediaForImport,
  forgetImportedMediaHandle,
  importMediaFiles,
  removeMediaCompatibility,
  retryMediaCompatibility,
} from '../app/mediaImportController'
import {
  canChooseActiveMediaFolder,
  chooseActiveAssetMedia,
  chooseActiveMediaFolder,
  connectActiveAssetMedia,
  connectActiveMediaFolderFiles,
} from '../app/projectController'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import {
  withMediaRuntimeFailure,
  type MediaCompatibilityItem,
  type MediaCompatibilityReport,
  type MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
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
import {
  INITIAL_PREFERENCES_STATE,
  usePreferencesStore,
} from '../state/preferencesStore'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'
import MediaPool from './MediaPool'

vi.mock('../app/mediaImportController', () => ({
  acceptPartialMediaImport: vi.fn(async () => ({
    status: 'imported',
    assetId: 'asset-9',
  })),
  canRememberImportedMedia: vi.fn(() => false),
  chooseMediaForImport: vi.fn(async () => ({
    status: 'imported',
    assetId: 'mock',
  })),
  forgetImportedMediaHandle: vi.fn(),
  importMediaFiles: vi.fn(async () => ({
    status: 'batch-complete',
    results: [{ status: 'imported', assetId: 'mock' }],
  })),
  removeMediaCompatibility: vi.fn(() => true),
  retryMediaCompatibility: vi.fn(async () => ({
    status: 'imported',
    assetId: 'mock',
  })),
  cancelMediaImport: vi.fn(),
  dismissMediaImportError: vi.fn(),
  resolveMediaImportDecision: vi.fn(),
}))

vi.mock('../app/projectController', () => ({
  canChooseActiveMediaFolder: vi.fn(() => false),
  chooseActiveAssetMedia: vi.fn(async () => ({ status: 'ready' })),
  chooseActiveMediaFolder: vi.fn(async () => ({ status: 'ready' })),
  connectActiveAssetMedia: vi.fn(async () => ({ status: 'ready' })),
  connectActiveMediaFolderFiles: vi.fn(async () => ({ status: 'ready' })),
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
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
    },
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

function makeTrack(
  overrides: Partial<MediaTrackCompatibility> = {},
): MediaTrackCompatibility {
  return {
    kind: 'video',
    number: 1,
    primary: true,
    codec: 'avc',
    codecParameter: 'avc1.640028',
    internalCodecId: 'avc1',
    decoderConfig: {
      codec: 'avc1.640028',
      descriptionBytes: 4,
      codedWidth: 1920,
      codedHeight: 1080,
      sampleRate: null,
      channels: null,
    },
    decoderPath: 'native',
    decodable: true,
    reason: null,
    detail: null,
    width: 1920,
    height: 1080,
    codedWidth: 1920,
    codedHeight: 1080,
    frameRate: { num: 30, den: 1 },
    sampleRate: null,
    channels: null,
    ...overrides,
  }
}

function makeReport(
  status: MediaCompatibilityReport['status'] = 'ready',
  overrides: Partial<MediaCompatibilityReport> = {},
): MediaCompatibilityReport {
  return {
    status,
    container: {
      name: 'MPEG-4 Part 14',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    },
    durationMicroseconds: 4_000_000,
    tracks: [
      makeTrack(),
      makeTrack({
        kind: 'audio',
        codec: 'aac',
        codecParameter: 'mp4a.40.2',
        internalCodecId: 'mp4a',
        decoderConfig: {
          codec: 'mp4a.40.2',
          descriptionBytes: 0,
          codedWidth: null,
          codedHeight: null,
          sampleRate: 48_000,
          channels: 2,
        },
        width: null,
        height: null,
        codedWidth: null,
        codedHeight: null,
        frameRate: null,
        sampleRate: 48_000,
        channels: 2,
      }),
    ],
    reason: null,
    detail: null,
    ...overrides,
  }
}

function makeCompatibility(
  overrides: Partial<MediaCompatibilityItem> = {},
): MediaCompatibilityItem {
  return {
    id: 'asset-9',
    requestId: 'request-1',
    fileName: 'beach.mp4',
    declaredMimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    status: 'checking',
    report: null,
    ...overrides,
  }
}

function seedCompatibility(item: MediaCompatibilityItem): void {
  useMediaStore.setState({ compatibility: new Map([[item.id, item]]) })
}

function seedVideoOnlyCandidate(): void {
  const failedAudio = makeTrack({
    kind: 'audio',
    codec: 'prores-audio',
    codecParameter: 'apac',
    internalCodecId: 'apac',
    decoderConfig: null,
    decodable: false,
    reason: 'unsupported-codec',
    detail: 'This browser cannot decode this audio codec.',
    width: null,
    height: null,
    codedWidth: null,
    codedHeight: null,
    frameRate: null,
    sampleRate: 48_000,
    channels: 2,
  })
  seedCompatibility(makeCompatibility({
    status: 'limited',
    report: makeReport('limited', {
      tracks: [makeTrack(), failedAudio],
      reason: 'unsupported-codec',
      detail: 'Some media tracks are not usable in this browser.',
    }),
  }))
}

function seedAudioOnlyCandidate(): void {
  const failedVideo = makeTrack({
    decodable: false,
    reason: 'unsupported-codec',
    detail: 'This browser cannot decode this video codec.',
  })
  const usableAudio = makeTrack({
    kind: 'audio',
    codec: 'aac',
    codecParameter: 'mp4a.40.2',
    internalCodecId: 'mp4a',
    decoderConfig: {
      codec: 'mp4a.40.2',
      descriptionBytes: 0,
      codedWidth: null,
      codedHeight: null,
      sampleRate: 48_000,
      channels: 2,
    },
    width: null,
    height: null,
    codedWidth: null,
    codedHeight: null,
    frameRate: null,
    sampleRate: 48_000,
    channels: 2,
  })
  seedCompatibility(makeCompatibility({
    status: 'limited',
    report: makeReport('limited', {
      tracks: [failedVideo, usableAudio],
      reason: 'unsupported-codec',
      detail: 'Some media tracks are not usable in this browser.',
    }),
  }))
}

function descriptorFromAsset(asset: MediaAsset): PortableAssetDescriptor {
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

function seedOfflineDescriptor(
  descriptor: PortableAssetDescriptor = descriptorFromAsset(makeAsset()),
): void {
  useMediaStore.setState({
    descriptors: new Map([[descriptor.id, descriptor]]),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
}

function seedLargeCatalog(count: number, connected: boolean): void {
  const descriptors = new Map<string, PortableAssetDescriptor>()
  const assets = new Map<string, MediaAsset>()
  for (let index = 0; index < count; index++) {
    const kind = index % 3 === 0
      ? 'video'
      : index % 3 === 1 ? 'audio' : 'image'
    const extension = kind === 'video' ? 'mp4' : kind === 'audio' ? 'wav' : 'webp'
    const asset = makeAsset({
      id: `asset-${String(index).padStart(4, '0')}`,
      fileName: `Clip ${String(index).padStart(4, '0')}.${extension}`,
      mimeType: kind === 'video'
        ? 'video/mp4'
        : kind === 'audio' ? 'audio/wav' : 'image/webp',
      objectUrl: `blob:asset-${index}`,
      kind,
      hasAudio: kind !== 'image',
      width: kind === 'audio' ? null : 1_920,
      height: kind === 'audio' ? null : 1_080,
      audioSampleRate: kind !== 'image' ? 48_000 : null,
      audioChannels: kind !== 'image' ? 2 : null,
    })
    descriptors.set(asset.id, descriptorFromAsset(asset))
    if (connected) assets.set(asset.id, asset)
  }
  useMediaStore.setState({
    descriptors,
    assets,
    visuals: new Map(),
    compatibility: new Map(),
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
    compatibility: new Map(),
  })
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
  usePreferencesStore.setState({ ...INITIAL_PREFERENCES_STATE })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
    activeProjectName: 'Test project',
    activeMediaRelink: INITIAL_ACTIVE_MEDIA_RELINK,
  })
  vi.mocked(importMediaFiles).mockClear()
  vi.mocked(acceptPartialMediaImport).mockClear()
  vi.mocked(chooseMediaForImport).mockClear()
  vi.mocked(forgetImportedMediaHandle).mockClear()
  vi.mocked(removeMediaCompatibility).mockClear()
  vi.mocked(retryMediaCompatibility).mockClear()
  vi.mocked(canRememberImportedMedia).mockReturnValue(false)
  vi.mocked(canChooseActiveMediaFolder).mockReset()
  vi.mocked(canChooseActiveMediaFolder).mockReturnValue(false)
  vi.mocked(chooseActiveAssetMedia).mockClear()
  vi.mocked(chooseActiveMediaFolder).mockClear()
  vi.mocked(connectActiveAssetMedia).mockClear()
  vi.mocked(connectActiveMediaFolderFiles).mockClear()
  useDocumentStore.getState().setDoc({
    ...useDocumentStore.getState().doc,
    frameRate: { num: 30, den: 1 },
  })
})

describe('MediaPool presentation', () => {
  test('keeps the rendered DOM bounded for a searchable 500-item catalog', async () => {
    seedLargeCatalog(500, true)
    render(<MediaPool />)

    const listbox = screen.getByRole('listbox', { name: 'Media assets' })
    expect(within(listbox).getAllByRole('option').length).toBeLessThan(40)
    expect(screen.getByText('500 of 500')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'clip 0499' },
    })

    await waitFor(() => {
      expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    })
    expect(screen.getByTitle('Clip 0499.wav')).toHaveAttribute(
      'aria-posinset',
      '1',
    )
    expect(screen.getByText('1 of 500')).toBeInTheDocument()
  })

  test('does not subscribe the rendered pool to offscreen visual updates', () => {
    seedLargeCatalog(500, true)
    let commitCount = 0
    const countCommit: ProfilerOnRenderCallback = () => {
      commitCount++
    }
    render(
      <Profiler id="media-pool" onRender={countCommit}>
        <MediaPool />
      </Profiler>,
    )
    expect(screen.queryByTitle('Clip 0499.wav')).not.toBeInTheDocument()
    const initialCommitCount = commitCount

    act(() => {
      useMediaStore.setState((state) => ({
        visuals: new Map(state.visuals).set('asset-0499', {
          filmstrip: null,
          waveform: { url: 'blob:offscreen-waveform', width: 800, height: 44 },
        }),
      }))
    })

    expect(commitCount).toBe(initialCommitCount)
  })

  test('keeps keyboard selection and drag identity across a virtual boundary', async () => {
    seedLargeCatalog(500, true)
    render(<MediaPool />)
    const listbox = screen.getByRole('listbox', { name: 'Media assets' })
    listbox.focus()

    fireEvent.keyDown(listbox, { key: 'End' })

    const finalCard = await screen.findByTitle('Clip 0499.wav')
    expect(listbox).toHaveFocus()
    expect(finalCard).toHaveAttribute('aria-selected', 'true')
    expect(finalCard).toHaveAttribute('aria-posinset', '500')
    const setData = vi.fn()
    fireEvent.dragStart(finalCard, {
      dataTransfer: { setData, effectAllowed: 'none' },
    })
    expect(setData).toHaveBeenCalledWith(ASSET_DRAG_TYPE, 'asset-0499')
    expect(setData).toHaveBeenCalledWith(assetKindDragType('audio'), 'audio')
  })

  test('relinks an offline item reached across a virtual boundary', async () => {
    seedLargeCatalog(500, false)
    render(<MediaPool />)
    const listbox = screen.getByRole('listbox', { name: 'Media assets' })
    listbox.focus()

    fireEvent.keyDown(listbox, { key: 'End' })

    const input = await screen.findByLabelText('Relink Clip 0499.wav')
    const file = new File(['audio'], 'Clip 0499.wav', { type: 'audio/wav' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(connectActiveAssetMedia).toHaveBeenCalledWith('asset-0499', file)
  })

  test('edits the future-import duration with an exact accessible name', () => {
    render(<MediaPool />)

    const input = screen.getByRole('spinbutton', {
      name: 'Default still-image duration',
    })
    expect(input).toHaveValue(5)
    expect(input).toHaveAccessibleDescription('Future imports only')

    fireEvent.change(input, { target: { value: '2.5' } })
    fireEvent.blur(input)
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(2_500_000)

    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue(2.5)
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(2_500_000)

    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(2.5)
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(2_500_000)
  })

  test('delegates every selected fallback file to the bounded batch controller', () => {
    render(<MediaPool />)

    expect(screen.getByRole('heading', { name: 'Media' })).toBeInTheDocument()
    const input = screen.getByLabelText('Import media')
    const video = new File(['video'], 'fresh.mp4', { type: 'video/mp4' })
    const image = new File(['image'], 'poster.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [video, image] } })

    expect(input).toHaveAttribute('multiple')
    expect(input).toHaveAttribute('accept', expect.stringContaining('image/png'))
    expect(importMediaFiles).toHaveBeenCalledOnce()
    expect(importMediaFiles).toHaveBeenCalledWith([video, image])
    expect(useMediaStore.getState().assets.size).toBe(0)
  })

  test('supporting browsers offer remembered and quick import paths', () => {
    vi.mocked(canRememberImportedMedia).mockReturnValue(true)
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', { name: 'Import & remember' }))

    expect(chooseMediaForImport).toHaveBeenCalledOnce()
    const quickInput = screen.getByLabelText('Import media once')
    const file = new File(['video'], 'fresh.mp4', { type: 'video/mp4' })
    fireEvent.change(quickInput, { target: { files: [file] } })

    expect(quickInput).toHaveAttribute('multiple')
    expect(importMediaFiles).toHaveBeenCalledWith([file])
  })

  test('disables every import path while another import is active', () => {
    vi.mocked(canRememberImportedMedia).mockReturnValue(true)
    useMediaImportStore.setState({
      ...INITIAL_MEDIA_IMPORT_STATE,
      phase: 'analyzing',
      fileName: 'busy.mp4',
    })
    render(<MediaPool />)

    expect(screen.getByRole('button', {
      name: 'Import & remember',
    })).toBeDisabled()
    expect(screen.getByLabelText('Import media once')).toBeDisabled()
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

  test('presents a verified animated still as one contained, draggable tile', () => {
    const image = makeAsset({
      id: 'image-1',
      fileName: 'poster.webp',
      mimeType: 'image/webp',
      objectUrl: 'blob:image',
      kind: 'image',
      durationFrames: 150,
      durationMicroseconds: 5_000_000,
      frameRate: null,
      width: 640,
      height: 360,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    })
    seedAsset(image, {
      filmstrip: {
        url: 'blob:image-tile',
        tiles: 1,
        tileWidth: 320,
        tileHeight: 180,
      },
      waveform: null,
    })
    seedCompatibility(makeCompatibility({
      id: image.id,
      fileName: image.fileName,
      declaredMimeType: image.mimeType,
      status: 'ready',
      report: makeReport('ready', {
        container: {
          name: 'WEBP image',
          mimeType: 'image/webp',
          fullMimeType: 'image/webp',
        },
        durationMicroseconds: 5_000_000,
        tracks: [],
        image: {
          format: 'webp',
          mimeType: 'image/webp',
          width: 640,
          height: 360,
          animated: true,
          frameCount: 4,
          firstFrameOnly: true,
          decodePath: 'image-bitmap',
        },
        detail: 'Animated image detected; Myrelith uses its first frame only.',
      }),
    }))
    render(<MediaPool />)

    const card = screen.getByTitle('poster.webp')
    const thumbnail = screen.getByTestId('media-thumbnail-image-1')
    expect(card).toHaveAttribute('draggable', 'true')
    expect(screen.getByText(
      '640×360 · 00:00:05:00 · First frame only',
    )).toBeInTheDocument()
    expect(screen.getByText('Still image')).toBeInTheDocument()
    expect(screen.getByText(
      'WEBP · 640×360 · ImageBitmap · First frame only',
    )).toBeInTheDocument()
    expect(thumbnail).toHaveStyle({
      backgroundSize: 'contain',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    })
    const setData = vi.fn()
    fireEvent.dragStart(card, {
      dataTransfer: { setData, effectAllowed: 'none' },
    })
    expect(setData).toHaveBeenCalledWith(ASSET_DRAG_TYPE, 'image-1')
    expect(setData).toHaveBeenCalledWith(assetKindDragType('image'), 'image')
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

    fireEvent.click(screen.getByRole('button', { name: 'Remove beach.mp4' }))

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
                sourceMode: 'timed',
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

    fireEvent.click(screen.getByRole('button', { name: 'Remove beach.mp4' }))

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
    expect(screen.getByText('Offline · relink needed')).toBeInTheDocument()
    expect(screen.getByTestId('media-thumbnail-asset-9')).toHaveAttribute(
      'data-state',
      'offline',
    )
    const setData = vi.fn()
    fireEvent.dragStart(card, {
      dataTransfer: { setData, effectAllowed: 'none' },
    })
    expect(setData).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', {
      name: 'Relink & remember beach.mp4',
    }))
    expect(chooseActiveAssetMedia).toHaveBeenCalledWith('asset-9')

    const file = new File(['source'], 'beach.mp4', { type: 'video/mp4' })
    fireEvent.change(screen.getByLabelText('Relink beach.mp4 once'), {
      target: { files: [file] },
    })
    expect(connectActiveAssetMedia).toHaveBeenCalledWith('asset-9', file)
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

  test('keeps a checking provisional file visible, announced, and non-draggable', () => {
    seedCompatibility(makeCompatibility())
    render(<MediaPool />)

    const card = screen.getByTitle('beach.mp4')
    expect(card).toHaveAttribute('data-connection', 'provisional')
    expect(card).toHaveAttribute('draggable', 'false')
    expect(screen.getByRole('status', {
      name: 'beach.mp4 compatibility status',
    })).toHaveTextContent('Compatibility: Checking')
    expect(screen.getByText('Reading file bytes and media metadata…'))
      .toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove beach.mp4' }))
    expect(removeMediaCompatibility).toHaveBeenCalledWith('asset-9')
  })

  test('shows detected container and every ready track diagnostic', () => {
    seedAsset(makeAsset())
    seedCompatibility(makeCompatibility({
      status: 'ready',
      report: makeReport(),
    }))
    render(<MediaPool />)

    expect(screen.getByRole('status', {
      name: 'beach.mp4 compatibility status',
    })).toHaveTextContent('Compatibility: Ready')
    expect(screen.getByText('Container')).toBeInTheDocument()
    expect(screen.getByText(/MPEG-4 Part 14/)).toBeInTheDocument()
    expect(screen.getByText('Video track 1 (primary)')).toBeInTheDocument()
    expect(screen.getByText('Audio track 1 (primary)')).toBeInTheDocument()
    expect(screen.getAllByText(/Native browser decoder/)).toHaveLength(2)
    expect(screen.getByTitle('beach.mp4')).toHaveAttribute('draggable', 'true')
  })

  test('identifies locally decoded ProRes and AC-3 tracks honestly', () => {
    seedAsset(makeAsset())
    seedCompatibility(makeCompatibility({
      status: 'ready',
      report: makeReport('ready', {
        tracks: [
          makeTrack({
            codec: 'prores',
            codecParameter: 'apch',
            internalCodecId: 'apch',
            decoderConfig: {
              codec: 'apch',
              descriptionBytes: 0,
              codedWidth: 1920,
              codedHeight: 1080,
              sampleRate: null,
              channels: null,
            },
            decoderPath: 'local-prores',
          }),
          makeTrack({
            kind: 'audio',
            codec: 'eac3',
            codecParameter: 'ec-3',
            internalCodecId: 'ec-3',
            decoderConfig: {
              codec: 'ec-3',
              descriptionBytes: 0,
              codedWidth: null,
              codedHeight: null,
              sampleRate: 48_000,
              channels: 6,
            },
            decoderPath: 'local-ac3',
            width: null,
            height: null,
            codedWidth: null,
            codedHeight: null,
            frameRate: null,
            sampleRate: 48_000,
            channels: 6,
          }),
        ],
      }),
    }))

    render(<MediaPool />)

    expect(screen.getByText(/Local fallback \(ProRes\)/)).toBeInTheDocument()
    expect(screen.getByText(/Local fallback \(AC-3\/E-AC-3\)/))
      .toBeInTheDocument()
  })

  test('rechecks live compatibility before writing drag data', () => {
    seedAsset(makeAsset())
    seedCompatibility(makeCompatibility({
      status: 'ready',
      report: makeReport(),
    }))
    render(<MediaPool />)
    const card = screen.getByTitle('beach.mp4')
    const setData = vi.fn()

    act(() => {
      useMediaStore.setState({
        compatibility: new Map([[
          'asset-9',
          makeCompatibility({
            status: 'unsupported',
            report: makeReport('unsupported', {
              reason: 'unsupported-codec',
              detail: 'Decoder support changed before the drag began.',
            }),
          }),
        ]]),
      })
    })
    fireEvent.dragStart(card, {
      dataTransfer: { setData, effectAllowed: 'none' },
    })

    expect(setData).not.toHaveBeenCalled()
  })

  test('keeps limited media out of drag flow and exposes exact retryable failure', () => {
    const failedAudio = makeTrack({
      kind: 'audio',
      codec: 'prores-audio',
      codecParameter: 'apac',
      internalCodecId: 'apac',
      decoderConfig: null,
      decodable: false,
      reason: 'unsupported-codec',
      detail: 'This browser cannot decode this audio codec.',
      width: null,
      height: null,
      codedWidth: null,
      codedHeight: null,
      frameRate: null,
      sampleRate: 48_000,
      channels: 2,
    })
    seedCompatibility(makeCompatibility({
      status: 'limited',
      report: makeReport('limited', {
        tracks: [makeTrack(), failedAudio],
        reason: 'unsupported-codec',
        detail: 'Some media tracks are not usable in this browser.',
      }),
    }))
    render(<MediaPool />)

    expect(screen.getByTitle('beach.mp4')).toHaveAttribute('draggable', 'false')
    expect(screen.getByText('This browser cannot decode this audio codec.'))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {
      name: 'Retry compatibility check for beach.mp4',
    }))
    expect(retryMediaCompatibility).toHaveBeenCalledWith('asset-9')
  })

  test('reviews a video-only import in an explicitly named dialog before committing', async () => {
    seedVideoOnlyCandidate()
    render(<MediaPool />)

    const review = screen.getByRole('button', {
      name: 'Review video-only import for beach.mp4',
    })
    expect(review).toHaveAttribute('aria-haspopup', 'dialog')
    expect(acceptPartialMediaImport).not.toHaveBeenCalled()

    fireEvent.click(review)

    const dialog = await screen.findByRole('dialog', {
      name: 'Import “beach.mp4” without audio?',
    })
    expect(dialog).toHaveAccessibleDescription(
      'The original file stays unchanged. Myrelith will use Video track 1 (primary) and omit Audio track 1 (primary). Omitted audio will not appear on the timeline or in exports.',
    )
    expect(within(dialog).getByText('Video track 1 (primary)')).toBeInTheDocument()
    expect(within(dialog).getByText('Audio track 1 (primary)')).toBeInTheDocument()
    await waitFor(() => {
      expect(within(dialog).getByRole('button', {
        name: 'Keep as Limited',
      })).toHaveFocus()
    })
    expect(acceptPartialMediaImport).not.toHaveBeenCalled()
  })

  test('Escape keeps the Limited row and restores focus to its review action', async () => {
    seedVideoOnlyCandidate()
    render(<MediaPool />)
    const review = screen.getByRole('button', {
      name: 'Review video-only import for beach.mp4',
    })
    fireEvent.click(review)
    const dialog = await screen.findByRole('dialog', {
      name: 'Import “beach.mp4” without audio?',
    })

    const cancelEvent = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancelEvent)

    expect(cancelEvent.defaultPrevented).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTitle('beach.mp4')).toHaveAttribute(
      'data-compatibility',
      'limited',
    )
    expect(screen.getByRole('status', {
      name: 'beach.mp4 compatibility status',
    })).toHaveTextContent('Compatibility: Limited')
    expect(acceptPartialMediaImport).not.toHaveBeenCalled()
    await waitFor(() => expect(review).toHaveFocus())
  })

  test('Keep as Limited cancels without removing or importing the row', async () => {
    seedVideoOnlyCandidate()
    render(<MediaPool />)
    const review = screen.getByRole('button', {
      name: 'Review video-only import for beach.mp4',
    })
    fireEvent.click(review)
    await screen.findByRole('dialog', {
      name: 'Import “beach.mp4” without audio?',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Keep as Limited' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTitle('beach.mp4')).toHaveAttribute(
      'data-compatibility',
      'limited',
    )
    expect(screen.getByRole('button', {
      name: 'Review video-only import for beach.mp4',
    })).toBeInTheDocument()
    expect(acceptPartialMediaImport).not.toHaveBeenCalled()
    await waitFor(() => expect(review).toHaveFocus())
  })

  test('confirms the reviewed video-only import exactly once', async () => {
    seedVideoOnlyCandidate()
    render(<MediaPool />)
    fireEvent.click(screen.getByRole('button', {
      name: 'Review video-only import for beach.mp4',
    }))
    await screen.findByRole('dialog', {
      name: 'Import “beach.mp4” without audio?',
    })

    const confirm = screen.getByRole('button', { name: 'Import video only' })
    fireEvent.click(confirm)

    expect(acceptPartialMediaImport).toHaveBeenCalledOnce()
    expect(acceptPartialMediaImport).toHaveBeenCalledWith(
      'asset-9',
      'video-only',
    )
  })

  test('mirrors informed consent for an audio-only import', async () => {
    seedAudioOnlyCandidate()
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Review audio-only import for beach.mp4',
    }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Import “beach.mp4” without video?',
    })
    expect(dialog).toHaveAccessibleDescription(
      'The original file stays unchanged. Myrelith will use Audio track 1 (primary) and omit Video track 1 (primary). Omitted video will not appear on the timeline or in exports.',
    )

    fireEvent.click(within(dialog).getByRole('button', {
      name: 'Import audio only',
    }))
    expect(acceptPartialMediaImport).toHaveBeenCalledOnce()
    expect(acceptPartialMediaImport).toHaveBeenCalledWith(
      'asset-9',
      'audio-only',
    )
  })

  test('names an accepted projection in Ready status and durable metadata', () => {
    const asset = makeAsset({
      partialTrackSelection: 'video-only',
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    })
    seedAsset(asset)
    seedCompatibility(makeCompatibility({
      status: 'ready',
      report: makeReport('ready', {
        partialImport: { selection: 'video-only' },
      }),
    }))
    render(<MediaPool />)

    expect(screen.getByRole('status', {
      name: 'beach.mp4 compatibility status',
    })).toHaveTextContent('Compatibility: Ready — video only')
    expect(screen.getByText(/Video only/)).toBeInTheDocument()
  })

  test('shows an exact file-level failure when no tracks could be inspected', () => {
    seedCompatibility(makeCompatibility({
      status: 'error',
      report: makeReport('error', {
        container: null,
        durationMicroseconds: null,
        tracks: [],
        reason: 'malformed-media',
        detail: 'The media is damaged or incomplete: truncated header.',
      }),
    }))
    render(<MediaPool />)

    expect(screen.getByText('Not detected')).toBeInTheDocument()
    expect(screen.getByText(
      'The media is damaged or incomplete: truncated header.',
    )).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: 'Retry compatibility check for beach.mp4',
    })).toBeEnabled()
    expect(screen.getByTitle('beach.mp4')).toHaveAttribute('draggable', 'false')
  })

  test('descriptor runtime diagnostics keep Relink recovery and never offer import Retry', () => {
    seedOfflineDescriptor()
    vi.mocked(canRememberImportedMedia).mockReturnValue(true)
    const runtimeDetail = 'hardware decoder stopped'
    const report = withMediaRuntimeFailure(makeReport(), {
      surface: 'preview',
      trackKind: 'video',
      reason: 'decode-failed',
      detail: runtimeDetail,
    })
    seedCompatibility(makeCompatibility({
      status: 'error',
      report,
    }))
    render(<MediaPool />)

    expect(screen.getByRole('status', {
      name: 'beach.mp4 compatibility status',
    })).toHaveTextContent('Compatibility: Error')
    expect(screen.getAllByText(runtimeDetail)).toHaveLength(1)
    expect(screen.queryByText(`Preview failed: ${runtimeDetail}`))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('button', {
      name: 'Retry compatibility check for beach.mp4',
    })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {
      name: 'Relink & remember beach.mp4',
    }))
    expect(chooseActiveAssetMedia).toHaveBeenCalledWith('asset-9')
  })

  test('offers remembered and one-time folder relink while offline sources exist', () => {
    seedOfflineDescriptor()
    vi.mocked(canChooseActiveMediaFolder).mockReturnValue(true)
    render(<MediaPool />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Relink folder & remember',
    }))

    expect(chooseActiveMediaFolder).toHaveBeenCalledOnce()

    const file = new File(['source'], 'beach.mp4', { type: 'video/mp4' })
    fireEvent.change(screen.getByLabelText('Relink a media folder once'), {
      target: { files: [file] },
    })
    expect(connectActiveMediaFolderFiles).toHaveBeenCalledWith([file])
  })

  test('shows folder scan progress, completion counts, and errors', () => {
    seedOfflineDescriptor()
    useProjectSessionStore.setState({
      activeMediaRelink: {
        phase: 'scanning',
        processedFileCount: 0,
        scannedFileCount: 3,
        connectedCount: 1,
        skippedCount: 0,
        errors: [],
        ambiguity: null,
      },
    })
    render(<MediaPool />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking 0 of 3 source files',
    )
    expect(screen.getByRole('progressbar', {
      name: 'Folder relink progress',
    })).toHaveAttribute('max', '3')

    act(() => {
      useProjectSessionStore.setState({
        activeMediaRelink: {
          phase: 'complete',
          processedFileCount: 3,
          scannedFileCount: 3,
          connectedCount: 2,
          skippedCount: 1,
          errors: ['One source could not be inspected.'],
          ambiguity: null,
        },
      })
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Relink finished · 3 of 3 checked · 2 connected · 1 skipped',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'One source could not be inspected.',
    )
  })
})
