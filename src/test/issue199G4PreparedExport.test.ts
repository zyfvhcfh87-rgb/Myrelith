import { afterEach, expect, test, vi } from 'vitest'
import { buildFixtureProject } from '../../scripts/issue199/g4/fixture'
import { G4PreparedExportFailure, runPreparedExport, type PreparedExportEvent } from '../../scripts/issue199/g4/preparedExport'
import { DEFAULT_EXPORT_PROFILE } from '../domain/exportProfile'
import { retimeClip, splitClipAtFrame } from '../domain/operations'
import { planTitleEdit } from '../domain/titleEditing'
import type { MediaAsset } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { createPluginPreparedExportOwner } from '../app/pluginPreparedExportOwner'
import { createPluginPreparedExportController } from '../app/pluginPreparedExportController'
import { createPluginExportAttemptController } from '../app/pluginExportAttemptController'
import { createPluginDocumentGenerationController } from '../app/pluginDocumentGeneration'
import { disposeExport, startPreparedExport, type ExportControllerDeps, type ExportResult } from '../app/exportController'
import { ATTRIBUTE_ASSET_DESCRIPTOR } from './clipAttributeFixtures'
import { resetMediaStoreForTest } from './storeFixtures'

const video: MediaAsset = { ...ATTRIBUTE_ASSET_DESCRIPTOR, width: 1280, height: 720, durationMicroseconds: 2_000_000, objectUrl: 'blob:g4-unit', durationFrames: 60, frameRate: { num: 30, den: 1 }, decoderConfigB64: null }
const audio: MediaAsset = { ...video, id: 'audio', kind: 'audio', fileName: 'g4-oracle.wav', mimeType: 'audio/wav', durationFrames: 30, durationMicroseconds: 1_000_000, width: null, height: null, hasAudio: true, audioChannels: 2, audioSampleRate: 48000, frameRate: null, sourceBounds: { video: null, audio: { status: 'unknown' } } }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); await disposeExport(); resetMediaStoreForTest() })

function installFixture(missingFallback = false) {
  let project = buildFixtureProject(video, audio)
  const split = splitClipAtFrame(retimeClip(project.sequences[0], 'g4-video', { numerator: 2, denominator: 1 }), 'g4-video', 15)
  project = { ...project, sequences: [split] }
  if (missingFallback) project = planTitleEdit(project, { sequenceId: 'g4', clipId: 'g4-title' }, { kind: 'patch', ids: ['g4-words'], patch: { font: { family: 'G4 Missing Named Font', fallbackFamily: null } } }, () => 'unused')
  useDocumentStore.getState().setProject(project)
  useMediaStore.setState({ assets: new Map([[video.id, video], [audio.id, audio]]), descriptors: new Map([[video.id, ATTRIBUTE_ASSET_DESCRIPTOR], [audio.id, { ...ATTRIBUTE_ASSET_DESCRIPTOR, id: audio.id, kind: 'audio', hasAudio: true, audioSampleRate: 48000, audioChannels: 2, sourceBounds: audio.sourceBounds }]]) })
  return useDocumentStore.getState().project
}

function harness(options: { preparationFailure?: Error; startFailure?: Error } = {}) {
  const result: ExportResult = { destination: 'download', buffer: new Uint8Array([1, 2, 3]).buffer, mimeType: 'video/mp4', fileExtension: 'mp4', profile: DEFAULT_EXPORT_PROFILE }
  const fetchBlob = vi.fn(async () => new Blob(['source']))
  const runExport = vi.fn(async function* () { if (options.startFailure) throw options.startFailure; yield 1; return result })
  const deps: ExportControllerDeps = {
    preparePlaybackForExport: vi.fn(async () => undefined),
    preflightProfile: vi.fn(async () => undefined), fetchBlob,
    createMediaSource: vi.fn(() => ({ openFrame: vi.fn(async () => { throw new Error('No native decoding in focused tests') }), close: vi.fn(async () => undefined) })),
    createPipelineDeps: vi.fn(() => { throw new Error('Pipeline factory must be stubbed') }),
    runExport,
  }
  // No encoder or decoder is constructed. Admission and font preflight remain real.
  deps.createPipelineDeps = vi.fn(() => ({} as ReturnType<ExportControllerDeps['createPipelineDeps']>))
  const catalog = vi.fn(async () => { if (options.preparationFailure) throw options.preparationFailure; return { generation: 0, declarations: [] } })
  const runtime = vi.fn(async () => { throw new Error('Disabled fixture must not create a plugin runtime') })
  const generation = createPluginDocumentGenerationController()
  const generationDispose = vi.fn(() => generation.dispose()), unregister = vi.fn()
  const consume = vi.fn(), executionClose = vi.fn(), teardown = vi.fn()
  const owner = createPluginPreparedExportOwner({
    appOwner: { exportCompositionPort: { getDeclarationCatalog: catalog, preflightExport: runtime } },
    documentGeneration: { getDocumentSnapshot: generation.getDocumentSnapshot, dispose: generationDispose },
    registerExportDisposer: () => unregister,
    createPreparedController: (input) => createPluginPreparedExportController({ ...input,
      startExport: (token, attempts, callbacks) => startPreparedExport(token, attempts, callbacks, deps),
      createAttemptController: (input) => {
        const real = createPluginExportAttemptController(input)
        consume.mockImplementation(async (...args: Parameters<typeof real.consume>) => {
          const execution = await real.consume(...args)
          return { ...execution, close: async (reason: string) => { executionClose(reason); await execution.close(reason) } }
        })
        teardown.mockImplementation(real.teardown)
        return { ...real, consume, teardown }
      },
    }),
  })
  const close = vi.fn((reason: string) => owner.close(reason))
  cleanups.push(() => owner.close('test-finished'))
  const prepare = vi.fn(owner.port.prepare), start = vi.fn(owner.port.start), approve = vi.fn(owner.port.approveReviewedBlockers)
  const port = { ...owner.port, prepare, start, approveReviewedBlockers: approve }
  const events: PreparedExportEvent[] = []
  const write = vi.fn(async (event: PreparedExportEvent) => { events.push(event) })
  return { accessor: { getPort: () => port, close }, owner, prepare, start, approve, close, generationDispose, unregister, consume, executionClose, teardown, runtime, fetchBlob, runExport, deps, events, write, result }
}

function expectClosed(h: ReturnType<typeof harness>) {
  expect(h.close).toHaveBeenCalledOnce()
  expect(h.owner.port.getSnapshot().status).toBe('closed')
  expect(h.generationDispose).toHaveBeenCalledOnce()
  expect(h.unregister).toHaveBeenCalledOnce()
  expect(h.teardown).toHaveBeenCalledOnce()
  expect(h.events.at(-1)).toEqual({ phase: 'closed' })
}

test('the exact split G4 descriptors are reviewed through the canonical token without changing their payload', async () => {
  const project = installFixture(), serialized = JSON.stringify(project), h = harness()
  await expect(runPreparedExport(DEFAULT_EXPORT_PROFILE, project, h.write, h.accessor)).resolves.toBe(h.result)
  const event = h.events[0]
  expect(event.phase).toBe('prepared'); if (event.phase !== 'prepared') throw new Error('Missing preparation evidence')
  expect(event.status).toBe('blocked')
  expect(event.attempt?.effects).toHaveLength(2)
  expect(event.attempt?.effects.every((e) => e.effectType === 'plugin:missing/future' && e.descriptorVersion === 99 && !e.enabled && e.status === 'invalid')).toBe(true)
  expect(event.attempt?.blockers).toHaveLength(2)
  // Ready snapshots retain the reviewed blocker facts; approval is token state.
  expect(h.events[1]).toMatchObject({ phase: 'reviewed', status: 'ready', attempt: { blockers: event.attempt!.blockers } })
  expect(h.start).toHaveBeenCalledOnce(); expect(h.approve).toHaveBeenCalledOnce(); expect(h.consume).toHaveBeenCalledOnce(); expect(h.runtime).not.toHaveBeenCalled()
  expect(useDocumentStore.getState().project).toBe(project); expect(JSON.stringify(project)).toBe(serialized)
  expectClosed(h)
})

test.each(['enabled', 'changed-payload', 'additional'] as const)('refuses %s blocker drift without approving or starting', async (drift) => {
  const project = structuredClone(installFixture())
  const clip = project.sequences[0].tracks.flatMap((t) => t.clips).find((c) => c.id === 'g4-video')!
  const effect = clip.effects.find((e) => e.id === 'g4-future')!
  if (drift === 'enabled') effect.enabled = true
  else if (drift === 'changed-payload') effect.params.literal = 'changed'
  else clip.effects.push({ ...effect, id: 'unexpected-plugin' })
  useDocumentStore.getState().setProject(project)
  const before = useDocumentStore.getState().project, h = harness()
  await expect(runPreparedExport(DEFAULT_EXPORT_PROFILE, before, h.write, h.accessor)).rejects.toMatchObject({ stage: 'prepare' })
  expect(h.approve).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled(); expect(h.consume).not.toHaveBeenCalled()
  expect(useDocumentStore.getState().project).toBe(before)
  expectClosed(h)
})

test('ready attempt consumes once and closes after completion', async () => {
  const project = installFixture(), h = harness()
  const result = await runPreparedExport(DEFAULT_EXPORT_PROFILE, useDocumentStore.getState().project, h.write, h.accessor)
  expect(result).toBe(h.result)
  expect(h.consume).toHaveBeenCalledOnce(); expect(h.start).toHaveBeenCalledOnce(); expect(h.runExport).toHaveBeenCalledOnce()
  expect(h.executionClose).toHaveBeenCalledOnce()
  const token = h.start.mock.calls[0][0]
  expect(typeof token).toBe('string'); expect(JSON.stringify(h.events)).not.toContain(token)
  await expect(h.owner.port.start(token)).rejects.toMatchObject({ code: 'closed' })
  expect(h.consume).toHaveBeenCalledOnce()
  expect(useDocumentStore.getState().project).toBe(project)
  expectClosed(h)
})

test('cleanup failure cannot masquerade as an expected strict font refusal', async () => {
  installFixture(true)
  const h = harness(), cleanupFailure = new Error('font owner cleanup failed')
  h.close.mockImplementationOnce(async (reason) => { await h.owner.close(reason); throw cleanupFailure })
  const failure = await runPreparedExport(DEFAULT_EXPORT_PROFILE, useDocumentStore.getState().project, h.write, h.accessor).catch((cause: unknown) => cause)
  expect(failure).toBe(cleanupFailure); expect(failure).not.toBeInstanceOf(G4PreparedExportFailure)
  expect(h.owner.port.getSnapshot().status).toBe('closed')
  expect(h.generationDispose).toHaveBeenCalledOnce(); expect(h.unregister).toHaveBeenCalledOnce()
})

test('real prepared start reaches strict missing-font preflight and closes its consumed execution before any Blob or encoder work', async () => {
  const project = installFixture(true), h = harness()
  const failure = await runPreparedExport(DEFAULT_EXPORT_PROFILE, useDocumentStore.getState().project, h.write, h.accessor).catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(G4PreparedExportFailure)
  expect(failure).toMatchObject({ stage: 'start' })
  expect(String((failure as Error).cause)).toMatch(/font|fallback/i)
  expect(h.consume).toHaveBeenCalledOnce(); expect(h.executionClose).toHaveBeenCalledOnce()
  expect(h.fetchBlob).not.toHaveBeenCalled(); expect(h.runExport).not.toHaveBeenCalled()
  expect(useDocumentStore.getState().project).toBe(project)
  expectClosed(h)
})

test('preparation failure retains its cause and closes generation ownership without a ready token', async () => {
  installFixture()
  const cause = new Error('catalog unavailable'), h = harness({ preparationFailure: cause })
  await expect(runPreparedExport(DEFAULT_EXPORT_PROFILE, useDocumentStore.getState().project, h.write, h.accessor)).rejects.toMatchObject({ stage: 'prepare', cause })
  expect(h.start).not.toHaveBeenCalled(); expect(h.consume).not.toHaveBeenCalled()
  expectClosed(h)
})

test('a downstream export failure closes consumed execution and preserves the operational error', async () => {
  installFixture()
  const cause = new Error('encoder failed'), h = harness({ startFailure: cause })
  await expect(runPreparedExport(DEFAULT_EXPORT_PROFILE, useDocumentStore.getState().project, h.write, h.accessor)).rejects.toMatchObject({ stage: 'start', cause })
  expect(h.consume).toHaveBeenCalledOnce(); expect(h.executionClose).toHaveBeenCalledOnce()
  expectClosed(h)
})

test('evidence sink failure after readiness closes the unconsumed preparation', async () => {
  installFixture()
  const h = harness(), cause = new Error('evidence write failed')
  h.write.mockRejectedValueOnce(cause)
  await expect(runPreparedExport(DEFAULT_EXPORT_PROFILE, useDocumentStore.getState().project, h.write, h.accessor)).rejects.toBe(cause)
  expect(h.start).not.toHaveBeenCalled(); expect(h.consume).not.toHaveBeenCalled()
  expectClosed(h)
})
