import { describe, expect, test, vi } from 'vitest'
import { AvCaptureOwner, avPermissionFailure, type AvCaptureDeps } from './avCaptureOwner'
import type { AvRecorderResult } from '../pipeline/avCaptureRecorder'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live'
  stops = 0
  readonly kind: string
  readonly label: string
  constructor(kind: string, label: string) { super(); this.kind = kind; this.label = label }
  stop() { this.stops++; this.readyState = 'ended' }
  clone() { return new FakeTrack(this.kind, this.label) }
  getSettings() { return this.kind === 'video' ? { width: 1280, height: 720 } : { channelCount: 1, sampleRate: 48_000 } }
}

function stream(...tracks: FakeTrack[]) {
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio') } as unknown as MediaStream
}

const RESULT: AvRecorderResult = { bytes: 1000, durationUs: 2_000_000, videoFrames: 60, droppedVideoFrames: 0,
  audioSamples: 96_000, audioSampleRate: 48_000, driftUs: 0, maxAbsDriftUs: 100, gapEvents: 0,
  uncorrectedDriftEvents: 0, width: 1280, height: 720, reason: 'stopped', clockNote: null }

function harness(options: {
  media?: Promise<MediaStream>
  calibrate?: Promise<{ offsetUs: number; method: 'capture-time'; pairs: number; spreadUs: number }>
  stopFails?: boolean
  discardFailures?: number
  audioInDisplay?: boolean
  project?: { projectId: string; projectGeneration: number }
  conflict?: string | null
  unrecoverable?: boolean
  importGate?: Promise<void>
} = {}) {
  const video = new FakeTrack('video', 'Camera')
  const audio = new FakeTrack('audio', 'Mic')
  const calls: string[] = []
  const bridges: Array<{ onProgress: ((p: unknown) => void) | null; onSelfStop: ((reason: 'source-ended' | 'limit') => void) | null
    onCrash: (() => void) | null; isClosed: boolean }> = []
  let project = options.project ?? { projectId: 'p', projectGeneration: 1 }
  const lock = { held: 0, released: 0 }
  let discardFailures = options.discardFailures ?? 0
  const deps: AvCaptureDeps = {
    projectContext: () => project,
    requestCamera: (camera, microphone) => { calls.push(`camera:${camera}:${microphone}`); return options.media ?? Promise.resolve(stream(video, audio)) },
    requestDisplay: (withAudio) => {
      calls.push(`display:${withAudio}`)
      return options.media ?? Promise.resolve(options.audioInDisplay ? stream(video, audio) : stream(video))
    },
    requestMicrophone: (id) => { calls.push(`mic:${id}`); return Promise.resolve(stream(new FakeTrack('audio', 'USB mic'))) },
    calibrate: () => options.calibrate ?? Promise.resolve({ offsetUs: 42, method: 'capture-time', pairs: 9, spreadUs: 100 }),
    createProcessor: () => new ReadableStream(),
    createBridge: () => {
      const bridge = {
        onProgress: null as ((p: unknown) => void) | null,
        onSelfStop: null as ((reason: 'source-ended' | 'limit') => void) | null,
        onCrash: null as (() => void) | null,
        isClosed: false,
        start: vi.fn(async (request: { videoClockOffsetUs: number; audio: unknown }) => {
          calls.push(`start:${request.videoClockOffsetUs}:${request.audio ? 'audio' : 'silent'}`)
          return { type: 'start' as const, encoding: { video: { codec: 'avc' as const, bitrate: 1 }, audio: null }, width: 1280, height: 720 }
        }),
        stop: vi.fn(async () => {
          calls.push('stop')
          if (options.stopFails) throw new Error('Finalize failed')
          return { type: 'stop' as const, result: RESULT }
        }),
        abort: vi.fn(async () => { calls.push('abort'); return { type: 'abort' as const } }),
        file: vi.fn(async () => { calls.push('file'); return { type: 'file' as const, file: new File(['x'], 'c.mp4'), handle: {} as FileSystemFileHandle } }),
        discardId: vi.fn(async () => { calls.push('discard'); if (discardFailures-- > 0) throw new Error('remove failed') }),
        recover: vi.fn(async () => {
          calls.push('recover')
          if (options.unrecoverable) {
            const error = new Error('No complete media fragment was written')
            error.name = 'UnrecoverableCapture'
            throw error
          }
          return { pcmBytes: 2_097_152, committedBytes: 2_097_152, discardedTailBytes: 10 }
        }),
        close: vi.fn(() => { bridge.isClosed = true }),
      }
      bridges.push(bridge)
      return bridge as unknown as ReturnType<AvCaptureDeps['createBridge']>
    },
    visibleAndFocused: () => true,
    preflight: () => null,
    startConflict: () => options.conflict ?? null,
    holdDraftLock: async () => { lock.held++; return () => { lock.released++ } },
    importCapture: vi.fn(async () => { await options.importGate; return { status: 'imported' as const, assetId: 'asset-1' } }),
    projectBinding: () => `binding:${project.projectId}`,
    rememberOriginal: vi.fn(async () => {}),
    publish: vi.fn(),
  }
  const owner = new AvCaptureOwner(deps)
  return { owner, deps, calls, video, audio, bridges, lock,
    setProject(next: typeof project) { project = next },
    async recording(mode: 'camera' | 'screen' = 'camera', extra = {}) {
      expect(owner.start({ mode, ...extra }).status).toBe('started')
      await owner.whenIdle()
      expect(owner.status.session?.phase).toBe('recording')
    } }
}

describe('camera/screen capture owner', () => {
  test('camera take: permission in the click, measured clock offset, stop, keep into the Media Pool', async () => {
    const h = harness()
    await h.recording('camera', { cameraId: 'cam', cameraMicrophoneId: 'usb' })
    expect(h.calls.slice(0, 2)).toEqual(['camera:cam:usb', 'start:42:audio'])
    expect(h.owner.status.clockMethod).toBe('capture-time')
    await h.owner.stop()
    expect(h.owner.status.session?.phase).toBe('review')
    expect(h.video.stops + h.audio.stops).toBeGreaterThanOrEqual(2)
    expect(h.owner.status.progress?.durationUs).toBe(2_000_000)
    await h.owner.keepTake()
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', assetId: 'asset-1' })
    expect(h.deps.rememberOriginal).toHaveBeenCalledOnce()
    expect(h.lock).toEqual({ held: 1, released: 1 })
  })

  test('permission failures are distinct; a missing macOS screen permission is named', async () => {
    expect(avPermissionFailure(new DOMException('x', 'NotAllowedError'), 'camera')).toBe('permission-denied')
    expect(avPermissionFailure(new DOMException('Permission dismissed', 'NotAllowedError'), 'screen')).toBe('permission-dismissed')
    expect(avPermissionFailure(new DOMException('Could not start video source', 'NotReadableError'), 'screen')).toBe('screen-permission')
    expect(avPermissionFailure(new DOMException('busy', 'NotReadableError'), 'camera')).toBe('device-unavailable')
    const denied = harness({ media: Promise.reject(new DOMException('no', 'NotAllowedError')) })
    denied.owner.start({ mode: 'camera' })
    await denied.owner.whenIdle()
    expect(denied.owner.status.session).toMatchObject({ phase: 'failed', failure: 'permission-denied' })
    expect(denied.bridges).toHaveLength(0)
  })

  test('cancel during clock calibration never starts a worker and stops every track', async () => {
    const calibration = deferred<{ offsetUs: number; method: 'capture-time'; pairs: number; spreadUs: number }>()
    const h = harness({ calibrate: calibration.promise })
    h.owner.start({ mode: 'camera' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const cancelled = h.owner.cancel()
    calibration.resolve({ offsetUs: 1, method: 'capture-time', pairs: 5, spreadUs: 0 })
    await cancelled
    await h.owner.whenIdle()
    expect(h.owner.status.session?.phase).toBe('cancelled')
    expect(h.calls.some((call) => call.startsWith('start:'))).toBe(false)
    expect(h.video.readyState).toBe('ended')
  })

  test('the source ending (Stop sharing) finalizes the take for review', async () => {
    const h = harness()
    await h.recording('screen')
    h.bridges[0]!.onSelfStop?.('source-ended')
    await h.owner.whenIdle()
    expect(h.owner.status.session).toMatchObject({ phase: 'review', interruption: 'source-ended' })
    expect(h.calls).toContain('stop')
  })

  test('a failed finalize keeps the completely written fragments for review', async () => {
    const h = harness({ stopFails: true })
    await h.recording()
    await h.owner.stop()
    expect(h.owner.status.session?.phase).toBe('review')
    expect(h.calls).toContain('recover')
    expect(h.owner.status.diagnostic).toMatch(/kept the 2\.0 MiB/)
  })

  test('discard deletes the draft; a failed delete blocks until retried', async () => {
    const h = harness({ discardFailures: 1 })
    await h.recording()
    await h.owner.stop()
    await h.owner.cancel()
    expect(h.owner.status.session?.phase).toBe('cleanup-failed')
    expect(h.owner.start({ mode: 'camera' }).status).toBe('rejected')
    await h.owner.retryCleanup()
    expect(h.owner.status.session?.phase).toBe('cancelled')
    expect(h.calls.filter((call) => call === 'discard')).toHaveLength(2)
  })

  test('a take is never imported into a different project', async () => {
    const h = harness()
    await h.recording()
    await h.owner.stop()
    h.setProject({ projectId: 'other', projectGeneration: 2 })
    await h.owner.keepTake()
    expect(h.owner.status.session?.phase).toBe('review')
    expect(h.owner.status.diagnostic).toMatch(/project changed/)
    expect(h.deps.importCapture).not.toHaveBeenCalled()
  })

  test('project replacement releases (keeps) the draft for later recovery', async () => {
    const h = harness()
    await h.recording()
    await h.owner.teardownForProjectChange()
    expect(h.owner.status.session).toMatchObject({ phase: 'failed', failure: 'project-replaced' })
    expect(h.calls).toContain('abort')
    expect(h.calls).not.toContain('discard')
  })

  test('screen with microphone: display audio is dropped, the chosen microphone is recorded', async () => {
    const h = harness({ audioInDisplay: true })
    await h.recording('screen', { screenAudio: 'microphone', screenMicrophoneId: 'usb' })
    expect(h.calls.slice(0, 3)).toEqual(['display:false', 'mic:usb', 'start:42:audio'])
    expect(h.audio.stops).toBe(1)
    expect(h.owner.status.audioLabel).toBe('USB mic')
  })

  test('requested display audio that the browser withheld is explained, not hidden', async () => {
    const h = harness()
    await h.recording('screen', { screenAudio: 'display' })
    expect(h.calls[0]).toBe('display:true')
    expect(h.calls).toContain('start:42:silent')
    expect(h.owner.status.audioNote).toMatch(/did not share audio/)
  })

  test('only one capture at a time', () => {
    const h = harness({ conflict: 'Finish the voiceover take first.' })
    expect(h.owner.start({ mode: 'camera' })).toEqual({ status: 'rejected', reason: 'Finish the voiceover take first.' })
    expect(h.calls).toEqual([])
  })

  test('a worker crash mid-take interrupts it and Stop keeps the complete fragments', async () => {
    const h = harness()
    await h.recording()
    h.bridges[0]!.isClosed = true
    h.bridges[0]!.onCrash?.()
    await h.owner.whenIdle()
    expect(h.owner.status.session).toMatchObject({ phase: 'review', interruption: 'worker-lost' })
    expect(h.calls).toContain('recover')
    expect(h.calls).not.toContain('stop')
  })

  test('a take with nothing playable ends as a failure and removes its empty file', async () => {
    const h = harness({ stopFails: true, unrecoverable: true })
    await h.recording()
    await h.owner.stop()
    await h.owner.whenIdle()
    expect(h.owner.status.session).toMatchObject({ phase: 'failed', failure: 'writer-failed' })
    expect(h.owner.status.diagnostic).toMatch(/Nothing playable/)
    expect(h.calls).toContain('discard')
  })

  test('project exit waits for a committed Keep and remembers the original under the pinned project', async () => {
    const gate = deferred<void>()
    const h = harness({ importGate: gate.promise })
    await h.recording()
    await h.owner.stop()
    const keeping = h.owner.keepTake()
    await vi.waitFor(() => expect(h.deps.importCapture).toHaveBeenCalledOnce())
    const teardown = h.owner.teardownForProjectChange()
    h.setProject({ projectId: 'next', projectGeneration: 2 })
    gate.resolve()
    await keeping
    await teardown
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', assetId: 'asset-1' })
    expect(h.deps.rememberOriginal).toHaveBeenCalledWith('asset-1', expect.anything(), 'binding:p')
  })
})
