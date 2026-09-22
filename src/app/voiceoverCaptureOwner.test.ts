import { describe, expect, test, vi } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { VoiceoverDestinationContext } from '../domain/voiceoverDestination'
import { useDocumentStore } from '../state/documentStore'
import { VoiceoverCaptureOwner, currentVoiceoverDestinationContext, type VoiceoverCaptureDeps } from './voiceoverCaptureOwner'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live'
  label = 'Test microphone'
  stops = 0
  stop() { this.stops++; this.readyState = 'ended' }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
}

function stream(track = new FakeTrack()) {
  return { track, media: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream }
}

function harness(options: { permission?: Promise<MediaStream>; failDiscardOnce?: boolean;
  failStopOnce?: boolean; create?: Promise<void>; visible?: boolean; unsupported?: boolean;
  lifecycle?: EventTarget } = {}) {
  const live: VoiceoverDestinationContext = {
    projectId: 'project', projectGeneration: 1, editRevision: 1,
    doc: createTimelineDoc('Voiceover', DEFAULT_PROJECT_SETTINGS, 'sequence'),
  }
  const calls = { requested: 0, created: 0, stopRequests: 0, stopped: 0, released: 0,
    recovered: 0, discarded: 0, closed: 0, aborted: 0, connected: 0 }
  let started: (() => void) | null = null
  let overrun: (() => void) | null = null
  let finishedReject: ((cause: Error) => void) | null = null
  const owner = new VoiceoverCaptureOwner({
    destinationContext: () => live,
    requestMicrophone: () => { calls.requested++; return options.permission ?? Promise.resolve(stream().media) },
    getContext: () => ({ sampleRate: 48_000, currentTime: 0, resume: async () => {} }) as unknown as AudioContext,
    createWriter: () => ({
      create: async () => { calls.created++; await options.create; return { pcmBytes: 0, committedBytes: 0 } as never },
      append: async () => ({ pcmBytes: 0, committedBytes: 0 }) as never,
      stop: async () => { calls.stopped++; return { pcmBytes: 0, committedBytes: 0 } as never },
      release: async () => { calls.released++; return { pcmBytes: 0, committedBytes: 0 } as never },
      recover: async () => { calls.recovered++; return {} as never },
      discard: async () => { calls.discarded++; if (options.failDiscardOnce && calls.discarded === 1) throw new Error('Injected cleanup failure') },
      close: () => { calls.closed++ },
    }),
    connect: async (input) => {
      calls.connected++
      started = () => input.onStarted?.(input.startFrame)
      overrun = () => input.onOverrun?.(input.startFrame)
      const finished = new Promise<never>((_, reject) => { finishedReject = reject })
      return { outputNode: {} as AudioWorkletNode, finished,
        stop: async () => { calls.stopRequests++
          if (options.failStopOnce && calls.stopRequests === 1) throw new Error('Injected graph stop failure')
          const progress = await input.writer.stop(); return {
          reason: 'stopped' as const, startFrame: input.startFrame, endFrame: input.startFrame,
          samples: 0, batches: 0, peakInFlightBytes: 0, progress,
        } },
        abortForCleanup: () => { calls.aborted++; finishedReject?.(new Error('aborted')) },
        dispose: () => {}, snapshot: () => ({ nextFrame: 0, pendingBytes: 0,
          peakInFlightBytes: 0, batches: 0, reason: null, settled: false }),
      }
    },
    visibleAndFocused: () => options.visible !== false,
    preflight: () => options.unsupported ? 'Unsupported browser' : null,
    planStartFrame: () => 128,
    publish: vi.fn(),
    subscribePageEvents: options.lifecycle ? (onHidden) => {
      for (const name of ['hidden', 'freeze', 'pagehide']) options.lifecycle!.addEventListener(name, onHidden)
      return () => {
        for (const name of ['hidden', 'freeze', 'pagehide']) options.lifecycle!.removeEventListener(name, onHidden)
      }
    } : undefined,
  } satisfies VoiceoverCaptureDeps)
  return { owner, calls, live, start: () => owner.start('A1', 20),
    recording: async () => { owner.start('A1', 20); await owner.whenIdle(); started?.(); expect(owner.status.session?.phase).toBe('recording') },
    getStarted: () => started, getOverrun: () => overrun }
}

describe('voiceover capture ownership', () => {
  test.each([['NotAllowedError', 'permission-denied'], ['AbortError', 'permission-dismissed'],
    ['NotFoundError', 'device-unavailable']] as const)('reports %s and never opens a writer', async (name, reason) => {
    const denied = deferred<MediaStream>()
    const h = harness({ permission: denied.promise })
    expect(h.start().status).toBe('started')
    expect(h.calls.requested).toBe(1)
    denied.reject(new DOMException('No microphone', name))
    await h.owner.whenIdle()
    expect(h.owner.status.session).toMatchObject({ phase: 'failed', failure: reason })
    expect(h.calls.created).toBe(0)
  })

  test('rejects hidden, invalid destination and unsupported capability before permission', async () => {
    const hidden = harness({ visible: false })
    expect(hidden.start().status).toBe('rejected')
    expect(hidden.calls.requested).toBe(0)
    const invalid = harness()
    expect(invalid.owner.start('missing', 20).status).toBe('rejected')
    expect(invalid.calls.requested).toBe(0)
    const unsupported = harness({ unsupported: true })
    expect(unsupported.start().status).toBe('rejected')
    await unsupported.owner.whenIdle()
    expect(unsupported.owner.status.session).toMatchObject({ phase: 'failed', failure: 'unsupported' })
    expect(unsupported.calls.requested).toBe(0)
  })

  test('stops a late permission stream after cancellation without creating a writer', async () => {
    const pending = deferred<MediaStream>()
    const h = harness({ permission: pending.promise })
    h.start()
    await h.owner.cancel()
    expect(h.owner.status.session?.phase).toBe('cancelled')
    const late = stream()
    pending.resolve(late.media)
    await h.owner.whenIdle()
    expect(late.track.stops).toBe(1)
    expect(h.calls.created).toBe(0)
  })

  test('manual stop closes the graph and tracks, then retains review draft until cancel', async () => {
    const captured = stream()
    const h = harness({ permission: Promise.resolve(captured.media) })
    await h.recording()
    await h.owner.stop()
    expect(captured.track.stops).toBe(1)
    expect(h.calls.stopped).toBe(1)
    expect(h.owner.status.session?.phase).toBe('review')
    await h.owner.cancel()
    expect(h.owner.status.session?.phase).toBe('cancelled')
    expect(h.calls.discarded).toBe(1)
  })

  test.each(['device', 'hidden'] as const)('%s interruption stops tracks and recovers the durable review draft', async (reason) => {
    const captured = stream()
    const h = harness({ permission: Promise.resolve(captured.media) })
    await h.recording()
    if (reason === 'device') captured.track.end()
    else h.owner.onHidden()
    await h.owner.whenIdle()
    expect(captured.track.readyState).toBe('ended')
    expect(h.owner.status.session).toMatchObject({ phase: 'review', interruption: reason === 'device' ? 'source-ended' : 'hidden' })
    expect(h.calls.aborted).toBe(1)
    expect(h.calls.released).toBe(1)
    expect(h.calls.recovered).toBe(1)
  })

  test.each(['hidden', 'freeze', 'pagehide'])('%s event interrupts capture and stops its track', async (event) => {
    const lifecycle = new EventTarget()
    const captured = stream()
    const h = harness({ permission: Promise.resolve(captured.media), lifecycle })
    await h.recording()
    lifecycle.dispatchEvent(new Event(event))
    await h.owner.whenIdle()
    expect(captured.track.stops).toBe(1)
    expect(h.owner.status.session).toMatchObject({ phase: 'review', interruption: 'hidden' })
  })

  test('cleanup failure blocks a new take and retry discards the same draft', async () => {
    const captured = stream()
    const h = harness({ permission: Promise.resolve(captured.media), failDiscardOnce: true })
    await h.recording()
    await h.owner.cancel()
    expect(captured.track.stops).toBe(1)
    expect(h.owner.status.session?.phase).toBe('cleanup-failed')
    expect(h.start().status).toBe('rejected')
    await h.owner.retryCleanup()
    expect(h.owner.status.session?.phase).toBe('cancelled')
    expect(h.calls.discarded).toBe(2)
  })

  test('failed graph stop retries through the durable checkpoint', async () => {
    const captured = stream()
    const h = harness({ permission: Promise.resolve(captured.media), failStopOnce: true })
    await h.recording()
    await h.owner.stop()
    expect(h.owner.status.session?.phase).toBe('cleanup-failed')
    expect(captured.track.stops).toBe(1)
    await h.owner.retryCleanup()
    expect(h.owner.status.session?.phase).toBe('review')
    expect(h.calls.stopRequests).toBe(1)
    expect(h.calls.released).toBe(1)
    expect(h.calls.recovered).toBe(1)
  })

  test('project replacement waits for pending setup, stops tracks immediately and ignores late start', async () => {
    const create = deferred<void>()
    const captured = stream()
    const h = harness({ permission: Promise.resolve(captured.media), create: create.promise })
    h.start()
    // Let permission settle and writer creation begin without resolving it.
    await Promise.resolve(); await Promise.resolve()
    const teardown = h.owner.teardownForProjectChange()
    expect(captured.track.stops).toBe(1)
    create.resolve()
    await teardown
    h.getStarted()?.()
    expect(h.owner.status.session).toMatchObject({ phase: 'failed', failure: 'project-replaced' })
    expect(h.calls.connected).toBe(0)
    expect(h.calls.released).toBe(1)
  })

  test('project replacement retires a review draft without deleting it', async () => {
    const h = harness()
    await h.recording()
    await h.owner.stop()
    await h.owner.teardownForProjectChange()
    expect(h.owner.status.session).toMatchObject({ phase: 'failed', failure: 'project-replaced' })
    expect(h.calls.released).toBe(0)
    expect(h.calls.discarded).toBe(0)
    expect(h.calls.closed).toBe(1)
  })

  test('late worklet callbacks cannot interrupt the next session', async () => {
    const h = harness()
    await h.recording()
    const staleOverrun = h.getOverrun()
    await h.owner.cancel()
    await h.recording()
    staleOverrun?.()
    expect(h.owner.status.session?.phase).toBe('recording')
    await h.owner.cancel()
  })

  test('destination revision advances through edit and undo even when the original object returns', () => {
    const initial = useDocumentStore.getState()
    const first = currentVoiceoverDestinationContext().editRevision
    useDocumentStore.setState({ doc: { ...initial.doc } })
    const edited = currentVoiceoverDestinationContext().editRevision
    useDocumentStore.setState({ doc: initial.doc })
    const undone = currentVoiceoverDestinationContext().editRevision
    expect(edited).toBeGreaterThan(first)
    expect(undone).toBeGreaterThan(edited)
  })
})
