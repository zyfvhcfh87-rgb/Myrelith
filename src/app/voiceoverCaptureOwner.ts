/** One app-owned microphone session. Native resources never enter Zustand. */
import { checkVoiceoverDestination, pinVoiceoverDestination, type VoiceoverDestinationContext } from '../domain/voiceoverDestination'
import { beginVoiceoverSession, transitionVoiceoverSession, type VoiceoverFailure, type VoiceoverInterruption, type VoiceoverSession, type VoiceoverSessionEffect, type VoiceoverSessionEvent } from '../domain/voiceoverSession'
import { VOICEOVER_WAV_LIMITS } from '../pipeline/voiceoverWavDraft'
import { planVoiceoverSampleWindow, voiceoverStopBoundary, voiceoverTimelineFrameAtSample } from '../domain/voiceoverClock'
import { useDocumentStore } from '../state/documentStore'
import { useVoiceoverCaptureStore, type VoiceoverCaptureStatus, type VoiceoverCaptureTiming } from '../state/voiceoverCaptureStore'
import { useTransportStore } from '../state/transportStore'
import { armVoiceoverTransport, getPlaybackClockContext, type VoiceoverTransportLease } from './transportController'
import { connectVoiceoverMicrophone, prepareVoiceoverMicrophoneWorklet } from './voiceoverMicrophoneBridge'
import { VoiceoverWavBridge } from './voiceoverWavBridge'

type Capture = Awaited<ReturnType<typeof connectVoiceoverMicrophone>>
type Writer = Pick<VoiceoverWavBridge, 'create' | 'stop' | 'release' | 'recover' | 'discard' | 'close' | 'append'>
  & { readonly isClosed?: boolean }

export interface VoiceoverCaptureDeps {
  destinationContext(): VoiceoverDestinationContext
  requestMicrophone(): Promise<MediaStream>
  getContext(): AudioContext
  createWriter(): Writer
  connect(options: Parameters<typeof connectVoiceoverMicrophone>[0]): Promise<Capture>
  armTransport?(context: AudioContext, startFrame: number, countInFrames: number,
    onInterrupted: (reason: 'transport-changed' | 'destination-changed') => void): Promise<VoiceoverTransportLease>
  prepareWorklet?(context: AudioContext): Promise<void>
  visibleAndFocused(): boolean
  preflight?(): string | null
  startConflict?(): string | null
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
  transport: VoiceoverTransportLease | null
  timing: VoiceoverCaptureTiming | null
  requestedStopSample: number | null
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
      capturedSamples: active?.capturedSamples ?? 0, diagnostic: active?.diagnostic ?? null,
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
  start(trackId: string, startFrame: number, countInFrames?: number): { status: 'started'; sessionId: string }
    | { status: 'rejected'; reason: string } {
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
      countInFrames: countIn, transport: null, timing: null, requestedStopSample: null }
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
    try { permission = this.deps.requestMicrophone() }
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
    if (effect.kind === 'request-permission' || effect.kind === 'keep') return Promise.resolve()
    const kind = effect.kind
    const normalStop = kind === 'stop' && !active.stopRetryRecovery &&
      (!active.state.interruption || active.state.interruption === 'overrun')
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

  private completedWindow(active: Active, startSample: number, endSample: number, samples: number): void {
    if (!active.timing) return
    const plan = planVoiceoverSampleWindow({ anchorSample: active.timing.anchorSample,
      stopSample: endSample, inputStartSample: startSample, inputEndSample: endSample,
      compensationSamples: 0, audioSampleRate: VOICEOVER_WAV_LIMITS.sampleRate })
    if (plan.missingInputSamples !== 0 || plan.sourceSamples !== samples ||
      plan.outputSamples !== samples) throw new Error('Voiceover input missed its pinned sample window')
    active.timing = { ...active.timing, stopSample: endSample,
      stopFrame: active.timing.stopFrame ?? voiceoverTimelineFrameAtSample(endSample,
        active.timing.anchorSample, active.timing.startFrame, active.state.destination) }
    this.publish()
  }

  private async prepare(active: Active, operation: number): Promise<void> {
    try {
      const writer = this.deps.createWriter()
      active.writer = writer
      await writer.create(active.state.sessionId)
      active.writerCreated = true
      if (!this.live(active, operation, 'preparing')) return
      const context = this.deps.getContext()
      if (context.sampleRate !== VOICEOVER_WAV_LIMITS.sampleRate) throw new Error('The playback clock is not 48 kHz')
      await context.resume()
      if (!this.live(active, operation, 'preparing')) return
      await this.deps.prepareWorklet?.(context)
      if (!this.live(active, operation, 'preparing')) return
      const transport = await this.deps.armTransport?.(context, active.state.destination.startFrame,
        active.countInFrames, (reason) => {
          if (this.active === active) void this.dispatch(active,
            { sessionId: active.state.sessionId, kind: 'interrupted', reason })
        })
      if (!this.live(active, operation, 'preparing')) { transport?.release(); return }
      active.transport = transport ?? null
      const startFrame = transport?.anchorSample ?? this.deps.planStartFrame(context)
      if (!Number.isSafeInteger(startFrame) ||
        startFrame - Math.ceil(context.currentTime * context.sampleRate) < 128) {
        throw new Error('Voiceover worklet missed its playback anchor setup deadline')
      }
      const trackSettings = active.stream?.getAudioTracks()[0]?.getSettings?.() as
        (MediaTrackSettings & { latency?: number }) | undefined
      const trackLatency = trackSettings?.latency
      active.timing = { anchorSample: startFrame,
        countInStartSample: transport?.countInStartSample ?? startFrame,
        startFrame: active.state.destination.startFrame, stopSample: null, stopFrame: null,
        compensationSamples: 0,
        trackLatencySeconds: typeof trackLatency === 'number' && Number.isFinite(trackLatency) ? trackLatency : null,
        outputLatencySeconds: Number.isFinite(context.outputLatency) ? context.outputLatency : null }
      this.publish()
      const capture = await this.deps.connect({ context, stream: active.stream!, writer,
        startFrame, closeWriterOnFailure: false,
        onStarted: () => {
          if (this.live(active, operation, 'preparing')) active.pendingStarted = true
          else if (this.live(active, operation, 'counting-in')) {
            void this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'recording-started' })
          }
        },
        onBatch: ({ frames }) => {
          if (this.active === active && (active.state.phase === 'counting-in' ||
            active.state.phase === 'recording' ||
            (active.state.phase === 'closing' && active.state.after === 'review'))) {
            active.capturedSamples += frames
            this.publish()
          }
        },
        onOverrun: () => {
          if (this.active === active) void this.dispatch(active,
            { sessionId: active.state.sessionId, kind: 'interrupted', reason: 'overrun' })
        },
        onTerminal: (_reason, endFrame) => {
          if (this.active !== active) return
          active.transport?.release()
          active.transport = null
          stopTracks(active.stream)
          if (active.timing) active.timing = { ...active.timing, stopSample: endFrame }
          this.publish()
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
    if (kind === 'stop' && capture && !active.writerStopped && !active.stopRetryRecovery &&
      (!active.state.interruption || active.state.interruption === 'overrun')) {
      const result = await capture.stop()
      active.writerStopped = true
      active.capturedSamples = result.progress.pcmBytes / 2
      this.publish()
    }
    if (writer) {
      if (kind === 'discard') {
        if (active.writerCreated) await writer.discard()
        writer.close()
        active.writer = null
      } else if (kind === 'release') {
        if (active.writerCreated && !active.writerStopped && !writer.isClosed) await writer.release()
        writer.close()
        active.writer = null
      } else if (kind === 'stop' &&
        (active.stopRetryRecovery || (active.state.interruption && active.state.interruption !== 'overrun'))) {
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
    if (active.state.phase === 'recording' && active.transport && active.timing) {
      try {
        const nowSample = Math.ceil(active.transport.context.currentTime * VOICEOVER_WAV_LIMITS.sampleRate)
        const boundary = voiceoverStopBoundary(nowSample, active.timing.anchorSample,
          active.timing.startFrame, 4_800, active.state.destination)
        active.requestedStopSample = boundary.stopSample
        active.timing = { ...active.timing, stopFrame: boundary.stopFrame }
        this.publish()
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

  retryCleanup(): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
    return this.dispatch(active, { sessionId: active.state.sessionId, kind: 'retry-cleanup' })
  }

  interrupt(reason: VoiceoverInterruption): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
    return this.dispatch(active, { sessionId: active.state.sessionId, kind: 'interrupted', reason })
  }

  /** Wait for owned writer cleanup before project media/transport are replaced. */
  async teardownForProjectChange(): Promise<void> {
    const active = this.active
    if (!active) return
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
    void this.cancel()
  }
}

let owner: VoiceoverCaptureOwner | null = null

export function getVoiceoverCaptureOwner(): VoiceoverCaptureOwner {
  if (owner) return owner
  owner = new VoiceoverCaptureOwner({
    destinationContext: currentVoiceoverDestinationContext,
    requestMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }),
    getContext: () => getPlaybackClockContext() as AudioContext,
    createWriter: () => new VoiceoverWavBridge(),
    connect: connectVoiceoverMicrophone,
    armTransport: (context, startFrame, countInFrames, onInterrupted) =>
      armVoiceoverTransport({ context, startFrame, countInFrames, onInterrupted }),
    prepareWorklet: prepareVoiceoverMicrophoneWorklet,
    visibleAndFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
    preflight: () => !navigator.mediaDevices?.getUserMedia || !navigator.storage?.getDirectory ||
      typeof Worker === 'undefined' || typeof AudioWorkletNode === 'undefined'
      ? 'Microphone recording requires browser media, AudioWorklet, Worker and OPFS support.' : null,
    startConflict: () => useTransportStore.getState().isPlaying || useTransportStore.getState().isScrubbing
      ? 'Pause playback and scrubbing before recording.' : null,
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
