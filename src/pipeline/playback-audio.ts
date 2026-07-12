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
import type { AssetId, Clip, ClipId, TimelineDoc } from '../domain/schema'
import { audibleTracks, docDurationFrames } from '../domain/selectors'
import { framesToSeconds, rangeEnd } from '../domain/time'

export const PLAYBACK_AUDIO_LOOKAHEAD_SECONDS = 0.75
export const PLAYBACK_AUDIO_START_LEAD_SECONDS = 0.05
export const PLAYBACK_AUDIO_PUMP_INTERVAL_MS = 100

const TIME_EPSILON = 1e-7

export type PlaybackAssetResolver = (assetId: AssetId) => Promise<Blob>

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
}

export interface PlaybackAudioMediaSource {
  openClip(request: PlaybackAudioClipRequest): Promise<PlaybackAudioCursor>
  close(): Promise<void>
}

export interface ScheduledPlaybackAudio {
  clipId: ClipId
  buffer: AudioBuffer
  when: number
  offset: number
  duration: number
  volume: number
}

export interface PlaybackAudioOutputDiagnostics {
  contextTime: number
  activeNodeCount: number
  rms: number
}

export interface PlaybackAudioOutput {
  currentTime(): number
  schedule(request: ScheduledPlaybackAudio): void
  stop(): void
  diagnostics(): PlaybackAudioOutputDiagnostics
}

export interface TimelineAudioPlaybackDiagnostics
  extends PlaybackAudioOutputDiagnostics {
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
  createOutput(context: AudioContext): PlaybackAudioOutput
  schedulePump(callback: () => void, delayMs: number): number
  cancelPump(id: number): void
  lookaheadSeconds: number
  startLeadSeconds: number
  pumpIntervalMs: number
}

export interface StartTimelineAudioOptions {
  signal?: AbortSignal
  onWarning?: (clipId: ClipId | null, cause: unknown) => void
}

interface AudioClipPlan {
  clipId: ClipId
  assetId: AssetId
  timelineStartFrame: number
  timelineEndFrame: number
  sourceStartFrame: number
  timelineStartTime: number
  timelineEndTime: number
  sourceStartTime: number
  sourceEndTime: number
  volume: number
}

interface ClipCursorState {
  plan: AudioClipPlan
  cursor: PlaybackAudioCursor
  pending: PlaybackAudioBuffer | null
  done: boolean
}

interface PreparedAudioEvent extends ScheduledPlaybackAudio {
  timelineStartTime: number
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

function buildAudioClipPlans(doc: TimelineDoc): AudioClipPlan[] {
  const plans: AudioClipPlan[] = []
  for (const track of audibleTracks(doc)) {
    for (const clip of track.clips) {
      assertClipRange(clip)
      if (clip.volume <= 0) continue

      const timelineEndFrame = rangeEnd(clip.timelineRange)
      const sourceEndFrame = rangeEnd(clip.sourceRange)
      plans.push({
        clipId: clip.id,
        assetId: clip.assetId,
        timelineStartFrame: clip.timelineRange.startFrame,
        timelineEndFrame,
        sourceStartFrame: clip.sourceRange.startFrame,
        timelineStartTime: framesToSeconds(
          clip.timelineRange.startFrame,
          doc.frameRate,
        ),
        timelineEndTime: framesToSeconds(timelineEndFrame, doc.frameRate),
        sourceStartTime: framesToSeconds(
          clip.sourceRange.startFrame,
          doc.frameRate,
        ),
        sourceEndTime: framesToSeconds(sourceEndFrame, doc.frameRate),
        volume: clip.volume,
      })
    }
  }
  return plans.sort((left, right) =>
    left.timelineStartFrame - right.timelineStartFrame
    || left.clipId.localeCompare(right.clipId),
  )
}

/** Stable fingerprint for changes that require a live audio re-prime. */
export function audioPlaybackPlanKey(doc: TimelineDoc): string {
  return JSON.stringify({
    rate: doc.frameRate,
    sampleRate: doc.audioSampleRate,
    durationFrames: docDurationFrames(doc),
    tracks: doc.tracks
      .filter((track) => track.kind === 'audio')
      .map((track) => ({
        id: track.id,
        muted: track.muted,
        solo: track.solo,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          sourceRange: clip.sourceRange,
          timelineRange: clip.timelineRange,
          volume: clip.volume,
        })),
      })),
  })
}

/** Asset ids that can still produce audible output at/after `fromFrame`. */
export function audioPlaybackAssetIds(
  doc: TimelineDoc,
  fromFrame = 0,
): AssetId[] {
  if (!Number.isSafeInteger(fromFrame) || fromFrame < 0) return []
  return [
    ...new Set(
      buildAudioClipPlans(doc)
        .filter((plan) => plan.timelineEndFrame > fromFrame)
        .map((plan) => plan.assetId),
    ),
  ]
}

export function hasAudioPlaybackContent(
  doc: TimelineDoc,
  fromFrame: number,
): boolean {
  if (!Number.isSafeInteger(fromFrame) || fromFrame < 0) return false
  return buildAudioClipPlans(doc).some(
    (plan) => plan.timelineEndFrame > fromFrame,
  )
}

interface DecodedAudioAsset {
  input: Input
  sink: AudioBufferSink
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

  const disposeAsset = (
    assetId: AssetId,
    asset: DecodedAudioAsset,
  ): void => {
    if (asset.disposed) return
    asset.disposed = true
    sessions.delete(assetId)
    resolvedAssets.delete(assetId)
    openInputs.delete(asset.input)
    asset.input.dispose()
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
      const blob = await resolveAsset(assetId)
      if (closed) throw new Error('Playback audio source is closed')

      const input = new Input({
        source: new BlobSource(blob),
        formats: ALL_FORMATS,
      })
      openInputs.add(input)
      try {
        const track = await input.getPrimaryAudioTrack()
        if (!track) {
          throw new Error(`Playback asset "${assetId}" has no audio track`)
        }
        if (!(await track.canDecode())) {
          throw new Error(
            `Playback asset "${assetId}" audio cannot be decoded in this browser`,
          )
        }
        if (closed) throw new Error('Playback audio source is closed')
        const asset: DecodedAudioAsset = {
          input,
          sink: new AudioBufferSink(track),
          activeCursors: 0,
          disposed: false,
        }
        resolvedAssets.set(assetId, asset)
        return asset
      } catch (cause) {
        try {
          input.dispose()
        } catch {
          // Preserve the decode/open failure over disposal cleanup.
        }
        openInputs.delete(input)
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
      iterator = asset.sink.buffers(
        request.startTime,
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
          input.dispose()
        } catch (cause) {
          failure ??= cause
        } finally {
          openInputs.delete(input)
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
}

/** The only module that turns decoded buffers into an audible Web Audio graph. */
export function createWebAudioPlaybackOutput(
  context: AudioContext,
): PlaybackAudioOutput {
  const master = context.createGain()
  const analyser = context.createAnalyser()
  analyser.fftSize = 2_048
  master.gain.value = 0
  master.connect(analyser)
  analyser.connect(context.destination)

  const nodes = new Set<ActiveOutputNode>()
  const sampleWindow = new Float32Array(analyser.fftSize)
  let stopped = false
  let graphDisconnected = false
  let armed = false

  const disconnectGraph = (): void => {
    if (graphDisconnected) return
    graphDisconnected = true
    try {
      master.disconnect()
    } finally {
      analyser.disconnect()
    }
  }

  const cleanupNode = (record: ActiveOutputNode): void => {
    if (!nodes.delete(record)) return
    record.source.onended = null
    try {
      record.source.disconnect()
    } finally {
      record.gain.disconnect()
    }
    if (stopped && nodes.size === 0) disconnectGraph()
  }

  const schedule = (request: ScheduledPlaybackAudio): void => {
    if (stopped) return
    const source = context.createBufferSource()
    const gain = context.createGain()
    source.buffer = request.buffer
    gain.gain.value = request.volume
    source.connect(gain)
    gain.connect(master)

    const record = { source, gain }
    nodes.add(record)
    source.onended = () => cleanupNode(record)
    try {
      source.start(request.when, request.offset, request.duration)
      if (!armed) {
        master.gain.cancelScheduledValues(request.when)
        master.gain.setValueAtTime(0, request.when)
        master.gain.linearRampToValueAtTime(1, request.when + 0.005)
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

  const diagnostics = (): PlaybackAudioOutputDiagnostics => {
    let sum = 0
    if (!stopped) {
      analyser.getFloatTimeDomainData(sampleWindow)
      for (const sample of sampleWindow) sum += sample * sample
    }
    return {
      contextTime: context.currentTime,
      activeNodeCount: nodes.size,
      rms: stopped ? 0 : Math.sqrt(sum / sampleWindow.length),
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

  const plans = buildAudioClipPlans(doc).filter(
    (plan) => plan.timelineEndFrame > fromFrame,
  )
  const fromTime = framesToSeconds(fromFrame, doc.frameRate)
  const durationTime = framesToSeconds(durationFrames, doc.frameRate)
  const output = deps.createOutput(context)
  const media = deps.createMediaSource(resolveAsset)
  const cursorStates = new Map<ClipId, ClipCursorState>()
  const failedClips = new Set<ClipId>()
  const exhaustedClips = new Set<ClipId>()

  let anchorTime = output.currentTime()
  let scheduledThroughTime = fromTime
  let pumpTimer: number | null = null
  let stopped = false
  let closePromise: Promise<void> | null = null
  let abortHandler: (() => void) | null = null

  const warn = (clipId: ClipId | null, cause: unknown): void => {
    options.onWarning?.(clipId, cause)
  }

  const closeCursor = async (clipId: ClipId): Promise<void> => {
    const state = cursorStates.get(clipId)
    if (!state) return
    cursorStates.delete(clipId)
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

    const sourceStartTime =
      plan.sourceStartTime
      + (Math.max(timelineStartTime, plan.timelineStartTime)
        - plan.timelineStartTime)
    try {
      const cursor = await media.openClip({
        assetId: plan.assetId,
        startTime: sourceStartTime,
        endTime: plan.sourceEndTime,
      })
      if (stopped) {
        await cursor.close()
        return null
      }
      const state: ClipCursorState = {
        plan,
        cursor,
        pending: null,
        done: false,
      }
      cursorStates.set(plan.clipId, state)
      return state
    } catch (cause) {
      if (stopped) return null
      failedClips.add(plan.clipId)
      warn(plan.clipId, cause)
      return null
    }
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
          warn(plan.clipId, cause)
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
        warn(plan.clipId, new Error('Decoded audio buffer has invalid timing'))
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
        events.push({
          clipId: plan.clipId,
          buffer: wrapped.buffer,
          timelineStartTime:
            plan.timelineStartTime + (overlapStart - plan.sourceStartTime),
          when: 0,
          offset: overlapStart - bufferStart,
          duration: overlapEnd - overlapStart,
          volume: plan.volume,
        })
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
        warn(plan.clipId, cause)
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
      let offset = event.offset
      let duration = event.duration
      const now = output.currentTime()
      if (when < now) {
        const lateness = now - when
        when = now
        offset += lateness
        duration -= lateness
      }
      duration = Math.min(duration, event.buffer.duration - offset)
      if (duration <= TIME_EPSILON) continue

      try {
        output.schedule({ ...event, when, offset, duration })
      } catch (cause) {
        warn(event.clipId, cause)
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
          warn(null, failure)
          void stop().catch((cause) => warn(null, cause))
        } else {
          queuePump()
        }
      })()
    }, deps.pumpIntervalMs)
  }

  abortHandler = () => {
    void stop().catch((cause) => warn(null, cause))
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
      anchorTime,
      fromFrame,
      scheduledThroughTimelineTime: scheduledThroughTime,
      scheduledThroughContextTime:
        anchorTime + (scheduledThroughTime - fromTime),
    }),
  }
}
