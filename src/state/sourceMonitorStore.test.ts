import { beforeEach, describe, expect, test } from 'vitest'
import type { MediaAsset } from '../domain/schema'
import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'
import {
  createProjectFileSnapshot,
  serializeProjectFile,
} from '../domain/projectFile'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
} from '../domain/projectSettings'
import {
  getSourceMonitorResetRevision,
  INITIAL_SOURCE_MONITOR_STATE,
  useSourceMonitorStore,
} from './sourceMonitorStore'

const CANARY_FILE_NAME = '__source_monitor_session_canary__.mp4'

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
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
  }
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

const getState = () => useSourceMonitorStore.getState()

beforeEach(() => {
  getState().resetSourceMonitor()
})

describe('sourceMonitorStore', () => {
  test('starts empty and opens a connected ready source without undo history', () => {
    expect(getState()).toMatchObject(INITIAL_SOURCE_MONITOR_STATE)
    const result = getState().openSource({
      asset: asset(),
      compatibility: compatibility('ready'),
    })
    expect(result.status).toBe('ok')
    expect(getState().session?.source).toMatchObject({
      assetId: 'asset-source',
      durationFrames: 600,
      rate: { num: 60, den: 1 },
    })
    expect(getState().lastOpenRejection).toBeNull()
    expect(getState().playbackOwner).toBe('none')
  })

  test('rejected opens keep the live session and record the existing reason', () => {
    getState().openSource({
      asset: asset(),
      compatibility: compatibility('ready'),
    })
    const live = getState().session
    const offline = getState().openSource({ asset: null })
    expect(offline).toEqual({
      status: 'rejected',
      reason: 'offline',
      session: live,
    })
    expect(getState().session).toBe(live)
    expect(getState().lastOpenRejection).toBe('offline')

    getState().openSource({
      asset: asset(),
      compatibility: compatibility('unsupported'),
    })
    expect(getState().session).toBe(live)
    expect(getState().lastOpenRejection).toBe('incompatible')
  })

  test('mark and shuttle edits write one session object and skip same-reference no-ops', () => {
    getState().openSource({
      asset: asset(),
      compatibility: compatibility('ready'),
    })
    getState().setPlayhead(24)
    getState().setIn()
    getState().setPlayhead(48)
    getState().setOut()
    getState().stepShuttle('l')

    const afterEdit = getState().session
    expect(afterEdit).toMatchObject({
      playheadFrame: 48,
      inFrame: 24,
      outFrameExclusive: 49,
      shuttleStep: 1,
    })

    getState().stepFrame(-1)
    expect(getState().session).toMatchObject({
      playheadFrame: 47,
      shuttleStep: 0,
      inFrame: 24,
    })

    getState().jumpToStart()
    const parked = getState().session
    getState().stepFrame(-1)
    expect(getState().session).toBe(parked)
    expect(parked?.playheadFrame).toBe(0)
    expect(parked).not.toBe(afterEdit)
  })

  test('playback handoff is session-only and source play requires an open asset', () => {
    expect(getState().requestPlayback('source')).toEqual({
      owner: 'none',
      pausedOwner: null,
    })
    expect(getState().playbackOwner).toBe('none')

    getState().openSource({
      asset: asset(),
      compatibility: compatibility('ready'),
    })
    expect(getState().requestPlayback('source')).toEqual({
      owner: 'source',
      pausedOwner: null,
    })
    getState().closeSource()
    expect(getState().session).toBeNull()
    expect(getState().playbackOwner).toBe('none')

    getState().openSource({
      asset: asset(),
      compatibility: compatibility('ready'),
    })
    getState().requestPlayback('source')
    expect(getState().requestPlayback('program')).toEqual({
      owner: 'program',
      pausedOwner: 'source',
    })
    getState().closeSource()
    expect(getState().session).toBeNull()
    expect(getState().playbackOwner).toBe('program')
  })

  test('resetSourceMonitor clears the session and invalidates later ticks', () => {
    getState().openSource({
      asset: asset(),
      compatibility: compatibility('ready'),
    })
    getState().setPlayhead(90)
    getState().setIn()
    getState().stepShuttle('l')
    getState().requestPlayback('source')
    getState().openSource({ asset: null })
    const revision = getSourceMonitorResetRevision()

    getState().resetSourceMonitor()

    expect(getState()).toMatchObject(INITIAL_SOURCE_MONITOR_STATE)
    expect(getSourceMonitorResetRevision()).toBe(revision + 1)
  })

  test('an open source never enters a portable project snapshot', () => {
    const document = createTimelineDoc(
      'Portable edit',
      DEFAULT_PROJECT_SETTINGS,
      'doc-source-monitor',
    )
    const before = serializeProjectFile(createProjectFileSnapshot(document, []))

    getState().openSource({
      asset: asset({ fileName: CANARY_FILE_NAME }),
      compatibility: compatibility('ready'),
    })
    getState().setPlayhead(123)
    getState().setIn()
    getState().requestPlayback('source')

    const after = serializeProjectFile(createProjectFileSnapshot(document, []))
    expect(after).toBe(before)
    expect(after).not.toContain(CANARY_FILE_NAME)
    expect(getState().session?.source.fileName).toBe(CANARY_FILE_NAME)
  })
})
