import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceoverDraftInfo } from '../domain/voiceoverDrafts'
import type { VoiceoverSession } from '../domain/voiceoverSession'
import type { MediaImportResult } from './mediaImportController'
import type { LocalMediaFileHandle } from './localMediaHandles'
import {
  VoiceoverDraftRecovery,
  type RecoveryWriter,
  type VoiceoverDraftRecoveryDeps,
} from './voiceoverDraftRecovery'

const BINDING = 'local-project:test'

/** The recordings directory as seen by the dedicated worker. */
interface FakeDirectory {
  entries: Map<string, VoiceoverDraftInfo>
}

/** The browser-local handle registry, keyed by binding + asset. */
class FakeRegistry {
  handles = new Map<string, LocalMediaFileHandle>()
  tombstones = new Set<string>()
  failLoadFor: string | null = null
  forgetCalls: string[] = []

  private key(binding: string, assetId: string): string {
    return `${binding}:${assetId}`
  }

  load(binding: string, assetId: string): Promise<LocalMediaFileHandle | null> {
    const key = this.key(binding, assetId)
    if (this.failLoadFor === assetId) return Promise.reject(new Error('IndexedDB unavailable'))
    if (this.tombstones.has(key)) return Promise.resolve(null)
    return Promise.resolve(this.handles.get(key) ?? null)
  }

  remember(binding: string, assetId: string, handle: LocalMediaFileHandle): Promise<void> {
    const key = this.key(binding, assetId)
    this.tombstones.delete(key)
    this.handles.set(key, handle)
    return Promise.resolve()
  }

  forget(binding: string, assetId: string): Promise<void> {
    const key = this.key(binding, assetId)
    this.forgetCalls.push(`${binding}:${assetId}`)
    this.handles.delete(key)
    this.tombstones.add(key)
    return Promise.resolve()
  }

  list() {
    if (this.failLoadFor !== null) return Promise.reject(new Error('IndexedDB unavailable'))
    return Promise.resolve([...this.handles].flatMap(([key, rememberedHandle]) => {
      const separator = key.lastIndexOf(':')
      if (separator < 0) return []
      return [{
        projectBindingId: key.slice(0, separator),
        assetId: key.slice(separator + 1),
        handle: rememberedHandle,
      }]
    }))
  }
}

function handle(name: string): LocalMediaFileHandle {
  return { kind: 'file', name, getFile: async () => new File([], name) } as unknown as LocalMediaFileHandle
}

/** One dedicated worker bridge as the recovery feature sees it. */
function createFakeWriter(
  directory: FakeDirectory,
  options: {
    failRecoverFor?: string | null
    failDiscardFor?: string | null
  } = {},
): RecoveryWriter & { calls: string[] } {
  const writer = {
    calls: [] as string[],
    closed: false,
    recoveredId: null as string | null,
    get isClosed() { return this.closed },
    async list() {
      this.calls.push('list')
      return [...directory.entries.values()].map((entry) => ({ ...entry }))
    },
    async recover(id: string) {
      this.calls.push(`recover:${id}`)
      if (options.failRecoverFor === id) throw new Error('No valid checkpoint')
      this.recoveredId = id
      return { pcmBytes: 96, committedBytes: 96, discardedTailBytes: 0 }
    },
    async finalize() {
      this.calls.push('finalize')
      const name = `${this.recoveredId ?? 'take'}.wav`
      // The real worker returns the draft's own file handle, whose name is the
      // draft id; the remembered handle therefore matches the draft on re-survey.
      return { file: new File([], name), handle: handle(name), pcmBytes: 96 }
    },
    async discardId(id: string) {
      this.calls.push(`discard-id:${id}`)
      if (options.failDiscardFor === id) throw new Error('OPFS remove failed')
      directory.entries.delete(id)
    },
    close() { this.closed = true },
  }
  return writer
}

interface HarnessOptions {
  /** Drafts currently in the recordings directory. */
  drafts: VoiceoverDraftInfo[]
  /** Asset ids whose remembered handle points into the directory. */
  remembered?: { assetId: string; name: string }[]
  /** Asset ids present in the active project. */
  projectAssets?: string[]
  /** Asset ids referenced by clips. */
  clipReferenced?: string[]
  sessionPhase?: VoiceoverSession['phase'] | null
  importResult?: (file: File, handle: LocalMediaFileHandle) => Promise<MediaImportResult>
  failLoadFor?: string
  failRecoverFor?: string
  failDiscardFor?: string
  sameEntry?: boolean
  /** Draft ids whose capture Web Lock another tab holds. */
  lockedIds?: string[]
  /** File names of current-project media descriptors. */
  assetFileNames?: string[]
  rememberFailure?: boolean
  /** Camera/screen `.mp4` drafts in the separate captures directory. */
  captures?: VoiceoverDraftInfo[]
  liveCaptureId?: string
}

function harness(options: HarnessOptions) {
  const directory: FakeDirectory = {
    entries: new Map(options.drafts.map((draft) => [draft.id, draft])),
  }
  const captureDirectory: FakeDirectory = {
    entries: new Map((options.captures ?? []).map((draft) => [draft.id, draft])),
  }
  const captureWriters: Array<RecoveryWriter & { calls: string[] }> = []
  const registry = new FakeRegistry()
  registry.failLoadFor = options.failLoadFor ?? null
  for (const remembered of options.remembered ?? []) {
    registry.handles.set(`${BINDING}:${remembered.assetId}`, handle(remembered.name))
  }
  let writers: Array<RecoveryWriter & { calls: string[] }> = []
  const projectAssets = [...(options.projectAssets ?? [])]
  let binding: string | null = BINDING
  let projectGeneration = 0
  let documentSnapshot: object = {}
  const deps: VoiceoverDraftRecoveryDeps = {
    createWriter: () => {
      const writer = createFakeWriter(directory, {
        failRecoverFor: options.failRecoverFor ?? null,
        failDiscardFor: options.failDiscardFor ?? null,
      })
      writers = [writer, ...writers]
      return writer
    },
    projectBindingId: () => binding,
    projectGeneration: () => projectGeneration,
    documentSnapshot: () => documentSnapshot,
    // Live view: an import adds its asset to the project, like the media store.
    projectAssetIds: () => projectAssets,
    loadHandle: (binding, assetId) => registry.load(binding, assetId),
    forgetHandle: (binding, assetId) => registry.forget(binding, assetId),
    allRememberedHandles: () => registry.list(),
    retainedAssetIds: () => options.clipReferenced ?? [],
    isRecordingOriginal: async (fileName, rememberedHandle) => (
      options.sameEntry ?? rememberedHandle.name === fileName
    ),
    importMedia: (file, importedHandle) =>
      options.importResult
        ? options.importResult(file, importedHandle)
        : registry.remember(BINDING, 'imported-asset', importedHandle).then(() => {
            projectAssets.push('imported-asset')
            return { status: 'imported' as const, assetId: 'imported-asset' }
          }),
    liveSession: () => options.sessionPhase === null
      ? null
      : {
          sessionId: 'voiceover_live', destination: {} as never, operation: 1,
          interruption: null, failure: null,
          phase: options.sessionPhase ?? 'recording',
        } as VoiceoverSession,
    disconnectAsset: vi.fn(),
    heldDraftLockIds: async () => options.lockedIds ?? [],
    liveCaptureId: () => options.liveCaptureId ?? null,
    createCaptureStore: () => {
      const writer = createFakeWriter(captureDirectory)
      // A capture's file keeps its `.mp4` name.
      writer.finalize = async () => ({ file: new File([], 'capture_a.mp4'), handle: handle('capture_a.mp4'), pcmBytes: 1 })
      captureWriters.push(writer)
      return writer
    },
    projectAssetFileNames: () => options.assetFileNames ?? [],
    rememberHandle: vi.fn(async (bindingId: string, assetId: string, rememberedHandle: LocalMediaFileHandle) => {
      if (options.rememberFailure) throw new Error('IndexedDB unavailable')
      await registry.remember(bindingId, assetId, rememberedHandle)
    }),
  }
  const recovery = new VoiceoverDraftRecovery(deps)
  return {
    recovery,
    directory,
    registry,
    writers,
    deps,
    projectAssets,
    setProjectGeneration(value: number) { projectGeneration = value },
    setBinding(value: string | null) { binding = value },
    setDocumentSnapshot(value: object) { documentSnapshot = value },
    newestWriter: () => writers[0] as RecoveryWriter & { calls: string[] },
    captureDirectory,
    captureWriters,
  }
}

describe('voiceover draft recovery', () => {
  beforeEach(() => vi.clearAllMocks())

  const draft = (id: string, overrides: Partial<VoiceoverDraftInfo> = {}): VoiceoverDraftInfo => (
    { id, sizeBytes: 48, hasJournal: true, ...overrides }
  )

  it('survey classifies kept, live, and orphaned drafts without importing or deleting anything', async () => {
    const registry = new FakeRegistry()
    registry.handles.set(`${BINDING}:asset_kept`, handle('voiceover_a.wav'))
    const directory: FakeDirectory = {
      entries: new Map([
        ['voiceover_a', draft('voiceover_a')],
        ['voiceover_live', draft('voiceover_live')],
        ['voiceover_orphan', draft('voiceover_orphan', { hasJournal: false })],
      ]),
    }
    const writers: Array<RecoveryWriter & { calls: string[] }> = []
    const importMedia = vi.fn()
    const recovery = new VoiceoverDraftRecovery({
      createWriter: () => {
        const writer = createFakeWriter(directory)
        writers.push(writer)
        return writer
      },
      projectBindingId: () => BINDING,
      projectGeneration: () => 0,
      documentSnapshot: () => ({}),
      projectAssetIds: () => ['asset_kept'],
      loadHandle: (binding, assetId) => registry.load(binding, assetId),
      forgetHandle: (binding, assetId) => registry.forget(binding, assetId),
      allRememberedHandles: () => registry.list(),
      retainedAssetIds: () => [],
      isRecordingOriginal: async () => true,
      importMedia,
      liveSession: () => ({
        sessionId: 'voiceover_live', destination: {} as never, operation: 1,
        interruption: null, failure: null, phase: 'recording',
      } as VoiceoverSession),
      disconnectAsset: vi.fn(),
    })

    const survey = await recovery.survey()
    expect(survey.drafts).toEqual([
      {
        id: 'voiceover_a', fileName: 'voiceover_a.wav', sizeBytes: 48, hasJournal: true,
        state: 'kept', assetIds: ['asset_kept'],
        references: [{
          fileName: 'voiceover_a.wav', projectBindingId: BINDING, assetId: 'asset_kept',
        }],
      },
      { id: 'voiceover_live', fileName: 'voiceover_live.wav', sizeBytes: 48, hasJournal: true, state: 'live', assetIds: [], references: [] },
      { id: 'voiceover_orphan', fileName: 'voiceover_orphan.wav', sizeBytes: 48, hasJournal: false, state: 'orphaned', assetIds: [], references: [] },
    ])
    // Survey is a read: the worker only listed, never imported or deleted.
    expect(writers[0].calls).toEqual(['list'])
    expect(importMedia).not.toHaveBeenCalled()
    expect(directory.entries.size).toBe(3)
    expect(registry.forgetCalls).toEqual([])
  })

  it('fails a survey when the registry cannot be read instead of under-classifying', async () => {
    const { recovery } = harness({
      drafts: [draft('voiceover_a')],
      projectAssets: ['asset_a'],
      failLoadFor: 'asset_a',
    })
    await expect(recovery.survey()).rejects.toThrow(/Could not read remembered media handles/)
  })

  it('keeps a recording owned by a different local project protected from discard', async () => {
    const { recovery, directory, registry } = harness({
      drafts: [draft('voiceover_other_project')],
      projectAssets: [],
    })
    await registry.remember('local-project:other', 'asset_other', handle('voiceover_other_project.wav'))
    const survey = await recovery.survey()
    expect(survey.drafts[0]).toMatchObject({ state: 'kept', assetIds: ['asset_other'] })
    const action = await recovery.discardDraft('voiceover_other_project')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/kept recording/) })
    expect(directory.entries.has('voiceover_other_project')).toBe(true)
    recovery.dispose()
  })

  it('keeps a forgotten recent project original protected when no project is open', async () => {
    const { recovery, directory, registry, setBinding } = harness({
      drafts: [draft('voiceover_forgotten_project')],
      projectAssets: [],
    })
    await registry.remember(
      'local-project:forgotten',
      'asset_forgotten',
      handle('voiceover_forgotten_project.wav'),
    )
    setBinding(null)
    const survey = await recovery.survey()
    expect(survey.drafts[0]).toMatchObject({ state: 'kept', assetIds: ['asset_forgotten'] })
    const action = await recovery.discardDraft('voiceover_forgotten_project')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/kept recording/) })
    expect(directory.entries.has('voiceover_forgotten_project')).toBe(true)
    recovery.dispose()
  })

  it('refuses to remove an original still remembered by another project', async () => {
    const { recovery, directory, registry } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
    })
    await registry.remember('local-project:other', 'asset_other', handle('voiceover_a.wav'))
    const action = await recovery.removeKeptOriginal('asset_a')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/Another project/) })
    expect(directory.entries.has('voiceover_a')).toBe(true)
    expect(registry.forgetCalls).toEqual([])
    recovery.dispose()
  })

  it('recovers a crash remnant through import and leaves the original as the protected kept source', async () => {
    const { recovery, directory, registry, newestWriter, projectAssets } = harness({
      drafts: [draft('voiceover_orphan')],
      projectAssets: ['other'],
    })
    const action = await recovery.recoverDraft('voiceover_orphan')
    expect(action).toEqual({ status: 'recovered', assetId: 'imported-asset', sizeBytes: 48 })
    // The dedicated worker performed the full durable path, then closed.
    expect(newestWriter().calls).toEqual([
      'list', 'recover:voiceover_orphan', 'finalize',
    ])
    expect(newestWriter().isClosed).toBe(true)
    // The original STAYS in the directory and is remembered as the imported
    // asset's source, exactly like a Keep.
    expect(directory.entries.has('voiceover_orphan')).toBe(true)
    expect(registry.handles.get(`${BINDING}:imported-asset`)?.name).toBe('voiceover_orphan.wav')
    // After reload the same facts classify the draft as kept, so an explicit
    // discard is now rejected: recovery never strands the project's source.
    expect(projectAssets).toContain('imported-asset')
    const resurvey = await recovery.survey()
    expect(resurvey.drafts[0]).toMatchObject({ id: 'voiceover_orphan', state: 'kept', assetIds: ['imported-asset'] })
    expect(await recovery.discardDraft('voiceover_orphan')).toMatchObject({ status: 'rejected' })
    expect(directory.entries.has('voiceover_orphan')).toBe(true)
    recovery.dispose()
  })

  it('never imports or deletes from a recovery attempt that does not complete', async () => {
    const { recovery, directory, registry } = harness({
      drafts: [draft('voiceover_orphan')],
      projectAssets: ['other'],
      importResult: async () => ({ status: 'cancelled' }),
    })
    const action = await recovery.recoverDraft('voiceover_orphan')
    expect(action.status).toBe('failed')
    expect(directory.entries.has('voiceover_orphan')).toBe(true)
    expect(registry.forgetCalls).toEqual([])
    recovery.dispose()
  })

  it('rejects recovering a kept draft and a live draft', async () => {
    const kept = harness({
      drafts: [draft('voiceover_a')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
    })
    expect(await kept.recovery.recoverDraft('voiceover_a')).toMatchObject({
      status: 'rejected', reason: expect.stringMatching(/already the original/),
    })
    expect(kept.directory.entries.has('voiceover_a')).toBe(true)

    const live = harness({ drafts: [draft('voiceover_live')] })
    expect(await live.recovery.recoverDraft('voiceover_live')).toMatchObject({
      status: 'rejected', reason: expect.stringMatching(/active recording session/),
    })
    expect(live.directory.entries.has('voiceover_live')).toBe(true)
    kept.recovery.dispose()
    live.recovery.dispose()
  })

  it('reports a missing draft instead of guessing', async () => {
    const { recovery } = harness({ drafts: [] })
    expect(await recovery.recoverDraft('voiceover_gone')).toMatchObject({
      status: 'failed', message: expect.stringMatching(/no longer exists/),
    })
    recovery.dispose()
  })

  it('rejects discarding a kept draft so referenced media is never deleted', async () => {
    const { recovery, directory, registry } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
    })
    const action = await recovery.discardDraft('voiceover_a')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/Remove kept original/) })
    expect(directory.entries.has('voiceover_a')).toBe(true)
    expect(registry.forgetCalls).toEqual([])
    recovery.dispose()
  })

  it('rejects discarding a live draft owned by the capture session', async () => {
    const { recovery, directory } = harness({ drafts: [draft('voiceover_live')] })
    const action = await recovery.discardDraft('voiceover_live')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/active recording session/) })
    expect(directory.entries.has('voiceover_live')).toBe(true)
    recovery.dispose()
  })

  it('protects a draft that is write-locked by a capture in another tab', async () => {
    const { recovery, directory } = harness({
      drafts: [draft('voiceover_other_tab', { sizeBytes: null })],
      sessionPhase: null,
    })
    const action = await recovery.discardDraft('voiceover_other_tab')
    expect(action).toMatchObject({
      status: 'rejected', reason: expect.stringMatching(/active recording session/),
    })
    expect(directory.entries.has('voiceover_other_tab')).toBe(true)
    recovery.dispose()
  })

  it('discards an orphaned draft and nothing else', async () => {
    const { recovery, directory, registry, newestWriter } = harness({
      drafts: [draft('voiceover_orphan'), draft('voiceover_live')],
    })
    const action = await recovery.discardDraft('voiceover_orphan')
    expect(action).toEqual({ status: 'discarded', sizeBytes: 48 })
    expect(newestWriter().calls).toEqual(['list', 'discard-id:voiceover_orphan'])
    expect(directory.entries.has('voiceover_orphan')).toBe(false)
    expect(directory.entries.has('voiceover_live')).toBe(true)
    // Discard never touches the registry.
    expect(registry.forgetCalls).toEqual([])
    recovery.dispose()
  })

  it('reports a discard failure without forgetting or discarding anything else', async () => {
    const { recovery, directory, registry } = harness({
      drafts: [draft('voiceover_orphan'), draft('voiceover_live')],
      failDiscardFor: 'voiceover_orphan',
    })
    const action = await recovery.discardDraft('voiceover_orphan')
    expect(action).toMatchObject({ status: 'failed', message: expect.stringMatching(/OPFS remove failed/) })
    expect(directory.entries.has('voiceover_orphan')).toBe(true)
    expect(directory.entries.has('voiceover_live')).toBe(true)
    expect(registry.forgetCalls).toEqual([])
    recovery.dispose()
  })

  it('reports a recovery failure when the worker cannot replay the checkpoint', async () => {
    const { recovery, directory } = harness({
      drafts: [draft('voiceover_orphan')],
      failRecoverFor: 'voiceover_orphan',
    })
    const action = await recovery.recoverDraft('voiceover_orphan')
    expect(action).toMatchObject({ status: 'failed', message: expect.stringMatching(/No valid checkpoint/) })
    expect(directory.entries.has('voiceover_orphan')).toBe(true)
    recovery.dispose()
  })

  it('removes a kept original only when no clip references it, then forgets the grant', async () => {
    const { recovery, directory, registry, deps, newestWriter } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
    })
    const action = await recovery.removeKeptOriginal('asset_a')
    expect(action).toEqual({ status: 'removed', sizeBytes: 48 })
    expect(newestWriter().calls).toEqual(['list', 'discard-id:voiceover_a'])
    expect(directory.entries.has('voiceover_a')).toBe(false)
    expect(registry.forgetCalls).toEqual([`${BINDING}:asset_a`])
    expect(registry.handles.has(`${BINDING}:asset_a`)).toBe(false)
    expect(deps.disconnectAsset).toHaveBeenCalledWith('asset_a')
    // The draft is gone from the directory and the grant is a tombstone.
    const resurvey = await recovery.survey()
    expect(resurvey.drafts).toEqual([])
    recovery.dispose()
  })

  it('rejects removing a kept original that is still used by clips', async () => {
    const { recovery, directory, registry } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
      clipReferenced: ['asset_a'],
    })
    const action = await recovery.removeKeptOriginal('asset_a')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/still referenced by clips/) })
    expect(directory.entries.has('voiceover_a')).toBe(true)
    expect(registry.forgetCalls).toEqual([])
    recovery.dispose()
  })

  it('rejects removing an asset another kept asset shares the original with while clips use it', async () => {
    const { recovery, directory, registry } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [
        { assetId: 'asset_a', name: 'voiceover_a.wav' },
        { assetId: 'asset_b', name: 'voiceover_a.wav' },
      ],
      projectAssets: ['asset_a', 'asset_b'],
      clipReferenced: ['asset_b'],
    })
    const action = await recovery.removeKeptOriginal('asset_a')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/still referenced by clips/) })
    expect(directory.entries.has('voiceover_a')).toBe(true)
    expect(registry.forgetCalls).toEqual([])
    recovery.dispose()
  })

  it('removes every same-project grant when multiple assets share one original', async () => {
    const { recovery, directory, registry, deps } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [
        { assetId: 'asset_a', name: 'voiceover_a.wav' },
        { assetId: 'asset_b', name: 'voiceover_a.wav' },
      ],
      projectAssets: ['asset_a', 'asset_b'],
    })
    const action = await recovery.removeKeptOriginal('asset_a')
    expect(action).toEqual({ status: 'removed', sizeBytes: 48 })
    expect(directory.entries.has('voiceover_a')).toBe(false)
    expect(registry.forgetCalls).toEqual([`${BINDING}:asset_a`, `${BINDING}:asset_b`])
    expect(deps.disconnectAsset).toHaveBeenCalledTimes(2)
    recovery.dispose()
  })

  it('does not remove a same-named local file that is not the OPFS original', async () => {
    const { recovery, directory, registry, deps } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
      sameEntry: false,
    })
    const action = await recovery.removeKeptOriginal('asset_a')
    expect(action).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/not this recording original/) })
    expect(directory.entries.has('voiceover_a')).toBe(true)
    expect(registry.forgetCalls).toEqual([])
    expect(deps.disconnectAsset).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('cancels removal when project content changes during asynchronous checks', async () => {
    const { recovery, directory, deps, setDocumentSnapshot } = harness({
      drafts: [draft('voiceover_a')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
    })
    const load = deps.loadHandle
    deps.loadHandle = async (binding, assetId) => {
      const rememberedHandle = await load(binding, assetId)
      setDocumentSnapshot({ changed: true })
      return rememberedHandle
    }
    const action = await recovery.removeKeptOriginal('asset_a')
    expect(action).toEqual({ status: 'cancelled' })
    expect(directory.entries.has('voiceover_a')).toBe(true)
    recovery.dispose()
  })

  it('cancels crash recovery when the local project changes before import', async () => {
    const h = harness({ drafts: [draft('voiceover_orphan')] })
    const createWriter = h.deps.createWriter
    h.deps.createWriter = () => {
      const writer = createWriter()
      const recover = writer.recover.bind(writer)
      writer.recover = async (id) => {
        const result = await recover(id)
        h.setBinding('local-project:next')
        h.setProjectGeneration(1)
        return result
      }
      return writer
    }
    const importMedia = vi.fn(h.deps.importMedia)
    h.deps.importMedia = importMedia
    const action = await h.recovery.recoverDraft('voiceover_orphan')
    expect(action).toEqual({ status: 'cancelled' })
    expect(importMedia).not.toHaveBeenCalled()
    expect(h.directory.entries.has('voiceover_orphan')).toBe(true)
    h.recovery.dispose()
  })

  it('rejects removal when the remembered source is not in the recordings directory', async () => {
    const { recovery, directory, registry, deps } = harness({
      drafts: [draft('voiceover_other')],
      remembered: [{ assetId: 'asset_a', name: 'voiceover_a.wav' }],
      projectAssets: ['asset_a'],
    })
    const action = await recovery.removeKeptOriginal('asset_a')
    // A source that is not visibly a recording original is never forgotten or
    // disconnected; the existing missing-file relink owns that recovery.
    expect(action).toMatchObject({
      status: 'rejected', reason: expect.stringMatching(/reconnect/),
    })
    expect(registry.forgetCalls).toEqual([])
    expect(deps.disconnectAsset).not.toHaveBeenCalled()
    expect(registry.handles.has(`${BINDING}:asset_a`)).toBe(true)
    expect(directory.entries.has('voiceover_other')).toBe(true)
    recovery.dispose()
  })

  it('never lets a project asset whose registry entry is stale be confused with a draft', async () => {
    const { recovery } = harness({
      drafts: [draft('voiceover_orphan')],
      remembered: [{ assetId: 'asset_a', name: 'unrelated-import.mp4' }],
      projectAssets: ['asset_a'],
    })
    const survey = await recovery.survey()
    expect(survey.drafts[0]).toMatchObject({ id: 'voiceover_orphan', state: 'orphaned', assetIds: [] })
    recovery.dispose()
  })

  it('treats a draft locked by another tab as live, even with a known size', async () => {
    const h = harness({ drafts: [draft('voiceover_other_tab')], sessionPhase: null,
      lockedIds: ['voiceover_other_tab'] })
    const survey = await h.recovery.survey()
    expect(survey.drafts[0]?.state).toBe('live')
    expect(await h.recovery.discardDraft('voiceover_other_tab')).toMatchObject({ status: 'rejected' })
    expect(await h.recovery.recoverDraft('voiceover_other_tab')).toMatchObject({ status: 'rejected' })
    expect(h.directory.entries.has('voiceover_other_tab')).toBe(true)
  })

  it('awaits the grant for a recovered original before reporting success', async () => {
    // The importer returns before any grant exists (its remember is fire-and-forget).
    const h = harness({ drafts: [draft('voiceover_crash')], sessionPhase: null,
      importResult: async () => ({ status: 'imported', assetId: 'recovered-asset' }) })
    const result = await h.recovery.recoverDraft('voiceover_crash')
    expect(result).toMatchObject({ status: 'recovered', assetId: 'recovered-asset' })
    expect(h.deps.rememberHandle).toHaveBeenCalledOnce()
    const survey = await h.recovery.survey()
    expect(survey.drafts[0]?.state).toBe('kept')
  })

  it('reports a recovered take whose grant failed and never lets it be discarded while in use', async () => {
    const h = harness({ drafts: [draft('voiceover_crash')], sessionPhase: null, rememberFailure: true,
      assetFileNames: ['voiceover_crash.wav'],
      importResult: async () => ({ status: 'imported', assetId: 'recovered-asset' }) })
    const result = await h.recovery.recoverDraft('voiceover_crash')
    expect(result).toMatchObject({ status: 'recovered' })
    expect(result.status === 'recovered' && result.note).toMatch(/grant could not be saved/)
    expect(await h.recovery.discardDraft('voiceover_crash')).toMatchObject({ status: 'rejected' })
    expect(h.directory.entries.has('voiceover_crash')).toBe(true)
  })

  it('serializes concurrent operations so one cannot close the worker under another', async () => {
    const gate = { release: () => {}, entered: false }
    const h = harness({ drafts: [draft('voiceover_a'), draft('voiceover_b')], sessionPhase: null,
      importResult: (_file, importedHandle) => new Promise((resolve) => {
        gate.entered = true
        gate.release = () => {
          void h.registry.remember(BINDING, 'asset-a', importedHandle).then(() =>
            resolve({ status: 'imported', assetId: 'asset-a' }))
        }
      }) })
    const recovering = h.recovery.recoverDraft('voiceover_a')
    const discarding = h.recovery.discardDraft('voiceover_b')
    const surveying = h.recovery.survey()
    await vi.waitFor(() => expect(gate.entered).toBe(true))
    // Nothing else runs while the first recovery is waiting on import.
    expect(h.directory.entries.has('voiceover_b')).toBe(true)
    gate.release()
    expect(await recovering).toMatchObject({ status: 'recovered' })
    expect(await discarding).toMatchObject({ status: 'discarded' })
    const survey = await surveying
    expect(survey.drafts.map((entry) => [entry.id, entry.state])).toEqual([['voiceover_a', 'kept']])
  })

  it('lists, recovers, and discards camera/screen captures through the capture worker only', async () => {
    const capture = (id: string) => ({ id, sizeBytes: 4096, hasJournal: true, fileName: `${id}.mp4` })
    const h = harness({ drafts: [draft('voiceover_a')], captures: [capture('capture_a'), capture('capture_b')],
      sessionPhase: null, importResult: async (_file, importedHandle) => {
        await h.registry.remember(BINDING, 'capture-asset', importedHandle)
        return { status: 'imported', assetId: 'capture-asset' }
      } })
    const survey = await h.recovery.survey()
    expect(survey.drafts.map((entry) => [entry.fileName, entry.state])).toEqual([
      ['voiceover_a.wav', 'orphaned'], ['capture_a.mp4', 'orphaned'], ['capture_b.mp4', 'orphaned']])
    expect(await h.recovery.recoverDraft('capture_a')).toMatchObject({ status: 'recovered', assetId: 'capture-asset' })
    expect(h.captureWriters.some((writer) => writer.calls.includes('recover:capture_a'))).toBe(true)
    expect(await h.recovery.discardDraft('capture_b')).toMatchObject({ status: 'discarded' })
    expect(h.captureDirectory.entries.has('capture_b')).toBe(false)
    expect(h.directory.entries.has('voiceover_a')).toBe(true)
    const after = await h.recovery.survey()
    expect(after.drafts.find((entry) => entry.id === 'capture_a')?.state).toBe('kept')
  })

  it('a camera/screen take still in review is live without relying on the lock', async () => {
    const h = harness({ drafts: [], sessionPhase: null, liveCaptureId: 'capture_review',
      captures: [{ id: 'capture_review', sizeBytes: 4096, hasJournal: true, fileName: 'capture_review.mp4' }] })
    const survey = await h.recovery.survey()
    expect(survey.drafts[0]?.state).toBe('live')
    expect(await h.recovery.discardDraft('capture_review')).toMatchObject({ status: 'rejected' })
    expect(await h.recovery.recoverDraft('capture_review')).toMatchObject({ status: 'rejected' })
    expect(h.captureDirectory.entries.has('capture_review')).toBe(true)
  })
})
