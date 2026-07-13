import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_PROJECT_SETTINGS,
  createTimelineDoc,
} from '../domain/projectSettings'
import type { Clip, FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import { microsecondsToFrames } from '../domain/time'
import {
  INITIAL_MEDIA_IMPORT_STATE,
  useMediaImportStore,
} from '../state/mediaImportStore'
import {
  cancelMediaImport,
  dismissMediaImportError,
  importMedia,
  resetMediaImportController,
  resolveMediaImportDecision,
  type MediaImportDeps,
} from './mediaImportController'

const F24: FrameRate = { num: 24, den: 1 }
const F30: FrameRate = { num: 30, den: 1 }
const F60: FrameRate = { num: 60, den: 1 }

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-new',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 8,
    lastModified: 123,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 2_000_000,
    frameRate: F60,
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"avc1.64042a"}',
    ...overrides,
  }
}

function makeClip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'existing',
    name: 'Edited clip',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 0, durationFrames: 30 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Fixture {
  deps: MediaImportDeps
  assets: Map<string, MediaAsset>
  currentDocument(): TimelineDoc
  setDocument(document: TimelineDoc): void
  inspect: ReturnType<typeof vi.fn<MediaImportDeps['inspect']>>
  replaceDocument: ReturnType<typeof vi.fn<MediaImportDeps['replaceDocument']>>
  reconformAssets: ReturnType<typeof vi.fn<MediaImportDeps['reconformAssets']>>
  revokeObjectURL: ReturnType<typeof vi.fn<MediaImportDeps['revokeObjectURL']>>
}

function makeFixture(
  analyzed: MediaAsset = makeAsset(),
  startingDocument = createTimelineDoc(
    'Import test',
    DEFAULT_PROJECT_SETTINGS,
    'doc-import',
  ),
): Fixture {
  let document = startingDocument
  const assets = new Map<string, MediaAsset>()
  const inspect = vi.fn(async () => analyzed)
  const replaceDocument = vi.fn((next: TimelineDoc) => {
    document = next
  })
  const reconformAssets = vi.fn((rate: FrameRate) => {
    for (const [id, asset] of assets) {
      assets.set(id, {
        ...asset,
        durationFrames: microsecondsToFrames(asset.durationMicroseconds, rate),
      })
    }
  })
  const revokeObjectURL = vi.fn()
  const deps: MediaImportDeps = {
    inspect,
    getDocument: () => document,
    replaceDocument,
    hasAsset: (id) => assets.has(id),
    addAsset: (asset) => {
      if (assets.has(asset.id)) return false
      assets.set(asset.id, asset)
      return true
    },
    reconformAssets,
    revokeObjectURL,
  }
  return {
    deps,
    assets,
    currentDocument: () => document,
    setDocument: (next) => {
      document = next
    },
    inspect,
    replaceDocument,
    reconformAssets,
    revokeObjectURL,
  }
}

const file = () => new File(['source'], 'source.mp4', { type: 'video/mp4' })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  resetMediaImportController()
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
})

describe('mediaImportController', () => {
  test('matching FPS analyzes once and commits a complete asset immediately', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30, durationFrames: 999 }))

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })

    expect(fixture.inspect).toHaveBeenCalledOnce()
    expect(fixture.inspect).toHaveBeenCalledWith(expect.any(File), F30)
    expect(fixture.assets.get('asset-new')).toMatchObject({
      durationFrames: 60,
      frameRate: F30,
    })
    expect(fixture.replaceDocument).not.toHaveBeenCalled()
    expect(fixture.revokeObjectURL).not.toHaveBeenCalled()
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('Keep preserves project FPS and conforms duration from microseconds', async () => {
    const fixture = makeFixture()
    const result = importMedia(file(), fixture.deps)
    await flush()

    expect(fixture.assets).toHaveLength(0)
    expect(useMediaImportStore.getState()).toMatchObject({
      phase: 'awaiting-decision',
      prompt: {
        fileName: 'source.mp4',
        projectRate: F30,
        sourceRate: F60,
        canMatchSource: true,
      },
    })
    expect(resolveMediaImportDecision('keep-project-rate')).toBe(true)

    await expect(result).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })
    expect(fixture.currentDocument().frameRate).toEqual(F30)
    expect(fixture.assets.get('asset-new')?.durationFrames).toBe(60)
    expect(fixture.reconformAssets).not.toHaveBeenCalled()
  })

  test('Match changes an empty project and re-conforms all unused media', async () => {
    const fixture = makeFixture()
    fixture.assets.set('existing', makeAsset({
      id: 'existing',
      objectUrl: 'blob:existing',
      durationFrames: 60,
    }))
    const result = importMedia(file(), fixture.deps)
    await flush()

    expect(resolveMediaImportDecision('match-source-rate')).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'imported' })

    expect(fixture.currentDocument().frameRate).toEqual(F60)
    expect(fixture.replaceDocument).toHaveBeenCalledOnce()
    expect(fixture.reconformAssets).toHaveBeenCalledWith(F60)
    expect(fixture.assets.get('existing')?.durationFrames).toBe(120)
    expect(fixture.assets.get('asset-new')?.durationFrames).toBe(120)
  })

  test('Cancel leaves project and media unchanged and revokes the analyzed URL', async () => {
    const fixture = makeFixture()
    const startingDocument = fixture.currentDocument()
    const result = importMedia(file(), fixture.deps)
    await flush()

    expect(cancelMediaImport()).toBe(true)
    await expect(result).resolves.toEqual({ status: 'cancelled' })

    expect(fixture.currentDocument()).toBe(startingDocument)
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce()
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('Match remains visible but disabled after timeline editing begins', async () => {
    const empty = createTimelineDoc(
      'Edited import',
      DEFAULT_PROJECT_SETTINGS,
      'doc-edited',
    )
    const edited: TimelineDoc = {
      ...empty,
      tracks: [
        { ...empty.tracks[0], clips: [makeClip()] },
        empty.tracks[1],
      ],
    }
    const fixture = makeFixture(makeAsset(), edited)
    const result = importMedia(file(), fixture.deps)
    await flush()

    expect(useMediaImportStore.getState().prompt).toMatchObject({
      canMatchSource: false,
      matchUnavailableReason: expect.stringContaining('clips have been added'),
    })
    expect(resolveMediaImportDecision('match-source-rate')).toBe(false)
    expect(cancelMediaImport()).toBe(true)
    await expect(result).resolves.toEqual({ status: 'cancelled' })
  })

  test('Match is disabled for a source rate outside project presets', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: { num: 120, den: 1 } }))
    const result = importMedia(file(), fixture.deps)
    await flush()

    expect(useMediaImportStore.getState().prompt).toMatchObject({
      canMatchSource: false,
      matchUnavailableReason: expect.stringContaining('supported project presets'),
    })
    expect(resolveMediaImportDecision('match-source-rate')).toBe(false)
    expect(resolveMediaImportDecision('keep-project-rate')).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'imported' })
    expect(fixture.currentDocument().frameRate).toEqual(F30)
  })

  test('Cancel during analysis waits for cleanup and never commits late work', async () => {
    const pending = deferred<MediaAsset>()
    const fixture = makeFixture()
    fixture.deps.inspect = vi.fn(() => pending.promise)
    const result = importMedia(file(), fixture.deps)
    await flush()

    expect(cancelMediaImport()).toBe(true)
    expect(useMediaImportStore.getState().phase).toBe('cancelling')
    pending.resolve(makeAsset())
    await expect(result).resolves.toEqual({ status: 'cancelled' })

    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('a second selection reports busy while one import owns the flow', async () => {
    const pending = deferred<MediaAsset>()
    const fixture = makeFixture()
    fixture.deps.inspect = vi.fn(() => pending.promise)
    const first = importMedia(file(), fixture.deps)

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'busy',
    })
    cancelMediaImport()
    pending.resolve(makeAsset())
    await expect(first).resolves.toEqual({ status: 'cancelled' })
  })

  test('inspection failure is explicit and dismissible', async () => {
    const fixture = makeFixture()
    fixture.deps.inspect = vi.fn(async () => {
      throw new Error('unsupported container')
    })

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'failed',
      message: 'Could not import "source.mp4": unsupported container',
    })
    expect(useMediaImportStore.getState()).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('unsupported container'),
    })
    expect(fixture.assets).toHaveLength(0)

    dismissMediaImportError()
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('project replacement during analysis rejects the stale import', async () => {
    const pending = deferred<MediaAsset>()
    const fixture = makeFixture()
    fixture.deps.inspect = vi.fn(() => pending.promise)
    const result = importMedia(file(), fixture.deps)
    fixture.setDocument({ ...fixture.currentDocument(), id: 'another-doc' })
    pending.resolve(makeAsset())

    await expect(result).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('active project changed'),
    })
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
  })

  test('settings change while the prompt is open rejects the stale choice', async () => {
    const fixture = makeFixture()
    const result = importMedia(file(), fixture.deps)
    await flush()
    fixture.setDocument({ ...fixture.currentDocument(), frameRate: F24 })

    expect(resolveMediaImportDecision('keep-project-rate')).toBe(true)
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('project settings changed'),
    })
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
  })

  test('duplicate asset ids fail without transferring URL ownership', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30 }))
    fixture.assets.set('asset-new', makeAsset({
      frameRate: F30,
      objectUrl: 'blob:existing',
    }))

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('already in use'),
    })
    expect(fixture.assets.get('asset-new')?.objectUrl).toBe('blob:existing')
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
  })
})
