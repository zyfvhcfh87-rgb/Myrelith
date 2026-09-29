/** Pure session decisions. The app executes effects and owns every resource. */
import type { VoiceoverDestination } from './voiceoverDestination'

export type VoiceoverInterruption =
  | 'source-ended' | 'hidden' | 'transport-changed' | 'destination-changed' | 'overrun'
export type VoiceoverFailure =
  | 'permission-denied' | 'permission-dismissed' | 'unsupported' | 'device-unavailable'
  | 'writer-failed' | 'finalization-failed' | 'project-replaced' | 'cleanup-failed'

interface SessionBase {
  readonly sessionId: string
  /** Monotonic effect token; superseded async completions cannot advance state. */
  readonly operation: number
  readonly destination: VoiceoverDestination
  readonly interruption: VoiceoverInterruption | null
  readonly failure: VoiceoverFailure | null
}

type AfterClose = 'review' | 'cancelled' | 'failed'
export type VoiceoverSession = SessionBase & (
  | { readonly phase: 'requesting' | 'preparing' | 'counting-in' | 'recording' | 'review' | 'keeping' | 'failed' | 'cancelled' }
  | { readonly phase: 'closing' | 'cleanup-failed'; readonly after: AfterClose }
  | { readonly phase: 'kept'; readonly assetId: string; readonly location: 'pool' | 'timeline' }
)

/**
 * stop: shut down capture and preserve a reviewable draft; discard: shut down
 * then delete it; release: shut down while preserving any recovery data.
 * Only acknowledge `closed` once the requested disposition has completed.
 * keep failures mean no asset was imported; placement failure after import
 * completes as `kept` in the Pool instead. Native work belongs to the app.
 */
export type VoiceoverSessionEffect = {
  readonly sessionId: string
  readonly operation: number
} & (
  | { readonly kind: 'request-permission' | 'prepare-recording' | 'stop' | 'discard' | 'release' }
  | { readonly kind: 'keep'; readonly placeOnTimeline: boolean }
)

export interface VoiceoverSessionDecision {
  readonly state: VoiceoverSession
  readonly effect: VoiceoverSessionEffect | null
}

export type VoiceoverSessionEvent = { readonly sessionId: string } & (
  | { readonly kind: 'permission-granted' | 'prepared' | 'recording-started' | 'closed' | 'cleanup-failed' | 'keep-failed'; readonly operation: number }
  | { readonly kind: 'failed'; readonly operation: number; readonly reason: VoiceoverFailure }
  | { readonly kind: 'kept'; readonly operation: number; readonly assetId: string; readonly location: 'pool' | 'timeline' }
  | { readonly kind: 'stop' | 'cancel' | 'project-replaced' | 'retry-cleanup' }
  | { readonly kind: 'interrupted'; readonly reason: VoiceoverInterruption }
  | { readonly kind: 'keep'; readonly placeOnTimeline: boolean }
)

/** Explicit record action with a newly unique id and a validated destination. */
export function beginVoiceoverSession(
  previous: VoiceoverSession | null,
  sessionId: string,
  destination: VoiceoverDestination,
): VoiceoverSessionDecision {
  if (!sessionId.trim()) throw new RangeError('Voiceover session id must not be empty')
  if (previous && (previous.sessionId === sessionId ||
    (previous.phase !== 'kept' && previous.phase !== 'cancelled' && previous.phase !== 'failed'))) {
    return { state: previous, effect: null }
  }
  return {
    state: { sessionId, destination, operation: 0, phase: 'requesting', interruption: null, failure: null },
    effect: { sessionId, operation: 0, kind: 'request-permission' },
  }
}

/**
 * Repeated/out-of-order events return the original state and no new effect.
 * The app must still dispose resources returned by a superseded async request.
 */
export function transitionVoiceoverSession(state: VoiceoverSession, event: VoiceoverSessionEvent): VoiceoverSessionDecision {
  const unchanged = (): VoiceoverSessionDecision => ({ state, effect: null })
  if (event.sessionId !== state.sessionId ||
    ('operation' in event && event.operation !== state.operation) ||
    state.phase === 'kept' || state.phase === 'cancelled') return unchanged()

  const base: SessionBase = {
    sessionId: state.sessionId, operation: state.operation, destination: state.destination,
    interruption: state.interruption, failure: state.failure,
  }
  const effect = (
    next: VoiceoverSession,
    command: { kind: 'request-permission' | 'prepare-recording' | 'stop' | 'discard' | 'release' }
      | { kind: 'keep'; placeOnTimeline: boolean },
  ): VoiceoverSessionDecision => {
    const operation = state.operation + 1
    if (!Number.isSafeInteger(operation)) throw new RangeError('Voiceover operation limit exceeded')
    return { state: { ...next, operation }, effect: { ...command, sessionId: state.sessionId, operation } }
  }
  const close = (
    after: AfterClose,
    kind: 'stop' | 'discard' | 'release',
    overrides: Partial<Pick<SessionBase, 'interruption' | 'failure'>> = {},
  ) => effect({ ...base, ...overrides, phase: 'closing', after }, { kind })

  switch (event.kind) {
    case 'permission-granted':
      return state.phase === 'requesting'
        ? effect({ ...base, phase: 'preparing' }, { kind: 'prepare-recording' }) : unchanged()
    case 'prepared':
      return state.phase === 'preparing' ? { state: { ...base, phase: 'counting-in' }, effect: null } : unchanged()
    case 'recording-started':
      return state.phase === 'counting-in' ? { state: { ...base, phase: 'recording' }, effect: null } : unchanged()
    case 'stop':
      if (state.phase === 'recording') return close('review', 'stop')
      if (state.phase === 'requesting' || state.phase === 'preparing' || state.phase === 'counting-in') return close('cancelled', 'discard')
      return unchanged()
    case 'interrupted':
      if (state.phase === 'recording') return close('review', 'stop', { interruption: event.reason })
      if (state.phase === 'requesting' || state.phase === 'preparing' || state.phase === 'counting-in') {
        return close('failed', 'release', { interruption: event.reason })
      }
      return unchanged()
    case 'cancel':
      // Keep commits the user's intent. Cancel is disabled during that one
      // import attempt; a failed attempt returns to review and can be discarded.
      if (state.phase === 'keeping' || (state.phase === 'closing' && state.after === 'cancelled')) return unchanged()
      return close('cancelled', 'discard')
    case 'project-replaced':
      if (state.phase === 'failed' ||
        ((state.phase === 'closing' || state.phase === 'cleanup-failed') && state.after === 'cancelled') ||
        (state.failure === 'project-replaced' && state.phase === 'closing')) return unchanged()
      return close('failed', 'release', { failure: 'project-replaced' })
    case 'failed':
      if (state.phase === 'requesting' || state.phase === 'preparing' || state.phase === 'counting-in' || state.phase === 'recording' || state.phase === 'keeping') {
        return close('failed', 'release', { failure: event.reason })
      }
      if (state.phase === 'closing' && state.after === 'review') {
        return close('failed', 'release', { failure: event.reason })
      }
      return unchanged()
    case 'closed':
      return state.phase === 'closing' ? { state: { ...base, phase: state.after }, effect: null } : unchanged()
    case 'cleanup-failed':
      return state.phase === 'closing'
        ? { state: { ...base, phase: 'cleanup-failed', after: state.after }, effect: null }
        : unchanged()
    case 'retry-cleanup':
      return state.phase === 'cleanup-failed'
        ? close(state.after, state.after === 'cancelled' ? 'discard' : state.after === 'review' ? 'stop' : 'release')
        : unchanged()
    case 'keep':
      return state.phase === 'review'
        ? effect({ ...base, phase: 'keeping', failure: null }, { kind: 'keep', placeOnTimeline: event.placeOnTimeline })
        : unchanged()
    case 'keep-failed':
      return state.phase === 'keeping'
        ? { state: { ...base, phase: 'review', failure: 'finalization-failed' }, effect: null } : unchanged()
    case 'kept':
      if (state.phase !== 'keeping') return unchanged()
      if (!event.assetId.trim()) throw new RangeError('Kept voiceover must identify its imported asset')
      return { state: { ...base, phase: 'kept', assetId: event.assetId, location: event.location }, effect: null }
  }
}
