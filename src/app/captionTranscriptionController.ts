/** Lazy caption speech facade: one source, one owner, one resource-free review. */
import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import { installedSpeechModel, installSpeechModel, removeSpeechModel, type InstalledSpeechModel } from '../codecs/speech/modelCache'
import { SPEECH_MODEL } from '../domain/speechModel'
import { projectSpeechCue } from '../domain/speechTimeline'
import type { SpeechTranscript } from '../domain/speechTranscript'
import type { CaptionItem, CaptionTrack, MediaAsset } from '../domain/schema'
import { compareCaptionItems } from '../domain/captions'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { CaptionEditSession } from './captionEditingController'
import { fingerprintLocalMediaSource } from './sourceFingerprint'
import { MediaJobScheduler } from './mediaJobScheduler'
import { mediaResourceAdmission } from './mediaResourceAdmission'
import { registerDerivedDataOwner, derivedDataIsClearing } from './derivedDataOwners'
import { registerSpeechRetirement, speechEssentialAdmissionPending, type SpeechRetirementReason } from './speechRetirement'
import { SpeechWorkerJob, type SpeechWorkerPort } from './speechWorkerJob'

export interface SpeechSelection { assetId: string; startMicroseconds: number; endMicroseconds: number; targetFrame: number; language: 'en' | 'fr' }
export interface SpeechReviewRow {
  readonly id: string; readonly text: string; readonly startFrame: number | null; readonly endFrame: number | null
  readonly included: boolean; readonly timing: 'model' | 'manual'; readonly sourceStartSample: number; readonly sourceSampleCount: number
}
export interface CaptionTranscriptionSnapshot {
  readonly phase: 'idle' | 'installing' | 'preparing' | 'running' | 'stopping' | 'review' | 'error'
  readonly message: string; readonly progress: number; readonly installed: InstalledSpeechModel | null
  readonly rows: readonly SpeechReviewRow[]; readonly sourceSampleRate: number; readonly error: string | null
}
export interface SpeechControllerPort {
  installed(): Promise<InstalledSpeechModel | null>
  install(file: File | null, signal: AbortSignal, progress: (fraction: number) => void): Promise<InstalledSpeechModel>
  remove(): Promise<void>
  fetchBlob(url: string, signal: AbortSignal): Promise<Blob>
  fingerprint: typeof fingerprintLocalMediaSource
  createWorker?: () => SpeechWorkerPort
}
const realPort: SpeechControllerPort = { installed: installedSpeechModel, install: installSpeechModel, remove: removeSpeechModel,
  async fetchBlob(url, signal) { const response = await fetch(url, { signal }); if (!response.ok) throw new Error('Connected source cannot be read'); return response.blob() }, fingerprint: fingerprintLocalMediaSource }
const projectScope = () => { const state = useDocumentStore.getState(); return { project: state.project, generation: state.projectGeneration, sequence: state.activeSequenceId } }
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
interface ActiveSpeech { scope: { project: object; generation: number; sequence: string }; abort: AbortController; done: Promise<void>; job: SpeechWorkerJob | null }
interface ReviewOwner { session: CaptionEditSession; track: CaptionTrack }
export class CaptionTranscriptionController {
  private readonly port: SpeechControllerPort
  private readonly scheduler = new MediaJobScheduler({ budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 } })
  private active: ActiveSpeech | null = null
  private review: ReviewOwner | null = null
  private epoch = 0
  private blocked: string | null = null
  private snapshot: CaptionTranscriptionSnapshot = Object.freeze({ phase: 'idle', message: '', progress: 0, installed: null, rows: [], sourceSampleRate: 16000, error: null })
  private readonly listeners = new Set<() => void>()
  private disconnect: (() => void) | null = null
  private pin: { project: object; projectGeneration: number; sequence: string; asset: MediaAsset; compatibilityRequest: string | null } | null = null
  constructor(port: SpeechControllerPort = realPort) { this.port = port }
  getSnapshot = (): CaptionTranscriptionSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.disconnect) {
      const unregister = registerSpeechRetirement(this.retireForEssential)
      const unregisterDerived = registerDerivedDataOwner(() => this.cancel('Clearing local data'))
      const changed = () => { const scope = projectScope(); if ((this.pin && !this.current()) || (this.active && (this.active.scope.project !== scope.project || this.active.scope.generation !== scope.generation || this.active.scope.sequence !== scope.sequence))) void this.cancel('The project, sequence or connected source changed').catch(cause => this.fail(cause)) }
      const document = useDocumentStore.subscribe(changed), media = useMediaStore.subscribe(changed)
      this.disconnect = () => { unregister(); unregisterDerived(); document(); media() }
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) void this.cancel('Caption editor closed').then(() => {
        if (!this.listeners.size) { this.disconnect?.(); this.disconnect = null }
      }).catch(cause => this.fail(cause)) // Keep the retirement owner registered after failed cleanup.
    }
  }
  private publish(patch: Partial<CaptionTranscriptionSnapshot>) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch })
    for (const listener of this.listeners) { try { listener() } catch { /* Observers never own cleanup. */ } }
  }
  private fail(cause: unknown) { const detail = this.blocked ?? message(cause); this.publish({ phase: 'error', error: detail, message: detail }) }
  private current(): boolean {
    const pin = this.pin, document = useDocumentStore.getState(), media = useMediaStore.getState()
    return pin !== null && pin.project === document.project && pin.projectGeneration === document.projectGeneration
      && pin.sequence === document.activeSequenceId && pin.asset === media.assets.get(pin.asset.id)
      && pin.compatibilityRequest === (media.compatibility.get(pin.asset.id)?.requestId ?? null)
  }
  private available() {
    if (this.blocked) throw new Error(this.blocked)
    if (this.active) throw new Error('The previous speech operation is still closing')
    if (derivedDataIsClearing()) throw new Error('Local data is being cleared')
    if (speechEssentialAdmissionPending() || useTransportStore.getState().isPlaying
      || useSourceMonitorStore.getState().playbackOwner === 'source'
      || mediaResourceAdmission.snapshot().blockers.length > 0) throw new Error('Pause playback and finish Source, export or other analysis work before starting speech')
  }
  refresh = async (): Promise<void> => {
    const epoch = this.epoch
    try { const installed = await this.port.installed(); if (epoch === this.epoch) this.publish({ installed }) }
    catch (cause) { if (epoch === this.epoch) this.fail(cause) }
  }
  retireForEssential = (reason: SpeechRetirementReason): Promise<void> | null => {
    if (this.blocked) return Promise.reject(new Error(this.blocked))
    if (!this.active) return null // A complete text review does not hold native resources.
    return this.cancel(`${reason} is waiting for speech cleanup (up to the current 120 second window deadline)`)
  }
  cancel = async (reason = 'Speech cancelled'): Promise<void> => {
    this.epoch++
    this.pin = null
    this.review?.session.dispose(); this.review = null
    const active = this.active
    this.publish({ rows: [], phase: active ? 'stopping' : this.blocked ? 'error' : 'idle', message: reason, error: this.blocked })
    if (active) {
      active.abort.abort()
      if (active.job) await active.job.cancel()
      await active.done
    }
    if (this.blocked) throw new Error(this.blocked)
    if (this.active === active) this.active = null
    if (!this.active && this.snapshot.phase === 'stopping') this.publish({ phase: 'idle', progress: 0 })
  }
  install = (file: File | null): void => {
    try { this.available() } catch (cause) { this.fail(cause); return }
    const epoch = ++this.epoch
    this.review?.session.dispose(); this.review = null; this.pin = null
    const active: ActiveSpeech = { scope: projectScope(), abort: new AbortController(), done: Promise.resolve(), job: null }
    this.active = active
    this.publish({ phase: 'installing', message: 'Installing the verified local speech model', progress: 0, rows: [], error: null })
    active.done = Promise.resolve().then(async () => {
      active.abort.signal.throwIfAborted()
      const installed = await this.port.install(file, active.abort.signal, progress => {
        if (this.active === active && epoch === this.epoch) this.publish({ progress })
      })
      if (epoch === this.epoch) this.publish({ installed, phase: 'idle', message: 'Speech model installed. Audio stays on this device.', progress: 1 })
    }).catch(cause => { if (epoch === this.epoch) this.fail(cause) }).finally(() => { if (this.active === active) this.active = null })
  }
  remove = async (): Promise<void> => {
    try { if (this.active) throw new Error('Cancel the current speech operation before removing its model'); if (this.blocked) throw new Error(this.blocked) }
    catch (cause) { this.fail(cause); return }
    const epoch = ++this.epoch
    this.review?.session.dispose(); this.review = null; this.pin = null
    const active: ActiveSpeech = { scope: projectScope(), abort: new AbortController(), done: Promise.resolve(), job: null }
    this.active = active
    this.publish({ phase: 'stopping', rows: [], message: 'Removing the local speech model', error: null })
    active.done = Promise.resolve().then(() => this.port.remove()).then(() => {
      if (epoch === this.epoch) this.publish({ installed: null, phase: 'idle', message: 'The local speech model was removed.', error: null })
    }).catch(cause => { if (epoch === this.epoch) this.fail(cause) }).finally(() => { if (this.active === active) this.active = null })
    await active.done
  }
  start = (selection: SpeechSelection): void => {
    try {
      this.available()
      const document = useDocumentStore.getState(), media = useMediaStore.getState(), asset = media.assets.get(selection.assetId)
      if (!asset || !asset.hasAudio || !['audio', 'video'].includes(asset.kind)) throw new Error('Choose one connected source with audio')
      const range = speechSourceRange(asset)
      if (!['en', 'fr'].includes(selection.language) || !Number.isSafeInteger(selection.startMicroseconds) || selection.startMicroseconds < range.startMicroseconds
        || !Number.isSafeInteger(selection.endMicroseconds) || selection.endMicroseconds > range.endMicroseconds
        || selection.endMicroseconds - selection.startMicroseconds < 1_000_000 || selection.endMicroseconds - selection.startMicroseconds > 300_000_000
        || !Number.isSafeInteger(selection.targetFrame) || selection.targetFrame < 0 || selection.targetFrame > 1_000_000_000) throw new Error(`Select 1–300 seconds inside audio coverage (${range.startMicroseconds / 1_000_000}–${range.endMicroseconds / 1_000_000} seconds) and a nonnegative insertion frame`)
      this.review?.session.dispose(); this.review = null
      this.pin = { project: document.project, projectGeneration: document.projectGeneration, sequence: document.activeSequenceId,
        asset, compatibilityRequest: media.compatibility.get(asset.id)?.requestId ?? null }
      const epoch = ++this.epoch, runId = crypto.randomUUID()
      const active: ActiveSpeech = { scope: projectScope(), abort: new AbortController(), done: Promise.resolve(), job: null }
      this.active = active
      const current = () => { active.abort.signal.throwIfAborted(); if (epoch !== this.epoch || !this.current()) throw new Error('Speech source or project changed') }
      this.publish({ phase: 'preparing', message: 'Checking the installed model and connected source', progress: 0, rows: [], error: null })
      active.done = Promise.resolve().then(async () => {
        current()
        const installed = await this.port.installed(); current()
        if (!installed) throw new Error('Install the local speech model first')
        const blob = await this.port.fetchBlob(asset.objectUrl, active.abort.signal); current()
        const fingerprint = await this.port.fingerprint(blob, asset); current()
        let transcript: SpeechTranscript | null = null
        this.scheduler.enqueue({ id: runId, generation: epoch, priority: 'selected', resources: { decoderSlots: 1 }, run: async context => {
          try {
            current()
            const job = new SpeechWorkerJob({ type: 'transcribe', requestId: runId, modelCache: installed.name,
              blob, sourceId: asset.id, budget: mediaAssetDecoderBudget(asset, blob.size), ...selection },
            (phase, progress) => {
              if (epoch === this.epoch && this.active === active) { context.reportProgress(progress); this.publish({ phase: 'running', message: phase, progress }) }
            }, failure => { this.blocked = failure; this.fail(failure) }, this.port.createWorker)
            active.job = job; context.setActiveDecoderCount(1)
            const abort = () => { void job.cancel().catch(cause => this.fail(cause)) }
            context.signal.addEventListener('abort', abort, { once: true }); active.abort.signal.addEventListener('abort', abort, { once: true })
            if (active.abort.signal.aborted) abort()
            try {
              const result = await job.result; current()
              transcript = result
            } catch (cause) { if (epoch === this.epoch) this.fail(cause) }
            finally {
              await job.retired
              context.signal.removeEventListener('abort', abort); active.abort.signal.removeEventListener('abort', abort)
              context.setActiveDecoderCount(0)
            }
          } catch (cause) { if (epoch === this.epoch) this.fail(cause) }
        } })
        await this.scheduler.whenIdle()
        current()
        if (transcript) {
          if (this.active === active) this.active = null
          this.prepareReview(transcript, selection, runId, fingerprint)
        }
      }).catch(cause => { if (epoch === this.epoch) this.fail(cause) }).finally(() => { if (this.active === active) this.active = null })
    } catch (cause) { this.fail(cause) }
  }
  private prepareReview(result: SpeechTranscript, selection: SpeechSelection, runId: string,
    fingerprint: Awaited<ReturnType<typeof fingerprintLocalMediaSource>>) {
    const session = new CaptionEditSession(), doc = session.document()
    const freshId = () => session.createId(() => `caption_${crypto.randomUUID()}`)
    try {
      const rate = result.sourceSampleRate
      const rows: SpeechReviewRow[] = result.windows.flatMap<SpeechReviewRow>(window => {
        if (window.timing === 'unavailable') return [{ id: freshId(), text: window.text, startFrame: null, endFrame: null,
          included: true, timing: 'manual' as const, sourceStartSample: window.sourceStartSample, sourceSampleCount: window.sourceSampleCount }]
        return window.segments.map(segment => {
          const start = window.sourceStartSample + Math.floor(segment.fromCentiseconds * rate / 100)
          const end = window.sourceStartSample + Math.ceil(segment.toCentiseconds * rate / 100)
          const { startFrame, endFrame } = projectSpeechCue(window.sourceStartSample - result.sourceStartSample,
            segment.fromCentiseconds, segment.toCentiseconds, rate, doc.frameRate, selection.targetFrame)
          return { id: freshId(), text: segment.text, startFrame, endFrame, included: true, timing: 'model' as const,
            sourceStartSample: start, sourceSampleCount: end - start }
        })
      })
      const track: CaptionTrack = { id: freshId(), name: `Transcription (${selection.language})`, language: selection.language,
        role: 'subtitles', stylePreset: 'classic', hidden: false, items: [], origin: { version: 1, params: {
          runId, sourceStartSample: result.sourceStartSample, sourceSampleCount: result.sourceSampleCount,
          modelId: SPEECH_MODEL.id, modelRevision: SPEECH_MODEL.revision, manifestDigest: SPEECH_MODEL.manifestDigest,
          runtimeVersion: SPEECH_MODEL.runtimeVersion, language: selection.language, sourceAssetId: selection.assetId,
          sourceFingerprintAlgorithm: fingerprint.algorithm, sourceFingerprintDigest: fingerprint.digest,
          sourceSampleRate: rate, targetFrameOffset: selection.targetFrame,
        } } }
      if (!this.current()) throw new Error('The project or connected source changed')
      this.review = { session, track }
      this.publish({ phase: 'review', sourceSampleRate: result.sourceSampleRate, rows: Object.freeze(rows.map(row => Object.freeze(row))), progress: 1, error: null,
        message: rows.length ? 'Review text and timing before Apply. Overlapping analysis windows may repeat words. Untimed text needs your own start/end frames or exclusion.' : 'No speech was detected in the selected source window.' })
    } catch (cause) { session.dispose(); throw cause }
  }
  updateRow = (id: string, patch: Partial<Pick<SpeechReviewRow, 'text' | 'startFrame' | 'endFrame' | 'included'>>): void => {
    if (!this.review || !this.current()) { void this.cancel('The project changed').catch(cause => this.fail(cause)); return }
    if (patch.text !== undefined && patch.text.length > 20_000) return
    this.publish({ error: null, rows: Object.freeze(this.snapshot.rows.map(row => row.id === id ? Object.freeze({ ...row, ...patch }) : row)) })
  }
  splitRow = (id: string): void => {
    if (!this.review || !this.current() || this.snapshot.rows.length >= 12_000) return
    const index = this.snapshot.rows.findIndex(row => row.id === id), row = this.snapshot.rows[index]
    if (!row || row.text.length < 2) return
    const midpoint = Math.floor(row.text.length / 2), space = row.text.indexOf(' ', midpoint), split = space > 0 ? space : midpoint
    const copy: SpeechReviewRow = { ...row, id: this.review.session.createId(() => `caption_${crypto.randomUUID()}`), text: row.text.slice(split).trim(),
      timing: 'manual', startFrame: null, endFrame: null }
    this.publish({ rows: Object.freeze([...this.snapshot.rows.slice(0, index), Object.freeze({ ...row, text: row.text.slice(0, split).trim(),
      timing: 'manual' as const, startFrame: null, endFrame: null }), Object.freeze(copy), ...this.snapshot.rows.slice(index + 1)]), error: null })
  }
  apply = (): boolean => {
    const owner = this.review
    if (!owner) return false
    try {
      if (!this.current()) throw new Error('The project or connected source changed. Transcribe again.')
      const selected = this.snapshot.rows.filter(row => row.included)
      if (!selected.length) throw new Error('Include at least one caption to apply')
      const items: CaptionItem[] = selected.map(row => {
        if (!Number.isSafeInteger(row.startFrame) || !Number.isSafeInteger(row.endFrame) || row.startFrame! < 0 || row.endFrame! <= row.startFrame!) throw new Error('Every included caption needs valid start/end frames. Time or exclude untimed text before Apply.')
        return { id: row.id, text: row.text, range: { startFrame: row.startFrame!, durationFrames: row.endFrame! - row.startFrame! },
          origin: { version: 1, params: { runId: owner.track.origin!.params.runId!, sourceStartSample: row.sourceStartSample, sourceSampleCount: row.sourceSampleCount } } }
      }).sort(compareCaptionItems)
      const doc = owner.session.document()
      const review = owner.session.prepareDocument({ ...doc, captionTracks: [...doc.captionTracks ?? [], { ...owner.track, items }] }, { changedCueCount: items.length })
      if (this.review !== owner || !this.current()) throw new Error('The caption review changed before Apply')
      const pin = this.pin
      this.pin = null
      const error = owner.session.apply(review)
      if (error) { this.pin = pin; throw new Error(error) }
      this.review = null
      this.epoch++
      this.publish({ phase: 'idle', rows: [], error: null, message: `Added ${items.length} captions. Undo removes the whole transcription.` })
      return true
    } catch (cause) { this.publish({ error: message(cause) }); return false }
  }
}
/** Source timestamps stay absolute; never pad or shift delayed audio. */
export function speechSourceRange(asset: MediaAsset) {
  const audio = asset.sourceBounds.audio
  return {
    startMicroseconds: audio?.status === 'exact' ? Math.max(0, audio.firstTimestampUs) : 0,
    endMicroseconds: audio?.status === 'exact'
      ? Math.min(asset.durationMicroseconds, audio.endTimestampUs) : asset.durationMicroseconds,
  }
}
export const captionTranscription = new CaptionTranscriptionController()
export { SPEECH_MODEL }
