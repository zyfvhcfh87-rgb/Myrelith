import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import Preview from './Preview'

const previewController = vi.hoisted(() => ({
  initPreview: vi.fn(),
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
  nativeFrameRate: null,
  width: 1280,
  height: 720,
  hasAudio: false,
  audioSampleRate: null,
  audioChannels: null,
}

beforeEach(() => {
  previewController.initPreview.mockClear()
  useMediaStore.setState({
    descriptors: new Map([[offlineVideo.id, offlineVideo]]),
    assets: new Map(),
    visuals: new Map(),
  })
  usePreviewStatusStore.getState().resetPreviewStatus()
})

describe('Preview', () => {
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
})
