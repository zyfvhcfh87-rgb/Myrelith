import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ProxyCacheEntry, ProxyCacheManifest } from '../domain/proxyCache'
import { PROXY_CACHE_SCHEMA_VERSION } from '../domain/proxyCache'
import type { MediaAsset } from '../domain/schema'
import { useMediaStore } from '../state/mediaStore'
import { useProxyStore } from '../state/proxyStore'
import type { PreparedExportFileCapability } from '../pipeline/export-file-target'
import {
  clearAllProxies,
  disposeProxyController,
  getProxySchedulerSnapshot,
  initProxyController,
  removeProxy,
  requestProxyGeneration,
  waitForProxyIdle,
  type ProxyControllerDeps,
} from './proxyController'
import {
  ProxyStorage,
  type ProxyStorageEntryCommit,
  type ProxyStorageEstimate,
} from './proxyStorage'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function asset(): MediaAsset {
  return {
    id: 'asset-1',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_000,
    objectUrl: 'blob:asset-1',
    kind: 'video',
    durationFrames: 240,
    // Audio is intentionally longer than the exact 2 s video stream.
    durationMicroseconds: 8_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: -250_000, endTimestampUs: 1_750_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 8_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
  }
}

class ControllerStorage extends ProxyStorage {
  entries: ProxyCacheEntry[] = []
  readonly commitEntered = deferred<void>()
  commitGate: Deferred<void> | null = null
  prepareCount = 0
  clearCount = 0
  removeCount = 0
  readGate: Deferred<void> | null = null
  readCount = 0

  constructor() {
    super({
      getRoot: async () => { throw new Error('unused') },
      estimate: async () => ({}),
      persisted: async () => false,
      now: () => 1,
      createToken: () => '1'.repeat(32),
    })
  }

  override async readManifest(): Promise<ProxyCacheManifest> {
    this.readCount++
    if (this.readGate) await this.readGate.promise
    return { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [...this.entries] }
  }

  override async estimate(): Promise<ProxyStorageEstimate> {
    return {
      cacheBytes: this.entries.reduce((sum, entry) => sum + entry.byteSize, 0),
      itemCount: this.entries.length,
      originUsageBytes: 0,
      originQuotaBytes: 1_000_000_000,
      persisted: false,
    }
  }

  override async ensureCapacity(): Promise<void> {}

  override async prepareFileCapability(cacheKey: string): Promise<PreparedExportFileCapability> {
    this.prepareCount++
    return {
      fileName: `${cacheKey}.${'1'.repeat(32)}.mp4`,
      takeFileHandle() {
        throw new Error('The injected generator does not consume a file handle')
      },
    }
  }

  override async commitEntry(entry: ProxyCacheEntry): Promise<ProxyStorageEntryCommit> {
    const previous = [...this.entries]
    this.commitEntered.resolve()
    if (this.commitGate) await this.commitGate.promise
    this.entries = [entry]
    let settled = false
    return {
      finalize: async () => { settled = true },
      rollback: async () => {
        if (settled) return
        settled = true
        this.entries = previous
      },
    }
  }

  override async discardFile(): Promise<void> {}

  override async removeAsset(assetId: string): Promise<void> {
    this.removeCount++
    this.entries = this.entries.filter((entry) => entry.assetId !== assetId)
  }

  override async clear(): Promise<void> {
    this.clearCount++
    this.entries = []
  }
}

function deps(
  storage: ControllerStorage,
  encoderSupported = true,
): ProxyControllerDeps {
  const generateProxy: ProxyControllerDeps['generateProxy'] = async (request) => {
    const capability = await request.openDestination()
    const durationMicroseconds = request.asset.videoBounds.endTimestampUs
      - request.asset.videoBounds.firstTimestampUs
    return {
      destination: 'file',
      fileName: capability.fileName,
      byteLength: 512,
      width: 1_280,
      height: 720,
      frameRate: request.asset.frameRate,
      durationMicroseconds,
      frameCount: 60,
    }
  }
  return {
    storage,
    fetchBlob: async () => new Blob([new Uint8Array(1_024)]),
    now: () => 5_000,
    probeEncoderSupport: async (_width, _height, rate) => ({
      supported: encoderSupported,
      reason: encoderSupported
        ? `exact ${rate.num / rate.den} fps supported`
        : `exact ${rate.num / rate.den} fps unsupported`,
    }),
    probeInputSupport: async () => ({ supported: true, reason: 'input supported' }),
    generateProxy,
  }
}

async function connectAndWaitAvailable(): Promise<void> {
  expect(useMediaStore.getState().addAsset(asset())).toBe(true)
  await vi.waitFor(() => {
    expect(useProxyStore.getState().assets.get('asset-1')?.phase).toBe('available')
  })
}

beforeEach(async () => {
  await disposeProxyController()
  useMediaStore.getState().clearAssets()
  useProxyStore.getState().reset()
})

afterEach(async () => {
  await disposeProxyController()
  useMediaStore.getState().clearAssets()
})

describe('proxy controller lifecycle and cache quiescing', () => {
  test('keeps a newer async initialization lease alive after an older mount releases', async () => {
    const storage = new ControllerStorage()
    storage.readGate = deferred<void>()
    const first = initProxyController(deps(storage))
    const second = initProxyController(deps(storage))

    storage.readGate.resolve()
    const [releaseFirst, releaseSecond] = await Promise.all([first, second])
    expect(storage.readCount).toBe(1)

    await releaseFirst()
    expect(getProxySchedulerSnapshot()).not.toBeNull()
    await releaseSecond()
    expect(getProxySchedulerSnapshot()).toBeNull()
  })

  test.each([
    ['remove', (assetId: string) => removeProxy(assetId)],
    ['clear', (_assetId: string) => clearAllProxies()],
  ] as const)('rolls back a queued late commit before %s resolves', async (_label, teardown) => {
    const storage = new ControllerStorage()
    storage.commitGate = deferred<void>()
    const release = await initProxyController(deps(storage))
    await connectAndWaitAvailable()
    expect(requestProxyGeneration('asset-1')).toBe(true)
    await storage.commitEntered.promise

    const teardownPromise = teardown('asset-1')
    await Promise.resolve()
    storage.commitGate.resolve()
    await teardownPromise
    await waitForProxyIdle()

    expect(storage.entries).toEqual([])
    expect(useProxyStore.getState().assets.get('asset-1')?.phase).not.toBe('ready')
    await release()
  })

  test('rolls back a queued late commit after the original source is replaced', async () => {
    const storage = new ControllerStorage()
    storage.commitGate = deferred<void>()
    const release = await initProxyController(deps(storage))
    await connectAndWaitAvailable()
    expect(requestProxyGeneration('asset-1')).toBe(true)
    await storage.commitEntered.promise

    const descriptor = useMediaStore.getState().descriptors.get('asset-1')
    expect(descriptor).toBeDefined()
    expect(useMediaStore.getState().replaceAssets(
      [descriptor!],
      [{ ...asset(), objectUrl: 'blob:asset-1-replacement' }],
    )).toBe(true)
    storage.commitGate.resolve()
    await waitForProxyIdle()

    expect(storage.entries).toEqual([])
    expect(useProxyStore.getState().assets.get('asset-1')?.phase).not.toBe('ready')
    await release()
  })

  test('keeps an unsupported exact frame rate disabled before output acquisition', async () => {
    const storage = new ControllerStorage()
    const baseDeps = deps(storage, false)
    const probeInputSupport = vi.fn(baseDeps.probeInputSupport)
    const controllerDeps: ProxyControllerDeps = { ...baseDeps, probeInputSupport }
    const release = await initProxyController(controllerDeps)
    expect(useMediaStore.getState().addAsset(asset())).toBe(true)

    await vi.waitFor(() => {
      const item = useProxyStore.getState().assets.get('asset-1')
      expect(item?.canGenerate).toBe(false)
      expect(item?.detail).toContain('30 fps unsupported')
    })
    expect(requestProxyGeneration('asset-1')).toBe(false)
    expect(storage.prepareCount).toBe(0)
    expect(probeInputSupport).not.toHaveBeenCalled()
    await release()
  })
})
