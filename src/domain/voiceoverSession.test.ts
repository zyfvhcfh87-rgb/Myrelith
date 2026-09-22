import { describe, expect, test } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from './projectSettings'
import { pinVoiceoverDestination } from './voiceoverDestination'
import {
  beginVoiceoverSession, transitionVoiceoverSession,
  type VoiceoverSession, type VoiceoverSessionEvent,
} from './voiceoverSession'

type Payload<T> = T extends unknown ? Omit<T, 'sessionId'> : never
function send(state: VoiceoverSession, event: Payload<VoiceoverSessionEvent>) {
  return transitionVoiceoverSession(state, { ...event, sessionId: state.sessionId })
}
function complete(state: VoiceoverSession, kind: 'permission-granted' | 'prepared' | 'recording-started' | 'closed') {
  return send(state, { kind, operation: state.operation }).state
}
function begin() {
  const pinned = pinVoiceoverDestination({ projectId: 'project', projectGeneration: 1,
    editRevision: 2, doc: createTimelineDoc('Test', DEFAULT_PROJECT_SETTINGS, 'sequence') }, 'A1', 30)
  if (pinned.status !== 'pinned') throw new Error(pinned.reason)
  return beginVoiceoverSession(null, 'take-1', pinned.destination)
}
function recording() {
  return complete(complete(complete(begin().state, 'permission-granted'), 'prepared'), 'recording-started')
}
function review() {
  return complete(send(recording(), { kind: 'stop' }).state, 'closed')
}

describe('voiceover session transitions', () => {
  test('keeps exactly once after recording has stopped and cleanup has settled', () => {
    const start = begin()
    expect(start.effect?.kind).toBe('request-permission')
    const granted = send(start.state, { kind: 'permission-granted', operation: 0 })
    expect(granted.effect?.kind).toBe('prepare-recording')
    expect(granted.state.phase).toBe('preparing')
    const active = complete(complete(granted.state, 'prepared'), 'recording-started')
    expect(send(active, { kind: 'keep', placeOnTimeline: true }).effect).toBeNull()
    const stopped = send(active, { kind: 'stop' })
    expect(stopped.state.phase).toBe('closing')
    expect(stopped.effect?.kind).toBe('stop')
    expect(send(stopped.state, { kind: 'stop' }).state).toBe(stopped.state)
    const ready = complete(stopped.state, 'closed')
    const keep = send(ready, { kind: 'keep', placeOnTimeline: true })
    expect(keep.effect).toMatchObject({ kind: 'keep', placeOnTimeline: true })
    expect(send(keep.state, { kind: 'keep', placeOnTimeline: false }).effect).toBeNull()
    expect(send(keep.state, { kind: 'cancel' }).state).toBe(keep.state)
    const kept = send(keep.state, { kind: 'kept', operation: keep.state.operation,
      assetId: 'recorded-asset', location: 'pool' }).state
    expect(kept).toMatchObject({ phase: 'kept', assetId: 'recorded-asset', location: 'pool' })
    expect(send(kept, { kind: 'cancel' }).state).toBe(kept)
  })

  test('cancel wins over pending permission, count-in, recording, and review', () => {
    const preparing = complete(begin().state, 'permission-granted')
    for (const current of [begin().state, preparing, complete(preparing, 'prepared'), recording(), review()]) {
      const cancel = send(current, { kind: 'cancel' })
      expect(cancel.state).toMatchObject({ phase: 'closing', after: 'cancelled' })
      expect(cancel.effect?.kind).toBe('discard')
      expect(send(cancel.state, { kind: 'cancel' }).state).toBe(cancel.state)
      expect(complete(cancel.state, 'closed').phase).toBe('cancelled')
      expect(send(cancel.state, { kind: 'permission-granted', operation: current.operation }).state).toBe(cancel.state)
    }
  })

  test('a late stop completion cannot acknowledge a newer discard operation', () => {
    const stop = send(recording(), { kind: 'stop' })
    const cancel = send(stop.state, { kind: 'cancel' })
    expect(send(cancel.state, { kind: 'project-replaced' }).state).toBe(cancel.state)
    expect(send(cancel.state, { kind: 'closed', operation: stop.state.operation }).state).toBe(cancel.state)
    expect(complete(cancel.state, 'closed').phase).toBe('cancelled')
  })

  test.each(['source-ended', 'hidden', 'transport-changed', 'destination-changed', 'overrun'] as const)(
    '%s stops for explicit review and never silently keeps', (reason) => {
      const interrupted = send(recording(), { kind: 'interrupted', reason })
      expect(interrupted.effect?.kind).toBe('stop')
      const ready = complete(interrupted.state, 'closed')
      expect(ready).toMatchObject({ phase: 'review', interruption: reason })
      const early = send(begin().state, { kind: 'interrupted', reason })
      expect(complete(early.state, 'closed')).toMatchObject({ phase: 'failed', interruption: reason })
    },
  )

  test.each(['permission-denied', 'permission-dismissed', 'unsupported', 'writer-failed'] as const)(
    'retains the %s diagnostic and waits for resource cleanup', (reason) => {
      const current = begin().state
      const failure = send(current, { kind: 'failed', operation: current.operation, reason })
      expect(failure.effect?.kind).toBe('release')
      expect(failure.state.phase).toBe('closing')
      expect(complete(failure.state, 'closed')).toMatchObject({ phase: 'failed', failure: reason })
    },
  )

  test('project replacement invalidates a pending keep and preserves its draft', () => {
    const keeping = send(review(), { kind: 'keep', placeOnTimeline: true }).state
    const replaced = send(keeping, { kind: 'project-replaced' })
    expect(replaced.effect?.kind).toBe('release')
    expect(send(replaced.state, { kind: 'kept', operation: keeping.operation,
      assetId: 'late', location: 'timeline' }).state).toBe(replaced.state)
    expect(complete(replaced.state, 'closed')).toMatchObject({ phase: 'failed', failure: 'project-replaced' })
  })

  test('a writer failure while stopping cannot produce a successful review state', () => {
    const stop = send(recording(), { kind: 'stop' }).state
    const failure = send(stop, { kind: 'failed', operation: stop.operation, reason: 'writer-failed' })
    expect(failure.effect?.kind).toBe('release')
    expect(send(failure.state, { kind: 'closed', operation: stop.operation }).state).toBe(failure.state)
    expect(complete(failure.state, 'closed')).toMatchObject({ phase: 'failed', failure: 'writer-failed' })
  })

  test('a failed keep can be retried or discarded, with earlier replies ignored', () => {
    const keep = send(review(), { kind: 'keep', placeOnTimeline: false }).state
    const failed = send(keep, { kind: 'keep-failed', operation: keep.operation }).state
    expect(failed).toMatchObject({ phase: 'review', failure: 'finalization-failed' })
    const retry = send(failed, { kind: 'keep', placeOnTimeline: false }).state
    expect(send(retry, { kind: 'kept', operation: keep.operation, assetId: 'old', location: 'pool' }).state).toBe(retry)
    expect(send(failed, { kind: 'cancel' }).effect?.kind).toBe('discard')
  })

  test('failed cleanup blocks a new session until the retry completes', () => {
    const cancel = send(recording(), { kind: 'cancel' }).state
    const failed = send(cancel, { kind: 'cleanup-failed', operation: cancel.operation }).state
    expect(failed.phase).toBe('cleanup-failed')
    expect(beginVoiceoverSession(failed, 'take-2', failed.destination).state).toBe(failed)
    const retry = send(failed, { kind: 'retry-cleanup' })
    expect(retry.effect?.kind).toBe('discard')
    const cancelled = complete(retry.state, 'closed')
    expect(beginVoiceoverSession(cancelled, 'take-1', cancelled.destination).effect).toBeNull()
    expect(beginVoiceoverSession(cancelled, 'take-2', cancelled.destination).effect?.kind).toBe('request-permission')
  })

  test('ignores other sessions and duplicate begin, and leaves prior snapshots unchanged', () => {
    const current = recording()
    const snapshot = JSON.stringify(current)
    expect(transitionVoiceoverSession(current, { sessionId: 'other', kind: 'cancel' }).state).toBe(current)
    expect(beginVoiceoverSession(current, 'take-2', current.destination).effect).toBeNull()
    send(current, { kind: 'cancel' })
    expect(JSON.stringify(current)).toBe(snapshot)
    expect(() => beginVoiceoverSession(null, ' ', current.destination)).toThrow(RangeError)
  })
})
