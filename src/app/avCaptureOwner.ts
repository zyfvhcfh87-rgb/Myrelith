/**
 * One app-owned camera/screen capture session (Issue #209). Streams, the
 * capture worker, and file handles never enter Zustand; only serializable
 * status is published. Kept takes import through the ordinary Media Pool path.
 */
import {
  avCaptureSessionIsTerminal,
  beginAvCaptureSession,
  transitionAvCaptureSession,
  type AvCaptureEffect,
  type AvCaptureEvent,
  type AvCaptureFailure,
  type AvCaptureInterruption,
  type AvCaptureMode,
  type AvCaptureSession,
} from '../domain/avCaptureSession'
import { voiceoverDraftLockName } from '../domain/voiceoverDrafts'
import type { AvRecorderProgress } from '../pipeline/avCaptureRecorder'
import { useAvCaptureStore, type AvCaptureStatus, type ScreenAudioChoice } from '../state/avCaptureStore'
import { useDocumentStore } from '../state/documentStore'
import { useVoiceoverCaptureStore } from '../state/voiceoverCaptureStore'
import { AvCaptureBridge } from './avCaptureBridge'
import { calibrateVideoClock, mediaStreamTrackProcessor, type AvVideoClockCalibration } from './avClockCalibration'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { localMediaHandleRegistry } from './localMediaHandles'
import { cancelMediaImport, importMediaFromHandle, type MediaImportResult } from './mediaImportController'

type Bridge = Pick<AvCaptureBridge, 'start' | 'stop' | 'abort' | 'file' | 'discardId' | 'recover' | 'close'>
  & { onProgress: AvCaptureBridge['onProgress']; onSelfStop: AvCaptureBridge['onSelfStop']; readonly isClosed: boolean }

export interface AvCaptureStartOptions {
  readonly mode: AvCaptureMode
  readonly cameraId?: string | null
  /** Camera takes: microphone device, `null` for the default, or 'none'. */
  readonly cameraMicrophoneId?: string | null | 'none'
  readonly screenAudio?: ScreenAudioChoice
  readonly screenMicrophoneId?: string | null
}

export interface AvCaptureDeps {
  projectContext(): { projectId: string; projectGeneration: number }
  requestCamera(cameraId: string | null, microphoneId: string | null | 'none'): Promise<MediaStream>
  requestDisplay(withAudio: boolean): Promise<MediaStream>
  requestMicrophone(microphoneId: string | null): Promise<MediaStream>
  calibrate(track: MediaStreamTrack): Promise<AvVideoClockCalibration>
  createProcessor<T>(track: MediaStreamTrack): ReadableStream<T>
  createBridge(): Bridge
  visibleAndFocused(): boolean
  preflight(): string | null
  startConflict(): string | null
  holdDraftLock?(sessionId: string): Promise<() => void>
  importCapture(file: File, handle: FileSystemFileHandle): Promise<MediaImportResult>
  rememberOriginal(assetId: string, handle: FileSystemFileHandle): Promise<void>
  cancelImport?(): void
  publish(status: AvCaptureStatus): void
  subscribePageEvents?(onFrozen: () => void): () => void
}

interface Active {
  state: AvCaptureSession
  options: AvCaptureStartOptions
  streams: MediaStream[]
  videoTrack: MediaStreamTrack | null
  audioTrack: MediaStreamTrack | null
  bridge: Bridge | null
  recording: boolean
  draftMayExist: boolean
  preparing: Promise<void> | null
  cleanup: Promise<void>
  releaseLock: (() => void) | null
  keepCancelled: boolean
  keepImportPending: boolean
  status: Omit<AvCaptureStatus, 'session'>
}

function stopStreams(streams: readonly MediaStream[]): void {
  for (const stream of streams) for (const track of stream.getTracks()) {
    try { track.stop() } catch { /* already ended */ }
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Distinguish denial, dismissal, a missing macOS screen permission, and device trouble. */
export function avPermissionFailure(cause: unknown, mode: AvCaptureMode): AvCaptureFailure {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError') {
      // Chromium reports a dismissed display chooser as NotAllowedError too.
      return /dismiss|cancel/i.test(cause.message) ? 'permission-dismissed' : 'permission-denied'
    }
    if (cause.name === 'AbortError') return 'permission-dismissed'
    if (mode === 'screen' && cause.name === 'NotReadableError') return 'screen-permission'
  }
  return 'device-unavailable'
}

/** Display tracks carry internal ids as labels; name the surface instead. */
function displaySurfaceLabel(track: MediaStreamTrack): string {
  const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface
  return surface === 'browser' ? 'Browser tab' : surface === 'window' ? 'Window' : surface === 'monitor' ? 'Entire screen' : 'Shared screen'
}

const EMPTY_STATUS: Omit<AvCaptureStatus, 'session'> = { videoLabel: null, audioLabel: null, audioNote: null,
  clockMethod: null, progress: null, clockNote: null, diagnostic: null }

export class AvCaptureOwner {
  private active: Active | null = null
  private readonly deps: AvCaptureDeps
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly unsubscribePage: (() => void) | null

  constructor(deps: AvCaptureDeps) {
    this.deps = deps
    this.unsubscribePage = deps.subscribePageEvents?.(() => { void this.interrupt('page-frozen') }) ?? null
  }

  get status(): AvCaptureStatus {
    return { session: this.active?.state ?? null, ...(this.active?.status ?? EMPTY_STATUS) }
  }

  private publish(): void { this.deps.publish(this.status) }

  private watch(task: Promise<unknown>): void {
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task)).catch(() => {})
  }

  async whenIdle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
  }

  /** Call from the click handler: the browser prompt is requested before any await. */
  start(options: AvCaptureStartOptions): { status: 'started'; sessionId: string } | { status: 'rejected'; reason: string } {
    if (!avCaptureSessionIsTerminal(this.active?.state ?? null)) {
      return { status: 'rejected', reason: 'A recording is already active or awaiting cleanup.' }
    }
    if (!this.deps.visibleAndFocused()) return { status: 'rejected', reason: 'The editor must be visible and focused.' }
    const unavailable = this.deps.preflight()
    if (unavailable) return { status: 'rejected', reason: unavailable }
    const conflict = this.deps.startConflict()
    if (conflict) return { status: 'rejected', reason: conflict }
    const id = `capture_${crypto.randomUUID()}`
    const begun = beginAvCaptureSession(this.active?.state ?? null, id, options.mode, this.deps.projectContext())
    if (!begun) return { status: 'rejected', reason: 'A recording is already active.' }
    const active: Active = { state: begun.state, options, streams: [], videoTrack: null, audioTrack: null,
      bridge: null, recording: false, draftMayExist: false, preparing: null, cleanup: Promise.resolve(),
      releaseLock: null, keepCancelled: false, keepImportPending: false, status: { ...EMPTY_STATUS } }
    this.active = active
    this.publish()
    let request: Promise<MediaStream>
    try {
      request = options.mode === 'camera'
        ? this.deps.requestCamera(options.cameraId ?? null, options.cameraMicrophoneId ?? null)
        : this.deps.requestDisplay(options.screenAudio === 'display')
    } catch (cause) { request = Promise.reject(cause) }
    this.watch(request.then((stream) => this.granted(active, stream), (cause) => this.denied(active, cause)))
    return { status: 'started', sessionId: id }
  }

  private live(active: Active, phase: AvCaptureSession['phase'], operation?: number): boolean {
    return this.active === active && active.state.phase === phase &&
      (operation === undefined || active.state.operation === operation)
  }

  private dispatch(active: Active, event: AvCaptureEvent): Promise<void> {
    if (this.active !== active) return Promise.resolve()
    const decision = transitionAvCaptureSession(active.state, event)
    if (decision.state === active.state) return active.cleanup
    active.state = decision.state
    if (avCaptureSessionIsTerminal(active.state)) this.releaseLock(active)
    this.publish()
    if (!decision.effect) return active.cleanup
    const task = this.runEffect(active, decision.effect)
    this.watch(task)
    return task
  }

  private releaseLock(active: Active): void {
    const release = active.releaseLock
    active.releaseLock = null
    try { release?.() } catch { /* ends with the page */ }
  }

  private async granted(active: Active, stream: MediaStream): Promise<void> {
    active.streams.push(stream)
    if (!this.live(active, 'requesting', 0)) { stopStreams(active.streams); return }
    const video = stream.getVideoTracks()[0] ?? null
    let audio = stream.getAudioTracks()[0] ?? null
    if (!video || video.readyState !== 'live') {
      stopStreams(active.streams)
      active.status.diagnostic = 'The browser returned no live video.'
      await this.dispatch(active, { sessionId: active.state.sessionId, operation: 0, kind: 'failed', reason: 'device-unavailable' })
      return
    }
    const options = active.options
    if (options.mode === 'screen') {
      if (options.screenAudio === 'display' && !audio) {
        active.status.audioNote = 'The browser did not share audio for this surface; the take has no audio. Tabs can share their audio.'
      }
      if (options.screenAudio === 'microphone') {
        for (const extra of stream.getAudioTracks()) extra.stop()
        try {
          const microphone = await this.deps.requestMicrophone(options.screenMicrophoneId ?? null)
          active.streams.push(microphone)
          audio = microphone.getAudioTracks()[0] ?? null
        } catch (cause) {
          stopStreams(active.streams)
          active.status.diagnostic = message(cause)
          await this.dispatch(active, { sessionId: active.state.sessionId, operation: 0, kind: 'failed',
            reason: avPermissionFailure(cause, 'camera') })
          return
        }
        if (!this.live(active, 'requesting', 0)) { stopStreams(active.streams); return }
      }
    }
    active.videoTrack = video
    active.audioTrack = audio
    active.status.videoLabel = options.mode === 'camera' ? video.label || 'Camera' : displaySurfaceLabel(video)
    active.status.audioLabel = audio ? audio.label || 'Audio' : null
    // Before recording starts, a source that ends is a failure; afterwards the
    // worker's streams end and the recorder stops itself for review.
    for (const track of [video, audio]) track?.addEventListener('ended', () => {
      if (this.active === active && (active.state.phase === 'requesting' || active.state.phase === 'preparing')) {
        void this.dispatch(active, { sessionId: active.state.sessionId, kind: 'interrupted', reason: 'source-ended' })
      }
    })
    await this.dispatch(active, { sessionId: active.state.sessionId, operation: 0, kind: 'permission-granted' })
  }

  private async denied(active: Active, cause: unknown): Promise<void> {
    if (!this.live(active, 'requesting', 0)) return
    active.status.diagnostic = message(cause)
    await this.dispatch(active, { sessionId: active.state.sessionId, operation: 0, kind: 'failed',
      reason: avPermissionFailure(cause, active.options.mode) })
  }

  private runEffect(active: Active, effect: AvCaptureEffect): Promise<void> {
    if (effect.kind === 'prepare') {
      const task = this.prepare(active, effect.operation)
      active.preparing = task
      return task
    }
    if (effect.kind === 'keep') return this.keep(active, effect.operation)
    const task = active.cleanup.then(() => this.close(active, effect))
    active.cleanup = task
    return task
  }

  private async prepare(active: Active, operation: number): Promise<void> {
    try {
      if (this.deps.holdDraftLock) {
        const release = await this.deps.holdDraftLock(active.state.sessionId)
        if (!this.live(active, 'preparing', operation)) { release(); return }
        active.releaseLock = release
      }
      const video = active.videoTrack!
      const calibration = await this.deps.calibrate(video)
      if (!this.live(active, 'preparing', operation)) return
      active.status.clockMethod = calibration.method
      this.publish()
      const bridge = this.deps.createBridge()
      active.bridge = bridge
      bridge.onProgress = (progress) => this.progress(active, progress)
      bridge.onSelfStop = (reason) => {
        if (this.active === active) void this.interrupt(reason === 'limit' ? 'limit' : 'source-ended')
      }
      const settings = video.getSettings()
      const audio = active.audioTrack
      const audioSettings = audio?.getSettings()
      active.draftMayExist = true
      await bridge.start({ type: 'start', id: active.state.sessionId, mode: active.state.mode,
        video: this.deps.createProcessor<VideoFrame>(video),
        audio: audio ? this.deps.createProcessor<AudioData>(audio) : null,
        videoSettings: { width: settings.width ?? 1280, height: settings.height ?? 720 },
        audioSettings: audio ? { numberOfChannels: audioSettings?.channelCount ?? 1,
          sampleRate: audioSettings?.sampleRate ?? 48_000 } : null,
        videoClockOffsetUs: Math.round(calibration.offsetUs) })
      active.recording = true
      if (!this.live(active, 'preparing', operation)) return
      await this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'recording-started' })
    } catch (cause) {
      if (this.live(active, 'preparing', operation)) {
        active.status.diagnostic = message(cause)
        await this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'failed', reason: 'writer-failed' })
      }
    }
  }

  private progress(active: Active, progress: AvRecorderProgress): void {
    if (this.active !== active) return
    active.status.progress = { bytes: progress.bytes, durationUs: progress.durationUs, videoFrames: progress.videoFrames,
      droppedVideoFrames: progress.droppedVideoFrames, audioSamples: progress.audioSamples,
      audioSampleRate: progress.audioSampleRate, width: progress.width, height: progress.height }
    this.publish()
  }

  private async close(active: Active, effect: AvCaptureEffect): Promise<void> {
    try {
      await active.preparing?.catch(() => {})
      const bridge = active.bridge
      if (effect.kind === 'stop' && active.recording && bridge && !bridge.isClosed) {
        try {
          const { result } = await bridge.stop()
          active.recording = false
          active.status.clockNote = result.clockNote
          this.progress(active, result)
          if (result.reason === 'limit') active.status.diagnostic = 'The take reached its size or length limit and stopped there.'
        } catch (cause) {
          // The container could not be finalized: keep every complete fragment.
          active.recording = false
          const recoveredBytes = await this.recoverFlushed(active)
          active.status.diagnostic = `Recording stopped unexpectedly (${message(cause)}); ` +
            `kept the ${(recoveredBytes / 1_048_576).toFixed(1)} MiB that was completely written.`
        }
      } else if (active.recording && bridge && !bridge.isClosed) {
        await bridge.abort()
        active.recording = false
      }
      stopStreams(active.streams)
      if (effect.kind === 'discard' && active.draftMayExist) {
        const remover = bridge && !bridge.isClosed ? bridge : this.deps.createBridge()
        try { await remover.discardId(active.state.sessionId) } finally { if (remover !== bridge) remover.close() }
        active.draftMayExist = false
      }
      if (effect.kind !== 'stop') { bridge?.close(); active.bridge = null }
      // Not awaited: this task is itself `active.cleanup`, which dispatch returns.
      void this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation, kind: 'closed' })
    } catch (cause) {
      stopStreams(active.streams)
      active.status.diagnostic = message(cause)
      void this.dispatch(active, { sessionId: effect.sessionId, operation: effect.operation, kind: 'cleanup-failed' })
    }
  }

  private async recoverFlushed(active: Active): Promise<number> {
    active.bridge?.close()
    const recovery = this.deps.createBridge()
    active.bridge = recovery
    // `pcmBytes` carries the recovered file length for captures.
    return (await recovery.recover(active.state.sessionId)).pcmBytes
  }

  private async keep(active: Active, operation: number): Promise<void> {
    const live = () => this.live(active, 'keeping', operation) && !active.keepCancelled
    try {
      const project = this.deps.projectContext()
      if (project.projectId !== active.state.projectId || project.projectGeneration !== active.state.projectGeneration) {
        throw new Error('The project changed; the recording was kept as a draft to recover.')
      }
      const bridge = active.bridge && !active.bridge.isClosed ? active.bridge : this.deps.createBridge()
      active.bridge = bridge
      const { file, handle } = await bridge.file(active.state.sessionId)
      if (!live()) return
      active.keepImportPending = true
      let imported: MediaImportResult
      try { imported = await this.deps.importCapture(file, handle) }
      finally { active.keepImportPending = false }
      if (!live()) return
      if (imported.status !== 'imported') {
        throw new Error(imported.status === 'failed' ? imported.message : `The recording was not imported (${imported.status})`)
      }
      try { await this.deps.rememberOriginal(imported.assetId, handle) }
      catch (cause) { active.status.diagnostic = `Recording kept, but its browser file grant could not be saved: ${message(cause)}` }
      bridge.close()
      active.bridge = null
      await this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'kept', assetId: imported.assetId })
    } catch (cause) {
      if (!live()) return
      active.status.diagnostic = message(cause)
      await this.dispatch(active, { sessionId: active.state.sessionId, operation, kind: 'keep-failed' })
    }
  }

  stop(): Promise<void> {
    const active = this.active
    return active ? this.dispatch(active, { sessionId: active.state.sessionId, kind: 'stop' }) : Promise.resolve()
  }

  cancel(): Promise<void> {
    const active = this.active
    return active ? this.dispatch(active, { sessionId: active.state.sessionId, kind: 'cancel' }) : Promise.resolve()
  }

  keepTake(): Promise<void> {
    const active = this.active
    return active ? this.dispatch(active, { sessionId: active.state.sessionId, kind: 'keep' }) : Promise.resolve()
  }

  retryCleanup(): Promise<void> {
    const active = this.active
    return active ? this.dispatch(active, { sessionId: active.state.sessionId, kind: 'retry-cleanup' }) : Promise.resolve()
  }

  interrupt(reason: AvCaptureInterruption): Promise<void> {
    const active = this.active
    return active ? this.dispatch(active, { sessionId: active.state.sessionId, kind: 'interrupted', reason }) : Promise.resolve()
  }

  /** A muted clone of the recorded video for a live preview; the caller stops it. */
  previewTrack(): MediaStreamTrack | null {
    const track = this.active?.videoTrack
    return track && track.readyState === 'live' && !avCaptureSessionIsTerminal(this.active!.state) ? track.clone() : null
  }

  async teardownForProjectChange(): Promise<void> {
    const active = this.active
    if (!active) return
    active.keepCancelled = true
    if (active.keepImportPending) this.deps.cancelImport?.()
    await this.dispatch(active, { sessionId: active.state.sessionId, kind: 'project-replaced' })
    await active.cleanup
    if (active.state.phase === 'cleanup-failed') throw new Error(active.status.diagnostic ?? 'Capture cleanup failed')
  }

  dispose(): void {
    this.unsubscribePage?.()
    void this.cancel()
  }
}

let owner: AvCaptureOwner | null = null

export function avCaptureActive(): boolean {
  return !avCaptureSessionIsTerminal(useAvCaptureStore.getState().session)
}

export function getAvCaptureOwner(): AvCaptureOwner {
  if (owner) return owner
  const microphone = (deviceId: string | null) => ({
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  })
  owner = new AvCaptureOwner({
    projectContext: () => {
      const state = useDocumentStore.getState()
      return { projectId: state.project.id, projectGeneration: state.projectGeneration }
    },
    requestCamera: (cameraId, microphoneId) => navigator.mediaDevices.getUserMedia({
      video: { ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
        width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: microphoneId === 'none' ? false : microphone(microphoneId),
    }),
    requestDisplay: (withAudio) => navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30 } },
      audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      // Recording Myrelith itself would mirror the editor into the take.
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: withAudio ? 'include' : 'exclude',
    } as DisplayMediaStreamOptions),
    requestMicrophone: (deviceId) => navigator.mediaDevices.getUserMedia({ audio: microphone(deviceId), video: false }),
    calibrate: (track) => calibrateVideoClock(track),
    createProcessor: <T>(track: MediaStreamTrack) => {
      const Processor = mediaStreamTrackProcessor()
      if (!Processor) throw new Error('This browser cannot read camera or screen frames')
      return new Processor({ track }).readable as unknown as ReadableStream<T>
    },
    createBridge: () => new AvCaptureBridge(),
    visibleAndFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
    preflight: () => !navigator.mediaDevices?.getUserMedia || !mediaStreamTrackProcessor() ||
      typeof VideoEncoder === 'undefined' || typeof Worker === 'undefined' || !navigator.storage?.getDirectory ||
      !('requestVideoFrameCallback' in HTMLVideoElement.prototype)
      ? 'Camera and screen recording need a Chromium browser with WebCodecs and origin-private storage.' : null,
    startConflict: () => {
      const voiceover = useVoiceoverCaptureStore.getState().session
      return voiceover && !['kept', 'cancelled', 'failed'].includes(voiceover.phase)
        ? 'Finish the voiceover take before recording camera or screen.' : null
    },
    holdDraftLock: (sessionId) => new Promise<() => void>((resolve, reject) => {
      if (typeof navigator === 'undefined' || !navigator.locks) { resolve(() => {}); return }
      navigator.locks.request(voiceoverDraftLockName(sessionId), { mode: 'exclusive' },
        () => new Promise<void>((release) => resolve(release))).catch(reject)
    }),
    importCapture: (file, handle) => importMediaFromHandle(file, handle),
    rememberOriginal: async (assetId, handle) => {
      const binding = getActiveLocalProjectBindingId()
      if (!binding) throw new Error('The local project binding is unavailable')
      await localMediaHandleRegistry.remember(binding, assetId, handle)
    },
    cancelImport: () => { cancelMediaImport() },
    publish: (status) => useAvCaptureStore.setState(status),
    // Screen recording normally hides the editor, so only a real freeze or
    // page exit interrupts; hidden-but-running pages keep capturing.
    subscribePageEvents: (onFrozen) => {
      document.addEventListener('freeze', onFrozen)
      window.addEventListener('pagehide', onFrozen)
      return () => {
        document.removeEventListener('freeze', onFrozen)
        window.removeEventListener('pagehide', onFrozen)
      }
    },
  })
  return owner
}

export async function teardownAvCaptureForProjectChange(): Promise<void> {
  await owner?.teardownForProjectChange()
}
