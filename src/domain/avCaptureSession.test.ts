import { describe, expect, test } from 'vitest'
import { beginAvCaptureSession, transitionAvCaptureSession, type AvCaptureSession, type AvCaptureEvent } from './avCaptureSession'

const project = { projectId: 'p', projectGeneration: 1 }

function run(state: AvCaptureSession, ...events: Array<Omit<AvCaptureEvent, 'sessionId'> & Record<string, unknown>>) {
  let current = state
  const effects: string[] = []
  for (const event of events) {
    const decision = transitionAvCaptureSession(current, { sessionId: current.sessionId, ...event } as AvCaptureEvent)
    current = decision.state
    if (decision.effect) effects.push(decision.effect.kind)
  }
  return { state: current, effects }
}

function start() {
  return beginAvCaptureSession(null, 's1', 'screen', project)!.state
}

describe('camera/screen capture session', () => {
  test('happy path: permission → prepare → record → stop → review → keep', () => {
    const { state, effects } = run(start(),
      { kind: 'permission-granted', operation: 0 },
      { kind: 'recording-started', operation: 1 },
      { kind: 'stop' },
      { kind: 'closed', operation: 2 },
      { kind: 'keep' },
      { kind: 'kept', operation: 3, assetId: 'asset' })
    expect(effects).toEqual(['prepare', 'stop', 'keep'])
    expect(state).toMatchObject({ phase: 'kept', assetId: 'asset' })
  })

  test('a stale completion from a superseded operation is ignored', () => {
    const { state } = run(start(), { kind: 'permission-granted', operation: 0 }, { kind: 'stop' },
      { kind: 'recording-started', operation: 1 })
    expect(state).toMatchObject({ phase: 'closing', after: 'cancelled' })
  })

  test('source end while recording keeps the take for review with the reason', () => {
    const { state, effects } = run(start(), { kind: 'permission-granted', operation: 0 },
      { kind: 'recording-started', operation: 1 }, { kind: 'interrupted', reason: 'source-ended' },
      { kind: 'closed', operation: 2 })
    expect(effects).toEqual(['prepare', 'stop'])
    expect(state).toMatchObject({ phase: 'review', interruption: 'source-ended' })
  })

  test('denied permission fails without any effect; cancel after failure discards', () => {
    const failed = run(start(), { kind: 'failed', operation: 0, reason: 'permission-denied' }, { kind: 'closed', operation: 1 })
    expect(failed.state).toMatchObject({ phase: 'failed', failure: 'permission-denied' })
    const discarded = run(failed.state, { kind: 'cancel' })
    expect(discarded.effects).toEqual(['discard'])
  })

  test('project replacement releases (keeps) the draft; a new session needs a terminal predecessor', () => {
    const recording = run(start(), { kind: 'permission-granted', operation: 0 }, { kind: 'recording-started', operation: 1 }).state
    expect(beginAvCaptureSession(recording, 's2', 'camera', project)).toBeNull()
    const replaced = run(recording, { kind: 'project-replaced' }, { kind: 'closed', operation: 2 })
    expect(replaced.effects).toEqual(['release'])
    expect(replaced.state).toMatchObject({ phase: 'failed', failure: 'project-replaced' })
    expect(beginAvCaptureSession(replaced.state, 's2', 'camera', project)?.state.phase).toBe('requesting')
    expect(beginAvCaptureSession(replaced.state, 's1', 'camera', project)).toBeNull()
  })

  test('cleanup failure blocks until retried with the same disposition', () => {
    const { state, effects } = run(start(), { kind: 'permission-granted', operation: 0 },
      { kind: 'recording-started', operation: 1 }, { kind: 'cancel' }, { kind: 'cleanup-failed', operation: 2 },
      { kind: 'retry-cleanup' }, { kind: 'closed', operation: 3 })
    expect(effects).toEqual(['prepare', 'discard', 'discard'])
    expect(state.phase).toBe('cancelled')
  })

  test('keep failure returns to review; cancel is ignored while keeping', () => {
    const review = run(start(), { kind: 'permission-granted', operation: 0 }, { kind: 'recording-started', operation: 1 },
      { kind: 'stop' }, { kind: 'closed', operation: 2 }).state
    const keeping = run(review, { kind: 'keep' }, { kind: 'cancel' })
    expect(keeping.state.phase).toBe('keeping')
    expect(run(keeping.state, { kind: 'keep-failed', operation: 3 }).state.phase).toBe('review')
  })
})
