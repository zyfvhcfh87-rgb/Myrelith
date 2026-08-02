/**
 * Worker-side compatibility delegate for the retired keyframe-batch render
 * path. It owns every legacy decoder/cache/loan and exposes only lifecycle and
 * message handlers to the current streaming render worker.
 */

import type { AssetId, ClipId } from '../domain/schema'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import type {
  BitmapLike,
  ChunkPayload,
  DecodableFrame,
  VideoDecoderLike,
} from './decode-types'
import type {
  CompositeSourceEntry,
  LegacyCompositeMessage,
  LegacyConfigureAssetMessage,
} from './render-legacy-protocol'
import type { FromRenderWorker } from './render-protocol'

const QUEUE_HIGH_WATER = 8
const CACHE_CAPACITY = 12

export interface LegacyFrameCache<T> {
  keys(): Iterable<number>
  take(key: number): T | null
  put(key: number, value: T): void
  clear(): void
}

export interface LegacyFrameSource {
  getFrame(assetId: AssetId, sourceFrame: number): Promise<BitmapLike | null>
}

interface LegacyCompositeResult {
  drawn: ClipId[]
  missing: ClipId[]
}

export interface LegacyRenderWorkerEnv {
  post(msg: FromRenderWorker): void
  createDecoder(init: {
    output: (frame: DecodableFrame) => void
    error: (error: { message: string }) => void
  }): VideoDecoderLike
  isConfigSupported(config: VideoDecoderConfig): Promise<{ supported?: boolean }>
  createChunk(payload: ChunkPayload): unknown
  createBitmap(frame: DecodableFrame): Promise<BitmapLike>
  now(): number
}

interface LegacyRenderWorkerHost {
  supersede(): number
  generationIsCurrent(generation: number): boolean
  isReady(): boolean
  createCache(capacity: number): LegacyFrameCache<BitmapLike>
  enqueueComposite(run: () => Promise<void>): Promise<void>
  composite(
    plan: VideoCompositionPlan,
    source: LegacyFrameSource,
  ): Promise<LegacyCompositeResult>
  present(): void
}

export interface LegacyRenderWorkerCompatibility {
  wakeAll(): void
  releaseAsset(assetId: AssetId): void
  configureAsset(
    message: LegacyConfigureAssetMessage,
    isCurrent: () => boolean,
  ): Promise<void>
  handleComposite(message: LegacyCompositeMessage): Promise<void>
  close(): void
}

interface LegacyAssetState {
  config: VideoDecoderConfig
  decoder: VideoDecoderLike | null
  cache: LegacyFrameCache<BitmapLike>
  waiters: Set<() => void>
  chain: Promise<void>
  epoch: number
  dead: boolean
  batchJobs: Array<Promise<void>>
}

interface LegacyBitmapLoan {
  state: LegacyAssetState
  epoch: number
  key: number
  bitmap: BitmapLike
}

export function createLegacyRenderWorkerCompatibility(
  env: LegacyRenderWorkerEnv,
  host: LegacyRenderWorkerHost,
): LegacyRenderWorkerCompatibility {
  const assets = new Map<AssetId, LegacyAssetState>()

  function wake(state: LegacyAssetState): void {
    const waiters = [...state.waiters]
    state.waiters.clear()
    for (const wakeOne of waiters) wakeOne()
  }

  function wakeAll(): void {
    for (const state of assets.values()) wake(state)
  }

  function waitForWake(state: LegacyAssetState): Promise<void> {
    return new Promise((resolve) => state.waiters.add(resolve))
  }

  function findCachedKey(
    cache: LegacyFrameCache<BitmapLike>,
    targetTimestampUs: number,
    toleranceUs: number,
  ): number | null {
    for (const key of cache.keys()) {
      if (Math.abs(key - targetTimestampUs) <= toleranceUs) return key
    }
    return null
  }

  function teardownAsset(state: LegacyAssetState): void {
    state.epoch++
    state.dead = true
    state.decoder?.close()
    state.decoder = null
    state.cache.clear()
    wake(state)
  }

  function releaseAsset(assetId: AssetId): void {
    const state = assets.get(assetId)
    if (!state) return
    teardownAsset(state)
    assets.delete(assetId)
  }

  async function resolveEntry(
    state: LegacyAssetState,
    entry: CompositeSourceEntry,
    generation: number,
    loans: LegacyBitmapLoan[],
    requestId: number,
  ): Promise<BitmapLike | null> {
    if (!host.generationIsCurrent(generation) || state.dead) return null
    const decoder = state.decoder
    if (!decoder) return null

    const cachedKey = findCachedKey(
      state.cache,
      entry.targetTimestampUs,
      entry.toleranceUs,
    )
    if (cachedKey !== null) {
      const bitmap = state.cache.take(cachedKey) as BitmapLike
      loans.push({ state, epoch: state.epoch, key: cachedKey, bitmap })
      return bitmap
    }

    if (entry.chunks.length === 0) return null
    if (entry.chunks[0].type !== 'key') {
      env.post({
        type: 'error',
        requestId,
        assetId: entry.assetId,
        message: 'composite batch must start with a keyframe chunk',
      })
      return null
    }

    try {
      decoder.reset()
      decoder.configure(state.config)

      for (const chunk of entry.chunks) {
        while (decoder.decodeQueueSize >= QUEUE_HIGH_WATER) {
          if (!host.generationIsCurrent(generation) || state.dead) return null
          await waitForWake(state)
          if (!host.generationIsCurrent(generation) || state.dead) return null
        }
        if (!host.generationIsCurrent(generation) || state.dead) return null
        decoder.decode(env.createChunk(chunk))
      }
      try {
        await decoder.flush()
      } catch {
        // Supersession and decoder faults are resolved by the checks below.
      }
    } catch (error) {
      if (
        host.generationIsCurrent(generation)
        && !state.dead
        && assets.get(entry.assetId) === state
      ) {
        env.post({
          type: 'error',
          requestId,
          assetId: entry.assetId,
          message: `decode failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      return null
    }

    await Promise.allSettled(state.batchJobs.splice(0))
    if (!host.generationIsCurrent(generation)) return null

    const key = findCachedKey(
      state.cache,
      entry.targetTimestampUs,
      entry.toleranceUs,
    )
    if (key === null) return null
    const bitmap = state.cache.take(key) as BitmapLike
    loans.push({ state, epoch: state.epoch, key, bitmap })
    return bitmap
  }

  async function configureAsset(
    message: LegacyConfigureAssetMessage,
    isCurrent: () => boolean,
  ): Promise<void> {
    let support: { supported?: boolean }
    try {
      support = await env.isConfigSupported(message.config)
    } catch (error) {
      if (!isCurrent()) return
      throw error
    }
    if (!isCurrent()) return
    if (!support.supported) {
      env.post({
        type: 'error',
        assetId: message.assetId,
        setupId: message.setupId,
        message: `codec not supported by this browser: ${message.config.codec}`,
      })
      return
    }

    const state: LegacyAssetState = {
      config: message.config,
      decoder: null,
      cache: host.createCache(CACHE_CAPACITY),
      waiters: new Set(),
      chain: Promise.resolve(),
      epoch: 0,
      dead: false,
      batchJobs: [],
    }
    state.decoder = env.createDecoder({
      output: (frame) => {
        const timestampUs = frame.timestamp
        const epoch = state.epoch
        const job = env.createBitmap(frame)
          .then((bitmap) => {
            if (
              state.dead
              || state.epoch !== epoch
              || assets.get(message.assetId) !== state
            ) {
              bitmap.close()
              return
            }
            try {
              state.cache.put(timestampUs, bitmap)
            } catch {
              bitmap.close()
            }
          })
          .catch(() => undefined)
          .finally(() => frame.close())
        state.batchJobs.push(job)
      },
      error: (error) => {
        if (state.dead || assets.get(message.assetId) !== state) return
        state.dead = true
        wake(state)
        env.post({
          type: 'error',
          assetId: message.assetId,
          message: `decoder: ${error.message}`,
        })
      },
    })
    state.decoder.ondequeue = () => wake(state)
    state.decoder.configure(message.config)
    assets.set(message.assetId, state)
    env.post({
      type: 'assetConfigured',
      assetId: message.assetId,
      setupId: message.setupId,
    })
  }

  function postSuperseded(requestId: number): void {
    env.post({
      type: 'compositeDone',
      requestId,
      status: 'superseded',
      drawnClipIds: [],
      missingClipIds: [],
      renderMs: 0,
    })
  }

  function handleComposite(message: LegacyCompositeMessage): Promise<void> {
    const generation = host.supersede()

    const run = async (): Promise<void> => {
      if (!host.generationIsCurrent(generation)) {
        postSuperseded(message.requestId)
        return
      }
      if (!host.isReady()) {
        env.post({
          type: 'error',
          requestId: message.requestId,
          message: 'composite before init/setDoc',
        })
        return
      }
      if (message.plan.frame !== message.frame) {
        throw new Error('composite plan frame does not match request frame')
      }
      const startedAt = env.now()

      const table = new Map<string, CompositeSourceEntry>()
      for (const entry of message.sources) {
        table.set(`${entry.assetId}@${entry.sourceFrame}`, entry)
      }
      const memo = new Map<string, Promise<BitmapLike | null>>()
      const loans: LegacyBitmapLoan[] = []
      const source: LegacyFrameSource = {
        getFrame: (assetId, sourceFrame) => {
          const key = `${assetId}@${sourceFrame}`
          const memoized = memo.get(key)
          if (memoized) return memoized
          const entry = table.get(key)
          const state = entry ? assets.get(entry.assetId) : undefined
          let promise: Promise<BitmapLike | null>
          if (!entry || !state) {
            promise = Promise.resolve(null)
          } else {
            promise = state.chain.then(() => resolveEntry(
              state,
              entry,
              generation,
              loans,
              message.requestId,
            ))
            state.chain = promise.then(
              () => undefined,
              () => undefined,
            )
          }
          memo.set(key, promise)
          return promise
        },
      }

      let result: LegacyCompositeResult
      try {
        result = await host.composite(message.plan, source)
      } finally {
        for (const loan of loans) {
          if (loan.state.epoch === loan.epoch) {
            loan.state.cache.put(loan.key, loan.bitmap)
          } else {
            loan.bitmap.close()
          }
        }
      }

      if (!host.generationIsCurrent(generation)) {
        postSuperseded(message.requestId)
        return
      }
      host.present()
      env.post({
        type: 'compositeDone',
        requestId: message.requestId,
        status: 'drawn',
        drawnClipIds: result.drawn,
        missingClipIds: result.missing,
        renderMs: env.now() - startedAt,
      })
    }

    return host.enqueueComposite(() => run().catch((error) => {
      env.post({
        type: 'error',
        requestId: message.requestId,
        message: `composite failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      })
    }))
  }

  function close(): void {
    for (const state of assets.values()) teardownAsset(state)
    assets.clear()
  }

  return {
    wakeAll,
    releaseAsset,
    configureAsset,
    handleComposite,
    close,
  }
}
