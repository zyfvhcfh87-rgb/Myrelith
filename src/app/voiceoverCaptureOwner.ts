/** One app-owned microphone session. Native resources never enter Zustand. */
import { checkVoiceoverDestination, pinVoiceoverDestination, type VoiceoverDestinationContext } from '../domain/voiceoverDestination'
import { beginVoiceoverSession, transitionVoiceoverSession, type VoiceoverFailure, type VoiceoverInterruption, type VoiceoverSession, type VoiceoverSessionEffect, type VoiceoverSessionEvent } from '../domain/voiceoverSession'
import { VOICEOVER_WAV_LIMITS } from '../pipeline/voiceoverWavDraft'
import { useDocumentStore } from '../state/documentStore'
import { useVoiceoverCaptureStore, type VoiceoverCaptureStatus } from '../state/voiceoverCaptureStore'
import { getPlaybackClockContext } from './transportController'
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
  prepareWorklet?(context: AudioContext): Promise<void>
  visibleAndFocused(): boolean
  preflight?(): string | null
  /** Step 8 replaces this provisional clock frame with the shared count-in anchor. */
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
      capturedSamples: active?.capturedSamples ?? 0, diagnostic: active?.diagnostic ?? null }
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
  start(trackId: string, startFrame: number): { status: 'started'; sessionId: string }
    | { status: 'rejected'; reason: string } {
    const prior = this.active?.state
    if (prior && prior.phase !== 'cancelled' && prior.phase !== 'failed' && prior.phase !== 'kept') {
      return { status: 'rejected', reason: 'A recording is already active or awaiting cleanup.' }
    }
    if (!this.deps.visibleAndFocused()) return { status: 'rejected', reason: 'The editor must be visible and focused.' }
    const pinned = pinVoiceoverDestination(this.deps.destinationContext(), trackId, startFrame)
    if (pinned.status !== 'pinned') return { status: 'rejected', reason: pinned.reason }
    if (pinned.destination.audioSampleRate !== VOICEOVER_WAV_LIMITS.sampleRate) {
      return { status: 'rejected', reason: 'Voiceover requires a 48 kHz project.' }
    }
    const id = `voiceover_${crypto.randomUUID()}`
    const state = beginVoiceoverSession(prior ?? null, id, pinned.destination).state
    const active: Active = { state, stream: null, writer: null, writerCreated: false,
      writerStopped: false, stopRetryRecovery: false,
      capture: null, preparing: null, cleanup: Promise.resolve(), pendingStarted: false,
      trackListeners: [], sourceLabel: null, capturedSamples: 0, diagnostic: null }
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
        stopPending = active.capture.stop()
        void stopPending.catch(() => {})
      } else active.capture?.abortForCleanup()
    } catch (cause) { graphError = cause }
    // Stop every track synchronously on a terminal transition, including a
    // frozen page where async writer cleanup may not run until resume.
    let trackError: unknown = null
    try { stopTracks(active.stream) } catch (cause) { trackError = cause }
    const task = active.cleanup.then(async () => {
      try {
        await active.preparing
        if (trackError || graphError) throw trackError ?? graphError
        if (stopPending) {
          const result = await stopPending
          active.writerStopped = true
          active.capturedSamples = result.progress.pcmBytes / 2
          this.publish()
        }
        await this.cleanup(active, kind)
        void this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation, kind: 'closed' })
      } catch (cause) {
        if (kind === 'stop') active.stopRetryRecovery = true
        active.diagnostic = errorMessage(cause)
        this.publish()
        void this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation, kind: 'cleanup-failed' })
      }
    })
    active.cleanup = task
    return task
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
      const startFrame = this.deps.planStartFrame(context)
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
    active.capture = null
    active.stream = null
  }

  stop(): Promise<void> {
    const active = this.active
    if (!active) return Promise.resolve()
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
    prepareWorklet: prepareVoiceoverMicrophoneWorklet,
    visibleAndFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
    preflight: () => !navigator.mediaDevices?.getUserMedia || !navigator.storage?.getDirectory ||
      typeof Worker === 'undefined' || typeof AudioWorkletNode === 'undefined'
      ? 'Microphone recording requires browser media, AudioWorklet, Worker and OPFS support.' : null,
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
