import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import { createCaptionTrack } from '../domain/captions'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { usePreviewQualityStore } from '../state/previewQualityStore'
import { useProxyStore } from '../state/proxyStore'
import Preview from './Preview'
import { createTextClip } from '../domain/operations'
import { useDocumentStore } from '../state/documentStore'

const previewController = vi.hoisted(() => ({
  initPreview: vi.fn(),
  setPreviewViewport: vi.fn(),
}))

vi.mock('../app/previewController', () => previewController)

const offlineVideo: PortableAssetDescriptor = {
  id: 'offline-video',
  fileName: 'camera.mp4',
  mimeType: 'video/mp4',
  size: 8,
  lastModified: 111,
  kind: 'video',
  durationMicroseconds: 2_000_000,
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
    audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
  },
  nativeFrameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioSampleRate: 48_000,
  audioChannels: 2,
}

const offlineImage: PortableAssetDescriptor = {
  id: 'offline-image',
  fileName: 'title-card.png',
  mimeType: 'image/png',
  size: 4,
  lastModified: 222,
  kind: 'image',
  durationMicroseconds: 5_000_000,
  sourceBounds: { video: null, audio: null },
  nativeFrameRate: null,
  width: 1280,
  height: 720,
  hasAudio: false,
  audioSampleRate: null,
  audioChannels: null,
}

beforeEach(() => {
  previewController.initPreview.mockClear()
  previewController.setPreviewViewport.mockClear()
  useMediaStore.setState({
    descriptors: new Map([[offlineVideo.id, offlineVideo]]),
    assets: new Map(),
    visuals: new Map(),
  })
  usePreviewStatusStore.getState().resetPreviewStatus()
  usePreviewQualityStore.setState({ qualityMode: 'auto' })
  useProxyStore.getState().reset()
  useDocumentStore.getState().setDoc(
    createTimelineDoc('Preview', DEFAULT_PROJECT_SETTINGS, 'preview-doc'),
  )
})

describe('Preview', () => {
  test('offers an accessible Auto, Full, Half, and Quarter quality control', async () => {
    const user = userEvent.setup()
    render(<Preview />)

    const quality = screen.getByRole('combobox', { name: 'Preview quality' })
    expect(quality).toHaveValue('auto')
    expect(screen.getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Auto', 'Full', 'Half', 'Quarter'])

    await user.selectOptions(quality, 'quarter')
    expect(usePreviewQualityStore.getState().qualityMode).toBe('quarter')
    expect(quality).toHaveValue('quarter')
  })

  test('offers reconnection instead of import when every visual is offline', () => {
    render(<Preview />)

    expect(previewController.initPreview).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Visual sources are offline')
    expect(status).toHaveTextContent(/reconnect them in the Media panel/i)
    expect(screen.queryByText(/import a video or still image/i))
      .not.toBeInTheDocument()
  })

  test('does not cover an offline video when its editing proxy is ready', () => {
    const cacheKey = 'a'.repeat(64)
    useProxyStore.getState().setAsset({
      assetId: offlineVideo.id,
      phase: 'ready',
      progress: 1,
      detail: 'Proxy ready for preview.',
      canGenerate: false,
      originalAvailable: false,
      entry: {
        cacheKey,
        assetId: offlineVideo.id,
        original: {
          algorithm: 'sha256-sampled-v1',
          digest: 'b'.repeat(64),
          fileName: offlineVideo.fileName,
          size: offlineVideo.size,
          lastModified: offlineVideo.lastModified,
        },
        parameters: {
          container: 'mp4',
          videoCodec: 'avc',
          bitrate: 2_000_000,
          maxWidth: 1_280,
          maxHeight: 720,
          keyFrameIntervalSeconds: 1,
        },
        generatorVersion: 'mediabunny-webcodecs-v1',
        fileName: `${cacheKey}.${'1'.repeat(32)}.mp4`,
        mimeType: 'video/mp4',
        byteSize: 1_000,
        width: 1_280,
        height: 720,
        frameRate: { num: 30, den: 1 },
        durationMicroseconds: 2_000_000,
        createdAt: 1,
        lastUsedAt: 1,
      },
    })

    render(<Preview />)

    expect(screen.queryByText(/visual sources are offline/i)).not.toBeInTheDocument()
  })

  test('names an offline still needed by the displayed frame', () => {
    useMediaStore.setState({
      descriptors: new Map([[offlineImage.id, offlineImage]]),
      assets: new Map(),
      visuals: new Map(),
    })
    usePreviewStatusStore.getState().setOfflineVisualAssetIds([
      offlineImage.id,
    ])

    render(<Preview />)

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Source offline')
    expect(status).toHaveTextContent(
      'Reconnect title-card.png in the Media panel.',
    )
  })

  test('does not report offline visual sources for a text-only project', () => {
    useMediaStore.setState({
      descriptors: new Map(),
      assets: new Map(),
      visuals: new Map(),
    })
    const state = useDocumentStore.getState()
    const track = state.doc.tracks.find((candidate) => candidate.kind === 'video')
    expect(track).toBeDefined()
    state.insertClip(track!.id, createTextClip(state.doc, 0, 30, 'Title only'))

    render(<Preview />)

    expect(screen.queryByText(/visual sources are offline/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/import a video or still image/i)).not.toBeInTheDocument()
  })

  test('does not cover a caption-only project with the empty-preview hint', () => {
    useMediaStore.setState({
      descriptors: new Map(),
      assets: new Map(),
      visuals: new Map(),
    })
    const store = useDocumentStore.getState()
    store.addCaptionTrack(createCaptionTrack('captions', 'English', 'en'))
    store.addCaptionItem('captions', {
      id: 'caption-1',
      range: { startFrame: 0, durationFrames: 30 },
      text: 'Caption-only preview',
    })

    render(<Preview />)

    expect(screen.queryByText(/import a video or still image/i)).not.toBeInTheDocument()
  })
})
