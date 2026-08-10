import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import {
  disposeExport,
  startExport,
} from '../../app/exportController'
import { inspectMediaFileCompatibility } from '../../app/mediaInspection'
import {
  capturePreviewRuntimeTelemetry,
  disposePreview,
  setPreviewRuntimeTelemetryEnabled,
  subscribePreviewRenderDiagnostics,
  type PreviewRenderDiagnostic,
} from '../../app/previewController'
import {
  disposeTransport,
  getAudioPlaybackDiagnostics,
  pause,
  play,
} from '../../app/transportController'
import {
  cloneClipAnimation,
  defaultClipAnimation,
  remapEffectAnimationIds,
} from '../../domain/clipAnimation'
import { estimateDocumentMemory } from '../../domain/documentMemory'
import {
  defaultClipAudioSettings,
  defaultClipVisualSettings,
} from '../../domain/clipInspector'
import { exportPresetById } from '../../domain/exportProfile'
import type { PortableAssetDescriptor } from '../../domain/projectFile'
import type {
  Clip,
  FrameRate,
  MediaAsset,
  TimelineDoc,
  Track,
  Transition,
} from '../../domain/schema'
import { defaultSourceTimeMap } from '../../domain/sourceTimeMap'
import { proceduralTextAssetId } from '../../domain/textOverlay'
import { microsecondsDurationToFrames } from '../../domain/time'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useProjectSessionStore } from '../../state/projectSessionStore'
import { useTransportStore } from '../../state/transportStore'
import {
  PERFORMANCE_ARTIFACT_SCHEMA_VERSION,
  PERFORMANCE_HARNESS_VERSION,
  evaluateProposedGates,
  measuredMetric,
  performanceArtifactMarkdown,
  unavailableMetric,
  type BrowserPerformanceMetadata,
  type ChromiumPerformanceMetadata,
  type ChromiumProcessMemoryBatchSample,
  type ChromiumProcessMemoryEvidence,
  type HostPerformanceMetadata,
  type PerformanceArtifact,
  type PerformanceFixtureSummary,
  type PerformanceMetric,
  type PerformanceMetricId,
  type PerformanceResourceEvidence,
  type PerformanceRunOptions,
  type RuntimeHealthSample,
  type RuntimeTelemetryEvidence,
  type TelemetryOverheadEvidence,
  type UserAgentSpecificMemoryEvidence,
  type LongAnimationFrameEvidence,
} from './contract'
import { measureFramePlanningIndex } from './framePlanningBenchmark'
import { measureMediaAnalysisScheduler } from './mediaAnalysisBenchmark'
import { MediaJobScheduler } from '../../app/mediaJobScheduler'
import {
  PERFORMANCE_FIXTURE_HEIGHT,
  PERFORMANCE_FIXTURE_RATE,
  PERFORMANCE_FIXTURE_SOURCE_FRAMES,
  PERFORMANCE_FIXTURE_SOURCE_IN_FRAME,
  PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS,
  PERFORMANCE_FIXTURE_WIDTH,
  createPerformanceFixture,
  expectedFixtureDrawnClipIds,
  fingerprintPerformanceFixture,
  type PerformanceFixture,
  type PerformanceFixtureMediaGenerationSettings,
  type PerformanceFixtureRuntimeMedia,
} from './fixture'

const RENDER_TIMEOUT_MS = 30_000
const FIRST_FRAME_TIMEOUT_MS = 60_000
const PLAYBACK_STARTUP_TIMEOUT_MS = 30_000
const MAX_PLAYBACK_DIAGNOSTICS_PER_TRIAL = 10_000
const AUDIO_UNDERRUN_TOLERANCE_SECONDS = 0.005
const MEMORY_SETTLE_MS = 50
const MAX_LONG_ANIMATION_FRAME_ENTRIES = 500
const PERFORMANCE_HISTORY_EDIT_PAIRS = 3
const MEBIBYTE = 1024 * 1024
const KIBIBYTE = 1024
const CHROMIUM_MEMORY_SOURCE =
  'cdp:SystemInfo.getProcessInfo+host-os-process' as const
const CHROMIUM_MEMORY_SCOPE =
  'Aggregate host OS memory for every live Chromium process returned by SystemInfo.getProcessInfo at each batch boundary, including browser, renderer processes hosting the page and DedicatedWorkers, GPU, and utility processes. Native ImageBitmap/VideoFrame/render-cache allocations charged to those processes are in scope; device VRAM and memory not charged to a Chromium process are out of scope.'

export const DEFAULT_PERFORMANCE_RUN_OPTIONS: Readonly<PerformanceRunOptions> =
  Object.freeze({
    sampleCount: 7,
    playbackRuns: 3,
    playbackDurationMs: 2_000,
    memoryBatches: 7,
    scrubsPerMemoryBatch: 8,
    exportFrames: 30,
    skipExport: false,
  })

export const SMOKE_PERFORMANCE_RUN_OPTIONS: Readonly<PerformanceRunOptions> =
  Object.freeze({
    sampleCount: 2,
    playbackRuns: 1,
    playbackDurationMs: 350,
    memoryBatches: 2,
    scrubsPerMemoryBatch: 2,
    exportFrames: 3,
    skipExport: true,
  })

export const MAX_CONTINUOUS_PLAYBACK_DURATION_MS = 2_000
export const MAX_CONTINUOUS_EXPORT_FRAMES = 31

const EXPORT_METRIC_DEFINITION =
  'Elapsed export time divided by the bounded connected 4K A/V composition segment duration.'
const MAX_CONTINUOUS_PLAYBACK_FRAME_COUNT = Math.ceil(
  MAX_CONTINUOUS_PLAYBACK_DURATION_MS
  * PERFORMANCE_FIXTURE_RATE.num
  / (1_000 * PERFORMANCE_FIXTURE_RATE.den),
)
const PERFORMANCE_EXPORT_TRANSITION_FRAMES = 30
const SYNTHETIC_VIDEO_SEQUENTIAL_FRAME_COUNT =
  PERFORMANCE_FIXTURE_SOURCE_IN_FRAME + Math.max(
    MAX_CONTINUOUS_PLAYBACK_FRAME_COUNT,
    MAX_CONTINUOUS_EXPORT_FRAMES + PERFORMANCE_EXPORT_TRANSITION_FRAMES,
  )

export interface PerformanceHarnessRunRequest {
  readonly host: HostPerformanceMetadata
  readonly chromium: ChromiumPerformanceMetadata
  readonly options?: Partial<PerformanceRunOptions>
  readonly launcherInteractiveSamples?: readonly number[]
  readonly editorFirstUsableFrameSamples?: readonly number[]
  readonly consoleProblems?: readonly string[]
}

export interface PerformanceHarnessRunResult {
  readonly artifact: PerformanceArtifact
  readonly summaryMarkdown: string
}

export interface PerformanceHarnessApi {
  readonly fixture: PerformanceFixtureSummary
  firstUsableFrameMs(): Promise<number>
  run(request: PerformanceHarnessRunRequest): Promise<PerformanceHarnessRunResult>
  formatArtifact(artifact: PerformanceArtifact): string
  cleanup(): Promise<PerformanceResourceEvidence>
}

interface GlobalWithGc {
  gc?: () => void
}

interface ProcessMemorySampleResult {
  readonly status: 'measured'
  readonly sample: ChromiumProcessMemoryBatchSample
}

interface ProcessMemoryUnavailableResult {
  readonly status: 'unavailable'
  readonly reason: string
}

type ProcessMemoryBindingResult =
  | ProcessMemorySampleResult
  | ProcessMemoryUnavailableResult

interface PerformanceMemoryWindow extends Window {
  __myrelithSampleChromiumProcessMemory?: (
    request: { readonly batchIndex: number },
  ) => Promise<ProcessMemoryBindingResult>
}

interface UserAgentSpecificMemoryResult {
  readonly bytes: number
  readonly breakdown?: readonly unknown[]
}

interface LabMemoryPerformance extends Performance {
  measureUserAgentSpecificMemory?: () => Promise<UserAgentSpecificMemoryResult>
}

interface LongAnimationFrameCapture {
  finish(): LongAnimationFrameEvidence
}

function startLongAnimationFrameCapture(): LongAnimationFrameCapture {
  const supported = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
  if (!supported) {
    return {
      finish: () => ({
        status: 'unavailable',
        reason: 'PerformanceObserver long-animation-frame entries are unavailable.',
        entryCount: 0,
        overflowed: false,
        durationMs: [],
      }),
    }
  }
  const durationMs: number[] = []
  let entryCount = 0
  let overflowed = false
  let observer: PerformanceObserver
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        entryCount++
        if (durationMs.length < MAX_LONG_ANIMATION_FRAME_ENTRIES) {
          durationMs.push(entry.duration)
        } else {
          overflowed = true
        }
      }
    })
    observer.observe({ type: 'long-animation-frame', buffered: true })
  } catch (cause) {
    return {
      finish: () => ({
        status: 'unavailable',
        reason: `Long-animation-frame observation failed: ${errorMessage(cause)}`,
        entryCount: 0,
        overflowed: false,
        durationMs: [],
      }),
    }
  }
  let finished: LongAnimationFrameEvidence | null = null
  return {
    finish: () => {
      if (finished) return finished
      observer.takeRecords().forEach((entry) => {
        entryCount++
        if (durationMs.length < MAX_LONG_ANIMATION_FRAME_ENTRIES) {
          durationMs.push(entry.duration)
        } else {
          overflowed = true
        }
      })
      observer.disconnect()
      finished = {
        status: 'measured',
        reason: null,
        entryCount,
        overflowed,
        durationMs,
      }
      return finished
    },
  }
}

async function measureUserAgentSpecificMemory(): Promise<
  UserAgentSpecificMemoryEvidence
> {
  const method = (performance as LabMemoryPerformance)
    .measureUserAgentSpecificMemory
  if (typeof method !== 'function') {
    return {
      status: 'unavailable',
      reason: 'performance.measureUserAgentSpecificMemory is unavailable.',
      bytes: null,
      breakdownCount: null,
    }
  }
  try {
    const result = await method.call(performance)
    if (!Number.isFinite(result.bytes) || result.bytes < 0) {
      throw new TypeError('measureUserAgentSpecificMemory returned invalid bytes')
    }
    return {
      status: 'measured',
      reason: null,
      bytes: result.bytes,
      breakdownCount: Array.isArray(result.breakdown)
        ? result.breakdown.length
        : 0,
    }
  } catch (cause) {
    return {
      status: 'unavailable',
      reason: `performance.measureUserAgentSpecificMemory failed: ${errorMessage(cause)}`,
      bytes: null,
      breakdownCount: null,
    }
  }
}

interface StoredState {
  readonly document: ReturnType<typeof useDocumentStore.getState>
  readonly media: ReturnType<typeof useMediaStore.getState>
  readonly projectSession: ReturnType<typeof useProjectSessionStore.getState>
  readonly transport: ReturnType<typeof useTransportStore.getState>
}

export interface CanonicalPerformanceRunState {
  readonly document: ReturnType<typeof useDocumentStore.getState>
  readonly media: ReturnType<typeof useMediaStore.getState>
  readonly transport: ReturnType<typeof useTransportStore.getState>
}

interface DiagnosticWaiter {
  readonly frame: number
  readonly resolve: (diagnostic: PreviewRenderDiagnostic) => void
  readonly reject: (reason: Error) => void
  missingExpectedClipIds: readonly string[]
  timeout: ReturnType<typeof setTimeout>
}

interface CreatedSources {
  readonly video: Blob
  readonly png: Blob
  readonly wav: Blob
  readonly assets: readonly MediaAsset[]
  readonly objectUrls: readonly string[]
}

function runtimeMediaIdentity(sources: CreatedSources): PerformanceFixtureRuntimeMedia {
  return {
    video: sources.video,
    png: sources.png,
    wav: sources.wav,
    generation: PERFORMANCE_FIXTURE_MEDIA_GENERATION_SETTINGS,
  }
}

export interface PerformanceHarnessPreparationDeps {
  createVideo(): Promise<Blob>
  createPng(): Promise<Blob>
  createWav(): Blob
  fingerprintFixture(
    fixture: PerformanceFixture,
    runtimeMedia: PerformanceFixtureRuntimeMedia,
  ): Promise<string>
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

interface PlaybackAudioDiagnostic {
  readonly anchorTime: number
  readonly contextTime: number
  readonly scheduledThroughContextTime: number
}

export interface PlaybackObservationDeps {
  startPlayback(): void
  now(): number
  sleep(milliseconds: number): Promise<void>
  getAudioDiagnostics(): PlaybackAudioDiagnostic | null
  getPlayheadFrame(): number
}

export interface PlaybackObservation {
  readonly audioUnderruns: number
  readonly sawAudioDiagnostics: boolean
}

/**
 * Observe only the requested playback window, excluding asynchronous startup.
 * Playback is armed only after the audio context reaches its scheduled clock
 * anchor or the audio-clock-driven engine advances the playhead. Merely
 * exposing future-scheduled diagnostics, or drawing the already-visible start
 * frame after isPlaying changes, is deliberately not sufficient.
 */
export async function observeStartedPlayback(
  durationMs: number,
  deps: PlaybackObservationDeps,
  startupTimeoutMs = PLAYBACK_STARTUP_TIMEOUT_MS,
): Promise<PlaybackObservation> {
  const startFrame = deps.getPlayheadFrame()
  deps.startPlayback()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      reject(new Error(
        `Timed out after ${startupTimeoutMs} ms waiting for the playback clock to start`,
      ))
    }, startupTimeoutMs)
    const poll = (): void => {
      if (settled) return
      const audioDiagnostic = deps.getAudioDiagnostics()
      if (
        (
          audioDiagnostic !== null
          && audioDiagnostic.contextTime >= audioDiagnostic.anchorTime
        )
        || deps.getPlayheadFrame() > startFrame
      ) {
        settled = true
        clearTimeout(timeout)
        resolve()
        return
      }
      void deps.sleep(10).then(poll, (cause) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(cause)
      })
    }
    poll()
  })

  const observationStartedAt = deps.now()
  let audioUnderruns = 0
  let sawAudioDiagnostics = false
  while (deps.now() - observationStartedAt < durationMs) {
    await deps.sleep(25)
    const diagnostic = deps.getAudioDiagnostics()
    if (!diagnostic) continue
    sawAudioDiagnostics = true
    if (
      diagnostic.scheduledThroughContextTime
      + AUDIO_UNDERRUN_TOLERANCE_SECONDS
      < diagnostic.contextTime
    ) {
      audioUnderruns++
    }
  }
  return { audioUnderruns, sawAudioDiagnostics }
}

export interface FinishedPlaybackDiagnosticCapture {
  readonly frames: readonly number[]
  readonly overflowed: boolean
}

/** Retains only bounded frame numbers, and only while one trial is active. */
export class PlaybackDiagnosticCapture {
  private readonly maximumDiagnostics: number
  private readonly acceptsDiagnostic: (diagnostic: PreviewRenderDiagnostic) => boolean
  private frames: number[] = []
  private active = true
  private didOverflow = false

  constructor(
    maximumDiagnostics = MAX_PLAYBACK_DIAGNOSTICS_PER_TRIAL,
    acceptsDiagnostic: (diagnostic: PreviewRenderDiagnostic) => boolean = () => true,
  ) {
    if (!Number.isSafeInteger(maximumDiagnostics) || maximumDiagnostics < 1) {
      throw new Error('Playback diagnostic capacity must be a positive integer')
    }
    this.maximumDiagnostics = maximumDiagnostics
    this.acceptsDiagnostic = acceptsDiagnostic
  }

  record(diagnostic: PreviewRenderDiagnostic): void {
    if (
      !this.active
      || diagnostic.mode !== 'playback'
      || diagnostic.result.status !== 'drawn'
      || !this.acceptsDiagnostic(diagnostic)
    ) return
    if (this.frames.length < this.maximumDiagnostics) {
      this.frames.push(diagnostic.frame)
    } else {
      this.didOverflow = true
    }
  }

  retainedCount(): number {
    return this.frames.length
  }

  finish(): FinishedPlaybackDiagnosticCapture {
    this.active = false
    const frames = this.frames
    this.frames = []
    return { frames, overflowed: this.didOverflow }
  }
}

/** Snapshot the timed trial before pause/paint work can report late frames. */
export async function finishPlaybackCaptureBeforeSettling(
  capture: PlaybackDiagnosticCapture,
  pausePlayback: () => void,
  settleAfterPause: () => Promise<void>,
): Promise<FinishedPlaybackDiagnosticCapture> {
  const captured = capture.finish()
  pausePlayback()
  await settleAfterPause()
  return captured
}

/** The inclusive clock-derived terminal frame for a timed playback trial. */
export function expectedTerminalFrameForPlaybackTrial(
  expectedStartFrame: number,
  durationMs: number,
  rate: FrameRate,
): number {
  return expectedStartFrame + Math.ceil(
    (durationMs * rate.num) / (1_000 * rate.den),
  ) - 1
}

export function missingExpectedFixtureDrawnClipIds(
  fixture: PerformanceFixture,
  diagnostic: PreviewRenderDiagnostic,
): readonly string[] {
  const drawnClipIds = new Set(diagnostic.result.drawnClipIds)
  return expectedFixtureDrawnClipIds(fixture, diagnostic.frame).filter(
    (clipId) => !drawnClipIds.has(clipId),
  )
}

export function diagnosticDrawsExpectedFixtureClips(
  fixture: PerformanceFixture,
  diagnostic: PreviewRenderDiagnostic,
): boolean {
  return diagnostic.result.status === 'drawn'
    && expectedFixtureDrawnClipIds(fixture, diagnostic.frame).length > 0
    && missingExpectedFixtureDrawnClipIds(fixture, diagnostic).length === 0
}

/** Include missing frames before, between, and after observed presentations. */
export function droppedFramesForPlaybackTrial(
  frames: readonly number[],
  expectedStartFrame: number,
  expectedTerminalFrame: number,
): number | null {
  if (frames.length === 0) return null
  let previous = expectedStartFrame - 1
  let dropped = 0
  for (const frame of frames) {
    if (
      frame < expectedStartFrame
      || frame > expectedTerminalFrame
      || frame <= previous
    ) continue
    dropped += frame - previous - 1
    previous = frame
  }
  return dropped + Math.max(0, expectedTerminalFrame - previous)
}

export function aggregatePlaybackAudioUnderruns(
  observations: readonly PlaybackObservation[],
): {
  readonly audioUnderruns: number[] | null
  readonly unavailableReason: string | null
} {
  const missingTrials = observations.flatMap((observation, index) => (
    observation.sawAudioDiagnostics ? [] : [index + 1]
  ))
  if (missingTrials.length > 0) {
    return {
      audioUnderruns: null,
      unavailableReason:
        `Audio diagnostics were unavailable for playback trial${missingTrials.length === 1 ? '' : 's'} ${missingTrials.join(', ')}; missing evidence was not counted as zero.`,
    }
  }
  return {
    audioUnderruns: observations.map((observation) => observation.audioUnderruns),
    unavailableReason: null,
  }
}

/** Preserve every requested plateau value while refusing growth from one point. */
export function summarizeMemorySamples(samples: readonly number[]): {
  readonly plateauMiB: number[]
  readonly growthKiB: number[] | null
} {
  const plateauMiB = [...samples]
  if (plateauMiB.length < 2) return { plateauMiB, growthKiB: null }
  return {
    plateauMiB,
    growthKiB: plateauMiB.slice(1).map(
      (sample, index) => (sample - plateauMiB[index]) * MEBIBYTE / KIBIBYTE,
    ),
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validatedProcessMemorySample(
  value: unknown,
  expectedBatchIndex: number,
): ChromiumProcessMemoryBatchSample {
  if (!value || typeof value !== 'object') {
    throw new TypeError('The host memory binding returned no batch sample')
  }
  const sample = value as ChromiumProcessMemoryBatchSample
  if (sample.batchIndex !== expectedBatchIndex) {
    throw new Error(
      `The host memory binding returned batch ${sample.batchIndex} for boundary ${expectedBatchIndex}`,
    )
  }
  if (sample.source !== CHROMIUM_MEMORY_SOURCE) {
    throw new Error('The host memory binding returned an unsupported provenance source')
  }
  if (!sample.hostSampler || typeof sample.hostSampler !== 'string') {
    throw new Error('The host memory binding omitted its OS sampler provenance')
  }
  if (sample.primaryMetric !== 'private-bytes' && sample.primaryMetric !== 'rss-bytes') {
    throw new Error('The host memory binding returned an unsupported primary metric')
  }
  if (!isNonNegativeSafeInteger(sample.totalBytes)) {
    throw new Error('The host memory binding returned an invalid aggregate byte count')
  }
  if (!Array.isArray(sample.processes) || sample.processes.length === 0) {
    throw new Error('The host memory binding returned an empty Chromium process table')
  }
  const processIds = new Set<number>()
  let totalBytes = 0
  let sawRenderer = false
  let sawGpu = false
  for (const process of sample.processes) {
    if (
      !isNonNegativeSafeInteger(process.pid)
      || process.pid === 0
      || processIds.has(process.pid)
      || typeof process.type !== 'string'
      || !process.type
      || !Number.isFinite(process.cpuTimeSeconds)
      || process.cpuTimeSeconds < 0
      || !isNonNegativeSafeInteger(process.metricBytes)
      || (process.rssBytes !== null && !isNonNegativeSafeInteger(process.rssBytes))
      || (process.privateBytes !== null && !isNonNegativeSafeInteger(process.privateBytes))
    ) throw new Error('The host memory binding returned an invalid process entry')
    processIds.add(process.pid)
    sawRenderer ||= /renderer/i.test(process.type)
    sawGpu ||= /gpu/i.test(process.type)
    totalBytes += process.metricBytes
  }
  if (!sawRenderer || !sawGpu) {
    throw new Error('The host memory binding did not cover both renderer and GPU processes')
  }
  if (totalBytes !== sample.totalBytes) {
    throw new Error('The host memory binding aggregate does not match its process rows')
  }
  return sample
}

export async function collectChromiumProcessMemoryEvidence(
  options: Pick<PerformanceRunOptions, 'memoryBatches'>,
  runBatchWork: (batchIndex: number) => Promise<void>,
  sampleMemory: PerformanceMemoryWindow['__myrelithSampleChromiumProcessMemory'],
  platform: string,
): Promise<ChromiumProcessMemoryEvidence> {
  const samples: ChromiumProcessMemoryBatchSample[] = []
  let unavailableReason = sampleMemory
    ? null
    : 'The command-line Chromium host process-memory binding is unavailable.'
  for (let batchIndex = 1; batchIndex <= options.memoryBatches; batchIndex++) {
    await runBatchWork(batchIndex)
    if (!sampleMemory) continue
    try {
      const result = await sampleMemory({ batchIndex })
      if (result.status === 'unavailable') {
        unavailableReason ??= result.reason
        continue
      }
      const sample = validatedProcessMemorySample(result.sample, batchIndex)
      const first = samples[0]
      if (
        first
        && (
          first.hostSampler !== sample.hostSampler
          || first.primaryMetric !== sample.primaryMetric
        )
      ) {
        unavailableReason ??=
          'Host process-memory provenance changed between batch boundaries.'
        continue
      }
      samples.push(sample)
    } catch (cause) {
      unavailableReason ??=
        `Host process-memory sampling failed: ${errorMessage(cause)}`
    }
  }
  if (unavailableReason || samples.length !== options.memoryBatches) {
    return {
      status: 'unavailable',
      source: CHROMIUM_MEMORY_SOURCE,
      scope: CHROMIUM_MEMORY_SCOPE,
      platform,
      hostSampler: null,
      primaryMetric: null,
      reason: unavailableReason
        ?? `Expected ${options.memoryBatches} complete process-memory samples but received ${samples.length}.`,
      samples: [],
    }
  }
  return {
    status: 'measured',
    source: CHROMIUM_MEMORY_SOURCE,
    scope: CHROMIUM_MEMORY_SCOPE,
    platform,
    hostSampler: samples[0].hostSampler,
    primaryMetric: samples[0].primaryMetric,
    reason: null,
    samples,
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function afterTwoAnimationFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function normalizedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) return fallback
  return Math.min(value as number, maximum)
}

export function normalizedRunOptions(
  options: Partial<PerformanceRunOptions> | undefined,
): PerformanceRunOptions {
  if (
    Number.isSafeInteger(options?.playbackDurationMs)
    && (options?.playbackDurationMs ?? 0) > MAX_CONTINUOUS_PLAYBACK_DURATION_MS
  ) {
    throw new RangeError(
      `Playback duration exceeds the ${MAX_CONTINUOUS_PLAYBACK_DURATION_MS} ms continuous encoded source window`,
    )
  }
  if (
    Number.isSafeInteger(options?.exportFrames)
    && (options?.exportFrames ?? 0) > MAX_CONTINUOUS_EXPORT_FRAMES
  ) {
    throw new RangeError(
      `Export duration exceeds the ${MAX_CONTINUOUS_EXPORT_FRAMES}-frame continuous encoded source window`,
    )
  }
  return {
    sampleCount: normalizedPositiveInteger(
      options?.sampleCount,
      DEFAULT_PERFORMANCE_RUN_OPTIONS.sampleCount,
      100,
    ),
    playbackRuns: normalizedPositiveInteger(
      options?.playbackRuns,
      DEFAULT_PERFORMANCE_RUN_OPTIONS.playbackRuns,
      20,
    ),
    playbackDurationMs: normalizedPositiveInteger(
      options?.playbackDurationMs,
      DEFAULT_PERFORMANCE_RUN_OPTIONS.playbackDurationMs,
      MAX_CONTINUOUS_PLAYBACK_DURATION_MS,
    ),
    memoryBatches: normalizedPositiveInteger(
      options?.memoryBatches,
      DEFAULT_PERFORMANCE_RUN_OPTIONS.memoryBatches,
      50,
    ),
    scrubsPerMemoryBatch: normalizedPositiveInteger(
      options?.scrubsPerMemoryBatch,
      DEFAULT_PERFORMANCE_RUN_OPTIONS.scrubsPerMemoryBatch,
      100,
    ),
    exportFrames: normalizedPositiveInteger(
      options?.exportFrames,
      DEFAULT_PERFORMANCE_RUN_OPTIONS.exportFrames,
      MAX_CONTINUOUS_EXPORT_FRAMES,
    ),
    skipExport: options?.skipExport ?? DEFAULT_PERFORMANCE_RUN_OPTIONS.skipExport,
  }
}

function browserMetadata(): BrowserPerformanceMetadata {
  const extendedNavigator = navigator as Navigator & { deviceMemory?: number }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    logicalProcessors: Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : null,
    deviceMemoryGiB: Number.isFinite(extendedNavigator.deviceMemory)
      ? extendedNavigator.deviceMemory ?? null
      : null,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    crossOriginIsolated: window.crossOriginIsolated,
    webCodecs: 'VideoDecoder' in window && 'VideoEncoder' in window,
    offscreenCanvas: 'OffscreenCanvas' in window,
  }
}

export interface Synthetic4kVideoSample {
  readonly index: number
  readonly timestampSeconds: number
  readonly durationSeconds: number
}

/**
 * Keep generation bounded while covering the exact supported playback window
 * with ordinary frame-rate samples. One final tail sample preserves the
 * fixture's declared 47-second source duration for later bounded seeks.
 */
export function createSynthetic4kVideoSamplePlan(): readonly Synthetic4kVideoSample[] {
  const frameDurationSeconds = PERFORMANCE_FIXTURE_RATE.den
    / PERFORMANCE_FIXTURE_RATE.num
  const sourceDurationSeconds = PERFORMANCE_FIXTURE_SOURCE_MICROSECONDS / 1e6
  const samples: Synthetic4kVideoSample[] = Array.from(
    { length: SYNTHETIC_VIDEO_SEQUENTIAL_FRAME_COUNT },
    (_, index) => ({
      index,
      timestampSeconds: index * frameDurationSeconds,
      durationSeconds: frameDurationSeconds,
    }),
  )
  const tailTimestampSeconds = SYNTHETIC_VIDEO_SEQUENTIAL_FRAME_COUNT
    * frameDurationSeconds
  if (tailTimestampSeconds < sourceDurationSeconds) {
    samples.push({
      index: SYNTHETIC_VIDEO_SEQUENTIAL_FRAME_COUNT,
      timestampSeconds: tailTimestampSeconds,
      durationSeconds: sourceDurationSeconds - tailTimestampSeconds,
    })
  }
  return samples
}

export const PERFORMANCE_FIXTURE_MEDIA_GENERATION_SETTINGS:
Readonly<PerformanceFixtureMediaGenerationSettings> = Object.freeze({
  version: 'generated-media-v2',
  video: Object.freeze({
    width: PERFORMANCE_FIXTURE_WIDTH,
    height: PERFORMANCE_FIXTURE_HEIGHT,
    codec: 'avc',
    bitrate: 12_000_000,
    keyFrameInterval: 1,
    frameRate: Object.freeze({ ...PERFORMANCE_FIXTURE_RATE }),
    samplePlan: Object.freeze([...createSynthetic4kVideoSamplePlan()]),
  }),
  png: Object.freeze({
    width: PERFORMANCE_FIXTURE_WIDTH,
    height: PERFORMANCE_FIXTURE_HEIGHT,
    mimeType: 'image/png',
  }),
  wav: Object.freeze({
    durationSeconds: 47,
    sampleRate: 48_000,
    channels: 2,
    bytesPerSample: 2,
    frequenciesHz: Object.freeze([220, 330] as const),
    amplitude: 0.12,
    mimeType: 'audio/wav',
  }),
})

async function createSynthetic4kPng(): Promise<Blob> {
  const settings = PERFORMANCE_FIXTURE_MEDIA_GENERATION_SETTINGS.png
  const canvas = new OffscreenCanvas(
    settings.width,
    settings.height,
  )
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D OffscreenCanvas is unavailable')
  const gradient = context.createLinearGradient(
    0,
    0,
    PERFORMANCE_FIXTURE_WIDTH,
    PERFORMANCE_FIXTURE_HEIGHT,
  )
  gradient.addColorStop(0, '#171d2f')
  gradient.addColorStop(0.5, '#5a4ab8')
  gradient.addColorStop(1, '#e66c5c')
  context.fillStyle = gradient
  context.fillRect(0, 0, PERFORMANCE_FIXTURE_WIDTH, PERFORMANCE_FIXTURE_HEIGHT)
  for (let index = 0; index < 48; index++) {
    context.fillStyle = `hsla(${index * 19}, 80%, 70%, 0.24)`
    context.fillRect(
      (index * 317) % PERFORMANCE_FIXTURE_WIDTH,
      (index * 173) % PERFORMANCE_FIXTURE_HEIGHT,
      480,
      270,
    )
  }
  context.fillStyle = '#ffffff'
  context.font = '700 180px system-ui'
  context.textAlign = 'center'
  context.fillText(
    'Myrelith 4K benchmark',
    PERFORMANCE_FIXTURE_WIDTH / 2,
    PERFORMANCE_FIXTURE_HEIGHT / 2,
  )
  return canvas.convertToBlob({ type: settings.mimeType })
}

async function createSynthetic4kVideo(): Promise<Blob> {
  const settings = PERFORMANCE_FIXTURE_MEDIA_GENERATION_SETTINGS.video
  const canvas = new OffscreenCanvas(
    settings.width,
    settings.height,
  )
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D OffscreenCanvas is unavailable')
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new CanvasSource(canvas, {
    codec: settings.codec,
    bitrate: settings.bitrate,
    keyFrameInterval: settings.keyFrameInterval,
  })
  output.addVideoTrack(source, {
    frameRate: settings.frameRate.num / settings.frameRate.den,
  })
  let finalized = false
  try {
    await output.start()
    for (const sample of settings.samplePlan) {
      const hue = sample.index * 19 % 360
      context.fillStyle = `hsl(${hue} 42% 14%)`
      context.fillRect(0, 0, PERFORMANCE_FIXTURE_WIDTH, PERFORMANCE_FIXTURE_HEIGHT)
      context.fillStyle = `hsl(${hue + 96} 72% 58%)`
      context.fillRect(
        160 + sample.index * 53 % 2_400,
        240 + sample.index * 29 % 1_080,
        1_280,
        720,
      )
      context.fillStyle = '#ffffff'
      context.font = '700 180px system-ui'
      context.textAlign = 'center'
      context.fillText(
        `Myrelith 4K video ${sample.index + 1}`,
        PERFORMANCE_FIXTURE_WIDTH / 2,
        PERFORMANCE_FIXTURE_HEIGHT / 2,
      )
      await source.add(sample.timestampSeconds, sample.durationSeconds)
    }
    await output.finalize()
    finalized = true
  } finally {
    if (!finalized) {
      try {
        await output.cancel()
      } catch {
        // Preserve the generation failure; cancel is best-effort here.
      }
    }
  }
  if (!target.buffer || target.buffer.byteLength === 0) {
    throw new Error('Generated benchmark video is empty')
  }
  return new Blob([target.buffer], { type: 'video/mp4' })
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function createSyntheticWav(): Blob {
  const settings = PERFORMANCE_FIXTURE_MEDIA_GENERATION_SETTINGS.wav
  const {
    durationSeconds,
    sampleRate,
    channels,
    bytesPerSample,
  } = settings
  const frameCount = durationSeconds * sampleRate
  const dataBytes = frameCount * channels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  const amplitude = settings.amplitude * 0x7fff
  for (let frame = 0; frame < frameCount; frame++) {
    const envelope = Math.min(1, frame / 2_400, (frameCount - frame) / 2_400)
    const left = Math.round(
      Math.sin(2 * Math.PI * settings.frequenciesHz[0] * frame / sampleRate)
        * amplitude * envelope,
    )
    const right = Math.round(
      Math.sin(2 * Math.PI * settings.frequenciesHz[1] * frame / sampleRate)
        * amplitude * envelope,
    )
    const offset = 44 + frame * channels * bytesPerSample
    view.setInt16(offset, left, true)
    view.setInt16(offset + bytesPerSample, right, true)
  }
  return new Blob([buffer], { type: settings.mimeType })
}

const BROWSER_PREPARATION_DEPS: PerformanceHarnessPreparationDeps = {
  createVideo: createSynthetic4kVideo,
  createPng: createSynthetic4kPng,
  createWav: createSyntheticWav,
  fingerprintFixture: fingerprintPerformanceFixture,
}

function runtimeAsset(
  descriptor: PortableAssetDescriptor,
  objectUrl: string,
): MediaAsset {
  return {
    id: descriptor.id,
    fileName: descriptor.fileName,
    mimeType: descriptor.mimeType,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
    objectUrl,
    kind: descriptor.kind,
    ...(descriptor.partialTrackSelection === undefined
      ? {}
      : { partialTrackSelection: descriptor.partialTrackSelection }),
    durationFrames: microsecondsDurationToFrames(
      descriptor.durationMicroseconds,
      PERFORMANCE_FIXTURE_RATE,
    ),
    durationMicroseconds: descriptor.durationMicroseconds,
    sourceBounds: descriptor.sourceBounds,
    frameRate: descriptor.nativeFrameRate,
    width: descriptor.width,
    height: descriptor.height,
    hasAudio: descriptor.hasAudio,
    audioSampleRate: descriptor.audioSampleRate,
    audioChannels: descriptor.audioChannels,
    decoderConfigB64: null,
  }
}

async function createConnectedSources(
  fixture: PerformanceFixture,
  deps: PerformanceHarnessPreparationDeps,
): Promise<CreatedSources> {
  const [video, png, wav] = await Promise.all([
    deps.createVideo(),
    deps.createPng(),
    Promise.resolve(deps.createWav()),
  ])
  const descriptors = new Map(
    fixture.project.assets.map((descriptor) => [descriptor.id, descriptor]),
  )
  const objectUrls: string[] = []
  const assets: MediaAsset[] = []
  try {
    for (const assetId of fixture.connectedVideoAssetIds) {
      const descriptor = descriptors.get(assetId)
      if (!descriptor) throw new Error(`Fixture video ${assetId} is missing`)
      const objectUrl = URL.createObjectURL(video)
      objectUrls.push(objectUrl)
      assets.push(runtimeAsset(descriptor, objectUrl))
    }
    for (const assetId of fixture.connectedImageAssetIds) {
      const descriptor = descriptors.get(assetId)
      if (!descriptor) throw new Error(`Fixture image ${assetId} is missing`)
      const objectUrl = URL.createObjectURL(png)
      objectUrls.push(objectUrl)
      assets.push(runtimeAsset(descriptor, objectUrl))
    }
    for (const assetId of fixture.connectedAudioAssetIds) {
      const descriptor = descriptors.get(assetId)
      if (!descriptor) throw new Error(`Fixture audio ${assetId} is missing`)
      const objectUrl = URL.createObjectURL(wav)
      objectUrls.push(objectUrl)
      assets.push(runtimeAsset(descriptor, objectUrl))
    }
  } catch (cause) {
    for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
    throw cause
  }
  return { video, png, wav, assets, objectUrls }
}

function assertIsolatedEntry(): StoredState {
  const projectSession = useProjectSessionStore.getState()
  const document = useDocumentStore.getState()
  const media = useMediaStore.getState()
  const transport = useTransportStore.getState()
  if (projectSession.screen !== 'home' || projectSession.phase !== 'idle') {
    throw new Error('Performance harness refused to replace an active project session')
  }
  if (
    media.descriptors.size > 0
    || media.assets.size > 0
    || media.visuals.size > 0
    || media.compatibility.size > 0
  ) {
    throw new Error('Performance harness requires an empty media store')
  }
  if (document.past.length > 0 || document.future.length > 0) {
    throw new Error('Performance harness requires an empty document history')
  }
  return { document, media, projectSession, transport }
}

function shallowStateRestored<T extends object>(current: T, initial: T): boolean {
  return (Object.keys(initial) as Array<keyof T>).every(
    (key) => current[key] === initial[key],
  )
}

function mapsHaveSameEntries<K, V>(
  current: ReadonlyMap<K, V>,
  canonical: ReadonlyMap<K, V>,
): boolean {
  if (current.size !== canonical.size) return false
  for (const [key, value] of canonical) {
    if (current.get(key) !== value) return false
  }
  return true
}

export function captureCanonicalPerformanceRunState(): CanonicalPerformanceRunState {
  return {
    document: useDocumentStore.getState(),
    media: useMediaStore.getState(),
    transport: useTransportStore.getState(),
  }
}

export async function resetAndVerifyCanonicalPerformanceRunState(
  fixture: PerformanceFixture,
  expectedFingerprint: string,
  canonical: CanonicalPerformanceRunState,
  runtimeMedia: PerformanceFixtureRuntimeMedia,
  fingerprintFixture: (
    fixture: PerformanceFixture,
    runtimeMedia: PerformanceFixtureRuntimeMedia,
  ) => Promise<string>,
): Promise<void> {
  pause()

  const currentDocument = useDocumentStore.getState()
  if (
    currentDocument.doc !== canonical.document.doc
    || currentDocument.past !== canonical.document.past
    || currentDocument.future !== canonical.document.future
  ) {
    useDocumentStore.setState({
      doc: canonical.document.doc,
      past: canonical.document.past,
      future: canonical.document.future,
    })
  }

  const currentTransport = useTransportStore.getState()
  if (!shallowStateRestored(currentTransport, canonical.transport)) {
    useTransportStore.getState().resetTransport()
  }

  const currentMedia = useMediaStore.getState()
  if (
    !mapsHaveSameEntries(currentMedia.descriptors, canonical.media.descriptors)
    || !mapsHaveSameEntries(currentMedia.assets, canonical.media.assets)
    || !mapsHaveSameEntries(currentMedia.visuals, canonical.media.visuals)
    || !mapsHaveSameEntries(currentMedia.compatibility, canonical.media.compatibility)
  ) {
    if (canonical.media.visuals.size > 0) {
      throw new Error('Canonical performance media unexpectedly owns generated visuals')
    }
    const replaced = useMediaStore.getState().replaceAssets(
      canonical.media.descriptors.values(),
      canonical.media.assets.values(),
      canonical.media.compatibility.values(),
    )
    if (!replaced) {
      throw new Error('Performance fixture media could not be reset before the run')
    }
  }

  const restoredDocument = useDocumentStore.getState()
  const restoredMedia = useMediaStore.getState()
  const restoredTransport = useTransportStore.getState()
  if (
    restoredDocument.doc !== canonical.document.doc
    || restoredDocument.past !== canonical.document.past
    || restoredDocument.future !== canonical.document.future
    || !mapsHaveSameEntries(restoredMedia.descriptors, canonical.media.descriptors)
    || !mapsHaveSameEntries(restoredMedia.assets, canonical.media.assets)
    || !mapsHaveSameEntries(restoredMedia.visuals, canonical.media.visuals)
    || !mapsHaveSameEntries(restoredMedia.compatibility, canonical.media.compatibility)
    || !shallowStateRestored(restoredTransport, canonical.transport)
  ) {
    throw new Error('Performance fixture stores did not reset to their canonical run state')
  }

  const currentFingerprint = await fingerprintFixture({
    ...fixture,
    project: {
      ...fixture.project,
      document: restoredDocument.doc,
      assets: [...restoredMedia.descriptors.values()],
    },
  }, runtimeMedia)
  if (currentFingerprint !== expectedFingerprint) {
    throw new Error(
      `Performance fixture fingerprint changed before the run: expected ${expectedFingerprint}, received ${currentFingerprint}`,
    )
  }
}

/** Count only owned URLs whose real revocation call completed successfully. */
function clearBenchmarkMediaAndCountRevoked(
  benchmarkObjectUrls: readonly string[],
): number {
  const ownedUrls = new Set(benchmarkObjectUrls)
  const successfullyRevoked = new Set<string>()
  const revokeObjectUrl = URL.revokeObjectURL
  URL.revokeObjectURL = (objectUrl) => {
    try {
      revokeObjectUrl.call(URL, objectUrl)
      if (ownedUrls.has(objectUrl)) successfullyRevoked.add(objectUrl)
    } catch {
      // The evidence remains below the created count so the runner fails.
    }
  }
  try {
    useMediaStore.getState().clearAssets()
  } finally {
    URL.revokeObjectURL = revokeObjectUrl
  }
  return successfullyRevoked.size
}

function fixtureClip(
  template: TimelineDoc,
  trackKind: Track['kind'],
  assetIds: ReadonlySet<string>,
): { readonly clip: Clip; readonly track: Track } | null {
  for (const track of template.tracks) {
    if (track.kind !== trackKind) continue
    const clip = track.clips.find((candidate) => assetIds.has(candidate.assetId))
    if (clip) return { clip, track }
  }
  return null
}

function boundedExportClip(
  source: Clip,
  id: string,
  sourceRange: Clip['sourceRange'],
  timelineRange: Clip['timelineRange'],
): Clip {
  const maximumFadeFrames = Math.floor(timelineRange.durationFrames / 2)
  const visual = source.visual ?? defaultClipVisualSettings()
  const audio = source.audio ?? defaultClipAudioSettings()
  const animation = source.animation ?? defaultClipAnimation()
  const effectIdMap = new Map<string, string>()
  const effects = source.effects.map((effect, index) => {
    const effectId = `performance-export-effect-${id}-${index + 1}`
    effectIdMap.set(effect.id, effectId)
    return { ...effect, id: effectId, params: { ...effect.params } }
  })
  return {
    ...source,
    id,
    sourceRange,
    sourceTimeMap: defaultSourceTimeMap(
      sourceRange.startFrame,
      sourceRange.durationFrames,
    ),
    timelineRange,
    transform: { ...source.transform },
    visual: {
      ...visual,
      crop: { ...visual.crop },
    },
    audio: {
      ...audio,
      fadeInFrames: Math.min(audio.fadeInFrames, maximumFadeFrames),
      fadeOutFrames: Math.min(audio.fadeOutFrames, maximumFadeFrames),
    },
    animation: remapEffectAnimationIds(cloneClipAnimation(animation), effectIdMap),
    effects,
    ...(source.text === undefined ? {} : { text: { ...source.text } }),
  }
}

function boundedExportTrack(
  source: Track,
  id: string,
  clips: readonly Clip[],
  transitions: readonly Transition[] = [],
): Track {
  return {
    ...source,
    id,
    name: id,
    clips: [...clips],
    transitions: [...transitions],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

/** Build one small but source-backed A/V export composition from the fixture. */
export function createPerformanceExportDocument(
  fixture: PerformanceFixture,
  frames: number,
): TimelineDoc {
  if (
    !Number.isSafeInteger(frames)
    || frames < 1
    || frames > MAX_CONTINUOUS_EXPORT_FRAMES
  ) {
    throw new RangeError(
      `Performance export frames must be an integer from 1 through ${MAX_CONTINUOUS_EXPORT_FRAMES}`,
    )
  }
  const template = fixture.project.document
  const connectedVideoIds = new Set(fixture.connectedVideoAssetIds)
  const connectedImageIds = new Set(fixture.connectedImageAssetIds)
  const videoSource = fixtureClip(template, 'video', connectedVideoIds)
  const imageSource = fixtureClip(template, 'video', connectedImageIds)
  const textSource = template.tracks
    .filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
    .find(({ clip }) => clip.text !== undefined) ?? null
  const audioSources = fixture.connectedAudioAssetIds.slice(0, 2).map((assetId) => (
    fixtureClip(template, 'audio', new Set([assetId]))
  ))
  if (!videoSource) throw new Error('Connected fixture video clip is missing')
  if (!imageSource) throw new Error('Connected fixture image clip is missing')
  if (!textSource?.clip.text) throw new Error('Fixture text clip is missing')
  if (audioSources.length === 0 || audioSources.some((source) => source === null)) {
    throw new Error('Connected fixture audio clips are missing')
  }

  const videoClips: Clip[] = []
  const videoTransitions: Transition[] = []
  if (frames === 1) {
    videoClips.push(boundedExportClip(
      videoSource.clip,
      'performance-export-video-1',
      {
        startFrame: videoSource.clip.sourceRange.startFrame,
        durationFrames: 1,
      },
      { startFrame: 0, durationFrames: 1 },
    ))
  } else {
    const cutFrame = Math.floor(frames / 2)
    const transitionFrames = Math.min(PERFORMANCE_EXPORT_TRANSITION_FRAMES, frames)
    const secondDurationFrames = frames - cutFrame
    const secondSourceStart = videoSource.clip.sourceRange.startFrame
      + cutFrame
      + transitionFrames
    if (secondSourceStart + secondDurationFrames > PERFORMANCE_FIXTURE_SOURCE_FRAMES) {
      throw new RangeError('Performance export video segment exceeds its source bounds')
    }
    const from = boundedExportClip(
      videoSource.clip,
      'performance-export-video-1',
      {
        startFrame: videoSource.clip.sourceRange.startFrame,
        durationFrames: cutFrame,
      },
      { startFrame: 0, durationFrames: cutFrame },
    )
    const to = boundedExportClip(
      videoSource.clip,
      'performance-export-video-2',
      {
        startFrame: secondSourceStart,
        durationFrames: secondDurationFrames,
      },
      { startFrame: cutFrame, durationFrames: secondDurationFrames },
    )
    videoClips.push(from, to)
    videoTransitions.push({
      id: 'performance-export-crossfade',
      type: 'crossfade',
      fromClipId: from.id,
      toClipId: to.id,
      durationFrames: transitionFrames,
      audio: { enabled: false, curve: 'equal-power' },
    })
  }

  const imageClip = boundedExportClip(
    imageSource.clip,
    'performance-export-image',
    { ...imageSource.clip.sourceRange },
    { startFrame: 0, durationFrames: frames },
  )
  const textClip = boundedExportClip(
    textSource.clip,
    'performance-export-text',
    { startFrame: 0, durationFrames: frames },
    { startFrame: 0, durationFrames: frames },
  )
  textClip.assetId = proceduralTextAssetId(textClip.id)
  textClip.name = 'Myrelith 4K export benchmark'
  if (!textClip.text) throw new Error('Fixture text clip lost its text properties')
  textClip.text = {
    ...textClip.text,
    content: 'Myrelith 4K export benchmark',
  }

  const audioTracks = audioSources.map((source, index) => {
    if (!source) throw new Error('Connected fixture audio clip is missing')
    const clip = boundedExportClip(
      source.clip,
      `performance-export-audio-${index + 1}`,
      {
        startFrame: source.clip.sourceRange.startFrame,
        durationFrames: frames,
      },
      { startFrame: 0, durationFrames: frames },
    )
    return boundedExportTrack(source.track, `performance-export-a${index + 1}`, [clip])
  })

  return {
    ...template,
    id: 'performance-export-document',
    name: 'Performance export segment',
    tracks: [
      boundedExportTrack(
        videoSource.track,
        'performance-export-v1',
        videoClips,
        videoTransitions,
      ),
      boundedExportTrack(imageSource.track, 'performance-export-v2', [imageClip]),
      boundedExportTrack(textSource.track, 'performance-export-v3', [textClip]),
      ...audioTracks,
    ],
  }
}

export async function exportRealTimeRatioMetric(
  options: PerformanceRunOptions,
  measureExport: (options: PerformanceRunOptions) => Promise<readonly number[]>,
): Promise<PerformanceMetric> {
  if (options.skipExport) {
    return unavailableMetric(
      'ratio',
      EXPORT_METRIC_DEFINITION,
      'Export was explicitly skipped for this smoke run.',
    )
  }
  return measuredMetric(
    'ratio',
    EXPORT_METRIC_DEFINITION,
    await measureExport(options),
  )
}

class PerformanceHarnessSession implements PerformanceHarnessApi {
  readonly fixture: PerformanceFixtureSummary
  private readonly fixtureData: PerformanceFixture
  private readonly initial: StoredState
  private readonly canonical: CanonicalPerformanceRunState
  private readonly sources: CreatedSources
  private readonly fingerprintFixture: (
    fixture: PerformanceFixture,
    runtimeMedia: PerformanceFixtureRuntimeMedia,
  ) => Promise<string>
  private readonly waiters = new Set<DiagnosticWaiter>()
  private readonly firstFrame = deferred<number>()
  private readonly editorStartedAt: number
  private readonly unsubscribeDiagnostics: () => void
  private importedObjectUrlsRevoked = 0
  private playbackCapture: PlaybackDiagnosticCapture | null = null
  private longAnimationFrameCapture: LongAnimationFrameCapture | null = null
  private runPromise: Promise<PerformanceHarnessRunResult> | null = null
  private cleanupPromise: Promise<PerformanceResourceEvidence> | null = null

  constructor(
    fixtureData: PerformanceFixture,
    fixtureFingerprint: string,
    initial: StoredState,
    sources: CreatedSources,
    fingerprintFixture: (
      fixture: PerformanceFixture,
      runtimeMedia: PerformanceFixtureRuntimeMedia,
    ) => Promise<string>,
  ) {
    this.fixtureData = fixtureData
    this.fixture = { ...fixtureData.summary, fingerprint: fixtureFingerprint }
    this.initial = initial
    this.canonical = captureCanonicalPerformanceRunState()
    this.sources = sources
    this.fingerprintFixture = fingerprintFixture
    this.editorStartedAt = performance.now()
    this.unsubscribeDiagnostics = subscribePreviewRenderDiagnostics(
      (diagnostic) => this.onDiagnostic(diagnostic),
    )
  }

  private onDiagnostic(diagnostic: PreviewRenderDiagnostic): void {
    this.playbackCapture?.record(diagnostic)
    if (
      diagnosticDrawsExpectedFixtureClips(this.fixtureData, diagnostic)
    ) {
      this.firstFrame.resolve(diagnostic.presentedAt - this.editorStartedAt)
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.frame !== diagnostic.frame) continue
      if (diagnostic.result.status === 'superseded') continue
      if (
        diagnostic.result.status === 'drawn'
        && !diagnosticDrawsExpectedFixtureClips(this.fixtureData, diagnostic)
      ) {
        waiter.missingExpectedClipIds = missingExpectedFixtureDrawnClipIds(
          this.fixtureData,
          diagnostic,
        )
        continue
      }
      this.waiters.delete(waiter)
      clearTimeout(waiter.timeout)
      if (diagnostic.result.status === 'drawn') waiter.resolve(diagnostic)
      else waiter.reject(new Error(
        diagnostic.result.message ?? `Frame ${diagnostic.frame} failed to render`,
      ))
    }
  }

  firstUsableFrameMs(): Promise<number> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for the first usable editor frame')),
        FIRST_FRAME_TIMEOUT_MS,
      )
      void this.firstFrame.promise.then((value) => {
        clearTimeout(timeout)
        resolve(value)
      }, (cause) => {
        clearTimeout(timeout)
        reject(cause)
      })
    })
  }

  private waitForFrame(frame: number): Promise<PreviewRenderDiagnostic> {
    return new Promise((resolve, reject) => {
      const waiter: DiagnosticWaiter = {
        frame,
        resolve,
        reject,
        missingExpectedClipIds: [],
        timeout: setTimeout(() => {
          this.waiters.delete(waiter)
          const missing = waiter.missingExpectedClipIds.length > 0
            ? `; expected fixture clips were not all drawn: ${waiter.missingExpectedClipIds.join(', ')}`
            : ''
          reject(new Error(`Timed out waiting for rendered frame ${frame}${missing}`))
        }, RENDER_TIMEOUT_MS),
      }
      this.waiters.add(waiter)
    })
  }

  private async scrub(frame: number): Promise<{
    readonly inputToPresentMs: number
    readonly frameRenderMs: number
  }> {
    const rendered = this.waitForFrame(frame)
    const inputAt = performance.now()
    useTransportStore.getState().setPlayheadFrame(frame)
    const diagnostic = await rendered
    return {
      inputToPresentMs: diagnostic.presentedAt - inputAt,
      frameRenderMs: diagnostic.result.renderMs,
    }
  }

  private async measureScrubs(sampleCount: number): Promise<{
    readonly inputToPresent: number[]
    readonly render: number[]
  }> {
    const inputToPresent: number[] = []
    const render: number[] = []
    useTransportStore.getState().setIsScrubbing(true)
    try {
      for (let index = 0; index < sampleCount; index++) {
        const frame = this.fixtureData.scrubFrames[index % this.fixtureData.scrubFrames.length]
        const sample = await this.scrub(frame)
        inputToPresent.push(sample.inputToPresentMs)
        render.push(sample.frameRenderMs)
      }
    } finally {
      useTransportStore.getState().setIsScrubbing(false)
    }
    return { inputToPresent, render }
  }

  private async measureTelemetryOverhead(
    sampleCount: number,
  ): Promise<TelemetryOverheadEvidence> {
    const controlDurationsMs: number[] = []
    const instrumentedDurationsMs: number[] = []
    const frames = Array.from({ length: Math.max(7, sampleCount) }, (_, index) => (
      this.fixtureData.scrubFrames[index % this.fixtureData.scrubFrames.length]
    ))
    useTransportStore.getState().setIsScrubbing(true)
    try {
      if (!setPreviewRuntimeTelemetryEnabled(false)) {
        return {
          controlDurationsMs: [],
          instrumentedDurationsMs: [],
          overheadPercentSamples: [],
        }
      }
      // Warm both paths before measuring. The four-block ABBA order then
      // balances cache/order effects across identical scrub-frame sequences.
      await this.scrub(frames[0])
      setPreviewRuntimeTelemetryEnabled(true)
      await this.scrub(frames[1])
      const runBlock = async (enabled: boolean): Promise<number> => {
        setPreviewRuntimeTelemetryEnabled(enabled)
        const startedAt = performance.now()
        for (const frame of frames) await this.scrub(frame)
        return performance.now() - startedAt
      }
      for (const enabled of [false, true, true, false]) {
        const duration = await runBlock(enabled)
        if (enabled) instrumentedDurationsMs.push(duration)
        else controlDurationsMs.push(duration)
      }
      setPreviewRuntimeTelemetryEnabled(true)
    } finally {
      useTransportStore.getState().setIsScrubbing(false)
    }
    const controlTotal = controlDurationsMs.reduce(
      (sum, duration) => sum + duration,
      0,
    )
    const instrumentedTotal = instrumentedDurationsMs.reduce(
      (sum, duration) => sum + duration,
      0,
    )
    return {
      controlDurationsMs,
      instrumentedDurationsMs,
      overheadPercentSamples: [
        (instrumentedTotal - controlTotal)
        / Math.max(controlTotal, 0.001)
        * 100,
      ],
    }
  }

  private async measureImportReadiness(sampleCount: number): Promise<number[]> {
    const samples: number[] = []
    for (let index = 0; index < sampleCount; index++) {
      const file = new File(
        [this.sources.png],
        `benchmark-import-${index + 1}.png`,
        { type: 'image/png', lastModified: 1_700_000_100_000 + index },
      )
      const startedAt = performance.now()
      const result = await inspectMediaFileCompatibility(
        file,
        PERFORMANCE_FIXTURE_RATE,
        `benchmark-import-${index + 1}`,
      )
      try {
        if (result.status !== 'ready' || !result.asset) {
          throw new Error(
            result.compatibility.detail ?? 'Generated 4K import did not reach Ready.',
          )
        }
        samples.push(performance.now() - startedAt)
      } finally {
        if (result.asset?.objectUrl) {
          URL.revokeObjectURL(result.asset.objectUrl)
          this.importedObjectUrlsRevoked++
        }
      }
    }
    return samples
  }

  private async measurePlayback(
    options: PerformanceRunOptions,
  ): Promise<{
    readonly droppedFrames: number[] | null
    readonly droppedFramesUnavailableReason: string | null
    readonly audioUnderruns: number[] | null
    readonly audioUnavailableReason: string | null
  }> {
    const droppedFrames: number[] = []
    const audioObservations: PlaybackObservation[] = []
    const playbackUnavailableReasons: string[] = []
    const droppedFramesUnavailableReasons: string[] = []
    for (let run = 0; run < options.playbackRuns; run++) {
      useTransportStore.getState().setIsScrubbing(true)
      await this.scrub(0)
      useTransportStore.getState().setIsScrubbing(false)
      const capture = new PlaybackDiagnosticCapture(
        MAX_PLAYBACK_DIAGNOSTICS_PER_TRIAL,
        (diagnostic) => diagnosticDrawsExpectedFixtureClips(this.fixtureData, diagnostic),
      )
      this.playbackCapture = capture
      let observation: PlaybackObservation | null = null
      let playbackFailure: unknown = null
      try {
        observation = await observeStartedPlayback(
          options.playbackDurationMs,
          {
            startPlayback: play,
            now: () => performance.now(),
            sleep,
            getAudioDiagnostics: getAudioPlaybackDiagnostics,
            getPlayheadFrame: () => useTransportStore.getState().playheadFrame,
          },
        )
      } catch (cause) {
        playbackFailure = cause
      }
      if (this.playbackCapture === capture) this.playbackCapture = null
      const captured = await finishPlaybackCaptureBeforeSettling(
        capture,
        pause,
        afterTwoAnimationFrames,
      )
      if (playbackFailure) {
        playbackUnavailableReasons.push(
          `Playback trial ${run + 1} unavailable: ${errorMessage(playbackFailure)}.`,
        )
        continue
      }
      const dropped = droppedFramesForPlaybackTrial(
        captured.frames,
        0,
        expectedTerminalFrameForPlaybackTrial(
          0,
          options.playbackDurationMs,
          PERFORMANCE_FIXTURE_RATE,
        ),
      )
      if (dropped === null) {
        playbackUnavailableReasons.push(
          `Playback trial ${run + 1} unavailable: no drawn playback frames were observed.`,
        )
        continue
      }
      if (captured.overflowed) {
        droppedFramesUnavailableReasons.push(
          `Playback trial ${run + 1} exceeded the bounded diagnostic capacity.`,
        )
      } else {
        droppedFrames.push(dropped)
      }
      if (observation) {
        audioObservations.push(observation)
      }
    }
    const playbackUnavailableReason = playbackUnavailableReasons.length > 0
      ? playbackUnavailableReasons.join(' ')
      : null
    const droppedFramesUnavailableReason = [
      ...playbackUnavailableReasons,
      ...droppedFramesUnavailableReasons,
    ].join(' ') || null
    const audioAggregate = aggregatePlaybackAudioUnderruns(audioObservations)
    return {
      droppedFrames: droppedFramesUnavailableReason ? null : droppedFrames,
      droppedFramesUnavailableReason,
      audioUnderruns: playbackUnavailableReason
        ? null
        : audioAggregate.audioUnderruns,
      audioUnavailableReason: playbackUnavailableReason
        ?? audioAggregate.unavailableReason,
    }
  }

  private async measureMemory(
    options: PerformanceRunOptions,
    platform: string,
  ): Promise<{
    readonly memoryEvidence: ChromiumProcessMemoryEvidence
    readonly healthSamples: readonly RuntimeHealthSample[]
  }> {
    const sampleMemory = (window as PerformanceMemoryWindow)
      .__myrelithSampleChromiumProcessMemory
    const healthSamples: RuntimeHealthSample[] = []
    try {
      let scrubIndex = 0
      const memoryEvidence = await collectChromiumProcessMemoryEvidence(
        options,
        async (batchIndex) => {
          useTransportStore.getState().setIsScrubbing(true)
          await this.scrub(0)
          useTransportStore.getState().setIsScrubbing(false)
          await observeStartedPlayback(options.playbackDurationMs, {
            startPlayback: play,
            now: () => performance.now(),
            sleep,
            getAudioDiagnostics: getAudioPlaybackDiagnostics,
            getPlayheadFrame: () => useTransportStore.getState().playheadFrame,
          })
          healthSamples.push({
            cycleIndex: batchIndex,
            phase: 'playback',
            worker: await capturePreviewRuntimeTelemetry(),
            audio: getAudioPlaybackDiagnostics(),
          })
          pause()
          useTransportStore.getState().setIsScrubbing(true)
          for (let index = 0; index < options.scrubsPerMemoryBatch; index++) {
            const frame = this.fixtureData.scrubFrames[
              scrubIndex++ % this.fixtureData.scrubFrames.length
            ]
            await this.scrub(frame)
          }
          useTransportStore.getState().setIsScrubbing(false)
          ;(globalThis as GlobalWithGc).gc?.()
          await afterTwoAnimationFrames()
          await sleep(MEMORY_SETTLE_MS)
          healthSamples.push({
            cycleIndex: batchIndex,
            phase: 'drained',
            worker: await capturePreviewRuntimeTelemetry(),
            audio: getAudioPlaybackDiagnostics(),
          })
        },
        sampleMemory,
        platform,
      )
      return { memoryEvidence, healthSamples }
    } finally {
      pause()
      useTransportStore.getState().setIsScrubbing(false)
    }
  }

  private async measureExport(
    options: PerformanceRunOptions,
  ): Promise<number[]> {
    const originalDocument = useDocumentStore.getState()
    const document = createPerformanceExportDocument(
      this.fixtureData,
      options.exportFrames,
    )
    const profile = exportPresetById('web').profile
    const samples: number[] = []
    useDocumentStore.getState().setDoc(document)
    try {
      const exportRuns = Math.min(3, options.sampleCount)
      for (let run = 0; run < exportRuns; run++) {
        const startedAt = performance.now()
        const result = await startExport(profile)
        if (!result || result.destination !== 'download') {
          throw new Error('Buffered benchmark export did not return an output')
        }
        const elapsedSeconds = (performance.now() - startedAt) / 1_000
        const timelineSeconds = options.exportFrames
          * PERFORMANCE_FIXTURE_RATE.den
          / PERFORMANCE_FIXTURE_RATE.num
        samples.push(elapsedSeconds / timelineSeconds)
        // Reading the byte length proves finalization completed; the local
        // result then falls out of scope without creating another Blob URL.
        if (result.buffer.byteLength === 0) {
          throw new Error('Benchmark export returned an empty buffer')
        }
      }
    } finally {
      useDocumentStore.setState({
        doc: originalDocument.doc,
        past: originalDocument.past,
        future: originalDocument.future,
      })
      await disposeExport()
    }
    return samples
  }

  run(request: PerformanceHarnessRunRequest): Promise<PerformanceHarnessRunResult> {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.runOnce(request).catch(async (cause) => {
      await this.cleanup()
      throw cause
    })
    return this.runPromise
  }

  formatArtifact(artifact: PerformanceArtifact): string {
    return performanceArtifactMarkdown(artifact)
  }

  private async runOnce(
    request: PerformanceHarnessRunRequest,
  ): Promise<PerformanceHarnessRunResult> {
    const options = normalizedRunOptions(request.options)
    await resetAndVerifyCanonicalPerformanceRunState(
      this.fixtureData,
      this.fixture.fingerprint,
      this.canonical,
      runtimeMediaIdentity(this.sources),
      this.fingerprintFixture,
    )
    this.longAnimationFrameCapture = startLongAnimationFrameCapture()
    const warnings: string[] = [
      'Stress media catalog entries without generated local sources remain intentionally offline; scrubs target connected 4K stills plus procedural text, while playback and export use bounded connected 4K A/V sources.',
      'Proposed gates are advisory until repeated baselines ratify them across supported device profiles.',
    ]
    const metrics = {} as Record<PerformanceMetricId, PerformanceMetric>
    const canonicalDocument = useDocumentStore.getState()
    const documentMemory = estimateDocumentMemory(
      canonicalDocument.doc,
      canonicalDocument.past,
      canonicalDocument.future,
    )
    const launcherSamples = request.launcherInteractiveSamples ?? []
    metrics['launcher-interactive-ms'] = launcherSamples.length > 0
      ? measuredMetric(
          'ms',
          'Navigation start to two animation frames after the real launcher primary action became visible and enabled.',
          launcherSamples,
        )
      : unavailableMetric(
          'ms',
          'Navigation start to two animation frames after the real launcher primary action became visible and enabled.',
          'Launcher timing requires the command-line Chromium launcher.',
        )

    const ownFirstFrame = await this.firstUsableFrameMs()
    const firstFrameSamples = request.editorFirstUsableFrameSamples?.length
      ? request.editorFirstUsableFrameSamples
      : [ownFirstFrame]
    metrics['editor-first-usable-frame-ms'] = measuredMetric(
      'ms',
      'Benchmark editor mount start to the browser presentation boundary after the first frame drew every expected connected fixture contributor.',
      firstFrameSamples,
    )

    const telemetryOverhead = await this.measureTelemetryOverhead(
      options.sampleCount,
    )
    metrics['telemetry-overhead-percent'] =
      telemetryOverhead.overheadPercentSamples.length > 0
        ? measuredMetric(
            'percent',
            'Balanced ABBA aggregate input-to-present scrub overhead with local worker telemetry enabled versus identical control-frame sequences with telemetry disabled.',
            telemetryOverhead.overheadPercentSamples,
          )
        : unavailableMetric(
            'percent',
            'Balanced ABBA aggregate input-to-present scrub overhead with local worker telemetry enabled versus identical control-frame sequences with telemetry disabled.',
            'The live preview worker did not expose opt-in runtime telemetry.',
          )

    const scrubs = await this.measureScrubs(options.sampleCount)
    metrics['scrub-input-to-present-ms'] = measuredMetric(
      'ms',
      'Transport playhead input timestamp to the browser presentation boundary after the matching preview frame drew every expected connected fixture contributor.',
      scrubs.inputToPresent,
    )
    metrics['frame-render-ms'] = measuredMetric(
      'ms',
      'Worker-reported decode and composition time for the matching fully drawn fixture scrub frame.',
      scrubs.render,
    )

    const playback = await this.measurePlayback(options)
    metrics['dropped-frames'] = playback.droppedFrames
      ? measuredMetric(
          'count',
          'Missing fully drawn fixture frames from the expected playback start through the clock-derived inclusive terminal frame in one timed trial.',
          playback.droppedFrames,
        )
      : unavailableMetric(
          'count',
          'Missing fully drawn fixture frames from the expected playback start through the clock-derived inclusive terminal frame in one timed trial.',
          playback.droppedFramesUnavailableReason
            ?? 'Playback frame diagnostics were unavailable.',
        )
    metrics['audio-underruns'] = playback.audioUnderruns
      ? measuredMetric(
          'count',
          '25 ms observations where scheduled audio trailed the AudioContext clock by more than 5 ms.',
          playback.audioUnderruns,
        )
      : unavailableMetric(
          'count',
          '25 ms observations where scheduled audio trailed the AudioContext clock by more than 5 ms.',
          playback.audioUnavailableReason ?? 'Audio diagnostics were unavailable.',
        )
    if (playback.droppedFramesUnavailableReason) {
      warnings.push(playback.droppedFramesUnavailableReason)
    }
    if (
      playback.audioUnavailableReason
      && playback.audioUnavailableReason !== playback.droppedFramesUnavailableReason
    ) warnings.push(playback.audioUnavailableReason)

    try {
      metrics['import-readiness-ms'] = measuredMetric(
        'ms',
        'Content inspection plus bounded first-frame decode of the generated representative 3840x2160 PNG, ending at Ready.',
        await this.measureImportReadiness(options.sampleCount),
      )
    } catch (cause) {
      const reason = errorMessage(cause)
      metrics['import-readiness-ms'] = unavailableMetric(
        'ms',
        'Content inspection plus bounded first-frame decode of the generated representative 3840x2160 PNG, ending at Ready.',
        reason,
      )
      warnings.push(`Import readiness unavailable: ${reason}`)
    }

    const memoryRun = await this.measureMemory(options, request.host.platform)
    const { memoryEvidence } = memoryRun
    if (memoryEvidence.status === 'measured') {
      const memory = summarizeMemorySamples(
        memoryEvidence.samples.map((sample) => sample.totalBytes / MEBIBYTE),
      )
      const memoryKind = memoryEvidence.primaryMetric === 'private-bytes'
        ? 'private bytes'
        : 'resident-set bytes'
      const plateauDefinition =
        `Aggregate host OS ${memoryKind} for the complete CDP-reported Chromium process table at each post-warmup scrub-batch boundary.`
      metrics['memory-plateau-mib'] = measuredMetric(
        'MiB',
        plateauDefinition,
        memory.plateauMiB,
      )
      if (memory.growthKiB !== null) {
        metrics['memory-growth-kib-per-batch'] = measuredMetric(
          'KiB/batch',
          `Signed change between consecutive ${memoryKind} plateau samples over the same complete CDP process scope.`,
          memory.growthKiB,
        )
      } else {
        const reason =
          'Memory growth requires at least two complete process-memory plateau samples; one sample cannot establish change.'
        metrics['memory-growth-kib-per-batch'] = unavailableMetric(
          'KiB/batch',
          `Signed change between consecutive ${memoryKind} plateau samples over the same complete CDP process scope.`,
          reason,
        )
        warnings.push(reason)
      }
    } else {
      const reason = memoryEvidence.reason
        ?? 'Complete Chromium process-memory evidence is unavailable.'
      metrics['memory-plateau-mib'] = unavailableMetric(
        'MiB',
        'Aggregate host OS process memory for the complete CDP-reported Chromium process table at each post-warmup scrub-batch boundary.',
        reason,
      )
      metrics['memory-growth-kib-per-batch'] = unavailableMetric(
        'KiB/batch',
        'Signed change between consecutive complete CDP-scoped Chromium process-memory plateau samples.',
        reason,
      )
      warnings.push(reason)
    }

    metrics['export-real-time-ratio'] = await exportRealTimeRatioMetric(
      options,
      (measureOptions) => this.measureExport(measureOptions),
    )

    const mediaAnalysisScheduler = await measureMediaAnalysisScheduler({
      createScheduler: (now) => new MediaJobScheduler({ now }),
    })
    const framePlanningIndex = measureFramePlanningIndex()
    const drainedSamples = memoryRun.healthSamples.filter(
      (sample) => sample.phase === 'drained',
    )
    const checkedDrains = drainedSamples.filter(
      (sample) => sample.worker !== null,
    )
    const failedDrain = checkedDrains.find((sample) => {
      const worker = sample.worker
      return worker !== null && (
        worker.active.videoDecoders !== 0
        || worker.active.pendingBitmapCopies !== 0
        || worker.active.pendingStaticImageOpens !== 0
        || worker.queues.renderDepth !== 0
        || worker.queues.decodeDepth !== 0
        || worker.derivedCaches.streamingFrameBitmaps !== 0
      )
    })
    const cacheDrain = (
      checkedDrains.length === 0
      || checkedDrains.length !== drainedSamples.length
    )
      ? {
          status: 'unavailable' as const,
          reason: 'Worker runtime telemetry was not available after every cache drain.',
          checkedSamples: checkedDrains.length,
        }
      : failedDrain
        ? {
            status: 'fail' as const,
            reason: `Worker runtime resources remained live after health cycle ${failedDrain.cycleIndex}.`,
            checkedSamples: checkedDrains.length,
          }
        : {
            status: 'pass' as const,
            reason: null,
            checkedSamples: checkedDrains.length,
          }
    if (cacheDrain.status !== 'pass') {
      warnings.push(cacheDrain.reason ?? 'Runtime cache drain evidence unavailable.')
    }
    const userAgentSpecificMemory = await measureUserAgentSpecificMemory()
    if (userAgentSpecificMemory.status === 'unavailable') {
      warnings.push(userAgentSpecificMemory.reason ?? 'User-agent memory unavailable.')
    }
    const longAnimationFrames = this.longAnimationFrameCapture.finish()
    this.longAnimationFrameCapture = null
    if (longAnimationFrames.status === 'unavailable') {
      warnings.push(longAnimationFrames.reason ?? 'Long-animation-frame telemetry unavailable.')
    }
    const telemetry: RuntimeTelemetryEvidence = {
      documentMemory,
      overhead: telemetryOverhead,
      healthSamples: memoryRun.healthSamples,
      cacheDrain,
      longAnimationFrames,
      userAgentSpecificMemory,
    }

    const resources = await this.cleanup()
    const artifact: PerformanceArtifact = {
      schemaVersion: PERFORMANCE_ARTIFACT_SCHEMA_VERSION,
      harnessVersion: PERFORMANCE_HARNESS_VERSION,
      capturedAt: new Date().toISOString(),
      metadata: {
        host: request.host,
        browser: browserMetadata(),
        chromium: request.chromium,
      },
      fixture: this.fixture,
      options,
      metrics,
      proposedGates: evaluateProposedGates(metrics),
      memoryEvidence,
      mediaAnalysisScheduler,
      framePlanningIndex,
      telemetry,
      warnings,
      consoleProblems: [...(request.consoleProblems ?? [])],
      resources,
    }
    return {
      artifact,
      summaryMarkdown: performanceArtifactMarkdown(artifact),
    }
  }

  cleanup(): Promise<PerformanceResourceEvidence> {
    if (this.cleanupPromise) return this.cleanupPromise
    this.cleanupPromise = this.cleanupOnce()
    return this.cleanupPromise
  }

  private async cleanupOnce(): Promise<PerformanceResourceEvidence> {
    this.longAnimationFrameCapture?.finish()
    this.longAnimationFrameCapture = null
    setPreviewRuntimeTelemetryEnabled(false)
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('Performance harness cleaned up'))
    }
    this.waiters.clear()
    this.unsubscribeDiagnostics()
    disposePreview()
    await disposeTransport()
    await disposeExport()
    const benchmarkObjectUrlsRevoked = clearBenchmarkMediaAndCountRevoked(
      this.sources.objectUrls,
    )
    useDocumentStore.setState({
      doc: this.initial.document.doc,
      past: this.initial.document.past,
      future: this.initial.document.future,
    })
    useTransportStore.setState(this.initial.transport)
    useMediaStore.setState({
      descriptors: this.initial.media.descriptors,
      assets: this.initial.media.assets,
      visuals: this.initial.media.visuals,
      compatibility: this.initial.media.compatibility,
    })
    const currentDocument = useDocumentStore.getState()
    const currentMedia = useMediaStore.getState()
    const documentStoreRestored = currentDocument.doc === this.initial.document.doc
      && currentDocument.past === this.initial.document.past
      && currentDocument.future === this.initial.document.future
    const mediaStoreRestored = currentMedia.assets === this.initial.media.assets
      && currentMedia.descriptors === this.initial.media.descriptors
      && currentMedia.visuals === this.initial.media.visuals
      && currentMedia.compatibility === this.initial.media.compatibility
    const transportStoreRestored = shallowStateRestored(
      useTransportStore.getState(),
      this.initial.transport,
    )
    const projectSessionUnchanged = useProjectSessionStore.getState()
      === this.initial.projectSession
    const storesRestored = documentStoreRestored
      && mediaStoreRestored
      && transportStoreRestored
      && projectSessionUnchanged
    return {
      benchmarkObjectUrlsCreated: this.sources.objectUrls.length,
      benchmarkObjectUrlsRevoked,
      importedObjectUrlsRevoked: this.importedObjectUrlsRevoked,
      previewDisposed: true,
      transportDisposed: true,
      exportDisposed: true,
      documentStoreRestored,
      mediaStoreRestored,
      transportStoreRestored,
      projectSessionUnchanged,
      storesRestored,
    }
  }
}

export async function preparePerformanceHarness(
  deps: PerformanceHarnessPreparationDeps = BROWSER_PREPARATION_DEPS,
): Promise<PerformanceHarnessApi> {
  if (!('OffscreenCanvas' in window)) {
    throw new Error('The performance harness requires OffscreenCanvas')
  }
  const initial = assertIsolatedEntry()
  const fixture = createPerformanceFixture()
  const sources = await createConnectedSources(fixture, deps)
  let fixtureFingerprint: string
  try {
    fixtureFingerprint = await deps.fingerprintFixture(
      fixture,
      runtimeMediaIdentity(sources),
    )
  } catch (cause) {
    for (const objectUrl of sources.objectUrls) URL.revokeObjectURL(objectUrl)
    throw cause
  }
  const descriptors = fixture.project.assets
  if (!useMediaStore.getState().replaceAssets(descriptors, sources.assets)) {
    for (const objectUrl of sources.objectUrls) URL.revokeObjectURL(objectUrl)
    throw new Error('Performance fixture media could not enter the isolated store')
  }
  useTransportStore.getState().resetTransport()
  useDocumentStore.getState().setDoc(fixture.project.document)
  const historyTrack = fixture.project.document.tracks[0]
  if (!historyTrack) throw new Error('Performance fixture has no history track')
  for (let index = 0; index < PERFORMANCE_HISTORY_EDIT_PAIRS; index++) {
    useDocumentStore.getState().setTrackFlags(historyTrack.id, { hidden: true })
    useDocumentStore.getState().setTrackFlags(historyTrack.id, { hidden: false })
  }
  const documentWithHistory = useDocumentStore.getState()
  if (
    documentWithHistory.past.length !== PERFORMANCE_HISTORY_EDIT_PAIRS * 2
    || JSON.stringify(documentWithHistory.doc)
      !== JSON.stringify(fixture.project.document)
  ) {
    throw new Error('Performance document history fixture is not deterministic')
  }
  return new PerformanceHarnessSession(
    fixture,
    fixtureFingerprint,
    initial,
    sources,
    deps.fingerprintFixture,
  )
}

export function manualHostMetadata(): HostPerformanceMetadata {
  return {
    branch: null,
    commit: null,
    dirty: null,
    dirtyFingerprint: null,
    nodeVersion: null,
    platform: navigator.platform,
    architecture: null,
    osRelease: null,
    cpuModel: null,
    logicalProcessors: navigator.hardwareConcurrency,
    totalMemoryGiB: null,
    browserChannel: 'interactive Chromium',
    browserVersion: navigator.userAgent,
    command: 'node scripts/performance/run-benchmark.mjs',
  }
}

export function manualChromiumMetadata(): ChromiumPerformanceMetadata {
  const reason =
    'Manual in-page runs cannot access browser-level Chromium SystemInfo.getInfo; use the command-line runner for GPU identity.'
  return {
    source: 'cdp:SystemInfo.getInfo',
    renderer: { status: 'unavailable', reason },
    vendor: { status: 'unavailable', reason },
    driverVendor: { status: 'unavailable', reason },
    driverVersion: { status: 'unavailable', reason },
    acceleration: { status: 'unavailable', reason },
    devices: [],
    featureStatus: {},
  }
}
