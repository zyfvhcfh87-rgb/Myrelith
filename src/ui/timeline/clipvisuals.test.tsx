/**
 * ClipView's generated filmstrip and waveform layers.
 *
 * Filmstrip buckets stay in full-source integer-frame space, but each sprite
 * tile repeats at a fixed SVG-pattern size instead of horizontally stretching.
 * Waveforms use a normalized source-time SVG viewBox, so a virtual slice
 * never needs an asset-sized CSS background.
 */

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import type { PortableAssetDescriptor } from '../../domain/projectFile'
import type { Clip, MediaAsset } from '../../domain/schema'
import type { AssetVisuals } from '../../state/mediaStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import ClipView from './ClipView'
import { visibleFilmstripBuckets } from './clipVisualPlan'
import { MAX_TIMELINE_SURFACE_PX } from './timelineViewport'

function makeClip(id: string, tlStart: number, duration: number, srcStart = 0): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: srcStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

const asset: MediaAsset = {
  id: 'asset-1',
  fileName: 'a.mp4',
  mimeType: 'video/mp4',
  size: 1_024,
  lastModified: 1_725_000_000_000,
  objectUrl: 'blob:asset',
  kind: 'video',
  durationFrames: 300,
  durationMicroseconds: 10_000_000,
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioSampleRate: 48000,
  audioChannels: 2,
  decoderConfigB64: null,
}

const descriptor: PortableAssetDescriptor = {
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

const visuals: AssetVisuals = {
  filmstrip: { url: 'blob:strip', tiles: 5, tileWidth: 78, tileHeight: 44 },
  waveform: { url: 'blob:wave', width: 1000, height: 44 },
}

beforeEach(() => {
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 2,
    zoomMode: 'custom',
    customZoom: 2,
    timelineOriginFrame: 0,
    inOut: null,
    dragPreview: null,
    tool: 'select',
    selectedClipId: null,
    selectedClipIds: [],
    editPreview: null,
  })
  useMediaStore.setState({
    descriptors: new Map([[descriptor.id, descriptor]]),
    assets: new Map([[asset.id, asset]]),
    visuals: new Map([[asset.id, visuals]]),
  })
})

describe('clip visuals', () => {
  test('an offline descriptor-backed clip stays visible and marked Offline', () => {
    useMediaStore.setState({
      descriptors: new Map([[descriptor.id, descriptor]]),
      assets: new Map(),
      visuals: new Map(),
    })

    render(
      <ClipView
        clip={makeClip('offline', 25, 100, 60)}
        trackId="V1"
        trackKind="video"
      />,
    )

    const clip = screen.getByTestId('clip-offline')
    expect(clip).toBeVisible()
    expect(clip).toHaveClass('offline')
    expect(clip).toHaveAttribute('data-offline', 'true')
    expect(clip).toHaveStyle({ transform: 'translateX(50px)', width: '200px' })
    expect(screen.getByLabelText('Source offline')).toHaveTextContent('Offline')
    expect(screen.queryByTestId('clip-offline-visual')).not.toBeInTheDocument()
  })

  test('video lanes show time-aligned fixed-size sprite patterns', () => {
    // Clip shows source [60, 160) of a 300-frame asset, zoom 2.
    render(<ClipView clip={makeClip('c1', 0, 100, 60)} trackId="V1" trackKind="video" />)
    const visual = screen.getByTestId('clip-c1-visual')
    expect(visual).toHaveClass('clip-filmstrip')

    const first = screen.getByTestId('clip-c1-filmstrip-tile-1')
    const second = screen.getByTestId('clip-c1-filmstrip-tile-2')
    expect(first).toHaveStyle({ left: '0px', width: '120px' })
    expect(first.querySelector('pattern')).toHaveAttribute('width', '78')
    expect(first.querySelector('pattern')).toHaveAttribute('height', '44')
    expect(first.querySelector('image')).toHaveAttribute('x', '-78')
    expect(second).toHaveStyle({ left: '120px', width: '80px' })
    expect(second.querySelector('image')).toHaveAttribute('x', '-156')
    expect(visual.querySelectorAll('.clip-filmstrip-tile')).toHaveLength(2)
  })

  test('a still repeats its one visual tile across live timeline extensions', () => {
    const still = {
      ...makeClip('still', 0, 150),
      sourceMode: 'still' as const,
      sourceRange: { startFrame: 0, durationFrames: 1 },
    }
    useMediaStore.setState({
      assets: new Map([[
        asset.id,
        {
          ...asset,
          fileName: 'poster.png',
          mimeType: 'image/png',
          kind: 'image',
          frameRate: null,
          hasAudio: false,
          audioSampleRate: null,
          audioChannels: null,
        },
      ]]),
      visuals: new Map([[
        asset.id,
        {
          filmstrip: {
            url: 'blob:poster',
            tiles: 1,
            tileWidth: 78,
            tileHeight: 44,
          },
          waveform: null,
        },
      ]]),
    })

    render(<ClipView clip={still} trackId="V1" trackKind="video" />)
    const clip = screen.getByRole('button', {
      name: 'still, still image clip',
    })
    expect(clip).toHaveAttribute('data-source-mode', 'still')
    expect(clip).toHaveStyle({ width: '300px' })
    expect(screen.getByTestId('clip-still-filmstrip-tile-0')).toHaveStyle({
      left: '0px',
      width: '300px',
    })

    act(() => {
      useTransportStore.getState().setEditPreview({
        clipId: 'still',
        kind: 'trim-end',
        deltaFrames: 150,
      })
    })
    expect(clip).toHaveStyle({ width: '600px' })
    expect(screen.getByTestId('clip-still-filmstrip-tile-0')).toHaveStyle({
      left: '0px',
      width: '600px',
    })
  })

  test('audio lanes map the full-source vector waveform by time', () => {
    render(<ClipView clip={makeClip('c2', 0, 100)} trackId="A1" trackKind="audio" />)
    const waveform = screen.getByTestId('clip-c2-visual')
    expect(waveform).toHaveAttribute(
      'viewBox',
      '0 0 0.3333333333333333 1',
    )
    expect(waveform.querySelector('image')).toHaveAttribute('href', 'blob:wave')
  })

  test('a huge clip renders one bounded, source-aligned virtual slice', () => {
    useMediaStore.setState({
      assets: new Map([[asset.id, { ...asset, durationFrames: 2_000_000 }]]),
    })

    render(
      <ClipView
        clip={makeClip('long', 0, 2_000_000)}
        trackId="A1"
        trackKind="audio"
        timelineOriginFrame={1_000_000}
        timelineWindowEndFrame={1_100_000}
      />,
    )

    expect(screen.getByTestId('clip-long')).toHaveStyle({
      transform: 'translateX(0px)',
      width: '200000px',
    })
    expect(screen.getByTestId('clip-long-visual')).toHaveAttribute(
      'viewBox',
      '0.5 0 0.05 1',
    )
    expect(screen.queryByTestId('clip-long-edge-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('clip-long-edge-end')).not.toBeInTheDocument()
  })

  test('a huge filmstrip clips every source bucket to the bounded slice', () => {
    useMediaStore.setState({
      assets: new Map([[asset.id, { ...asset, durationFrames: 2_000_000 }]]),
    })
    act(() => useTransportStore.getState().setZoom(44))

    render(
      <ClipView
        clip={makeClip('long-video', 0, 2_000_000)}
        trackId="V1"
        trackKind="video"
        timelineOriginFrame={1_000_000}
        timelineWindowEndFrame={1_363_636}
      />,
    )

    const clip = screen.getByTestId('clip-long-video')
    const tiles = [
      ...screen
        .getByTestId('clip-long-video-visual')
        .querySelectorAll<HTMLElement>('.clip-filmstrip-tile'),
    ]
    const widths = tiles.map((tile) => Number.parseFloat(tile.style.width))
    expect(clip).toHaveStyle({ width: '15999984px' })
    expect(tiles).toHaveLength(2)
    expect(Math.max(...widths)).toBeLessThan(MAX_TIMELINE_SURFACE_PX)
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(15_999_984)
    expect(tiles[0].querySelector('pattern')).toHaveAttribute('x')
  })

  test('nothing renders while visuals or asset metadata are missing', () => {
    useMediaStore.setState({ visuals: new Map() })
    const { rerender } = render(
      <ClipView clip={makeClip('c3', 0, 100)} trackId="V1" trackKind="video" />,
    )
    expect(screen.queryByTestId('clip-c3-visual')).not.toBeInTheDocument()

    useMediaStore.setState({
      assets: new Map([[asset.id, { ...asset, durationFrames: 0 }]]),
      visuals: new Map([[asset.id, visuals]]),
    })
    rerender(<ClipView clip={makeClip('c3', 0, 100)} trackId="V1" trackKind="video" />)
    expect(screen.queryByTestId('clip-c3-visual')).not.toBeInTheDocument()
  })

  test('an audio clip without a waveform half renders no layer', () => {
    useMediaStore.setState({
      visuals: new Map([[asset.id, { ...visuals, waveform: null }]]),
    })
    render(<ClipView clip={makeClip('c4', 0, 100)} trackId="A1" trackKind="audio" />)
    expect(screen.queryByTestId('clip-c4-visual')).not.toBeInTheDocument()
  })

  test('a live slip preview shifts filmstrip buckets in source time', () => {
    render(<ClipView clip={makeClip('c5', 0, 100, 60)} trackId="V1" trackKind="video" />)
    act(() => {
      useTransportStore
        .getState()
        .setEditPreview({ clipId: 'c5', kind: 'slip', deltaFrames: 10 })
    })
    expect(screen.getByTestId('clip-c5-filmstrip-tile-1')).toHaveStyle({
      left: '0px',
      width: '100px',
    })
    expect(
      screen
        .getByTestId('clip-c5-filmstrip-tile-1')
        .querySelector('pattern'),
    ).toHaveAttribute('x', '-20')
  })

  test('zoom changes bucket geometry but keeps the same fixed-size source tile', () => {
    render(<ClipView clip={makeClip('c7', 0, 100, 60)} trackId="V1" trackKind="video" />)
    const first = screen.getByTestId('clip-c7-filmstrip-tile-1')
    expect(first.querySelector('pattern')).toHaveAttribute('width', '78')
    expect(first.querySelector('pattern')).toHaveAttribute('height', '44')
    expect(first).toHaveStyle({ width: '120px' })

    act(() => useTransportStore.getState().setZoom(8))
    expect(first.querySelector('pattern')).toHaveAttribute('width', '78')
    expect(first.querySelector('pattern')).toHaveAttribute('height', '44')
    expect(first).toHaveStyle({ width: '480px' })
  })

  test('non-divisible asset durations partition exactly through the final frame', () => {
    useMediaStore.setState({
      assets: new Map([[asset.id, { ...asset, durationFrames: 302 }]]),
    })
    render(<ClipView clip={makeClip('c6', 0, 302)} trackId="V1" trackKind="video" />)

    const tiles = screen.getByTestId('clip-c6-visual').querySelectorAll('.clip-filmstrip-tile')
    expect(tiles).toHaveLength(5)
    expect(tiles[0]).toHaveStyle({ left: '0px', width: '120px' })
    expect(tiles[4]).toHaveStyle({ left: '482px', width: '122px' })
  })
})

describe('visibleFilmstripBuckets', () => {
  test('partitions durations near MAX_SAFE_INTEGER without float precision loss', () => {
    const duration = Number.MAX_SAFE_INTEGER
    const buckets = visibleFilmstripBuckets(duration, 3, 78, 1, 0, duration)
    expect(buckets).toEqual([
      { index: 0, spriteIndex: 0, startFrame: 0, endFrame: 3_002_399_751_580_330 },
      { index: 1, spriteIndex: 1, startFrame: 3_002_399_751_580_330, endFrame: 6_004_799_503_160_660 },
      { index: 2, spriteIndex: 2, startFrame: 6_004_799_503_160_660, endFrame: duration },
    ])
  })

  test('uses fewer fixed-size previews instead of squeezing all capped sprites', () => {
    const buckets = visibleFilmstripBuckets(600, 48, 78, 1, 0, 600)
    expect(buckets).toHaveLength(7)
    expect(buckets.map((bucket) => bucket.spriteIndex)).toEqual([3, 10, 17, 24, 30, 37, 44])
    expect(buckets[0]).toMatchObject({ startFrame: 0, endFrame: 85 })
    expect(buckets[6]).toMatchObject({ startFrame: 514, endFrame: 600 })
  })
})
