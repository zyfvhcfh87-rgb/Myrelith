/**
 * Pure camera/screen capture session rules (Issue #209). The app executes
 * effects and owns every stream, worker and file. Operation tokens reject
 * stale completions; repeated events return the same state with no effect.
 *
 * Unlike voiceover there is no timeline destination: a kept take is imported
 * into the Media Pool only.
 */

export type AvCaptureMode = 'camera' | 'screen'
export type AvCaptureInterruption = 'source-ended' | 'page-frozen' | 'limit' | 'worker-lost'
export type AvCaptureFailure =
  | 'permission-denied' | 'permission-dismissed' | 'unsupported' | 'device-unavailable'
  | 'screen-permission' | 'writer-failed' | 'project-replaced'

type AfterClose = 'review' | 'cancelled' | 'failed'

interface Base {
  readonly sessionId: string
  readonly mode: AvCaptureMode
  readonly operation: number
  readonly interruption: AvCaptureInterruption | null
  readonly failure: AvCaptureFailure | null
  /** Project identity pinned at start; a kept take never enters another project. */
  readonly projectId: string
  readonly projectGeneration: number
}

export type AvCaptureSession = Base & (
  | { readonly phase: 'requesting' | 'preparing' | 'recording' | 'review' | 'keeping' | 'failed' | 'cancelled' }
  | { readonly phase: 'closing' | 'cleanup-failed'; readonly after: AfterClose }
  | { readonly phase: 'kept'; readonly assetId: string }
)

/**
 * stop: finalize the take for review; discard: stop then delete it;
 * release: stop and keep whatever was flushed for later recovery.
 */
export type AvCaptureEffect = { readonly sessionId: string; readonly operation: number } & (
  | { readonly kind: 'prepare' | 'stop' | 'discard' | 'release' | 'keep' }
)

export type AvCaptureEvent = { readonly sessionId: string } & (
  | { readonly kind: 'permission-granted' | 'recording-started' | 'closed' | 'cleanup-failed' | 'keep-failed'; readonly operation: number }
  | { readonly kind: 'failed'; readonly operation: number; readonly reason: AvCaptureFailure }
  | { readonly kind: 'kept'; readonly operation: number; readonly assetId: string }
  | { readonly kind: 'stop' | 'cancel' | 'keep' | 'project-replaced' | 'retry-cleanup' }
  | { readonly kind: 'interrupted'; readonly reason: AvCaptureInterruption }
)

export interface AvCaptureDecision {
  readonly state: AvCaptureSession
  readonly effect: AvCaptureEffect | null
}

const TERMINAL = new Set<AvCaptureSession['phase']>(['kept', 'cancelled', 'failed'])

export function avCaptureSessionIsTerminal(session: AvCaptureSession | null): boolean {
  return session === null || TERMINAL.has(session.phase)
}

export function beginAvCaptureSession(
  previous: AvCaptureSession | null,
  sessionId: string,
  mode: AvCaptureMode,
  project: { projectId: string; projectGeneration: number },
): AvCaptureDecision | null {
  if (!sessionId.trim()) throw new RangeError('Capture session id must not be empty')
  if (previous && (!TERMINAL.has(previous.phase) || previous.sessionId === sessionId)) return null
  return { state: { sessionId, mode, operation: 0, interruption: null, failure: null,
    projectId: project.projectId, projectGeneration: project.projectGeneration, phase: 'requesting' }, effect: null }
}

export function transitionAvCaptureSession(state: AvCaptureSession, event: AvCaptureEvent): AvCaptureDecision {
  const unchanged = (): AvCaptureDecision => ({ state, effect: null })
  if (event.sessionId !== state.sessionId ||
    ('operation' in event && event.operation !== state.operation) ||
    state.phase === 'kept' || state.phase === 'cancelled') return unchanged()
  const base: Base = { sessionId: state.sessionId, mode: state.mode, operation: state.operation,
    interruption: state.interruption, failure: state.failure,
    projectId: state.projectId, projectGeneration: state.projectGeneration }
  const effect = (next: AvCaptureSession, kind: AvCaptureEffect['kind']): AvCaptureDecision => {
    const operation = state.operation + 1
    return { state: { ...next, operation }, effect: { sessionId: state.sessionId, operation, kind } }
  }
  const close = (after: AfterClose, kind: 'stop' | 'discard' | 'release',
    overrides: Partial<Pick<Base, 'interruption' | 'failure'>> = {}) =>
    effect({ ...base, ...overrides, phase: 'closing', after }, kind)
  const active = state.phase === 'requesting' || state.phase === 'preparing'

  switch (event.kind) {
    case 'permission-granted':
      return state.phase === 'requesting' ? effect({ ...base, phase: 'preparing' }, 'prepare') : unchanged()
    case 'recording-started':
      return state.phase === 'preparing' ? { state: { ...base, phase: 'recording' }, effect: null } : unchanged()
    case 'stop':
      if (state.phase === 'recording') return close('review', 'stop')
      if (active) return close('cancelled', 'discard')
      return unchanged()
    case 'interrupted':
      // The source ended, the page froze, or a limit was reached: keep what exists.
      if (state.phase === 'recording') return close('review', 'stop', { interruption: event.reason })
      if (active) return close('failed', 'release', { interruption: event.reason })
      return unchanged()
    case 'cancel':
      if (state.phase === 'keeping' || (state.phase === 'closing' && state.after === 'cancelled')) return unchanged()
      return close('cancelled', 'discard')
    case 'project-replaced':
      if (state.phase === 'failed' ||
        ((state.phase === 'closing' || state.phase === 'cleanup-failed') && state.after === 'cancelled') ||
        (state.phase === 'closing' && state.failure === 'project-replaced')) return unchanged()
      return close('failed', 'release', { failure: 'project-replaced' })
    case 'failed':
      if (active || state.phase === 'recording' || state.phase === 'keeping' ||
        (state.phase === 'closing' && state.after === 'review')) {
        return close('failed', 'release', { failure: event.reason })
      }
      return unchanged()
    case 'closed':
      return state.phase === 'closing' ? { state: { ...base, phase: state.after }, effect: null } : unchanged()
    case 'cleanup-failed':
      return state.phase === 'closing'
        ? { state: { ...base, phase: 'cleanup-failed', after: state.after }, effect: null } : unchanged()
    case 'retry-cleanup':
      return state.phase === 'cleanup-failed'
        ? close(state.after, state.after === 'cancelled' ? 'discard' : state.after === 'review' ? 'stop' : 'release')
        : unchanged()
    case 'keep':
      return state.phase === 'review' ? effect({ ...base, phase: 'keeping', failure: null }, 'keep') : unchanged()
    case 'keep-failed':
      return state.phase === 'keeping' ? { state: { ...base, phase: 'review' }, effect: null } : unchanged()
    case 'kept':
      if (state.phase !== 'keeping' || !event.assetId.trim()) return unchanged()
      return { state: { ...base, phase: 'kept', assetId: event.assetId }, effect: null }
  }
}
