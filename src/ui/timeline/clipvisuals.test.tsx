/**
 * ui/timeline/clipvisuals.test.tsx — the filmstrip/waveform layer inside
 * ClipView (clip audio upgrade).
 *
 * The images span the asset's FULL duration, so the contract under test
 * is pure CSS math: background-size = assetDuration×zoom, position =
 * −sourceStart×zoom, waveform on audio lanes / filmstrip on video lanes,
 * nothing rendered while visuals or metadata are missing, and the slip
 * preview shifting the background live.
 */

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import type { Clip, MediaAsset } from '../../domain/schema'
import type { AssetVisuals } from '../../state/mediaStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import ClipView from './ClipView'

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
  objectUrl: 'blob:asset',
  kind: 'video',
  durationFrames: 300,
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioSampleRate: 48000,
  audioChannels: 2,
  decoderConfigB64: null,
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
    inOut: null,
    dragPreview: null,
    tool: 'select',
    selectedClipId: null,
    editPreview: null,
  })
  useMediaStore.setState({
    assets: new Map([[asset.id, asset]]),
    visuals: new Map([[asset.id, visuals]]),
  })
})

describe('clip visuals', () => {
  test('video lanes show the filmstrip mapped by asset length and in-point', () => {
    // Clip shows source [60, 160) of a 300-frame asset, zoom 2.
    render(<ClipView clip={makeClip('c1', 0, 100, 60)} trackId="V1" trackKind="video" />)
    const visual = screen.getByTestId('clip-c1-visual')
    expect(visual).toHaveStyle({
      backgroundImage: 'url(blob:strip)',
      backgroundSize: '600px 100%', // 300 frames × zoom 2
      backgroundPosition: '-120px 0', // −(60 × 2)
    })
  })

  test('audio lanes show the waveform instead', () => {
    render(<ClipView clip={makeClip('c2', 0, 100)} trackId="A1" trackKind="audio" />)
    expect(screen.getByTestId('clip-c2-visual')).toHaveStyle({
      backgroundImage: 'url(blob:wave)',
      backgroundPosition: '0px 0',
    })
  })

  test('nothing renders while visuals or asset metadata are missing', () => {
    useMediaStore.setState({ visuals: new Map() })
    const { rerender } = render(
      <ClipView clip={makeClip('c3', 0, 100)} trackId="V1" trackKind="video" />,
    )
    expect(screen.queryByTestId('clip-c3-visual')).not.toBeInTheDocument()

    // Visuals present but duration still the placeholder 0 → still nothing.
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

  test('a live slip preview shifts the material under the clip', () => {
    render(<ClipView clip={makeClip('c5', 0, 100, 60)} trackId="V1" trackKind="video" />)
    act(() => {
      useTransportStore
        .getState()
        .setEditPreview({ clipId: 'c5', kind: 'slip', deltaFrames: 10 })
    })
    expect(screen.getByTestId('clip-c5-visual')).toHaveStyle({
      backgroundPosition: '-140px 0', // −((60 + 10) × 2)
    })
  })
})
