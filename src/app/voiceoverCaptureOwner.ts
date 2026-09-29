/** One app-owned microphone session. Native resources never enter Zustand. */
import { checkVoiceoverDestination, pinVoiceoverDestination, resolveVoiceoverKeepDestination, type VoiceoverDestinationContext } from '../domain/voiceoverDestination'
import { beginVoiceoverSession, transitionVoiceoverSession, type VoiceoverFailure, type VoiceoverInterruption, type VoiceoverSession, type VoiceoverSessionEffect, type VoiceoverSessionEvent } from '../domain/voiceoverSession'
import { VOICEOVER_WAV_LIMITS } from '../pipeline/voiceoverWavDraft'
import { MAX_VOICEOVER_COMPENSATION_SECONDS, planVoiceoverSampleWindow, voiceoverCaptureSample, voiceoverLimitStop, voiceoverStopBoundary, voiceoverTimelineFrameAtSample } from '../domain/voiceoverClock'
import { useDocumentStore } from '../state/documentStore'
import { useVoiceoverCaptureStore, type VoiceoverCaptureStatus, type VoiceoverCaptureTiming } from '../state/voiceoverCaptureStore'
import { useTransportStore } from '../state/transportStore'
import { useMediaStore } from '../state/mediaStore'
import { importMediaFromHandle, cancelMediaImport, type MediaImportResult } from './mediaImportController'
import { placeImportedAsset, type PlaceImportedAssetResult } from './mediaPlacementController'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { localMediaHandleRegistry } from './localMediaHandles'
import { armVoiceoverTransport, getPlaybackClockContext, type VoiceoverTransportLease } from './transportController'
import { connectVoiceoverMicrophone, prepareVoiceoverMicrophoneWorklet } from './voiceoverMicrophoneBridge'
import { VoiceoverWavBridge } from './voiceoverWavBridge'
import { voiceoverDraftLockName } from '../domain/voiceoverDrafts'
import { avCaptureActive } from './avCaptureOwner'

type Capture = Awaited<ReturnType<typeof connectVoiceoverMicrophone>>
type Writer = Pick<VoiceoverWavBridge, 'create' | 'stop' | 'release' | 'recover' | 'discard' | 'close' | 'append'>
  & { finalize?: VoiceoverWavBridge['finalize'] }
  & { discardId?: VoiceoverWavBridge['discardId'] }
  & { readonly isClosed?: boolean }

export interface VoiceoverStartOptions {
  /** Integer frames at the document rate; defaults to one second. */
  countInFrames?: number
  /** Signed input-latency offset in samples (see voiceoverCaptureSample). */
  compensationSamples?: number
  mutePlayback?: boolean
  /** null lets the browser choose its default microphone. */
  deviceId?: string | null
}

export interface VoiceoverTransportExtras {
  mutePlayback: boolean
  preRollSamples: number
  onStopRequested(): void
}

/** Interruptions that leave the microphone usable end on a frame boundary and keep every written sample. */
const BOUNDARY_INTERRUPTIONS: ReadonlySet<VoiceoverInterruption> = new Set(['transport-changed', 'destination-changed'])
const STOP_LEAD_SAMPLES = 4_800
const MAX_COMPENSATION_SAMPLES = Math.floor(VOICEOVER_WAV_LIMITS.sampleRate * MAX_VOICEOVER_COMPENSATION_SECONDS)

export interface VoiceoverCaptureDeps {
  destinationContext(): VoiceoverDestinationContext
  requestMicrophone(deviceId: string | null): Promise<MediaStream>
  getContext(): AudioContext
  createWriter(): Writer
  connect(options: Parameters<typeof connectVoiceoverMicrophone>[0]): Promise<Capture>
  armTransport?(context: AudioContext, startFrame: number, countInFrames: number,
    onInterrupted: (reason: 'transport-changed' | 'destination-changed') => void,
    extras?: VoiceoverTransportExtras): Promise<VoiceoverTransportLease>
  /**
   * Hold a cross-tab lock naming this draft until the session is terminal, so
   * another tab's recovery list treats a take in review as live.
   */
  holdDraftLock?(sessionId: string): Promise<() => void>
  prepareWorklet?(context: AudioContext): Promise<void>
  visibleAndFocused(): boolean
  preflight?(): string | null
  startConflict?(): string | null
  importFinalized?(file: File, handle: FileSystemFileHandle): Promise<MediaImportResult>
  rememberOriginal?(assetId: string, handle: FileSystemFileHandle): Promise<void>
  importedDurationFrames?(assetId: string): number | null
  placeImported?(projectId: string, assetId: string, trackId: string, startFrame: number): PlaceImportedAssetResult
  cancelImport?(): void
  /** Fault-harness fallback; the app owner uses armTransport's shared anchor. */
  planStartFrame(context: AudioContext): number
  publish(status: VoiceoverCaptureStatus): void
  subscribeDocument?(onChange: () => void): () => void
  subscribePageEvents?(onHidden: () => void): () => void
}

interface Active {
  state: VoiceoverSession
  stream: MediaStream | null
  writer: Writer | null
  writerCreated: boolean
  writerStopped: boolean
  stopRetryRecovery: boolean
  capture: Capture | null
  preparing: Promise<void> | null
  cleanup: Promise<void>
  pendingStarted: boolean
  trackListeners: Array<() => void>
  sourceLabel: string | null
  capturedSamples: number
  diagnostic: string | null
  countInFrames: number
  compensationSamples: number
  mutePlayback: boolean
  inputPeak: number
  renderGapSamples: number
  /** A writer was asked to create this draft; a discard must remove its files. */
  draftMayExist: boolean
  releaseLock: (() => void) | null
  /** The shared playback clock the worklet renders on; outlives the transport lease. */
  context: AudioContext | null
  limit: { stopSample: number; stopFrame: number } | null
  transport: VoiceoverTransportLease | null
  timing: VoiceoverCaptureTiming | null
  requestedStopSample: number | null
  keepTask: Promise<void> | null
  keepImportPending: boolean
  keepCancelled: boolean
}

let editRevision = 0
let previousDocument = useDocumentStore.getState()

useDocumentStore.subscribe((current) => {
  if (current.project !== previousDocument.project ||
    current.projectGeneration !== previousDocument.projectGeneration ||
    current.activeSequenceId !== previousDocument.activeSequenceId ||
    current.doc !== previousDocument.doc) editRevision++
  previousDocument = current
})

/** Monotonic across edits, undo/redo, active-sequence navigation and replacement. */
export function currentVoiceoverDestinationContext(): VoiceoverDestinationContext {
  const current = useDocumentStore.getState()
  return { projectId: current.project.id, projectGeneration: current.projectGeneration,
    editRevision, doc: current.doc }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function permissionFailure(cause: unknown): VoiceoverFailure {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError') return 'permission-denied'
    if (cause.name === 'AbortError') return 'permission-dismissed'
  }
  return 'device-unavailable'
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return
  let firstError: unknown = null
  for (const track of stream.getTracks()) {
    if (track.readyState === 'ended') continue
    try { track.stop() } catch (cause) { firstError ??= cause }
  }
  if (firstError) throw firstError
}

export class VoiceoverCaptureOwner {
  private active: Active | null = null
  private readonly deps: VoiceoverCaptureDeps
  private readonly unsubscribe: (() => void) | null
  private readonly unsubscribePageEvents: (() => void) | null
  private readonly tasks = new Set<Promise<unknown>>()

  constructor(deps: VoiceoverCaptureDeps) {
    this.deps = deps
    this.unsubscribe = deps.subscribeDocument?.(() => this.onDocumentChange()) ?? null
    this.unsubscribePageEvents = deps.subscribePageEvents?.(() => this.onHidden()) ?? null
  }

  get status(): VoiceoverCaptureStatus {
    const active = this.active
    return { session: active?.state ?? null, sourceLabel: active?.sourceLabel ?? null,
      capturedSamples: active?.capturedSamples ?? 0, inputPeak: active?.inputPeak ?? 0,
      playbackMuted: active?.mutePlayback ?? false, renderGapSamples: active?.renderGapSamples ?? 0,
      diagnostic: active?.diagnostic ?? null,
      timing: active?.timing ?? null }
  }

  private publish(): void { this.deps.publish(this.status) }

  private watch(task: Promise<unknown>): void {
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task)).catch(() => {})
  }

  /** Test/teardown barrier. A pending native permission prompt keeps this pending. */
  async whenIdle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
  }

  /** Call from the click handler: permission is requested before the first await. */
  start(trackId: string, startFrame: number, options: VoiceoverStartOptions = {}): { status: 'started'; sessionId: string }
    | { status: 'rejected'; reason: string } {
    const { countInFrames } = options
    const compensation = options.compensationSamples ?? 0
    if (!Number.isSafeInteger(compensation) || Math.abs(compensation) > MAX_COMPENSATION_SAMPLES) {
      return { status: 'rejected', reason: 'Latency offset must be within half a second.' }
    }
    const prior = this.active?.state
    if (prior && prior.phase !== 'cancelled' && prior.phase !== 'failed' && prior.phase !== 'kept') {
      return { status: 'rejected', reason: 'A recording is already active or awaiting cleanup.' }
    }
    if (!this.deps.visibleAndFocused()) return { status: 'rejected', reason: 'The editor must be visible and focused.' }
    const conflict = this.deps.startConflict?.()
    if (conflict) return { status: 'rejected', reason: conflict }
    const pinned = pinVoiceoverDestination(this.deps.destinationContext(), trackId, startFrame)
    if (pinned.status !== 'pinned') return { status: 'rejected', reason: pinned.reason }
    if (pinned.destination.audioSampleRate !== VOICEOVER_WAV_LIMITS.sampleRate) {
      return { status: 'rejected', reason: 'Voiceover requires a 48 kHz project.' }
    }
    const countIn = countInFrames ?? Math.round(pinned.destination.frameRate.num / pinned.destination.frameRate.den)
    if (!Number.isSafeInteger(countIn) || countIn < 0 ||
      countIn > Math.ceil(pinned.destination.frameRate.num * 5 / pinned.destination.frameRate.den)) {
      return { status: 'rejected', reason: 'Count-in must be within five seconds.' }
    }
    const id = `voiceover_${crypto.randomUUID()}`
    const state = beginVoiceoverSession(prior ?? null, id, pinned.destination).state
    const active: Active = { state, stream: null, writer: null, writerCreated: false,
      writerStopped: false, stopRetryRecovery: false,
      capture: null, preparing: null, cleanup: Promise.resolve(), pendingStarted: false,
      trackListeners: [], sourceLabel: null, capturedSamples: 0, diagnostic: null,
      countInFrames: countIn, compensationSamples: compensation, mutePlayback: options.mutePlayback ?? false,
      inputPeak: 0, renderGapSamples: 0, draftMayExist: false, releaseLock: null, context: null, limit: null,
      transport: null, timing: null, requestedStopSample: null,
      keepTask: null, keepImportPending: false, keepCancelled: false }
    this.active = active
    this.publish()
    const unavailable = this.deps.preflight?.()
    if (unavailable) {
      active.diagnostic = unavailable
      this.publish()
      void this.dispatch(active, { sessionId: id, operation: 0, kind: 'failed', reason: 'unsupported' })
      return { status: 'rejected', reason: unavailable }
    }
    // Nothing asynchronous may precede this call; browsers can require the click activation.
    let permission: Promise<MediaStream>
    try { permission = this.deps.requestMicrophone(options.deviceId ?? null) }
    catch (cause) { permission = Promise.reject(cause) }
    this.watch(permission.then((stream) => this.permissionGranted(active, stream),
      (cause) => this.permissionRejected(active, cause)))
    return { status: 'started', sessionId: id }
  }

  private live(active: Active, operation: number, phase: VoiceoverSession['phase']): boolean {
    return this.active === active && active.state.operation === operation && active.state.phase === phase
  }

  private dispatch(active: Active, event: VoiceoverSessionEvent): Promise<void> {
    if (this.active !== active) return Promise.resolve()
    const decision = transitionVoiceoverSession(active.state, event)
    if (decision.state === active.state) return active.cleanup
    active.state = decision.state
    const phase = decision.state.phase
    if (phase === 'kept' || phase === 'cancelled' || phase === 'failed') this.releaseDraftLock(active)
    this.publish()
    if (!decision.effect) return active.cleanup
    const task = this.runEffect(active, decision.effect)
    this.watch(task)
    return task
  }

  private permissionGranted(active: Active, stream: MediaStream): void {
    if (!this.live(active, 0, 'requesting')) { stopTracks(stream); return }
    active.stream = stream
    active.sourceLabel = stream.getAudioTracks()[0]?.label || 'Microphone'
    for (const track of stream.getTracks()) {
      const ended = () => {
        if (this.active === active) void this.dispatch(active,
          { sessionId: active.state.sessionId, kind: 'interrupted', reason: 'source-ended' })
      }
      track.addEventListener('ended', ended)
      active.trackListeners.push(() => track.removeEventListener('ended', ended))
    }
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      void this.interrupt('source-ended')
      return
    }
    void this.dispatch(active, { sessionId: active.state.sessionId, operation: 0, kind: 'permission-granted' })
  }

  private permissionRejected(active: Active, cause: unknown): void {
    if (!this.live(active, 0, 'requesting')) return
    active.diagnostic = errorMessage(cause)
    this.publish()
    void this.dispatch(active, { sessionId: active.state.sessionId, operation: 0,
      kind: 'failed', reason: permissionFailure(cause) })
  }

  private runEffect(active: Active, effect: VoiceoverSessionEffect): Promise<void> {
    if (effect.kind === 'prepare-recording') {
      const task = this.prepare(active, effect.operation)
      active.preparing = task
      return task
    }
    if (effect.kind === 'request-permission') return Promise.resolve()
    if (effect.kind === 'keep') {
      const task = this.keepDraft(active, effect)
      active.keepTask = task
      void task.finally(() => { if (active.keepTask === task) active.keepTask = null }).catch(() => {})
      return task
    }
    const kind = effect.kind
    const normalStop = kind === 'stop' && this.finishesNormally(active)
    let stopPending: ReturnType<Capture['stop']> | null = null
    let graphError: unknown = null
    try {
      if (normalStop && active.capture) {
        stopPending = active.capture.stop(active.requestedStopSample ?? undefined)
        void stopPending.catch(() => {})
      } else active.capture?.abortForCleanup()
    } catch (cause) { graphError = cause }
    if (!normalStop || !active.capture || graphError) {
      active.transport?.release()
      active.transport = null
    }
    // Interrupted/cancelled input is cut immediately. A normal scheduled stop
    // retains input until the worklet reports its exact terminal sample.
    let trackError: unknown = null
    if (!normalStop || !active.capture || graphError) {
      try { stopTracks(active.stream) } catch (cause) { trackError = cause }
    }
    const task = active.cleanup.then(async () => {
      try {
        await active.preparing
        if (trackError || graphError) throw trackError ?? graphError
        if (stopPending) {
          const result = await stopPending
          if (active.requestedStopSample !== null && result.endFrame !== active.requestedStopSample) {
            throw new Error('Voiceover stopped outside its pinned timeline frame boundary')
          }
          this.completedWindow(active, result.startFrame, result.endFrame, result.samples)
          active.transport?.release()
          active.transport = null
          stopTracks(active.stream)
          active.writerStopped = true
          active.capturedSamples = result.progress.pcmBytes / 2
          this.publish()
        }
        await this.cleanup(active, kind)
        void this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation, kind: 'closed' })
      } catch (cause) {
        active.transport?.release()
        active.transport = null
        try { stopTracks(active.stream) } catch { /* Preserve the first cleanup error. */ }
        if (kind === 'stop') active.stopRetryRecovery = true
        active.diagnostic = errorMessage(cause)
        this.publish()
        void this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation, kind: 'cleanup-failed' })
      }
    })
    active.cleanup = task
    return task
  }

  /** Stop on a boundary that retains every accepted sample, then review. */
  private finishesNormally(active: Active): boolean {
    const interruption = active.state.interruption
    return !active.stopRetryRecovery && (!interruption || interruption === 'overrun' ||
      (BOUNDARY_INTERRUPTIONS.has(interruption) && active.requestedStopSample !== null))
  }

  /** Capture samples are the timeline window shifted by the take's compensation. */
  private completedWindow(active: Active, startSample: number, endSample: number, samples: number): void {
    if (!active.timing) return
    const compensation = active.compensationSamples
    const captureAnchor = voiceoverCaptureSample(active.timing.anchorSample, compensation,
      VOICEOVER_WAV_LIMITS.sampleRate)
    const plan = planVoiceoverSampleWindow({ anchorSample: captureAnchor,
      stopSample: endSample, inputStartSample: startSample, inputEndSample: endSample,
      compensationSamples: 0, audioSampleRate: VOICEOVER_WAV_LIMITS.sampleRate })
    if (plan.missingInputSamples !== 0 || plan.sourceSamples !== samples ||
      plan.outputSamples !== samples) throw new Error('Voiceover input missed its pinned sample window')
    const timelineStop = endSample - compensation
    active.timing = { ...active.timing, stopSample: timelineStop,
      stopFrame: active.timing.stopFrame ?? voiceoverTimelineFrameAtSample(timelineStop,
        active.timing.anchorSample, active.timing.startFrame, active.state.destination) }
    this.publish()
  }

  /**
   * Choose the next exact timeline frame boundary at least STOP_LEAD_SAMPLES
   * after the worklet's current position and ask the worklet to end there.
   */
  private scheduleBoundaryStop(active: Active): void {
    if (!active.context || !active.timing) throw new Error('Voiceover timing is unavailable')
    const compensation = active.compensationSamples
    const nowSample = Math.ceil(active.context.currentTime * VOICEOVER_WAV_LIMITS.sampleRate)
    const timelineNow = Math.max(nowSample - compensation, active.timing.anchorSample)
    const boundary = voiceoverStopBoundary(timelineNow, active.timing.anchorSample,
      active.timing.startFrame, STOP_LEAD_SAMPLES, active.state.destination)
    const limit = active.limit
    const chosen = limit && boundary.stopSample > limit.stopSample ? limit : boundary
    active.requestedStopSample = voiceoverCaptureSample(chosen.stopSample, compensation,
      VOICEOVER_WAV_LIMITS.sampleRate)
    active.timing = { ...active.timing, stopFrame: chosen.stopFrame }
    this.publish()
  }

  private releaseDraftLock(active: Active): void {
    const release = active.releaseLock
    active.releaseLock = null
    try { release?.() } catch { /* A lock that cannot be released ends with the page. */ }
  }

  private async keepDraft(active: Active, effect: Extract<VoiceoverSessionEffect, { kind: 'keep' }>): Promise<void> {
    const live = () => this.active === active && !active.keepCancelled && active.state.phase === 'keeping' &&
      active.state.operation === effect.operation
    let committedAssetId: string | null = null
    try {
      const writer = active.writer
      if (!writer || !active.writerStopped || !writer.finalize || !this.deps.importFinalized ||
        !this.deps.rememberOriginal || !this.deps.importedDurationFrames || !this.deps.placeImported) {
        throw new Error('The finalized recording is unavailable for Keep')
      }
      const expectedFrames = active.timing?.stopFrame !== null && active.timing?.stopFrame !== undefined
        ? active.timing.stopFrame - active.state.destination.startFrame : null
      const before = resolveVoiceoverKeepDestination(active.state.destination,
        this.deps.destinationContext(), Math.max(1, expectedFrames ?? 1),
        effect.placeOnTimeline && active.state.interruption === null && expectedFrames !== null)
      if (before.status === 'retain-draft') throw new Error('The project changed; the recording draft was retained')

      const finalized = await writer.finalize()
      if (!live()) return
      if (finalized.pcmBytes <= 0 || finalized.pcmBytes % 2 !== 0 ||
        finalized.file.size !== finalized.pcmBytes + VOICEOVER_WAV_LIMITS.headerBytes ||
        finalized.pcmBytes / 2 !== active.capturedSamples) {
        throw new Error('The finalized WAV does not match the reviewed sample count')
      }
      const beforeImport = resolveVoiceoverKeepDestination(active.state.destination,
        this.deps.destinationContext(), Math.max(1, expectedFrames ?? 1), false)
      if (beforeImport.status === 'retain-draft') throw new Error('The project changed; the recording draft was retained')

      active.keepImportPending = true
      let imported: MediaImportResult
      try { imported = await this.deps.importFinalized(finalized.file, finalized.handle) }
      finally { active.keepImportPending = false }
      if (!live()) return
      if (imported.status !== 'imported') {
        throw new Error(imported.status === 'failed' ? imported.message :
          `The finalized WAV was not imported (${imported.status})`)
      }
      const assetId = imported.assetId
      committedAssetId = assetId
      const importedFrames = this.deps.importedDurationFrames(assetId)
      let rememberWarning: string | null = null
      try { await this.deps.rememberOriginal(assetId, finalized.handle) }
      catch (cause) { rememberWarning = `Recording kept, but its OPFS original could not be remembered: ${errorMessage(cause)}` }
      if (!live()) return

      const validDuration = importedFrames !== null && Number.isSafeInteger(importedFrames) && importedFrames >= 1
      const matchingDuration = validDuration && expectedFrames !== null && importedFrames === expectedFrames
      const destination = resolveVoiceoverKeepDestination(active.state.destination,
        this.deps.destinationContext(), validDuration ? importedFrames : 1,
        effect.placeOnTimeline && active.state.interruption === null && matchingDuration)
      let location: 'pool' | 'timeline' = 'pool'
      let placementWarning: string | null = null
      if (destination.status === 'place') {
        try {
          const placed = this.deps.placeImported(active.state.destination.sequenceId, assetId,
            destination.trackId, destination.startFrame)
          if (placed.status === 'placed') location = 'timeline'
          else placementWarning = `Recording kept in the Media Pool: ${placed.reason}`
        } catch (cause) { placementWarning = `Recording kept in the Media Pool: ${errorMessage(cause)}` }
      } else if (effect.placeOnTimeline) {
        const reason = !matchingDuration && active.state.interruption === null
          ? 'the imported duration differs from the captured frame window'
          : destination.status === 'pool-only' ? destination.reason ?? 'the take was interrupted'
            : 'the project changed'
        placementWarning = `Recording kept in the Media Pool: ${reason}`
      }
      try { writer.close() }
      catch (cause) { rememberWarning = `${rememberWarning ?? ''} Recording worker close failed: ${errorMessage(cause)}`.trim() }
      active.writer = null
      active.diagnostic = [rememberWarning, placementWarning].filter(Boolean).join(' ') || null
      await this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation,
        kind: 'kept', assetId, location })
    } catch (cause) {
      if (!live()) return
      if (committedAssetId) {
        active.diagnostic = `Recording kept in the Media Pool after import: ${errorMessage(cause)}`
        try { active.writer?.close() } catch { /* The imported original remains in OPFS. */ }
        active.writer = null
        await this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation,
          kind: 'kept', assetId: committedAssetId, location: 'pool' })
        return
      }
      active.diagnostic = errorMessage(cause)
      this.publish()
      await this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation,
        kind: 'keep-failed' })
    }
  }

  private async prepare(active: Active, operation: number): Promise<void> {
    try {
      if (this.deps.holdDraftLock) {
        const release = await this.deps.holdDraftLock(active.state.sessionId)
        if (!this.live(active, operation, 'preparing')) { try { release() } catch { /* ended */ } return }
        active.releaseLock = release
      }
      const writer = this.deps.createWriter()
      active.writer = writer
      active.draftMayExist = true
      await writer.create(active.state.sessionId)
      active.writerCreated = true
      if (!this.live(active, operation, 'preparing')) return
      const context = this.deps.getContext()
      if (context.sampleRate !== VOICEOVER_WAV_LIMITS.sampleRate) throw new Error('The playback clock is not 48 kHz')
      active.context = context
      await context.resume()
      if (!this.live(active, operation, 'preparing')) return
      await this.deps.prepareWorklet?.(context)
      if (!this.live(active, operation, 'preparing')) return
      const transport = await this.deps.armTransport?.(context, active.state.destination.startFrame,
        active.countInFrames, (reason) => {
          if (this.active === active) void this.interruptActive(active, reason)
        }, { mutePlayback: active.mutePlayback, preRollSamples: Math.max(0, -active.compensationSamples),
          onStopRequested: () => { if (this.active === active) void this.stop() } })
      if (!this.live(active, operation, 'preparing')) { transport?.release(); return }
      active.transport = transport ?? null
      const anchorSample = transport?.anchorSample ?? this.deps.planStartFrame(context)
      if (!Number.isSafeInteger(anchorSample)) throw new Error('Voiceover playback anchor is invalid')
      const startFrame = voiceoverCaptureSample(anchorSample, active.compensationSamples, context.sampleRate)
      if (startFrame - Math.ceil(context.currentTime * context.sampleRate) < 128) {
        throw new Error('Voiceover worklet missed its playback anchor setup deadline')
      }
      active.limit = voiceoverLimitStop(anchorSample, active.state.destination.startFrame,
        VOICEOVER_WAV_LIMITS.maxDurationSamples, active.state.destination)
      const trackSettings = active.stream?.getAudioTracks()[0]?.getSettings?.() as
        (MediaTrackSettings & { latency?: number }) | undefined
      const trackLatency = trackSettings?.latency
      active.timing = { anchorSample,
        countInStartSample: transport?.countInStartSample ?? anchorSample,
        startFrame: active.state.destination.startFrame, stopSample: null, stopFrame: null,
        compensationSamples: active.compensationSamples,
        trackLatencySeconds: typeof trackLatency === 'number' && Number.isFinite(trackLatency) ? trackLatency : null,
        outputLatencySeconds: Number.isFinite(context.outputLatency) ? context.outputLatency : null }
      this.publish()
      const capture = await this.deps.connect({ context, stream: active.stream!, writer,
        startFrame, closeWriterOnFailure: false,
        limitStopFrame: voiceoverCaptureSample(active.limit.stopSample, active.compensationSamples, context.sampleRate),
        onStarted: () => {
          if (this.live(active, operation, 'preparing')) active.pendingStarted = true
          else if (this.live(active, operation, 'counting-in')) {
            void this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'recording-started' })
          }
        },
        onBatch: ({ frames, peak }) => {
          if (this.active === active && (active.state.phase === 'counting-in' ||
            active.state.phase === 'recording' ||
            (active.state.phase === 'closing' && active.state.after === 'review'))) {
            active.capturedSamples += frames
            active.inputPeak = peak
            this.publish()
          }
        },
        onGap: ({ frames }) => {
          if (this.active !== active) return
          active.renderGapSamples += Math.abs(frames)
          this.publish()
        },
        onOverrun: () => {
          if (this.active === active) void this.dispatch(active,
            { sessionId: active.state.sessionId, kind: 'interrupted', reason: 'overrun' })
        },
        onTerminal: (reason, endFrame) => {
          if (this.active !== active) return
          active.transport?.release()
          active.transport = null
          stopTracks(active.stream)
          active.inputPeak = 0
          if (active.timing) active.timing = { ...active.timing, stopSample: endFrame - active.compensationSamples }
          // A stop nobody requested is the pre-scheduled take limit: review it normally.
          const limitStop = reason === 'stopped' && active.requestedStopSample === null && active.limit
          if (limitStop && active.timing) {
            active.requestedStopSample = endFrame
            active.timing = { ...active.timing, stopFrame: active.limit!.stopFrame }
            active.diagnostic = 'Reached the 60-minute take limit; the take stopped there.'
          }
          this.publish()
          if (limitStop) void this.dispatch(active, { sessionId: active.state.sessionId, kind: 'stop' })
        },
      })
      active.capture = capture
      void capture.finished.then((result) => {
        if (result.reason === 'overrun' && this.active === active) void this.dispatch(active,
          { sessionId: active.state.sessionId, kind: 'interrupted', reason: 'overrun' })
      }, (cause) => {
        if (this.live(active, operation, 'recording') || this.live(active, operation, 'counting-in')) {
          active.diagnostic = errorMessage(cause)
          void this.dispatch(active, { sessionId: active.state.sessionId,
            operation: active.state.operation, kind: 'failed', reason: 'writer-failed' })
        }
      })
      if (!this.live(active, operation, 'preparing')) { capture.abortForCleanup(); return }
      await this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'prepared' })
      if (active.pendingStarted && this.live(active, operation, 'counting-in')) {
        await this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'recording-started' })
      }
    } catch (cause) {
      if (this.live(active, operation, 'preparing')) {
        active.diagnostic = errorMessage(cause)
        void this.dispatch(active, { sessionId: active.state.sessionId, operation,
          kind: 'failed', reason: 'writer-failed' })
      }
    }
  }

  private async cleanup(active: Active, kind: 'stop' | 'discard' | 'release'): Promise<void> {
    // Late setup has settled. There can be no new native graph after this point.
    const capture = active.capture
    const writer = active.writer
    const normal = this.finishesNormally(active)
    if (kind === 'stop' && capture && !active.writerStopped && normal) {
      const result = await capture.stop()
      active.writerStopped = true
      active.capturedSamples = result.progress.pcmBytes / 2
      this.publish()
    }
    if (kind === 'discard') {
      // A dead or already-released writer cannot discard its own draft; a
      // fresh worker removes the files by id (idempotent) instead.
      let discarded = !active.draftMayExist
      if (writer && active.writerCreated && !writer.isClosed) {
        try { await writer.discard(); discarded = true } catch { /* fall back below */ }
      }
      if (writer) { writer.close(); active.writer = null }
      if (!discarded) {
        const fresh = this.deps.createWriter()
        try {
          if (!fresh.discardId) throw new Error('The recording draft could not be discarded')
          await fresh.discardId(active.state.sessionId)
        } finally { fresh.close() }
      }
      active.draftMayExist = false
    } else if (writer) {
      if (kind === 'release') {
        if (active.writerCreated && !active.writerStopped && !writer.isClosed) await writer.release()
        writer.close()
        active.writer = null
      } else if (kind === 'stop' && !normal) {
        // An interrupted worklet cannot finalize its last in-memory batch.
        // Reopen the last durable checkpoint for explicit review.
        if (active.writerCreated && !active.writerStopped && !writer.isClosed) await writer.release()
        writer.close()
        active.writerCreated = false
        active.writerStopped = false
        const recovered = this.deps.createWriter()
        active.writer = recovered
        const recovery = await recovered.recover(active.state.sessionId)
        active.writerCreated = true
        active.writerStopped = true
        active.stopRetryRecovery = false
        active.capturedSamples = recovery.pcmBytes / 2
        active.diagnostic = `Capture interrupted; recovered ${active.capturedSamples} samples from the last durable checkpoint. Recent audio may be unavailable.`
        this.publish()
      }
    }
    for (const unsubscribe of active.trackListeners.splice(0)) unsubscribe()
    active.transport?.release()
    active.transport = null
    active.capture = null
    active.stream = null
  }

  stop(): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
    if (active.state.phase === 'recording' && active.transport && active.timing &&
      active.requestedStopSample === null) {
      try {
        this.scheduleBoundaryStop(active)
      } catch (cause) {
        active.diagnostic = errorMessage(cause)
        this.publish()
        return this.interrupt('transport-changed')
      }
    }
    return this.dispatch(active, { sessionId: active.state.sessionId, kind: 'stop' })
  }

  cancel(): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
    return this.dispatch(active, { sessionId: active.state.sessionId, kind: 'cancel' })
  }

  keep(placeOnTimeline: boolean): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
    return this.dispatch(active, { sessionId: active.state.sessionId, kind: 'keep', placeOnTimeline })
  }

  retryCleanup(): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
    return this.dispatch(active, { sessionId: active.state.sessionId, kind: 'retry-cleanup' })
  }

  interrupt(reason: VoiceoverInterruption): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
    return this.interruptActive(active, reason)
  }

  private interruptActive(active: Active, reason: VoiceoverInterruption): Promise<void> {
    // The microphone is still healthy after a seek, pause, or edit: end on the
    // next frame boundary so already-written audio is kept for review.
    if (BOUNDARY_INTERRUPTIONS.has(reason) && active.state.phase === 'recording' &&
      active.timing && active.requestedStopSample === null && active.capture) {
      try { this.scheduleBoundaryStop(active) }
      catch { active.requestedStopSample = null }
    }
    return this.dispatch(active, { sessionId: active.state.sessionId, kind: 'interrupted', reason })
  }

  /** Wait for owned writer cleanup before project media/transport are replaced. */
  async teardownForProjectChange(): Promise<void> {
    const active = this.active
    if (!active) return
    active.keepCancelled = true
    if (active.keepImportPending) this.deps.cancelImport?.()
    if (active.keepTask) await active.keepTask
    await this.dispatch(active, { sessionId: active.state.sessionId, kind: 'project-replaced' })
    if (active.state.phase === 'cleanup-failed') throw new Error(active.diagnostic ?? 'Voiceover cleanup failed')
  }

  onHidden(): void { void this.interrupt('hidden') }

  private onDocumentChange(): void {
    const active = this.active
    if (!active || active.state.phase === 'failed' || active.state.phase === 'cancelled' || active.state.phase === 'kept') return
    const check = checkVoiceoverDestination(active.state.destination, this.deps.destinationContext())
    if (check.status === 'reject') {
      void (check.reason === 'stale-project'
        ? this.teardownForProjectChange().catch(() => {})
        : this.interrupt('destination-changed'))
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribePageEvents?.()
    const active = this.active
    void this.cancel().finally(() => { if (active) this.releaseDraftLock(active) })
  }
}

let owner: VoiceoverCaptureOwner | null = null

export function getVoiceoverCaptureOwner(): VoiceoverCaptureOwner {
  if (owner) return owner
  owner = new VoiceoverCaptureOwner({
    destinationContext: currentVoiceoverDestinationContext,
    requestMicrophone: (deviceId) => navigator.mediaDevices.getUserMedia({ audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    }, video: false }),
    holdDraftLock: (sessionId) => new Promise<() => void>((resolve, reject) => {
      if (typeof navigator === 'undefined' || !navigator.locks) { resolve(() => {}); return }
      navigator.locks.request(voiceoverDraftLockName(sessionId), { mode: 'exclusive' },
        () => new Promise<void>((release) => resolve(release))).catch(reject)
    }),
    getContext: () => getPlaybackClockContext() as AudioContext,
    createWriter: () => new VoiceoverWavBridge(),
    connect: connectVoiceoverMicrophone,
    importFinalized: (file, handle) => importMediaFromHandle(file, handle),
    rememberOriginal: async (assetId, handle) => {
      const binding = getActiveLocalProjectBindingId()
      if (!binding) throw new Error('The local project binding is unavailable')
      await localMediaHandleRegistry.remember(binding, assetId, handle)
    },
    importedDurationFrames: (assetId) => useMediaStore.getState().assets.get(assetId)?.durationFrames ?? null,
    placeImported: placeImportedAsset,
    cancelImport: () => { cancelMediaImport() },
    armTransport: (context, startFrame, countInFrames, onInterrupted, extras) =>
      armVoiceoverTransport({ context, startFrame, countInFrames, onInterrupted, ...extras }),
    prepareWorklet: prepareVoiceoverMicrophoneWorklet,
    visibleAndFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
    preflight: () => !navigator.mediaDevices?.getUserMedia || !navigator.storage?.getDirectory ||
      typeof Worker === 'undefined' || typeof AudioWorkletNode === 'undefined'
      ? 'Microphone recording requires browser media, AudioWorklet, Worker and OPFS support.' : null,
    startConflict: () => useTransportStore.getState().isPlaying || useTransportStore.getState().isScrubbing
      ? 'Pause playback and scrubbing before recording.'
      : avCaptureActive() ? 'Finish the camera or screen recording first.' : null,
    planStartFrame: (context) => Math.ceil(context.currentTime * VOICEOVER_WAV_LIMITS.sampleRate) + 4800,
    publish: (status) => useVoiceoverCaptureStore.setState(status),
    subscribeDocument: (onChange) => useDocumentStore.subscribe(onChange),
    subscribePageEvents: (onHidden) => {
      const hidden = () => { if (document.visibilityState !== 'visible') onHidden() }
      document.addEventListener('visibilitychange', hidden)
      document.addEventListener('freeze', onHidden)
      window.addEventListener('pagehide', onHidden)
      return () => {
        document.removeEventListener('visibilitychange', hidden)
        document.removeEventListener('freeze', onHidden)
        window.removeEventListener('pagehide', onHidden)
      }
    },
  })
  return owner
}

export async function teardownVoiceoverForProjectChange(): Promise<void> {
  await owner?.teardownForProjectChange()
}
