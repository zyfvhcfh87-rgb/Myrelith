import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import { audioFeatureIdentity, type AudioFeatureCacheEntry } from '../domain/analysisCache'
import { correlateAudioFingerprints, decodeAudioFingerprint, encodeAudioFingerprint,
  MULTICAM_ALIGNMENT_LIMITS as LIMITS, type AudioAlignmentResult, type AudioFingerprint } from '../domain/multicamAlignment'
import { audioFeatureKeyPreimage, audioPairKeyPreimage, type AudioFeatureIdentity } from '../domain/multicamAlignmentProvenance'
import type { FrameRate, MediaAsset } from '../domain/schema'
import { analysisStorage, type AnalysisStorage } from './analysisStorage'
import { createAudioAlignmentWorker } from './audioAlignmentWorkerBridge'
import { derivedDataIsClearing, registerDerivedDataOwner } from './derivedDataOwners'
import { MediaJobScheduler, type MediaJobContext } from './mediaJobScheduler'
import { fingerprintLocalMediaSource, sha256Hex } from './sourceFingerprint'

export interface AudioAlignmentSource { readonly angleId: string; readonly asset: MediaAsset; readonly startBin: number }
export interface AudioAlignmentRequest {
  readonly projectBindingId: string
  /** Reference first; 1–7 targets follow. */
  readonly sources: readonly AudioAlignmentSource[]
  readonly binCount: number
  readonly maxLagBins: number
  readonly rate: FrameRate
  readonly definitionDigest: string
  readonly current: () => boolean
  readonly progress: (fraction: number, detail: string) => void
}
export interface AudioAlignmentComparison {
  readonly angleId: string
  readonly pairKey: string
  readonly result: AudioAlignmentResult
  readonly fromCache: boolean
}
export interface AudioAlignmentServiceResult {
  readonly comparisons: readonly AudioAlignmentComparison[]
  readonly cacheHits: number
  readonly cacheWarnings: readonly string[]
}
export interface AudioAlignmentServiceDeps {
  readonly storage: Pick<AnalysisStorage, 'findAudioFeature' | 'readResult' | 'touch' | 'stageResult' | 'commitEntry'>
  readonly scheduler: MediaJobScheduler
  readonly worker: typeof createAudioAlignmentWorker
  readonly fetchBlob: (asset: MediaAsset, signal: AbortSignal) => Promise<Blob>
  readonly fingerprint: typeof fingerprintLocalMediaSource
  readonly hash: typeof sha256Hex
  readonly yieldControl: () => Promise<void>
  readonly now: () => number
}

export async function yieldAlignmentControl(): Promise<void> {
  const host = globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }
  if (host.scheduler?.yield) await host.scheduler.yield()
  else await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
export async function readAlignmentBlob(asset: MediaAsset, signal: AbortSignal): Promise<Blob> {
  if (!asset.objectUrl.startsWith('blob:')) throw new Error('Alignment requires a connected local source')
  const response = await fetch(asset.objectUrl, { signal })
  if (!response.ok) throw new Error('The local audio source could not be read')
  const blob = await response.blob()
  if (blob.size !== asset.size) throw new Error('The connected source size changed')
  return blob
}
function realDeps(): AudioAlignmentServiceDeps {
  return { storage: analysisStorage, scheduler: new MediaJobScheduler({ budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 } }),
    worker: createAudioAlignmentWorker, fetchBlob: readAlignmentBlob, fingerprint: fingerprintLocalMediaSource,
    hash: sha256Hex, yieldControl: yieldAlignmentControl, now: Date.now }
}

/** Read-only operations may time out; staged/committed writes instead retain admission until drained. */
export async function alignmentRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', abort); action() }
    const abort = () => finish(() => reject(signal.reason ?? new DOMException('Alignment cancelled', 'AbortError')))
    const timer = setTimeout(() => finish(() => reject(new Error('Reading local alignment data timed out'))), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    operation.then((value) => finish(() => resolve(value)), (cause) => finish(() => reject(cause)))
    if (signal.aborted) abort()
  })
}

export class AudioAlignmentService {
  private readonly deps: AudioAlignmentServiceDeps
  private generation = 0
  private active: { started: boolean; reject: (cause: unknown) => void } | null = null
  private disposed = false
  private readonly unregister: () => void
  constructor(deps: AudioAlignmentServiceDeps = realDeps()) {
    this.deps = deps
    this.unregister = registerDerivedDataOwner(() => this.cancelAndDrain())
  }
  snapshot() { return this.deps.scheduler.snapshot() }
  async cancelAndDrain(): Promise<void> {
    this.deps.scheduler.cancelAll('removed')
    if (this.active && !this.active.started) {
      this.active.reject(new DOMException('Alignment cancelled', 'AbortError'))
      this.active = null
    }
    await this.deps.scheduler.whenIdle()
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.cancelAndDrain()
    this.unregister()
    this.deps.scheduler.dispose()
  }
  run(request: AudioAlignmentRequest): Promise<AudioAlignmentServiceResult> {
    if (this.disposed || this.active || derivedDataIsClearing()) return Promise.reject(new Error('Alignment is busy, clearing derived data, or closed'))
    if (request.sources.length < 2 || request.sources.length > 8
      || new Set(request.sources.map((source) => source.angleId)).size !== request.sources.length
      || !Number.isSafeInteger(request.binCount) || request.binCount < LIMITS.minBins || request.binCount > LIMITS.maxBins
      || !Number.isSafeInteger(request.maxLagBins) || request.maxLagBins < LIMITS.minLagBins || request.maxLagBins > LIMITS.maxLagBins
      || request.sources.some((source) => !Number.isSafeInteger(source.startBin) || source.startBin < 0
        || source.startBin + request.binCount > LIMITS.maxSourceSeconds * LIMITS.featureRate || !source.asset.hasAudio)) {
      return Promise.reject(new RangeError('Choose 2–8 connected audio angles and bounded 5–30 second windows'))
    }
    // Admit immutable request facts. Browser source references remain app-owned.
    const owned = { ...request, sources: request.sources.map((source) => ({ ...source })), rate: { ...request.rate } }
    return new Promise((resolve, reject) => {
      const active = { started: false, reject }
      this.active = active
      try {
        this.deps.scheduler.enqueue({ id: 'multicam-alignment', generation: ++this.generation, priority: 'selected', resources: { decoderSlots: 1 },
          run: async (context) => {
            active.started = true
            try { resolve(await this.analyze(owned, context)) }
            catch (cause) {
              const failure = context.signal.aborted ? new DOMException('Audio alignment cancelled', 'AbortError') : cause
              reject(failure)
              throw failure
            }
            finally { if (this.active === active) this.active = null }
          },
        })
      } catch (cause) { this.active = null; reject(cause) }
    })
  }
  private async analyze(request: AudioAlignmentRequest, context: MediaJobContext): Promise<AudioAlignmentServiceResult> {
    const { signal } = context
    const current = () => { signal.throwIfAborted(); if (!request.current()) throw new Error('The project or a connected source changed. Analyze again.') }
    const report = (fraction: number, detail: string) => { current(); context.reportProgress(fraction); request.progress(fraction, detail) }
    const warnings: string[] = []
    let cacheHits = 0
    let reference: { key: string; fingerprint: AudioFingerprint; fromCache: boolean } | null = null
    const comparisons: AudioAlignmentComparison[] = []
    for (let index = 0; index < request.sources.length; index++) {
      current()
      const source = request.sources[index]
      report(index / request.sources.length, `Reading ${source.asset.fileName}`)
      const blob = await alignmentRead(this.deps.fetchBlob(source.asset, signal), signal)
      current()
      const fingerprint = await alignmentRead(this.deps.fingerprint(blob, source.asset), signal)
      current()
      const worker = this.deps.worker(signal, context.setActiveDecoderCount,
        (fraction) => report((index + fraction * 0.6) / request.sources.length, `Analyzing ${source.asset.fileName}`))
      let feature: { key: string; fingerprint: AudioFingerprint; fromCache: boolean }
      try {
        const facts = await worker.open(blob, source.asset.id, mediaAssetDecoderBudget(source.asset, blob.size))
        current()
        const startSample = Math.round(source.startBin * facts.inputSampleRate / LIMITS.featureRate)
        const identity: AudioFeatureIdentity = {
          projectBindingId: request.projectBindingId, assetId: source.asset.id, sourceFingerprint: fingerprint,
          audioStreamIndex: facts.audioStreamIndex, audioTrackId: facts.audioTrackId,
          decodePolicyDigest: await alignmentRead(this.deps.hash(new TextEncoder().encode(facts.decodePolicy)), signal),
          timestampOrigin: 'source-presentation-zero-continuous-v1', inputSampleRate: facts.inputSampleRate,
          channels: facts.channels, startSample, binCount: request.binCount,
          sourceSampleCount: Math.ceil(request.binCount * facts.inputSampleRate / LIMITS.featureRate),
        }
        const preimage = audioFeatureKeyPreimage(identity)
        if (facts.inputSampleRate !== source.asset.audioSampleRate || facts.channels !== source.asset.audioChannels
          || startSample / facts.inputSampleRate < Math.max(0, facts.firstTimestamp)
          || (startSample + identity.sourceSampleCount) / facts.inputSampleRate > facts.endTimestamp + 0.25 / facts.inputSampleRate) {
          throw new Error('The complete selected audio window does not match the connected source coverage')
        }
        const key = await alignmentRead(this.deps.hash(new TextEncoder().encode(preimage)), signal)
        current()
        let cached: AudioFingerprint | null = null
        try {
          const entry = await alignmentRead(this.deps.storage.findAudioFeature(key), signal)
          current()
          if (entry && audioFeatureKeyPreimage(audioFeatureIdentity(entry)) === preimage) {
            cached = decodeAudioFingerprint(identity, await alignmentRead(this.deps.storage.readResult(entry), signal))
            current()
            await this.deps.storage.touch(key)
          }
        } catch (cause) {
          current()
          cached = null
          warnings.push(`Cache unavailable for ${source.asset.fileName}: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
        current()
        if (cached) {
          cacheHits++
          feature = { key, fingerprint: cached, fromCache: true }
        } else {
          const decoded = await worker.decode(identity)
          current()
          // The worker result must match this exact admitted window, not merely be structurally valid.
          if (decoded.inputSampleRate !== identity.inputSampleRate || decoded.channels !== identity.channels
            || decoded.startSample !== identity.startSample || decoded.sourceSampleCount !== identity.sourceSampleCount
            || decoded.values.length !== identity.binCount) throw new Error('Audio worker returned a different source window')
          feature = { key, fingerprint: decoded, fromCache: false }
          let staged: Awaited<ReturnType<AnalysisStorage['stageResult']>> | null = null
          let transaction: Awaited<ReturnType<AnalysisStorage['commitEntry']>> | null = null
          try {
            const bytes = encodeAudioFingerprint(decoded)
            staged = await this.deps.storage.stageResult(key, bytes, identity)
            current()
            const now = this.deps.now()
            const entry: AudioFeatureCacheEntry = { ...identity, cacheKind: 'audio-feature', cacheKey: key,
              resultFileName: staged.fileName, resultBytes: bytes.byteLength, createdAt: now, lastUsedAt: now }
            transaction = await this.deps.storage.commitEntry(entry)
            current()
            await transaction.finalize()
            transaction = null
            staged = null
          } catch (cause) {
            // Keep the job/decoder reservation until late storage ownership is settled.
            if (transaction) await transaction.rollback()
            if (staged) await staged.discard()
            current()
            warnings.push(`Could not cache ${source.asset.fileName}: ${cause instanceof Error ? cause.message : String(cause)}`)
          }
        }
      } finally { worker.close() }
      current()
      if (!reference) { reference = feature; continue }
      const pairKey = await alignmentRead(this.deps.hash(new TextEncoder().encode(audioPairKeyPreimage({
        referenceFeatureKey: reference.key, targetFeatureKey: feature.key, projectRate: request.rate,
        maxLagBins: request.maxLagBins, definitionDigest: request.definitionDigest,
      }))), signal)
      const iterator = correlateAudioFingerprints(reference.fingerprint, feature.fingerprint, request.rate, request.maxLagBins)
      try {
        for (;;) {
          current()
          const step = iterator.next()
          if (step.done) {
            comparisons.push({ angleId: source.angleId, pairKey, result: step.value, fromCache: reference.fromCache && feature.fromCache })
            break
          }
          await this.deps.yieldControl()
        }
      } finally { iterator.return({ state: 'unavailable', reason: 'invalid-input', facts: { score: null, alternativeScore: null, margin: null, overlapBins: 0, evaluatedLags: 0, comparisons: 0 } }) }
    }
    report(1, 'Audio proposals ready for review')
    return { comparisons, cacheHits, cacheWarnings: warnings }
  }
}
