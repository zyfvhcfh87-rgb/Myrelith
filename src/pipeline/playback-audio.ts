/**
 * pipeline/playback-audio.ts — bounded live timeline audio playback.
 *
 * Mediabunny decodes short, sequential AudioBuffer windows. Web Audio owns
 * mixing/resampling and schedules every buffer against one AudioContext
 * anchor. Refill timers only maintain a rolling lookahead; they never drive
 * timeline position. The shared AudioContext clock remains the master clock.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
} from 'mediabunny'
import {
  MediaAssetRuntimeError,
  type MediaRuntimeFailure,
} from '../domain/mediaCompatibility'
import {
  ensureMediaDecoderSupport,
  refineAudioDecoderBudget,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import type {
  AssetId,
  Clip,
  ClipAnimationTrack,
  ClipId,
  FrameRate,
  TimelineDoc,
  TrackId,
} from '../domain/schema'
import {
  clipAudioGainsAtLocalFrame,
  createTimelineAudioMixPlan,
  crossfadeAudioGain,
  isStretchedAudioClipPlan,
  type TimelineAudioDirectClipPlan,
  type TimelineAudioEnvelope,
  type TimelineAudioMasterBus,
  type TimelineAudioStretchedClipPlan,
  type TimelineAudioTrackBus,
} from '../domain/audioMixPlan'
import { timelineAudioMixerGraph } from '../domain/audioMixer'
import type {
  CrossfadeLegRole,
  SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import { audibleTracks, docDurationFrames } from '../domain/selectors'
import { clipLocalFrameAtSeconds, framesToSeconds, rangeEnd } from '../domain/time'
import {
  AUDIO_METER_FFT_SIZE,
  measureAudioMeterSample,
} from '../domain/audioMeter'
import { foldDecodedFrameToStereo } from '../domain/audioChannelMix'
import { sourceTicksToSeconds } from '../domain/sourceTimeMap'
import {
  AUDIO_STRETCH_MAX_SESSIONS,
  AUDIO_STRETCH_RECHUNK_FRAMES,
  audioStretchSourceLeadSamples,
  createConstantRateAudioStretcher,
  type ConstantRateAudioStretcher,
  type StereoPcm,
} from './audioStretch'

export const PLAYBACK_AUDIO_LOOKAHEAD_SECONDS = 0.75
export const PLAYBACK_AUDIO_START_LEAD_SECONDS = 0.05
export const PLAYBACK_AUDIO_PUMP_INTERVAL_MS = 100
export const PLAYBACK_EQUAL_POWER_CURVE_POINTS = 129

const TIME_EPSILON = 1e-7
const EMPTY_SOURCE_BOUNDS: SourceBoundsCatalog = new Map()

function runtimeFailureDetail(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return detail.slice(0, 2_048)
}

function playbackAssetError(
  assetId: AssetId,
  reason: MediaRuntimeFailure['reason'],
  cause: unknown,
  trackKind: MediaRuntimeFailure['trackKind'] = null,
): MediaAssetRuntimeError {
  if (
    cause instanceof MediaAssetRuntimeError
    && cause.assetId === assetId
    && cause.failure.surface === 'audio-playback'
    && cause.failure.trackKind === trackKind
  ) return cause
  return new MediaAssetRuntimeError(assetId, {
    surface: 'audio-playback',
    trackKind,
    reason,
    detail: runtimeFailureDetail(cause),
  }, cause)
}

export interface ResolvedPlaybackAsset {
  blob: Blob
  budget: LocalDecoderBudget
}

export type PlaybackAssetResolver = (
  assetId: AssetId,
) => Promise<ResolvedPlaybackAsset>

export interface PlaybackAudioBuffer {
  buffer: AudioBuffer
  timestamp: number
  duration: number
}

export interface PlaybackAudioCursor {
  next(): Promise<IteratorResult<PlaybackAudioBuffer, void>>
  close(): Promise<void>
}

export interface PlaybackAudioClipRequest {
  assetId: AssetId
  startTime: number
  endTime: number
  stretchLead?: true
}

export interface PlaybackAudioMediaSource {
  openClip(request: PlaybackAudioClipRequest): Promise<PlaybackAudioCursor>
  close(): Promise<void>
}

export interface ScheduledPlaybackAudio {
  clipId: ClipId
  trackId?: TrackId
  buffer: AudioBuffer
  timelineStartTime: number
  when: number
  offset: number
  duration: number
  volume: number
  envelope: PlaybackAudioEnvelope | null
  /** Effective audible bounds, including a valid linked crossfade handle. */
  clipTimelineStartTime?: number
  clipTimelineEndTime?: number
  fadeInEndTime?: number
  fadeOutStartTime?: number
  balance?: number
  leftGain?: number
  rightGain?: number
  clipTimelineStartFrame?: number
  frameRate?: FrameRate
  volumeAnimation?: ClipAnimationTrack | null
  balanceAnimation?: ClipAnimationTrack | null
}

export interface PlaybackAudioEnvelope {
  startTime: number
  endTime: number
  role: CrossfadeLegRole
  curve: TimelineAudioEnvelope['curve']
}

export interface PlaybackAudioTrackMeter {
  trackId: TrackId
  peakLeft: number
  peakRight: number
  peakMaster: number
}

export interface PlaybackAudioOutputDiagnostics {
  contextTime: number
  activeNodeCount: number
  rms: number
  peakLeft: number
  peakRight: number
  peakMaster: number
  meterSampleSize: number
  trackMeters?: readonly PlaybackAudioTrackMeter[]
}

export interface PlaybackAudioMixerGraph {
  tracks: readonly TimelineAudioTrackBus[]
  master: TimelineAudioMasterBus
}

export interface PlaybackAudioOutput {
  currentTime(): number
  schedule(request: ScheduledPlaybackAudio): void
  stop(): void
  diagnostics(): PlaybackAudioOutputDiagnostics
}

export interface TimelineAudioPlaybackDiagnostics
  extends PlaybackAudioOutputDiagnostics {
  /** Live clip-scoped sequential decoder cursors. */
  activeDecoderCount: number
  /** Decoded buffers held for a future scheduling boundary. */
  pendingBufferCount: number
  anchorTime: number
  fromFrame: number
  scheduledThroughTimelineTime: number
  scheduledThroughContextTime: number
}

export interface TimelineAudioPlaybackSession {
  readonly anchorTime: number
  stop(): Promise<void>
  diagnostics(): TimelineAudioPlaybackDiagnostics
}

export interface PlaybackAudioDeps {
  createMediaSource(resolveAsset: PlaybackAssetResolver): PlaybackAudioMediaSource
  createOutput(
    context: AudioContext,
    mixer?: PlaybackAudioMixerGraph,
  ): PlaybackAudioOutput
  schedulePump(callback: () => void, delayMs: number): number
  cancelPump(id: number): void
  lookaheadSeconds: number
  startLeadSeconds: number
  pumpIntervalMs: number
}

export type TimelineAudioPlaybackWarning =
  | {
      scope: 'media'
      stage: 'source-open' | 'decode' | 'decoded-timing'
      clipId: ClipId
      assetId: AssetId
      trackKind: MediaRuntimeFailure['trackKind']
      reason: MediaRuntimeFailure['reason']
      cause: unknown
    }
  | {
      scope: 'global'
      stage: 'output-schedule' | 'pump' | 'cleanup'
      cause: unknown
    }

export interface StartTimelineAudioOptions {
  signal?: AbortSignal
  onWarning?: (warning: TimelineAudioPlaybackWarning) => void
  sourceBoundsCatalog?: SourceBoundsCatalog
}

interface PlaybackAudioClipFields {
  timelineStartTime: number
  timelineEndTime: number
  sourceStartTime: number
  sourceEndTime: number
  decodeStartTime: number
  decodeEndTime: number
  volume: number
  balance: number
  leftGain: number
  rightGain: number
  fadeInEndTime: number
  fadeOutStartTime: number
  envelopes: PlaybackAudioEnvelope[]
  frameRate: FrameRate
}

type DirectAudioClipPlan =
  Omit<TimelineAudioDirectClipPlan, 'envelopes'> & PlaybackAudioClipFields
type StretchedAudioClipPlan =
  Omit<TimelineAudioStretchedClipPlan, 'envelopes'> & PlaybackAudioClipFields
type AudioClipPlan = DirectAudioClipPlan | StretchedAudioClipPlan

function isStretchedPlaybackPlan(
  plan: AudioClipPlan,
): plan is StretchedAudioClipPlan {
  return plan.stretch !== undefined
}

interface ClipCursorState {
  plan: AudioClipPlan
  cursor: PlaybackAudioCursor
  pending: PlaybackAudioBuffer | null
  stretchSession: ConstantRateAudioStretcher | null
  stretchSampleRate: number | null
  stretchChunk: StereoPcm | null
  stretchChunkOffset: number
  stretchSourceTime: number
  pendingFrameOffset: number
  done: boolean
}

interface PreparedAudioEvent extends ScheduledPlaybackAudio {
  timelineStartTime: number
}

function preparedEventsForOverlap(
  plan: AudioClipPlan,
  wrapped: PlaybackAudioBuffer,
  bufferStart: number,
  overlapStart: number,
  overlapEnd: number,
): PreparedAudioEvent[] {
  const timelineStart =
    plan.timelineStartTime + (overlapStart - plan.sourceStartTime)
  const timelineEnd = timelineStart + (overlapEnd - overlapStart)
  const boundaries = new Set([timelineStart, timelineEnd])
  if (
    plan.fadeInEndTime > timelineStart + TIME_EPSILON
    && plan.fadeInEndTime < timelineEnd - TIME_EPSILON
  ) boundaries.add(plan.fadeInEndTime)
  if (
    plan.fadeOutStartTime > timelineStart + TIME_EPSILON
    && plan.fadeOutStartTime < timelineEnd - TIME_EPSILON
  ) boundaries.add(plan.fadeOutStartTime)
  for (const envelope of plan.envelopes) {
    if (
      envelope.startTime > timelineStart + TIME_EPSILON
      && envelope.startTime < timelineEnd - TIME_EPSILON
    ) boundaries.add(envelope.startTime)
    if (
      envelope.endTime > timelineStart + TIME_EPSILON
      && envelope.endTime < timelineEnd - TIME_EPSILON
    ) boundaries.add(envelope.endTime)
  }
  const ordered = [...boundaries].sort((left, right) => left - right)
  const events: PreparedAudioEvent[] = []
  for (let index = 0; index < ordered.length - 1; index++) {
    const segmentStart = ordered[index]
    const segmentEnd = ordered[index + 1]
    const duration = segmentEnd - segmentStart
    if (duration <= TIME_EPSILON) continue
    const midpoint = segmentStart + duration / 2
    const envelope = plan.envelopes.find((candidate) =>
      midpoint >= candidate.startTime
      && midpoint < candidate.endTime,
    ) ?? null
    const sourceSegmentStart =
      overlapStart + (segmentStart - timelineStart)
    events.push({
      clipId: plan.clipId,
      trackId: plan.trackId,
      buffer: wrapped.buffer,
      timelineStartTime: segmentStart,
      when: 0,
      offset: sourceSegmentStart - bufferStart,
      duration,
      volume: plan.volume,
      envelope,
      clipTimelineStartTime: plan.timelineStartTime,
      clipTimelineEndTime: plan.timelineEndTime,
      fadeInEndTime: plan.fadeInEndTime,
      fadeOutStartTime: plan.fadeOutStartTime,
      balance: plan.balance,
      leftGain: plan.leftGain,
      rightGain: plan.rightGain,
      clipTimelineStartFrame: plan.clipTimelineStartFrame,
      frameRate: plan.frameRate,
      volumeAnimation: plan.volumeAnimation,
      balanceAnimation: plan.balanceAnimation,
    })
  }
  return events
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`)
  }
}

function assertClipRange(clip: Clip): void {
  const timelineEnd = rangeEnd(clip.timelineRange)
  const sourceEnd = rangeEnd(clip.sourceRange)
  if (
    !Number.isSafeInteger(clip.timelineRange.startFrame)
    || clip.timelineRange.startFrame < 0
    || !Number.isSafeInteger(timelineEnd)
    || timelineEnd <= clip.timelineRange.startFrame
    || !Number.isSafeInteger(clip.sourceRange.startFrame)
    || clip.sourceRange.startFrame < 0
    || !Number.isSafeInteger(sourceEnd)
    || sourceEnd <= clip.sourceRange.startFrame
  ) {
    throw new RangeError(`Audio clip "${clip.id}" has an invalid range`)
  }
  if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 2) {
    throw new RangeError(`Audio clip "${clip.id}" has an invalid volume`)
  }
}

function buildAudioClipPlans(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog = EMPTY_SOURCE_BOUNDS,
): AudioClipPlan[] {
  for (const track of audibleTracks(doc)) {
    for (const clip of track.clips) assertClipRange(clip)
  }
  return createTimelineAudioMixPlan(doc, catalog).clips
    .map((plan) => {
      const timelineStartTime = framesToSeconds(
        plan.timelineStartFrame,
        doc.frameRate,
      )
      const timelineEndTime = framesToSeconds(
        plan.timelineEndFrame,
        doc.frameRate,
      )
      const decodeStartTime = isStretchedAudioClipPlan(plan)
        ? sourceTicksToSeconds(plan.stretch.sourceStartTicks, doc.frameRate)
        : framesToSeconds(plan.sourceStartFrame, doc.frameRate)
      const decodeEndTime = isStretchedAudioClipPlan(plan)
        ? sourceTicksToSeconds(plan.stretch.sourceEndTicks, doc.frameRate)
        : framesToSeconds(plan.sourceEndFrame, doc.frameRate)
      return {
        ...plan,
        timelineStartTime,
        timelineEndTime,
        sourceStartTime: isStretchedAudioClipPlan(plan)
          ? timelineStartTime
          : decodeStartTime,
        sourceEndTime: isStretchedAudioClipPlan(plan)
          ? timelineEndTime
          : decodeEndTime,
        decodeStartTime,
        decodeEndTime,
        fadeInEndTime: framesToSeconds(
          plan.timelineStartFrame + plan.fadeInFrames,
          doc.frameRate,
        ),
        fadeOutStartTime: framesToSeconds(
          plan.timelineEndFrame - plan.fadeOutFrames,
          doc.frameRate,
        ),
        frameRate: doc.frameRate,
        envelopes: plan.envelopes.map((envelope) => ({
          startTime: framesToSeconds(envelope.startFrame, doc.frameRate),
          endTime: framesToSeconds(envelope.endFrame, doc.frameRate),
          role: envelope.role,
          curve: envelope.curve,
        })),
      }
    })
}

/** Stable fingerprint for changes that require a live audio re-prime. */
export function audioPlaybackPlanKey(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog = EMPTY_SOURCE_BOUNDS,
): string {
  const assetIds = [...new Set(
    doc.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)),
  )].sort()
  return JSON.stringify({
    rate: doc.frameRate,
    sampleRate: doc.audioSampleRate,
    durationFrames: docDurationFrames(doc),
    tracks: doc.tracks
      .filter((track) => track.kind === 'audio' || track.transitions.length > 0)
      .map((track) => ({
        id: track.id,
        kind: track.kind,
        muted: track.muted,
        solo: track.solo,
        volume: track.volume ?? null,
        balance: track.balance ?? null,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          sourceMode: clip.sourceMode,
          sourceRange: clip.sourceRange,
          sourceTimeMap: clip.sourceTimeMap ?? null,
          timelineRange: clip.timelineRange,
          volume: clip.volume,
          audio: clip.audio ?? null,
          animation: clip.animation ?? null,
          linkGroupId: clip.linkGroupId ?? null,
        })),
        transitions: track.transitions.map((transition) => ({
          id: transition.id,
          fromClipId: transition.fromClipId,
          toClipId: transition.toClipId,
          durationFrames: transition.durationFrames,
          audio: transition.audio,
        })),
      })),
    sourceBounds: assetIds.map((assetId) => [
      assetId,
      catalog.get(assetId) ?? null,
    ]),
    masterAudio: doc.masterAudio ?? null,
  })
}

/** Asset ids that can still produce audible output at/after `fromFrame`. */
export function audioPlaybackAssetIds(
  doc: TimelineDoc,
  fromFrame = 0,
  catalog: SourceBoundsCatalog = EMPTY_SOURCE_BOUNDS,
): AssetId[] {
  if (!Number.isSafeInteger(fromFrame) || fromFrame < 0) return []
  return [
    ...new Set(
      buildAudioClipPlans(doc, catalog)
        .filter((plan) => plan.timelineEndFrame > fromFrame)
        .map((plan) => plan.assetId),
    ),
  ]
}

export function hasAudioPlaybackContent(
  doc: TimelineDoc,
  fromFrame: number,
  catalog: SourceBoundsCatalog = EMPTY_SOURCE_BOUNDS,
): boolean {
  if (!Number.isSafeInteger(fromFrame) || fromFrame < 0) return false
  return buildAudioClipPlans(doc, catalog).some(
    (plan) => plan.timelineEndFrame > fromFrame,
  )
}

interface DecodedAudioAsset {
  input: Input
  sink: AudioBufferSink
  sampleRate: number
  activeCursors: number
  disposed: boolean
}

/**
 * One lazy Input/Sink per concurrently active asset and one sequential cursor
 * per active clip. The last cursor releases the Input so long timelines do not
 * retain every Blob they have ever touched.
 */
export function createMediabunnyPlaybackAudioSource(
  resolveAsset: PlaybackAssetResolver,
): PlaybackAudioMediaSource {
  const sessions = new Map<AssetId, Promise<DecodedAudioAsset>>()
  const resolvedAssets = new Map<AssetId, DecodedAudioAsset>()
  const openInputs = new Set<Input>()
  const cursors = new Set<PlaybackAudioCursor>()
  let closed = false
  let closePromise: Promise<void> | null = null

  const disposeInputOnce = (input: Input): void => {
    if (!openInputs.delete(input)) return
    input.dispose()
  }

  const disposeAsset = (
    assetId: AssetId,
    asset: DecodedAudioAsset,
  ): void => {
    if (asset.disposed) return
    asset.disposed = true
    sessions.delete(assetId)
    resolvedAssets.delete(assetId)
    disposeInputOnce(asset.input)
  }

  const releaseAsset = (
    assetId: AssetId,
    asset: DecodedAudioAsset,
  ): void => {
    asset.activeCursors = Math.max(0, asset.activeCursors - 1)
    if (asset.activeCursors === 0) disposeAsset(assetId, asset)
  }

  const openAsset = (assetId: AssetId): Promise<DecodedAudioAsset> => {
    const existing = sessions.get(assetId)
    if (existing) return existing

    const pending = (async () => {
      if (closed) throw new Error('Playback audio source is closed')
      let resolved: ResolvedPlaybackAsset
      try {
        resolved = await resolveAsset(assetId)
      } catch (cause) {
        throw playbackAssetError(assetId, 'resource-unavailable', cause)
      }
      const { blob } = resolved
      if (closed) throw new Error('Playback audio source is closed')

      let input: Input
      try {
        input = new Input({
          source: new BlobSource(blob),
          formats: ALL_FORMATS,
        })
      } catch (cause) {
        throw playbackAssetError(assetId, 'resource-unavailable', cause)
      }
      openInputs.add(input)
      try {
        const track = await input.getPrimaryAudioTrack()
        if (!track) {
          throw new Error(`Playback asset "${assetId}" has no audio track`)
        }
        const codec = await track.getCodec()
        const configuration = await track.getDecoderConfig()
        const support = await ensureMediaDecoderSupport({
          codec,
          canDecode: () => track.canDecode(),
          configuration,
          trackKind: 'audio',
          sourceId: assetId,
          boundary: 'audio-playback',
          policy: 'revalidate',
          budget: refineAudioDecoderBudget(
            resolved.budget,
            blob.size,
            configuration,
          ),
        })
        if (!support.decodable) {
          throw playbackAssetError(
            assetId,
            support.failure.reason,
            new Error(support.failure.detail),
            'audio',
          )
        }
        if (closed) throw new Error('Playback audio source is closed')
        const asset: DecodedAudioAsset = {
          input,
          sink: new AudioBufferSink(track),
          sampleRate: await track.getSampleRate(),
          activeCursors: 0,
          disposed: false,
        }
        resolvedAssets.set(assetId, asset)
        return asset
      } catch (cause) {
        try {
          disposeInputOnce(input)
        } catch {
          // Preserve the decode/open failure over disposal cleanup.
        }
        throw cause
      }
    })()
    sessions.set(assetId, pending)
    // A failed open belongs to the caller that requested it. Do not cache or
    // re-surface that rejection later during otherwise unrelated cleanup.
    void pending.catch(() => {
      if (sessions.get(assetId) === pending) sessions.delete(assetId)
    })
    return pending
  }

  const openClip = async (
    request: PlaybackAudioClipRequest,
  ): Promise<PlaybackAudioCursor> => {
    if (closed) throw new Error('Playback audio source is closed')
    assertFiniteTime(request.startTime, 'Playback audio start time')
    assertFiniteTime(request.endTime, 'Playback audio end time')
    if (request.endTime <= request.startTime) {
      throw new RangeError('Playback audio clip range must be non-empty')
    }

    let asset: DecodedAudioAsset
    while (true) {
      const candidate = await openAsset(request.assetId)
      if (closed) throw new Error('Playback audio source is closed')
      if (candidate.disposed) continue

      // Reserve the shared Input before creating the iterator. An adjacent
      // clip may be closing the asset's previous last cursor in another
      // microtask; once this count is incremented, that close cannot dispose
      // the Input underneath the new cursor.
      candidate.activeCursors++
      asset = candidate
      break
    }
    let iterator: AsyncIterator<PlaybackAudioBuffer, void>
    try {
      const supportedStretchRate = [44_100, 48_000, 96_000]
        .includes(asset.sampleRate)
      const startTime = request.stretchLead && supportedStretchRate
        ? Math.max(
            0,
            request.startTime
              - audioStretchSourceLeadSamples(asset.sampleRate) / asset.sampleRate,
          )
        : request.startTime
      iterator = asset.sink.buffers(
        startTime,
        request.endTime,
      )[Symbol.asyncIterator]()
    } catch (cause) {
      try {
        releaseAsset(request.assetId, asset)
      } catch {
        // Preserve the iterator-creation failure as the primary error.
      }
      throw cause
    }
    let cursorClosed = false
    let cursorClosePromise: Promise<void> | null = null
    let cursor!: PlaybackAudioCursor
    cursor = {
      next: () =>
        cursorClosed
          ? Promise.resolve({ done: true, value: undefined })
          : iterator.next(),
      close: () => {
        if (cursorClosePromise) return cursorClosePromise
        cursorClosed = true
        cursorClosePromise = (async () => {
          let failure: unknown
          try {
            await iterator.return?.()
          } catch (cause) {
            failure = cause
          } finally {
            cursors.delete(cursor)
            try {
              releaseAsset(request.assetId, asset)
            } catch (cause) {
              failure ??= cause
            }
          }
          if (failure !== undefined) throw failure
        })()
        return cursorClosePromise
      },
    }
    cursors.add(cursor)
    return cursor
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      let failure: unknown

      // Begin iterator cancellation and Input disposal together. A decoder
      // read may be pending, and disposing its Input is what lets it unwind.
      const cursorClosures = [...cursors].map((cursor) => cursor.close())
      const pendingSessions = [...sessions.values()]
      for (const [assetId, asset] of [...resolvedAssets]) {
        try {
          disposeAsset(assetId, asset)
        } catch (cause) {
          failure ??= cause
        }
      }
      for (const input of [...openInputs]) {
        try {
          disposeInputOnce(input)
        } catch (cause) {
          failure ??= cause
        }
      }

      const cursorResults = await Promise.allSettled(cursorClosures)
      await Promise.allSettled(pendingSessions)
      for (const entry of cursorResults) {
        if (entry.status === 'rejected') failure ??= entry.reason
      }
      if (failure !== undefined) throw failure
    })()
    return closePromise
  }

  return { openClip, close }
}

interface ActiveOutputNode {
  source: AudioBufferSourceNode
  gain: GainNode
  balanceNodes: AudioNode[]
}

/** Bounded deterministic curve for one equal-power event segment. */
export function createEqualPowerPlaybackCurve(
  role: CrossfadeLegRole,
  startProgress: number,
  endProgress: number,
  volume: number,
): Float32Array {
  if (
    !Number.isFinite(startProgress)
    || !Number.isFinite(endProgress)
    || !Number.isFinite(volume)
    || volume < 0
    || volume > 2
  ) {
    throw new RangeError('Equal-power playback curve inputs are invalid')
  }
  const values = new Float32Array(PLAYBACK_EQUAL_POWER_CURVE_POINTS)
  const span = endProgress - startProgress
  for (let index = 0; index < values.length; index++) {
    const progress = startProgress + span * index / (values.length - 1)
    values[index] = crossfadeAudioGain('equal-power', role, progress) * volume
  }
  return values
}

function playbackClipGainsAtTime(
  request: ScheduledPlaybackAudio,
  timelineTime: number,
): ReturnType<typeof clipAudioGainsAtLocalFrame> {
  if (
    request.clipTimelineStartFrame === undefined
    || request.frameRate === undefined
    || (request.volumeAnimation == null && request.balanceAnimation == null)
  ) {
    return {
      volume: request.volume,
      balance: request.balance ?? 0,
      leftGain: request.leftGain ?? 1,
      rightGain: request.rightGain ?? 1,
    }
  }
  return clipAudioGainsAtLocalFrame(
    {
      volume: request.volume,
      balance: request.balance ?? 0,
      volumeAnimation: request.volumeAnimation ?? null,
      balanceAnimation: request.balanceAnimation ?? null,
    },
    clipLocalFrameAtSeconds(
      request.clipTimelineStartFrame,
      timelineTime,
      request.frameRate,
    ),
  )
}

function playbackEnvelopeAtTime(
  request: ScheduledPlaybackAudio,
  timelineTime: number,
): number {
  const envelope = request.envelope
  const clipStart = request.clipTimelineStartTime
  const clipEnd = request.clipTimelineEndTime
  const fadeInEnd = request.fadeInEndTime
  const fadeOutStart = request.fadeOutStartTime
  let shaped = 1
  if (
    clipStart !== undefined
    && clipEnd !== undefined
    && fadeInEnd !== undefined
    && fadeOutStart !== undefined
  ) {
    if (fadeInEnd > clipStart) {
      shaped *= Math.min(1, Math.max(
        0,
        (timelineTime - clipStart) / (fadeInEnd - clipStart),
      ))
    }
    if (fadeOutStart < clipEnd) {
      shaped *= Math.min(1, Math.max(
        0,
        (clipEnd - timelineTime) / (clipEnd - fadeOutStart),
      ))
    }
  }
  if (!envelope) return shaped
  const envelopeDuration = envelope.endTime - envelope.startTime
  if (!Number.isFinite(envelopeDuration) || envelopeDuration <= 0) {
    throw new RangeError('Playback audio envelope has an invalid duration')
  }
  return shaped * crossfadeAudioGain(
    envelope.curve,
    envelope.role,
    (timelineTime - envelope.startTime) / envelopeDuration,
  )
}

function playbackHasFade(request: ScheduledPlaybackAudio): boolean {
  const clipStart = request.clipTimelineStartTime
  const clipEnd = request.clipTimelineEndTime
  const fadeInEnd = request.fadeInEndTime
  const fadeOutStart = request.fadeOutStartTime
  return clipStart !== undefined
    && clipEnd !== undefined
    && fadeInEnd !== undefined
    && fadeOutStart !== undefined
    && (fadeInEnd > clipStart + TIME_EPSILON || fadeOutStart < clipEnd - TIME_EPSILON)
}

function playbackHasShapedGain(request: ScheduledPlaybackAudio): boolean {
  return playbackHasFade(request)
    || request.volumeAnimation != null
    || request.envelope?.curve === 'equal-power'
}

function samplePlaybackGainCurve(request: ScheduledPlaybackAudio): Float32Array {
  const values = new Float32Array(PLAYBACK_EQUAL_POWER_CURVE_POINTS)
  for (let index = 0; index < values.length; index++) {
    const timelineTime = request.timelineStartTime
      + request.duration * index / (values.length - 1)
    values[index] = playbackClipGainsAtTime(request, timelineTime).volume
      * playbackEnvelopeAtTime(request, timelineTime)
  }
  return values
}

function scheduleNodeGain(
  gain: AudioParam,
  request: ScheduledPlaybackAudio,
): void {
  if (playbackHasShapedGain(request)) {
    gain.setValueCurveAtTime(
      samplePlaybackGainCurve(request),
      request.when,
      request.duration,
    )
    return
  }
  const envelope = request.envelope
  if (!envelope) {
    gain.value = request.volume
    return
  }
  const envelopeDuration = envelope.endTime - envelope.startTime
  if (!Number.isFinite(envelopeDuration) || envelopeDuration <= 0) {
    throw new RangeError('Playback audio envelope has an invalid duration')
  }
  const startProgress =
    (request.timelineStartTime - envelope.startTime) / envelopeDuration
  const endProgress =
    (request.timelineStartTime + request.duration - envelope.startTime)
    / envelopeDuration
  if (envelope.curve === 'linear') {
    gain.setValueAtTime(
      crossfadeAudioGain('linear', envelope.role, startProgress)
        * request.volume,
      request.when,
    )
    gain.linearRampToValueAtTime(
      crossfadeAudioGain('linear', envelope.role, endProgress)
        * request.volume,
      request.when + request.duration,
    )
    return
  }
  gain.setValueCurveAtTime(
    createEqualPowerPlaybackCurve(
      envelope.role,
      startProgress,
      endProgress,
      request.volume,
    ),
    request.when,
    request.duration,
  )
}

/** Fold 1 and 3–32 channel buffers to stereo before live routing. */
function foldPlaybackBufferToStereo(
  context: AudioContext,
  buffer: AudioBuffer,
): AudioBuffer {
  const channelCount = buffer.numberOfChannels
  // Already-stereo buffers stay as-is. A missing/non-integer channel count
  // is left unchanged rather than inventing a fold.
  if (!Number.isSafeInteger(channelCount) || channelCount === 2) return buffer
  if (channelCount < 1 || channelCount > 32) {
    throw new RangeError('Playback audio buffer has an invalid channel count')
  }
  const planes: Float32Array[] = []
  for (let index = 0; index < channelCount; index++) {
    planes.push(buffer.getChannelData(index))
  }
  const stereo = context.createBuffer(2, buffer.length, buffer.sampleRate)
  const left = stereo.getChannelData(0)
  const right = stereo.getChannelData(1)
  for (let frame = 0; frame < buffer.length; frame++) {
    const folded = foldDecodedFrameToStereo(planes, frame)
    left[frame] = folded[0]
    right[frame] = folded[1]
  }
  return stereo
}

interface StereoMeterTap {
  input: ChannelSplitterNode
  output: ChannelMergerNode
  left: AnalyserNode
  right: AnalyserNode
  leftWindow: Float32Array<ArrayBuffer>
  rightWindow: Float32Array<ArrayBuffer>
  nodes: AudioNode[]
}

function createStereoMeterTap(context: AudioContext): StereoMeterTap {
  const splitter = context.createChannelSplitter(2)
  const left = context.createAnalyser()
  const right = context.createAnalyser()
  const merger = context.createChannelMerger(2)
  left.fftSize = AUDIO_METER_FFT_SIZE
  right.fftSize = AUDIO_METER_FFT_SIZE
  left.smoothingTimeConstant = 0
  right.smoothingTimeConstant = 0
  splitter.connect(left, 0)
  splitter.connect(right, 1)
  left.connect(merger, 0, 0)
  right.connect(merger, 0, 1)
  return {
    input: splitter,
    output: merger,
    left,
    right,
    leftWindow: new Float32Array(AUDIO_METER_FFT_SIZE),
    rightWindow: new Float32Array(AUDIO_METER_FFT_SIZE),
    nodes: [splitter, left, right, merger],
  }
}

function createBalanceStage(
  context: AudioContext,
  leftGain: number,
  rightGain: number,
): { input: AudioNode; output: AudioNode; nodes: AudioNode[] } {
  if (leftGain === 1 && rightGain === 1) {
    const passthrough = context.createGain()
    passthrough.gain.value = 1
    return { input: passthrough, output: passthrough, nodes: [passthrough] }
  }
  const splitter = context.createChannelSplitter(2)
  const left = context.createGain()
  const right = context.createGain()
  const merger = context.createChannelMerger(2)
  left.gain.value = leftGain
  right.gain.value = rightGain
  splitter.connect(left, 0)
  splitter.connect(right, 1)
  left.connect(merger, 0, 0)
  right.connect(merger, 0, 1)
  return { input: splitter, output: merger, nodes: [splitter, left, right, merger] }
}

interface TrackPlaybackBus {
  input: GainNode
  meter: StereoMeterTap
  nodes: AudioNode[]
}

function readMeterTap(tap: StereoMeterTap): ReturnType<typeof measureAudioMeterSample> {
  tap.left.getFloatTimeDomainData(tap.leftWindow)
  tap.right.getFloatTimeDomainData(tap.rightWindow)
  return measureAudioMeterSample(tap.leftWindow, tap.rightWindow)
}

/** The only module that turns decoded buffers into an audible Web Audio graph. */
export function createWebAudioPlaybackOutput(
  context: AudioContext,
  mixer?: PlaybackAudioMixerGraph,
): PlaybackAudioOutput {
  const graphNodes: AudioNode[] = []
  const trackBuses = new Map<TrackId, TrackPlaybackBus>()
  const master = context.createGain()
  const masterMeter = createStereoMeterTap(context)
  const masterTargetGain = mixer
    ? (mixer.master.muted ? 0 : mixer.master.volume)
    : 1
  master.gain.value = 0
  graphNodes.push(master, ...masterMeter.nodes)

  let clipDestination: AudioNode = master
  if (mixer) {
    const masterSum = context.createGain()
    masterSum.gain.value = 1
    const masterBalance = createBalanceStage(
      context,
      mixer.master.leftGain,
      mixer.master.rightGain,
    )
    masterSum.connect(masterBalance.input)
    masterBalance.output.connect(master)
    graphNodes.push(masterSum, ...masterBalance.nodes)
    for (const track of mixer.tracks) {
      const input = context.createGain()
      input.gain.value = track.volume
      const balance = createBalanceStage(context, track.leftGain, track.rightGain)
      const meter = createStereoMeterTap(context)
      input.connect(balance.input)
      balance.output.connect(meter.input)
      meter.output.connect(masterSum)
      const bus: TrackPlaybackBus = {
        input,
        meter,
        nodes: [input, ...balance.nodes, ...meter.nodes],
      }
      trackBuses.set(track.trackId, bus)
      graphNodes.push(...bus.nodes)
    }
    clipDestination = masterSum
  }

  master.connect(masterMeter.input)
  masterMeter.output.connect(context.destination)

  const nodes = new Set<ActiveOutputNode>()
  let stopped = false
  let graphDisconnected = false
  let armed = false

  const disconnectGraph = (): void => {
    if (graphDisconnected) return
    graphDisconnected = true
    for (const node of graphNodes) node.disconnect()
  }

  const cleanupNode = (record: ActiveOutputNode): void => {
    if (!nodes.delete(record)) return
    record.source.onended = null
    try {
      record.source.disconnect()
    } finally {
      try {
        record.gain.disconnect()
      } finally {
        for (const node of record.balanceNodes) node.disconnect()
      }
    }
    if (stopped && nodes.size === 0) disconnectGraph()
  }

  const schedule = (request: ScheduledPlaybackAudio): void => {
    if (stopped) return
    const source = context.createBufferSource()
    const gain = context.createGain()
    const playbackBuffer = foldPlaybackBufferToStereo(context, request.buffer)
    source.buffer = playbackBuffer
    scheduleNodeGain(gain.gain, request)
    source.connect(gain)
    const balanceNodes: AudioNode[] = []
    if (
      playbackBuffer.numberOfChannels >= 2
      && (
        request.balanceAnimation != null
        || (
          request.balance !== undefined
          && request.balance !== 0
        )
      )
    ) {
      const splitter = context.createChannelSplitter(2)
      const left = context.createGain()
      const right = context.createGain()
      const merger = context.createChannelMerger(2)
      if (request.balanceAnimation != null) {
        const leftCurve = new Float32Array(PLAYBACK_EQUAL_POWER_CURVE_POINTS)
        const rightCurve = new Float32Array(PLAYBACK_EQUAL_POWER_CURVE_POINTS)
        for (let index = 0; index < leftCurve.length; index++) {
          const timelineTime = request.timelineStartTime
            + request.duration * index / (leftCurve.length - 1)
          const gains = playbackClipGainsAtTime(request, timelineTime)
          leftCurve[index] = gains.leftGain
          rightCurve[index] = gains.rightGain
        }
        left.gain.setValueCurveAtTime(leftCurve, request.when, request.duration)
        right.gain.setValueCurveAtTime(rightCurve, request.when, request.duration)
      } else {
        left.gain.value = request.leftGain ?? 1
        right.gain.value = request.rightGain ?? 1
      }
      gain.connect(splitter)
      splitter.connect(left, 0)
      splitter.connect(right, 1)
      left.connect(merger, 0, 0)
      right.connect(merger, 0, 1)
      const destination = (
        request.trackId !== undefined
          ? trackBuses.get(request.trackId)?.input
          : undefined
      ) ?? clipDestination
      merger.connect(destination)
      balanceNodes.push(splitter, left, right, merger)
    } else {
      const destination = (
        request.trackId !== undefined
          ? trackBuses.get(request.trackId)?.input
          : undefined
      ) ?? clipDestination
      gain.connect(destination)
    }

    const record = { source, gain, balanceNodes }
    nodes.add(record)
    source.onended = () => cleanupNode(record)
    try {
      source.start(request.when, request.offset, request.duration)
      if (!armed) {
        master.gain.cancelScheduledValues(request.when)
        master.gain.setValueAtTime(0, request.when)
        master.gain.linearRampToValueAtTime(
          masterTargetGain,
          request.when + 0.005,
        )
        armed = true
      }
    } catch (cause) {
      cleanupNode(record)
      throw cause
    }
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    const now = context.currentTime
    if (context.state !== 'running') {
      try {
        master.gain.cancelScheduledValues(now)
      } catch {
        // A closed context can reject automation cleanup.
      }
      master.gain.value = 0
      for (const record of [...nodes]) {
        try {
          record.source.stop()
        } catch {
          // The node may already have ended or the context may be closed.
        }
        cleanupNode(record)
      }
      disconnectGraph()
      return
    }

    const stopAt = now + 0.005
    try {
      master.gain.cancelScheduledValues(now)
      master.gain.setValueAtTime(master.gain.value, now)
      master.gain.linearRampToValueAtTime(0, stopAt)
    } catch {
      master.gain.value = 0
    }
    for (const record of [...nodes]) {
      try {
        record.source.stop(stopAt)
      } catch {
        cleanupNode(record)
      }
    }
    if (nodes.size === 0) disconnectGraph()
    else {
      // `onended` should own normal cleanup, but a wall-clock fallback keeps
      // broken/paused implementations from retaining the graph indefinitely.
      globalThis.setTimeout(() => {
        for (const record of [...nodes]) cleanupNode(record)
        disconnectGraph()
      }, 50)
    }
  }

  const silentTrackMeters = (): PlaybackAudioTrackMeter[] =>
    mixer === undefined
      ? []
      : mixer.tracks.map((track) => ({
          trackId: track.trackId,
          peakLeft: 0,
          peakRight: 0,
          peakMaster: 0,
        }))

  const diagnostics = (): PlaybackAudioOutputDiagnostics => {
    if (stopped) {
      return {
        contextTime: context.currentTime,
        activeNodeCount: nodes.size,
        rms: 0,
        peakLeft: 0,
        peakRight: 0,
        peakMaster: 0,
        meterSampleSize: AUDIO_METER_FFT_SIZE,
        trackMeters: silentTrackMeters(),
      }
    }
    const sample = readMeterTap(masterMeter)
    const trackMeters: PlaybackAudioTrackMeter[] = []
    if (mixer) {
      for (const track of mixer.tracks) {
        const bus = trackBuses.get(track.trackId)
        const peaks = bus === undefined
          ? { left: 0, right: 0, master: 0, rms: 0 }
          : readMeterTap(bus.meter)
        trackMeters.push({
          trackId: track.trackId,
          peakLeft: peaks.left,
          peakRight: peaks.right,
          peakMaster: peaks.master,
        })
      }
    }
    return {
      contextTime: context.currentTime,
      activeNodeCount: nodes.size,
      rms: sample.rms,
      peakLeft: sample.left,
      peakRight: sample.right,
      peakMaster: sample.master,
      meterSampleSize: AUDIO_METER_FFT_SIZE,
      trackMeters,
    }
  }

  return {
    currentTime: () => context.currentTime,
    schedule,
    stop,
    diagnostics,
  }
}

const realDeps: PlaybackAudioDeps = {
  createMediaSource: createMediabunnyPlaybackAudioSource,
  createOutput: createWebAudioPlaybackOutput,
  schedulePump: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancelPump: (id) => window.clearTimeout(id),
  lookaheadSeconds: PLAYBACK_AUDIO_LOOKAHEAD_SECONDS,
  startLeadSeconds: PLAYBACK_AUDIO_START_LEAD_SECONDS,
  pumpIntervalMs: PLAYBACK_AUDIO_PUMP_INTERVAL_MS,
}

function abortedError(): Error {
  const error = new Error('Playback audio startup was cancelled')
  error.name = 'AbortError'
  return error
}

function validateDeps(deps: PlaybackAudioDeps): void {
  if (!Number.isFinite(deps.lookaheadSeconds) || deps.lookaheadSeconds <= 0) {
    throw new RangeError('Audio lookahead must be positive')
  }
  if (!Number.isFinite(deps.startLeadSeconds) || deps.startLeadSeconds < 0) {
    throw new RangeError('Audio start lead must be non-negative')
  }
  if (!Number.isFinite(deps.pumpIntervalMs) || deps.pumpIntervalMs <= 0) {
    throw new RangeError('Audio pump interval must be positive')
  }
}

/**
 * Prime and start one immutable timeline-audio session. The returned anchor
 * is the exact AudioContext time the video engine must share.
 */
export async function startTimelineAudioPlayback(
  context: AudioContext,
  doc: TimelineDoc,
  fromFrame: number,
  resolveAsset: PlaybackAssetResolver,
  options: StartTimelineAudioOptions = {},
  deps: PlaybackAudioDeps = realDeps,
): Promise<TimelineAudioPlaybackSession> {
  validateDeps(deps)
  const durationFrames = docDurationFrames(doc)
  if (
    !Number.isSafeInteger(fromFrame)
    || fromFrame < 0
    || fromFrame >= durationFrames
  ) {
    throw new RangeError('Audio playback start frame is outside the timeline')
  }

  const plans = buildAudioClipPlans(
    doc,
    options.sourceBoundsCatalog ?? EMPTY_SOURCE_BOUNDS,
  ).filter(
    (plan) => plan.timelineEndFrame > fromFrame,
  )
  const fromTime = framesToSeconds(fromFrame, doc.frameRate)
  const durationTime = framesToSeconds(durationFrames, doc.frameRate)
  const output = deps.createOutput(context, timelineAudioMixerGraph(doc))
  const media = deps.createMediaSource(resolveAsset)
  const cursorStates = new Map<ClipId, ClipCursorState>()
  const failedClips = new Set<ClipId>()
  const exhaustedClips = new Set<ClipId>()
  const admittedStretchClips = new Set<ClipId>()

  let anchorTime = output.currentTime()
  let scheduledThroughTime = fromTime
  let pumpTimer: number | null = null
  let stopped = false
  let closePromise: Promise<void> | null = null
  let abortHandler: (() => void) | null = null

  const warnMedia = (
    plan: AudioClipPlan,
    stage: Extract<TimelineAudioPlaybackWarning, { scope: 'media' }>['stage'],
    cause: unknown,
    reason: MediaRuntimeFailure['reason'] = 'decode-failed',
    trackKind: MediaRuntimeFailure['trackKind'] = 'audio',
  ): void => {
    options.onWarning?.({
      scope: 'media',
      stage,
      clipId: plan.clipId,
      assetId: plan.assetId,
      trackKind,
      reason,
      cause,
    })
  }

  const warnGlobal = (
    stage: Extract<TimelineAudioPlaybackWarning, { scope: 'global' }>['stage'],
    cause: unknown,
  ): void => {
    options.onWarning?.({ scope: 'global', stage, cause })
  }

  const closeCursor = async (clipId: ClipId): Promise<void> => {
    const state = cursorStates.get(clipId)
    if (!state) return
    cursorStates.delete(clipId)
    admittedStretchClips.delete(clipId)
    state.stretchSession?.close()
    state.stretchChunk = null
    await state.cursor.close()
  }

  const openCursor = async (
    plan: AudioClipPlan,
    timelineStartTime: number,
  ): Promise<ClipCursorState | null> => {
    const existing = cursorStates.get(plan.clipId)
    if (existing) return existing
    if (
      failedClips.has(plan.clipId)
      || exhaustedClips.has(plan.clipId)
      || stopped
    ) return null

    const timelineOffset = Math.max(timelineStartTime, plan.timelineStartTime)
      - plan.timelineStartTime
    const sourceStartTime = isStretchedPlaybackPlan(plan)
      ? plan.decodeStartTime
        + timelineOffset * plan.stretch.rate.numerator
          / plan.stretch.rate.denominator
      : plan.sourceStartTime + timelineOffset
    if (isStretchedPlaybackPlan(plan)) {
      if (admittedStretchClips.size >= AUDIO_STRETCH_MAX_SESSIONS) {
        return null
      }
      admittedStretchClips.add(plan.clipId)
    }
    try {
      const cursor = await media.openClip({
        assetId: plan.assetId,
        startTime: sourceStartTime,
        endTime: plan.decodeEndTime,
        ...(isStretchedPlaybackPlan(plan) ? { stretchLead: true as const } : {}),
      })
      if (stopped) {
        admittedStretchClips.delete(plan.clipId)
        await cursor.close()
        return null
      }
      const state: ClipCursorState = {
        plan,
        cursor,
        pending: null,
        stretchSession: null,
        stretchSampleRate: null,
        stretchChunk: null,
        stretchChunkOffset: 0,
        stretchSourceTime: sourceStartTime,
        pendingFrameOffset: 0,
        done: false,
      }
      cursorStates.set(plan.clipId, state)
      return state
    } catch (cause) {
      admittedStretchClips.delete(plan.clipId)
      if (stopped) return null
      failedClips.add(plan.clipId)
      const reason =
        cause instanceof MediaAssetRuntimeError
        && cause.assetId === plan.assetId
        && cause.failure.surface === 'audio-playback'
          ? cause.failure.reason
          : 'decode-failed'
      const trackKind =
        cause instanceof MediaAssetRuntimeError
        && cause.assetId === plan.assetId
        && cause.failure.surface === 'audio-playback'
          ? cause.failure.trackKind
          : 'audio'
      warnMedia(plan, 'source-open', cause, reason, trackKind)
      return null
    }
  }

  const fillStretchChunk = async (
    state: ClipCursorState,
  ): Promise<void> => {
    const left = new Float32Array(AUDIO_STRETCH_RECHUNK_FRAMES)
    const right = new Float32Array(AUDIO_STRETCH_RECHUNK_FRAMES)
    let written = 0
    while (written < AUDIO_STRETCH_RECHUNK_FRAMES && !state.done) {
      if (!state.pending) {
        const step = await state.cursor.next()
        if (step.done) {
          state.done = true
          exhaustedClips.add(state.plan.clipId)
          break
        }
        state.pending = step.value
        state.pendingFrameOffset = 0
      }
      const wrapped = state.pending
      const buffer = wrapped.buffer
      const sampleRate = buffer.sampleRate
      if (
        !Number.isSafeInteger(sampleRate)
        || ![44_100, 48_000, 96_000].includes(sampleRate)
      ) {
        throw new RangeError(
          'Audio stretch sample rate must be 44100, 48000, or 96000',
        )
      }
      if (
        !Number.isSafeInteger(buffer.length)
        || buffer.length < 1
        || !Number.isSafeInteger(buffer.numberOfChannels)
        || buffer.numberOfChannels < 1
        || buffer.numberOfChannels > 32
      ) throw new Error('Decoded audio buffer has invalid PCM geometry')
      if (
        state.stretchSampleRate !== null
        && state.stretchSampleRate !== sampleRate
      ) throw new Error('Decoded audio sample rate changed during a stretch session')
      state.stretchSampleRate = sampleRate

      const sourceFrame = Math.max(
        state.pendingFrameOffset,
        Math.ceil(
          (state.stretchSourceTime - wrapped.timestamp) * sampleRate
          - TIME_EPSILON,
        ),
      )
      if (sourceFrame >= buffer.length) {
        state.pending = null
        state.pendingFrameOffset = 0
        continue
      }
      const copied = Math.min(
        buffer.length - sourceFrame,
        AUDIO_STRETCH_RECHUNK_FRAMES - written,
      )
      const planes = Array.from(
        { length: buffer.numberOfChannels },
        (_value, channel) => buffer.getChannelData(channel),
      )
      for (let index = 0; index < copied; index++) {
        const folded = foldDecodedFrameToStereo(planes, sourceFrame + index)
        left[written + index] = folded[0]
        right[written + index] = folded[1]
      }
      written += copied
      state.pendingFrameOffset = sourceFrame + copied
      state.stretchSourceTime =
        wrapped.timestamp + state.pendingFrameOffset / sampleRate
      if (state.pendingFrameOffset >= buffer.length) {
        state.pending = null
        state.pendingFrameOffset = 0
      }
    }
    state.stretchChunk = { left, right }
    state.stretchChunkOffset = 0
  }

  const readStretchSource = async (
    state: ClipCursorState,
    sampleCount: number,
  ): Promise<StereoPcm> => {
    const left = new Float32Array(sampleCount)
    const right = new Float32Array(sampleCount)
    let written = 0
    while (written < sampleCount) {
      if (
        !state.stretchChunk
        || state.stretchChunkOffset === state.stretchChunk.left.length
      ) await fillStretchChunk(state)
      const chunk = state.stretchChunk!
      const copied = Math.min(
        chunk.left.length - state.stretchChunkOffset,
        sampleCount - written,
      )
      left.set(
        chunk.left.subarray(
          state.stretchChunkOffset,
          state.stretchChunkOffset + copied,
        ),
        written,
      )
      right.set(
        chunk.right.subarray(
          state.stretchChunkOffset,
          state.stretchChunkOffset + copied,
        ),
        written,
      )
      state.stretchChunkOffset += copied
      written += copied
    }
    return { left, right }
  }

  const readPlanInterval = async (
    plan: AudioClipPlan,
    intervalStart: number,
    intervalEnd: number,
  ): Promise<PreparedAudioEvent[]> => {
    const timelineStart = Math.max(intervalStart, plan.timelineStartTime)
    const timelineEnd = Math.min(intervalEnd, plan.timelineEndTime)
    if (timelineEnd <= timelineStart + TIME_EPSILON || stopped) return []

    const cursorState = await openCursor(plan, timelineStart)
    if (!cursorState || stopped) return []
    if (isStretchedPlaybackPlan(plan)) {
      try {
        if (!cursorState.pending) {
          const step = await cursorState.cursor.next()
          if (step.done) {
            cursorState.done = true
            exhaustedClips.add(plan.clipId)
            await closeCursor(plan.clipId)
            return []
          }
          cursorState.pending = step.value
          cursorState.pendingFrameOffset = 0
        }
        const sampleRate = cursorState.pending.buffer.sampleRate
        if (
          !Number.isSafeInteger(sampleRate)
          || ![44_100, 48_000, 96_000].includes(sampleRate)
        ) {
          throw new RangeError(
            'Audio stretch sample rate must be 44100, 48000, or 96000',
          )
        }
        const outputStartSample = Math.round(
          (timelineStart - plan.timelineStartTime) * sampleRate,
        )
        const outputEndSample = Math.round(
          (timelineEnd - plan.timelineStartTime) * sampleRate,
        )
        const sampleCount = outputEndSample - outputStartSample
        if (sampleCount < 1) return []
        cursorState.stretchSampleRate = sampleRate
        cursorState.stretchSession ??= createConstantRateAudioStretcher({
          stretch: plan.stretch,
          sampleRate,
          outputStartSample,
        })
        const stretched = await cursorState.stretchSession.pull(
          sampleCount,
          (count) => readStretchSource(cursorState, count),
        )
        const buffer = context.createBuffer(2, sampleCount, sampleRate)
        buffer.getChannelData(0).set(stretched.left)
        buffer.getChannelData(1).set(stretched.right)
        const wrapped: PlaybackAudioBuffer = {
          buffer,
          timestamp: timelineStart,
          duration: sampleCount / sampleRate,
        }
        const events = preparedEventsForOverlap(
          plan,
          wrapped,
          timelineStart,
          timelineStart,
          timelineStart + wrapped.duration,
        )
        if (timelineEnd >= plan.timelineEndTime - TIME_EPSILON) {
          await closeCursor(plan.clipId)
        }
        return events
      } catch (cause) {
        if (!stopped) {
          failedClips.add(plan.clipId)
          warnMedia(plan, 'decode', cause)
          try {
            await closeCursor(plan.clipId)
          } catch (cleanupCause) {
            warnGlobal('cleanup', cleanupCause)
          }
        }
        return []
      }
    }
    const sourceStart =
      plan.sourceStartTime + (timelineStart - plan.timelineStartTime)
    const sourceEnd =
      plan.sourceStartTime + (timelineEnd - plan.timelineStartTime)
    const events: PreparedAudioEvent[] = []

    while (!stopped && !cursorState.done) {
      if (!cursorState.pending) {
        let step: IteratorResult<PlaybackAudioBuffer, void>
        try {
          step = await cursorState.cursor.next()
        } catch (cause) {
          if (stopped) break
          failedClips.add(plan.clipId)
          cursorState.done = true
          warnMedia(plan, 'decode', cause)
          break
        }
        if (stopped) break
        if (step.done) {
          cursorState.done = true
          exhaustedClips.add(plan.clipId)
          break
        }
        cursorState.pending = step.value
      }

      const wrapped = cursorState.pending
      if (!wrapped) continue
      const bufferDuration = wrapped.buffer.duration
      const usableDuration = Math.min(wrapped.duration, bufferDuration)
      if (
        !Number.isFinite(wrapped.timestamp)
        || !Number.isFinite(usableDuration)
        || usableDuration <= 0
      ) {
        cursorState.pending = null
        warnMedia(
          plan,
          'decoded-timing',
          new Error('Decoded audio buffer has invalid timing'),
        )
        continue
      }

      const bufferStart = wrapped.timestamp
      const bufferEnd = bufferStart + usableDuration
      if (bufferEnd <= sourceStart + TIME_EPSILON) {
        cursorState.pending = null
        continue
      }
      if (bufferStart >= sourceEnd - TIME_EPSILON) break

      const overlapStart = Math.max(sourceStart, bufferStart)
      const overlapEnd = Math.min(sourceEnd, bufferEnd)
      if (overlapEnd > overlapStart + TIME_EPSILON) {
        events.push(...preparedEventsForOverlap(
          plan,
          wrapped,
          bufferStart,
          overlapStart,
          overlapEnd,
        ))
      }

      if (bufferEnd <= sourceEnd + TIME_EPSILON) {
        cursorState.pending = null
      } else {
        break
      }
    }

    if (
      cursorState.done
      || timelineEnd >= plan.timelineEndTime - TIME_EPSILON
    ) {
      try {
        await closeCursor(plan.clipId)
      } catch (cause) {
        warnGlobal('cleanup', cause)
      }
    }
    return events
  }

  const prepareInterval = async (
    intervalStart: number,
    intervalEnd: number,
  ): Promise<PreparedAudioEvent[]> => {
    const relevant = plans.filter(
      (plan) =>
        plan.timelineStartTime < intervalEnd - TIME_EPSILON
        && plan.timelineEndTime > intervalStart + TIME_EPSILON,
    )
    const batches = await Promise.all(
      relevant.map((plan) => readPlanInterval(plan, intervalStart, intervalEnd)),
    )
    return batches.flat().sort((left, right) =>
      left.timelineStartTime - right.timelineStartTime
      || left.clipId.localeCompare(right.clipId),
    )
  }

  const scheduleEvents = (events: readonly PreparedAudioEvent[]): void => {
    for (const event of events) {
      if (stopped) return
      let when = anchorTime + (event.timelineStartTime - fromTime)
      let timelineStartTime = event.timelineStartTime
      let offset = event.offset
      let duration = event.duration
      const now = output.currentTime()
      if (when < now) {
        const lateness = now - when
        when = now
        timelineStartTime += lateness
        offset += lateness
        duration -= lateness
      }
      duration = Math.min(duration, event.buffer.duration - offset)
      if (duration <= TIME_EPSILON) continue

      try {
        output.schedule({
          ...event,
          timelineStartTime,
          when,
          offset,
          duration,
        })
      } catch (cause) {
        warnGlobal('output-schedule', cause)
      }
    }
  }

  const stop = (): Promise<void> => {
    if (closePromise) return closePromise
    stopped = true
    if (abortHandler) {
      options.signal?.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
    if (pumpTimer !== null) {
      deps.cancelPump(pumpTimer)
      pumpTimer = null
    }
    let failure: unknown
    try {
      output.stop()
    } catch (cause) {
      failure = cause
    }

    // Start all cancellation immediately. In particular, do not wait behind
    // a pending decoder read: media.close() disposes the Input that unblocks it.
    const cursorClosures = [...cursorStates.keys()].map((clipId) =>
      closeCursor(clipId)
    )
    let mediaClosure: Promise<void>
    try {
      mediaClosure = media.close()
    } catch (cause) {
      mediaClosure = Promise.reject(cause)
    }
    closePromise = (async () => {
      const settled = await Promise.allSettled([
        ...cursorClosures,
        mediaClosure,
      ])
      for (const entry of settled) {
        if (entry.status === 'rejected') failure ??= entry.reason
      }
      if (failure !== undefined) throw failure
    })()
    return closePromise
  }

  const runPump = async (): Promise<void> => {
    if (stopped) return
    const elapsed = Math.max(0, output.currentTime() - anchorTime)
    const target = Math.min(
      durationTime,
      fromTime + elapsed + deps.lookaheadSeconds,
    )
    if (target <= scheduledThroughTime + TIME_EPSILON) return
    const events = await prepareInterval(scheduledThroughTime, target)
    if (stopped) return
    scheduleEvents(events)
    scheduledThroughTime = target
  }

  const queuePump = (): void => {
    if (stopped || scheduledThroughTime >= durationTime - TIME_EPSILON) return
    pumpTimer = deps.schedulePump(() => {
      pumpTimer = null
      void (async () => {
        let failure: unknown
        try {
          await runPump()
        } catch (cause) {
          failure = cause
        }
        if (failure !== undefined) {
          warnGlobal('pump', failure)
          void stop().catch((cause) => warnGlobal('cleanup', cause))
        } else {
          queuePump()
        }
      })()
    }, deps.pumpIntervalMs)
  }

  abortHandler = () => {
    void stop().catch((cause) => warnGlobal('cleanup', cause))
  }
  options.signal?.addEventListener('abort', abortHandler, { once: true })

  try {
    if (options.signal?.aborted) throw abortedError()
    const initialEnd = Math.min(
      durationTime,
      fromTime + deps.lookaheadSeconds,
    )
    const initialEvents = await prepareInterval(fromTime, initialEnd)
    if (options.signal?.aborted) throw abortedError()

    anchorTime = output.currentTime() + deps.startLeadSeconds
    scheduleEvents(initialEvents)
    scheduledThroughTime = initialEnd
    queuePump()
  } catch (cause) {
    try {
      await stop()
    } catch {
      // Preserve startup/abort as the primary failure.
    }
    throw cause
  }

  return {
    anchorTime,
    stop,
    diagnostics: () => ({
      ...output.diagnostics(),
      activeDecoderCount: cursorStates.size,
      pendingBufferCount: [...cursorStates.values()].filter(
        (cursor) => cursor.pending !== null,
      ).length,
      anchorTime,
      fromFrame,
      scheduledThroughTimelineTime: scheduledThroughTime,
      scheduledThroughContextTime:
        anchorTime + (scheduledThroughTime - fromTime),
    }),
  }
}
