/**
 * Source Monitor chrome: Media Pool remediation copy, insert/overwrite
 * commands, and Home/End shortcuts on the review transport.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'
import type { MediaAsset } from '../domain/schema'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'
import { openSourceAsset } from '../app/sourceMonitorController'
import SourceMonitor from './SourceMonitor'

vi.mock('../app/sourceMonitorPreviewController', () => ({
  initSourcePreview: vi.fn(),
  disposeSourcePreview: vi.fn(async () => undefined),
  setSourcePreviewViewport: vi.fn(),
}))

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

function seed(asset: MediaAsset | null, item?: MediaCompatibilityItem): void {
  const live = asset ?? makeAsset()
  useMediaStore.setState({
    descriptors: new Map([[live.id, {
      id: live.id,
      fileName: live.fileName,
      mimeType: live.mimeType,
      size: live.size,
      lastModified: live.lastModified,
      kind: live.kind,
      durationMicroseconds: live.durationMicroseconds,
      sourceBounds: live.sourceBounds,
      nativeFrameRate: live.frameRate,
      width: live.width,
      height: live.height,
      hasAudio: live.hasAudio,
      audioSampleRate: live.audioSampleRate,
      audioChannels: live.audioChannels,
    }]]),
    assets: asset ? new Map([[asset.id, asset]]) : new Map(),
    visuals: new Map(),
    compatibility: item ? new Map([[item.id, item]]) : new Map(),
  })
}

beforeEach(() => {
  useSourceMonitorStore.getState().resetSourceMonitor()
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
})

function unsupportedReport() {
  return {
    status: 'unsupported' as const,
    container: null,
    durationMicroseconds: null,
    tracks: [],
    reason: 'unsupported-codec' as const,
    detail: 'This browser cannot decode this video codec.',
  }
}

describe('SourceMonitor', () => {
  test('shows Media Pool offline remediation', () => {
    seed(null)
    openSourceAsset('asset-source')
    render(<SourceMonitor />)
    expect(screen.getByRole('status')).toHaveTextContent('Offline · relink needed')
    expect(screen.queryByText(/Reconnect it in the Media panel/)).not.toBeInTheDocument()
  })

  test('shows Media Pool unsupported remediation', () => {
    seed(makeAsset(), compatibility({
      status: 'unsupported',
      report: unsupportedReport(),
    }))
    openSourceAsset('asset-source')
    render(<SourceMonitor />)
    expect(screen.getByRole('status')).toHaveTextContent('Compatibility: Unsupported')
    expect(screen.getByRole('status')).toHaveTextContent(
      'This browser cannot decode this video codec.',
    )
  })

  test('shows unsupported remediation for a compatibility-only file', () => {
    useMediaStore.setState({
      descriptors: new Map(),
      assets: new Map(),
      visuals: new Map(),
      compatibility: new Map([['asset-broken', compatibility({
        id: 'asset-broken',
        fileName: 'broken.mp4',
        status: 'unsupported',
        report: unsupportedReport(),
      })]]),
    })
    openSourceAsset('asset-broken')
    render(<SourceMonitor />)
    expect(screen.getByRole('status')).toHaveTextContent('Compatibility: Unsupported')
    expect(screen.getByRole('status')).toHaveTextContent(
      'This browser cannot decode this video codec.',
    )
  })

  test('exposes insert/overwrite and Home/End', () => {
    seed(makeAsset(), compatibility())
    expect(openSourceAsset('asset-source').status).toBe('ok')
    render(<SourceMonitor />)

    expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'source video patch' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'source audio patch' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Home',
    )
    expect(screen.getByRole('button', { name: 'End' })).toHaveAttribute(
      'aria-keyshortcuts',
      'End',
    )
  })

  test('scrubs the Source playhead without changing its marks or Program', () => {
    seed(makeAsset(), compatibility())
    expect(openSourceAsset('asset-source').status).toBe('ok')
    const source = useSourceMonitorStore.getState()
    source.scrubPlayhead(25)
    source.setIn()
    source.scrubPlayhead(125)
    source.setOut()
    useTransportStore.getState().setPlayheadFrame(48)
    render(<SourceMonitor />)

    fireEvent.change(screen.getByRole('slider', { name: 'Source playhead' }), {
      target: { value: '90' },
    })

    expect(useSourceMonitorStore.getState().session).toMatchObject({
      playheadFrame: 90,
      inFrame: 25,
      outFrameExclusive: 126,
    })
    expect(useTransportStore.getState().playheadFrame).toBe(48)
  })
})
