/**
 * Browser-free Source Monitor session facts.
 *
 * Opens one connected Media Pool asset for review without touching
 * TimelineDoc, recovery, or undo. Playhead and In/Out are integer source
 * frames on the asset's own clock: native video rate, or a 30/1 grid for
 * audio-only and stills. Shuttle is a signed 1-2-4-8 step. Rejected edits
 * return the original session reference.
 */

import {
  compatibilityAllowsTimelineUse,
  type MediaCompatibilityItem,
} from './mediaCompatibility'
import type {
  AssetId,
  AssetKind,
  FrameRate,
  MediaAsset,
  TimeRange,
} from './schema'
import {
  microsecondsDurationToFrames,
  rateEquals,
  rescaleFrames,
} from './time'

/** Display/step grid used when an asset has no native video rate. */
export const SOURCE_MONITOR_FALLBACK_RATE: Readonly<FrameRate> = Object.freeze({
  num: 30,
  den: 1,
})

/** Forward J/L magnitudes. Reverse uses the same values with a minus sign. */
export const SOURCE_MONITOR_SHUTTLE_MAGNITUDES = Object.freeze([1, 2, 4, 8])

export type SourceMonitorShuttleKey = 'j' | 'k' | 'l'

export type SourceMonitorOpenRejection =
  | 'offline'
  | 'incompatible'
  | 'invalid-duration'

export type MonitorPlaybackOwner = 'none' | 'program' | 'source'

export interface SourceMonitorSourceFacts {
  readonly assetId: AssetId
  readonly kind: AssetKind
  readonly fileName: string
  readonly rate: FrameRate
  readonly durationFrames: number
  readonly hasAudio: boolean
}

export interface SourceMonitorSession {
  readonly source: SourceMonitorSourceFacts
  readonly playheadFrame: number
  readonly inFrame: number | null
  readonly outFrameExclusive: number | null
  readonly shuttleStep: number
}

export type SourceMonitorOpenResult =
  | { readonly status: 'ok'; readonly session: SourceMonitorSession }
  | {
      readonly status: 'rejected'
      readonly reason: SourceMonitorOpenRejection
      readonly session: SourceMonitorSession | null
    }

export interface MonitorPlaybackHandoff {
  readonly owner: MonitorPlaybackOwner
  readonly pausedOwner: 'program' | 'source' | null
}

export interface SourceMonitorOpenInput {
  readonly asset: MediaAsset | null
  readonly compatibility?: MediaCompatibilityItem
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function lastFrameOf(durationFrames: number): number {
  return Math.max(0, durationFrames - 1)
}

function clampPlayhead(frame: number, durationFrames: number): number {
  if (!Number.isFinite(frame)) return 0
  const rounded = Math.round(frame)
  return Math.min(lastFrameOf(durationFrames), Math.max(0, rounded))
}

function validMarkFrame(frame: number, durationFrames: number): boolean {
  return Number.isSafeInteger(frame)
    && frame >= 0
    && frame < durationFrames
}

function sessionsEqual(
  left: SourceMonitorSession,
  right: SourceMonitorSession,
): boolean {
  return sourceFactsEqual(left.source, right.source)
    && left.playheadFrame === right.playheadFrame
    && left.inFrame === right.inFrame
    && left.outFrameExclusive === right.outFrameExclusive
    && left.shuttleStep === right.shuttleStep
}

function commit(
  current: SourceMonitorSession,
  next: SourceMonitorSession,
): SourceMonitorSession {
  return sessionsEqual(current, next) ? current : next
}

function withSession(
  session: SourceMonitorSession,
  patch: Partial<Omit<SourceMonitorSession, 'source'>> & {
    readonly source?: SourceMonitorSourceFacts
  },
): SourceMonitorSession {
  return commit(session, {
    source: patch.source ?? session.source,
    playheadFrame: patch.playheadFrame === undefined
      ? session.playheadFrame
      : patch.playheadFrame,
    inFrame: patch.inFrame === undefined ? session.inFrame : patch.inFrame,
    outFrameExclusive: patch.outFrameExclusive === undefined
      ? session.outFrameExclusive
      : patch.outFrameExclusive,
    shuttleStep: patch.shuttleStep === undefined
      ? session.shuttleStep
      : patch.shuttleStep,
  })
}

function nextShuttleStep(current: number, direction: 1 | -1): number {
  if (current === 0 || Math.sign(current) !== direction) return direction
  const magnitude = Math.abs(current)
  const index = SOURCE_MONITOR_SHUTTLE_MAGNITUDES.indexOf(magnitude)
  if (index < 0) return direction
  const nextIndex = Math.min(index + 1, SOURCE_MONITOR_SHUTTLE_MAGNITUDES.length - 1)
  return direction * SOURCE_MONITOR_SHUTTLE_MAGNITUDES[nextIndex]
}

export function sourceMonitorClockRate(asset: MediaAsset): FrameRate {
  return asset.frameRate ?? SOURCE_MONITOR_FALLBACK_RATE
}

export function sourceMonitorSourceFacts(asset: MediaAsset): SourceMonitorSourceFacts {
  const rate = sourceMonitorClockRate(asset)
  const durationFrames = microsecondsDurationToFrames(
    asset.durationMicroseconds,
    rate,
  )
  return {
    assetId: asset.id,
    kind: asset.kind,
    fileName: asset.fileName,
    rate,
    durationFrames,
    hasAudio: asset.hasAudio,
  }
}

function createSession(source: SourceMonitorSourceFacts): SourceMonitorSession {
  return {
    source,
    playheadFrame: 0,
    inFrame: null,
    outFrameExclusive: null,
    shuttleStep: 0,
  }
}

function remapMark(
  frame: number | null,
  from: FrameRate,
  to: FrameRate,
  durationFrames: number,
  exclusive: boolean,
): number | null {
  if (frame === null) return null
  const mapped = rateEquals(from, to) ? frame : rescaleFrames(frame, from, to)
  if (exclusive) {
    const clamped = Math.min(durationFrames, Math.max(0, mapped))
    return clamped > 0 ? clamped : null
  }
  return validMarkFrame(mapped, durationFrames) ? mapped : null
}

function sourceFactsEqual(
  left: SourceMonitorSourceFacts,
  right: SourceMonitorSourceFacts,
): boolean {
  return left.assetId === right.assetId
    && left.kind === right.kind
    && left.fileName === right.fileName
    && rateEquals(left.rate, right.rate)
    && left.durationFrames === right.durationFrames
    && left.hasAudio === right.hasAudio
}

function remapSession(
  session: SourceMonitorSession,
  source: SourceMonitorSourceFacts,
): SourceMonitorSession {
  if (sourceFactsEqual(session.source, source)) return session
  const from = session.source.rate
  const rateUnchanged = rateEquals(from, source.rate)
  const durationUnchanged = session.source.durationFrames === source.durationFrames
  if (rateUnchanged && durationUnchanged) {
    return withSession(session, { source })
  }
  const playheadFrame = clampPlayhead(
    rateUnchanged
      ? session.playheadFrame
      : rescaleFrames(session.playheadFrame, from, source.rate),
    source.durationFrames,
  )
  let inFrame = remapMark(
    session.inFrame,
    from,
    source.rate,
    source.durationFrames,
    false,
  )
  let outFrameExclusive = remapMark(
    session.outFrameExclusive,
    from,
    source.rate,
    source.durationFrames,
    true,
  )
  if (
    inFrame !== null
    && outFrameExclusive !== null
    && inFrame >= outFrameExclusive
  ) {
    inFrame = null
    outFrameExclusive = null
  }
  return commit(session, {
    source,
    playheadFrame,
    inFrame,
    outFrameExclusive,
    shuttleStep: 0,
  })
}

export function openSourceMonitor(
  current: SourceMonitorSession | null,
  input: SourceMonitorOpenInput,
): SourceMonitorOpenResult {
  const asset = input.asset
  if (asset === null) {
    return { status: 'rejected', reason: 'offline', session: current }
  }
  if (!compatibilityAllowsTimelineUse(input.compatibility)) {
    return { status: 'rejected', reason: 'incompatible', session: current }
  }
  if (!isPositiveSafeInteger(asset.durationMicroseconds)) {
    return { status: 'rejected', reason: 'invalid-duration', session: current }
  }

  const source = sourceMonitorSourceFacts(asset)
  if (!isPositiveSafeInteger(source.durationFrames)) {
    return { status: 'rejected', reason: 'invalid-duration', session: current }
  }

  if (current && current.source.assetId === source.assetId) {
    return { status: 'ok', session: remapSession(current, source) }
  }
  return { status: 'ok', session: createSession(source) }
}

export function closeSourceMonitor(
  _session: SourceMonitorSession | null,
): null {
  return null
}

export function sourceMonitorLastFrame(session: SourceMonitorSession): number {
  return lastFrameOf(session.source.durationFrames)
}

export function sourceMonitorSelectionRange(
  session: SourceMonitorSession,
): TimeRange | null {
  const { inFrame, outFrameExclusive } = session
  if (inFrame === null || outFrameExclusive === null) return null
  if (inFrame >= outFrameExclusive) return null
  return {
    startFrame: inFrame,
    durationFrames: outFrameExclusive - inFrame,
  }
}

export function sourceMonitorDecodeFrame(session: SourceMonitorSession): number {
  return session.source.kind === 'image' ? 0 : session.playheadFrame
}

export function sourceMonitorAudioAudition(session: SourceMonitorSession): boolean {
  return session.source.hasAudio && session.shuttleStep === 1
}

export function setSourcePlayhead(
  session: SourceMonitorSession,
  frame: number,
): SourceMonitorSession {
  return withSession(session, {
    playheadFrame: clampPlayhead(frame, session.source.durationFrames),
  })
}

export function scrubSourcePlayhead(
  session: SourceMonitorSession,
  frame: number,
): SourceMonitorSession {
  return withSession(session, {
    playheadFrame: clampPlayhead(frame, session.source.durationFrames),
    shuttleStep: 0,
  })
}

export function stepSourceFrame(
  session: SourceMonitorSession,
  deltaFrames: number,
): SourceMonitorSession {
  if (!Number.isSafeInteger(deltaFrames) || deltaFrames === 0) return session
  return scrubSourcePlayhead(session, session.playheadFrame + deltaFrames)
}

export function advanceSourcePlayhead(
  session: SourceMonitorSession,
  deltaFrames: number,
): SourceMonitorSession {
  if (!Number.isSafeInteger(deltaFrames) || deltaFrames === 0) return session
  const next = clampPlayhead(
    session.playheadFrame + deltaFrames,
    session.source.durationFrames,
  )
  const hitStart = deltaFrames < 0 && next === 0
  const hitEnd = deltaFrames > 0 && next === sourceMonitorLastFrame(session)
  return withSession(session, {
    playheadFrame: next,
    shuttleStep: hitStart || hitEnd ? 0 : session.shuttleStep,
  })
}

export function stopSourcePlayback(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return withSession(session, { shuttleStep: 0 })
}

export function parkSourcePlayback(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return withSession(session, {
    playheadFrame: sourceMonitorLastFrame(session),
    shuttleStep: 0,
  })
}

export function jumpSourceToStart(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return scrubSourcePlayhead(session, 0)
}

export function jumpSourceToEnd(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return scrubSourcePlayhead(session, sourceMonitorLastFrame(session))
}

export function jumpSourceToIn(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return session.inFrame === null
    ? jumpSourceToStart(session)
    : scrubSourcePlayhead(session, session.inFrame)
}

export function jumpSourceToOut(
  session: SourceMonitorSession,
): SourceMonitorSession {
  if (session.outFrameExclusive === null) return jumpSourceToEnd(session)
  return scrubSourcePlayhead(session, session.outFrameExclusive - 1)
}

export function setSourceIn(session: SourceMonitorSession): SourceMonitorSession {
  const inFrame = session.playheadFrame
  const outFrameExclusive =
    session.outFrameExclusive !== null && inFrame >= session.outFrameExclusive
      ? null
      : session.outFrameExclusive
  return withSession(session, { inFrame, outFrameExclusive })
}

export function setSourceOut(session: SourceMonitorSession): SourceMonitorSession {
  const outFrameExclusive = session.playheadFrame + 1
  const inFrame =
    session.inFrame !== null && session.inFrame >= outFrameExclusive
      ? null
      : session.inFrame
  return withSession(session, { inFrame, outFrameExclusive })
}

export function clearSourceIn(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return withSession(session, { inFrame: null })
}

export function clearSourceOut(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return withSession(session, { outFrameExclusive: null })
}

export function clearSourceMarks(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return withSession(session, { inFrame: null, outFrameExclusive: null })
}

export function resetSourceSession(
  session: SourceMonitorSession,
): SourceMonitorSession {
  return withSession(session, {
    playheadFrame: 0,
    inFrame: null,
    outFrameExclusive: null,
    shuttleStep: 0,
  })
}

export function stepSourceShuttle(
  session: SourceMonitorSession,
  key: SourceMonitorShuttleKey,
): SourceMonitorSession {
  if (key === 'k') return stopSourcePlayback(session)
  const direction = key === 'l' ? 1 : -1
  return withSession(session, {
    shuttleStep: nextShuttleStep(session.shuttleStep, direction),
  })
}

export function requestMonitorPlayback(
  current: MonitorPlaybackOwner,
  requested: 'program' | 'source',
): MonitorPlaybackHandoff {
  if (current === requested) {
    return { owner: requested, pausedOwner: null }
  }
  if (current === 'none') {
    return { owner: requested, pausedOwner: null }
  }
  return { owner: requested, pausedOwner: current }
}

/** Marks currently inside the source, used by later three-point commands. */
export function sourceMonitorPreparedRange(
  session: SourceMonitorSession,
): TimeRange {
  const marked = sourceMonitorSelectionRange(session)
  if (marked) return marked
  return {
    startFrame: 0,
    durationFrames: session.source.durationFrames,
  }
}
