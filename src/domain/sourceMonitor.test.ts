import { describe, expect, test } from 'vitest'
import type { MediaAsset } from './schema'
import type { MediaCompatibilityItem } from './mediaCompatibility'
import {
  advanceSourcePlayhead,
  clearSourceIn,
  clearSourceMarks,
  closeSourceMonitor,
  jumpSourceToEnd,
  jumpSourceToIn,
  jumpSourceToOut,
  jumpSourceToStart,
  openSourceMonitor,
  parkSourcePlayback,
  requestMonitorPlayback,
  resetSourceSession,
  scrubSourcePlayhead,
  setSourceIn,
  setSourceOut,
  setSourcePlayhead,
  sourceMonitorAudioAudition,
  sourceMonitorClockRate,
  sourceMonitorDecodeFrame,
  sourceMonitorLastFrame,
  sourceMonitorPreparedRange,
  sourceMonitorSelectionRange,
  SOURCE_MONITOR_FALLBACK_RATE,
  stepSourceFrame,
  stepSourceShuttle,
  stopSourcePlayback,
  type SourceMonitorSession,
} from './sourceMonitor'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return deepFreeze({
    id: 'asset-source',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 300,
    durationMicroseconds: 10_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
    },
    frameRate: { num: 60, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...over,
  })
}

function compatibility(
  status: MediaCompatibilityItem['status'] = 'ready',
): MediaCompatibilityItem {
  return {
    id: 'asset-source',
    requestId: 'req-1',
    fileName: 'clip.mp4',
    declaredMimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    status,
    report: null,
  }
}

function opened(over: Partial<MediaAsset> = {}): SourceMonitorSession {
  const result = openSourceMonitor(null, {
    asset: asset(over),
    compatibility: compatibility('ready'),
  })
  if (result.status !== 'ok') throw new Error(`open failed: ${result.reason}`)
  return result.session
}

describe('openSourceMonitor', () => {
  test('opens a 10s 60fps source on its native 600-frame clock', () => {
    const session = opened()
    expect(session.source).toMatchObject({
      assetId: 'asset-source',
      kind: 'video',
      rate: { num: 60, den: 1 },
      durationFrames: 600,
      hasAudio: true,
    })
    expect(session.playheadFrame).toBe(0)
    expect(session.inFrame).toBeNull()
    expect(session.outFrameExclusive).toBeNull()
    expect(session.shuttleStep).toBe(0)
    expect(sourceMonitorLastFrame(session)).toBe(599)
  })

  test('keeps NTSC duration exact instead of accumulating seconds', () => {
    const session = opened({
      durationFrames: 30,
      durationMicroseconds: 1_001_000,
      frameRate: { num: 30000, den: 1001 },
    })
    expect(session.source.durationFrames).toBe(30)
    expect(session.source.rate).toEqual({ num: 30000, den: 1001 })
  })

  test('uses the 30/1 fallback grid for audio-only and stills', () => {
    const audio = opened({
      kind: 'audio',
      fileName: 'bed.wav',
      mimeType: 'audio/wav',
      durationFrames: 150,
      frameRate: null,
      width: null,
      height: null,
      hasAudio: true,
    })
    expect(sourceMonitorClockRate(asset({ kind: 'audio', frameRate: null })))
      .toEqual(SOURCE_MONITOR_FALLBACK_RATE)
    expect(audio.source.rate).toEqual(SOURCE_MONITOR_FALLBACK_RATE)
    expect(audio.source.durationFrames).toBe(300)

    const still = opened({
      kind: 'image',
      fileName: 'still.png',
      mimeType: 'image/png',
      durationFrames: 150,
      durationMicroseconds: 5_000_000,
      frameRate: null,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
      sourceBounds: { video: null, audio: null },
    })
    expect(still.source.durationFrames).toBe(150)
    expect(sourceMonitorDecodeFrame(still)).toBe(0)
  })

  test('rejects offline, incompatible, and empty sources without replacing a live session', () => {
    const live = opened()
    expect(openSourceMonitor(live, { asset: null })).toEqual({
      status: 'rejected',
      reason: 'offline',
      session: live,
    })
    expect(openSourceMonitor(live, {
      asset: asset(),
      compatibility: compatibility('unsupported'),
    })).toEqual({
      status: 'rejected',
      reason: 'incompatible',
      session: live,
    })
    expect(openSourceMonitor(live, {
      asset: asset({ durationMicroseconds: 0 }),
      compatibility: compatibility('ready'),
    })).toEqual({
      status: 'rejected',
      reason: 'invalid-duration',
      session: live,
    })
  })

  test('reopening the same asset keeps marks; a different asset starts fresh', () => {
    const marked = setSourceOut(setSourceIn(setSourcePlayhead(opened(), 24)))
    const same = openSourceMonitor(marked, {
      asset: asset(),
      compatibility: compatibility('ready'),
    })
    expect(same.status).toBe('ok')
    if (same.status !== 'ok') return
    expect(same.session).toBe(marked)

    const other = openSourceMonitor(marked, {
      asset: asset({ id: 'asset-b', fileName: 'other.mp4' }),
      compatibility: { ...compatibility('ready'), id: 'asset-b' },
    })
    expect(other.status).toBe('ok')
    if (other.status !== 'ok') return
    expect(other.session).not.toBe(marked)
    expect(other.session.source.assetId).toBe('asset-b')
    expect(other.session.inFrame).toBeNull()
    expect(other.session.playheadFrame).toBe(0)
  })

  test('reconnect remaps playhead and marks onto the new source clock', () => {
    const marked = setSourceOut(setSourceIn(setSourcePlayhead(opened(), 120)))
    const remapped = openSourceMonitor(marked, {
      asset: asset({
        durationMicroseconds: 5_000_000,
        frameRate: { num: 30, den: 1 },
        durationFrames: 150,
      }),
      compatibility: compatibility('ready'),
    })
    expect(remapped.status).toBe('ok')
    if (remapped.status !== 'ok') return
    expect(remapped.session.source.durationFrames).toBe(150)
    expect(remapped.session.playheadFrame).toBe(60)
    expect(remapped.session.inFrame).toBe(60)
    expect(remapped.session.outFrameExclusive).toBe(61)
    expect(remapped.session.shuttleStep).toBe(0)
  })
})

describe('source marks and playhead', () => {
  test('scrubbing pauses shuttle but keeps In/Out', () => {
    const playing = stepSourceShuttle(setSourceIn(opened()), 'l')
    const scrubbed = scrubSourcePlayhead(playing, 40)
    expect(scrubbed.shuttleStep).toBe(0)
    expect(scrubbed.inFrame).toBe(0)
    expect(scrubbed.playheadFrame).toBe(40)
    expect(setSourcePlayhead(playing, 40).shuttleStep).toBe(1)
  })

  test('In/Out are half-open, ordered, and bounded to the source', () => {
    const inMark = setSourceIn(setSourcePlayhead(opened(), 10))
    const range = setSourceOut(setSourcePlayhead(inMark, 25))
    expect(range.inFrame).toBe(10)
    expect(range.outFrameExclusive).toBe(26)
    expect(sourceMonitorSelectionRange(range)).toEqual({
      startFrame: 10,
      durationFrames: 16,
    })
    expect(sourceMonitorPreparedRange(opened())).toEqual({
      startFrame: 0,
      durationFrames: 600,
    })

    const invertedOut = setSourceOut(setSourcePlayhead(range, 4))
    expect(invertedOut.inFrame).toBeNull()
    expect(invertedOut.outFrameExclusive).toBe(5)

    const invertedIn = setSourceIn(setSourcePlayhead(range, 40))
    expect(invertedIn.inFrame).toBe(40)
    expect(invertedIn.outFrameExclusive).toBeNull()
  })

  test('jump and reset commands pause and stay on the source session', () => {
    const marked = setSourceOut(setSourceIn(setSourcePlayhead(
      stepSourceShuttle(opened(), 'l'),
      20,
    )))
    expect(jumpSourceToIn(marked).playheadFrame).toBe(20)
    expect(jumpSourceToOut(marked).playheadFrame).toBe(20)
    expect(jumpSourceToStart(marked).playheadFrame).toBe(0)
    expect(jumpSourceToEnd(marked).playheadFrame).toBe(599)
    expect(jumpSourceToEnd(marked).shuttleStep).toBe(0)

    const reset = resetSourceSession(marked)
    expect(reset).toMatchObject({
      playheadFrame: 0,
      inFrame: null,
      outFrameExclusive: null,
      shuttleStep: 0,
    })
    expect(clearSourceMarks(marked).inFrame).toBeNull()
    const clearedIn = clearSourceIn(marked)
    expect(clearSourceIn(clearedIn)).toBe(clearedIn)
    expect(closeSourceMonitor(marked)).toBeNull()
  })

  test('frame steps clamp and still decode frame 0 for stills', () => {
    const video = opened()
    expect(stepSourceFrame(video, -1)).toBe(video)
    expect(stepSourceFrame(video, 1).playheadFrame).toBe(1)
    const end = jumpSourceToEnd(video)
    expect(stepSourceFrame(end, 1)).toBe(end)

    const still = setSourcePlayhead(opened({
      kind: 'image',
      durationMicroseconds: 5_000_000,
      durationFrames: 150,
      frameRate: null,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    }), 40)
    expect(still.playheadFrame).toBe(40)
    expect(sourceMonitorDecodeFrame(still)).toBe(0)
  })
})

describe('JKL shuttle', () => {
  test('walks the signed 1-2-4-8 ladder and parks at the source ends', () => {
    let session = opened()
    session = stepSourceShuttle(session, 'l')
    expect(session.shuttleStep).toBe(1)
    expect(sourceMonitorAudioAudition(session)).toBe(true)
    session = stepSourceShuttle(session, 'l')
    expect(session.shuttleStep).toBe(2)
    expect(sourceMonitorAudioAudition(session)).toBe(false)
    session = stepSourceShuttle(session, 'l')
    session = stepSourceShuttle(session, 'l')
    expect(session.shuttleStep).toBe(8)
    expect(stepSourceShuttle(session, 'l')).toBe(session)

    session = stepSourceShuttle(session, 'j')
    expect(session.shuttleStep).toBe(-1)
    session = stepSourceShuttle(session, 'j')
    expect(session.shuttleStep).toBe(-2)
    session = stepSourceShuttle(session, 'k')
    expect(session.shuttleStep).toBe(0)
    expect(stepSourceShuttle(session, 'k')).toBe(session)
  })

  test('clock ticks stop shuttle when they hit either exclusive end', () => {
    const forward = advanceSourcePlayhead(
      setSourcePlayhead(stepSourceShuttle(opened(), 'l'), 598),
      4,
    )
    expect(forward.playheadFrame).toBe(599)
    expect(forward.shuttleStep).toBe(0)

    const reverse = advanceSourcePlayhead(
      setSourcePlayhead(stepSourceShuttle(opened(), 'j'), 2),
      -4,
    )
    expect(reverse.playheadFrame).toBe(0)
    expect(reverse.shuttleStep).toBe(0)
    expect(parkSourcePlayback(opened()).playheadFrame).toBe(599)
    const idle = opened()
    expect(stopSourcePlayback(idle)).toBe(idle)
  })
})

describe('monitor playback handoff', () => {
  test('starting one monitor pauses the other and never double-owns the clock', () => {
    expect(requestMonitorPlayback('none', 'source')).toEqual({
      owner: 'source',
      pausedOwner: null,
    })
    expect(requestMonitorPlayback('program', 'source')).toEqual({
      owner: 'source',
      pausedOwner: 'program',
    })
    expect(requestMonitorPlayback('source', 'program')).toEqual({
      owner: 'program',
      pausedOwner: 'source',
    })
    expect(requestMonitorPlayback('source', 'source')).toEqual({
      owner: 'source',
      pausedOwner: null,
    })
  })
})
