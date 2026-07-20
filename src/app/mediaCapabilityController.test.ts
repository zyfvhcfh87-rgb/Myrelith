import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { MediaAsset } from '../domain/schema'
import {
  initMediaCapabilityLifecycle,
  resetMediaCapabilityLifecycle,
  type MediaCapabilityLifecycleDeps,
} from './mediaCapabilityController'

type Snapshot = Parameters<
  Parameters<MediaCapabilityLifecycleDeps['subscribe']>[0]
>[0]

function descriptor(
  id: string,
  over: Partial<PortableAssetDescriptor> = {},
): PortableAssetDescriptor {
  return {
    id,
    fileName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 100,
    kind: 'video',
    durationMicroseconds: 1_000_000,
    nativeFrameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    ...over,
  }
}

function asset(id: string, objectUrl: string): MediaAsset {
  const source = descriptor(id)
  return {
    id: source.id,
    fileName: source.fileName,
    mimeType: source.mimeType,
    size: source.size,
    lastModified: source.lastModified,
    objectUrl,
    kind: source.kind,
    durationFrames: 30,
    durationMicroseconds: source.durationMicroseconds,
    frameRate: { num: 30, den: 1 },
    width: source.width,
    height: source.height,
    hasAudio: source.hasAudio,
    audioSampleRate: source.audioSampleRate,
    audioChannels: source.audioChannels,
    decoderConfigB64: null,
  }
}

function compatibility(id: string): MediaCompatibilityItem {
  return {
    id,
    requestId: `request-${id}`,
    fileName: `${id}.mp4`,
    declaredMimeType: 'video/mp4',
    size: 1_024,
    lastModified: 100,
    status: 'checking',
    report: null,
  }
}

function snapshot(
  descriptors: PortableAssetDescriptor[] = [],
  assets: MediaAsset[] = [],
  compatibilityItems: MediaCompatibilityItem[] = [],
): Snapshot {
  return {
    descriptors: new Map(descriptors.map((entry) => [entry.id, entry])),
    assets: new Map(assets.map((entry) => [entry.id, entry])),
    compatibility: new Map(
      compatibilityItems.map((entry) => [entry.id, entry]),
    ),
  }
}

function harness() {
  let listener: Parameters<MediaCapabilityLifecycleDeps['subscribe']>[0]
    | null = null
  let visible: DocumentVisibilityState = 'hidden'
  const documentEvents = new EventTarget()
  const windowEvents = new EventTarget()
  const unsubscribe = vi.fn()
  const invalidateSource = vi.fn()
  const invalidateRuntime = vi.fn()
  const deps: MediaCapabilityLifecycleDeps = {
    subscribe: vi.fn((next) => {
      listener = next
      return unsubscribe
    }),
    documentEvents,
    windowEvents,
    visibilityState: () => visible,
    invalidateSource,
    invalidateRuntime,
  }
  return {
    deps,
    documentEvents,
    windowEvents,
    invalidateSource,
    invalidateRuntime,
    unsubscribe,
    publish(current: Snapshot, previous: Snapshot) {
      if (!listener) throw new Error('Lifecycle listener was not installed')
      listener(current, previous)
    },
    setVisibility(next: DocumentVisibilityState) {
      visible = next
    },
  }
}

describe('media capability lifecycle', () => {
  beforeEach(() => resetMediaCapabilityLifecycle())
  afterEach(() => resetMediaCapabilityLifecycle())

  test('invalidates removed, replaced, and provisional sources once', () => {
    const h = harness()
    const dispose = initMediaCapabilityLifecycle(h.deps)
    const firstDescriptor = descriptor('camera')
    const firstAsset = asset('camera', 'blob:camera-1')

    h.publish(
      snapshot(
        [{ ...firstDescriptor }],
        [{ ...firstAsset, durationFrames: 60 }],
      ),
      snapshot([firstDescriptor], [firstAsset]),
    )
    expect(h.invalidateSource).not.toHaveBeenCalled()

    h.publish(
      snapshot(
        [descriptor('camera', { size: 2_048 })],
        [asset('camera', 'blob:camera-2')],
      ),
      snapshot([firstDescriptor], [firstAsset]),
    )
    expect(h.invalidateSource).toHaveBeenCalledTimes(1)
    expect(h.invalidateSource).toHaveBeenLastCalledWith('camera')

    h.invalidateSource.mockClear()
    h.publish(
      snapshot(),
      snapshot(
        [firstDescriptor],
        [firstAsset],
        [compatibility('camera')],
      ),
    )
    expect(h.invalidateSource).toHaveBeenCalledTimes(1)
    expect(h.invalidateSource).toHaveBeenCalledWith('camera')

    h.invalidateSource.mockClear()
    h.publish(snapshot(), snapshot([], [], [compatibility('provisional')]))
    expect(h.invalidateSource).toHaveBeenCalledWith('provisional')
    dispose()
  })

  test('invalidates runtime facts only on a visible resume or BFCache restore', () => {
    const h = harness()
    const dispose = initMediaCapabilityLifecycle(h.deps)

    h.documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(h.invalidateRuntime).not.toHaveBeenCalled()
    h.setVisibility('visible')
    h.documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(h.invalidateRuntime).toHaveBeenCalledTimes(1)

    const ordinaryShow = new Event('pageshow')
    Object.defineProperty(ordinaryShow, 'persisted', { value: false })
    h.windowEvents.dispatchEvent(ordinaryShow)
    expect(h.invalidateRuntime).toHaveBeenCalledTimes(1)
    const restored = new Event('pageshow')
    Object.defineProperty(restored, 'persisted', { value: true })
    h.windowEvents.dispatchEvent(restored)
    expect(h.invalidateRuntime).toHaveBeenCalledTimes(2)

    dispose()
    h.windowEvents.dispatchEvent(restored)
    expect(h.invalidateRuntime).toHaveBeenCalledTimes(2)
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })

  test('shares one listener set until every initializer releases it', () => {
    const h = harness()
    const first = initMediaCapabilityLifecycle(h.deps)
    const second = initMediaCapabilityLifecycle(h.deps)
    expect(h.deps.subscribe).toHaveBeenCalledOnce()

    first()
    expect(h.unsubscribe).not.toHaveBeenCalled()
    second()
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })
})
