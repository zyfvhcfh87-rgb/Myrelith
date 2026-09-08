import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { observeProjectSession, MAX_SESSION_EVENTS, type SessionEvent } from '../../scripts/issue199/g4/sessionObservation'
import { useProjectSessionStore, INITIAL_PROJECT_SESSION_STATE } from '../state/projectSessionStore'
import { useDocumentStore } from '../state/documentStore'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { sequenceProjectFromTimeline } from '../domain/projectSequences'
import { createProjectFileSnapshot, serializeProjectFile } from '../domain/projectFile'
import { ProjectPersistenceController, RECOVERY_SAVE_DELAY_MS } from '../app/projectPersistenceController'
import { createLocalProjectStorage, createMapLocalProjectStorageBackend } from '../app/localProjectStorage'
import { createNewProject, leaveActiveProject, openProjectFile, activateResumedProject, resetProjectController, type ProjectControllerDeps } from '../app/projectController'

const fixture = () => sequenceProjectFromTimeline(createTimelineDoc('Fixture', DEFAULT_PROJECT_SETTINGS, 'g4'))
let observation: ReturnType<typeof observeProjectSession> | null = null
let persistence: ProjectPersistenceController | null = null
beforeEach(() => { vi.useFakeTimers(); useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE }) })
afterEach(async () => { observation?.stop(); observation = null; persistence?.suspendSession(); persistence = null; await resetProjectController({ revokeObjectURL: () => undefined }); vi.useRealTimers() })

function realLifecycle() {
  const storage = createLocalProjectStorage(createMapLocalProjectStorageBackend())
  let identity = 0
  persistence = new ProjectPersistenceController({
    supportsSavePicker: () => false, pickSaveFile: async () => { throw new Error('Unexpected picker') }, download: () => { throw new Error('Unexpected download') },
    now: () => Date.now(), setTimer: (fn, ms) => window.setTimeout(fn, ms), clearTimer: (id) => window.clearTimeout(id), addBeforeUnload: () => undefined, removeBeforeUnload: () => undefined,
    createRecoveryJournalId: () => `journal-${++identity}`, createRecoverySnapshotId: () => `snapshot-${++identity}`,
    appendRecoverySnapshot: async (snapshot) => { await storage.appendRecoverySnapshot(snapshot) }, deleteRecoveryJournal: async (id) => { await storage.deleteRecoveryJournal(id) }, rememberRecentProject: async () => undefined,
  })
  const controller = persistence
  const deps: ProjectControllerDeps = {
    createDocumentId: () => 'launcher', createProjectBindingId: () => `binding-${++identity}`, createCompatibilityRequestId: () => 'unused', now: () => Date.now(),
    readText: async () => serializeProjectFile(createProjectFileSnapshot(fixture(), [])), inspectMedia: async () => { throw new Error('No media in lifecycle identity test') },
    disposeExport: async () => undefined, disposeTransport: async () => undefined, disposePreview: async () => undefined, disposePlugins: async () => undefined, disposeMediaVisuals: () => undefined, resetMediaImport: () => undefined,
    pauseProjectPersistence: () => controller.pauseSession(), discardProjectRecovery: () => controller.discardRecovery(), resumeProjectPersistence: () => controller.resumeSession(),
    startProjectPersistence: (session) => controller.startSession(session), suspendProjectPersistence: () => controller.suspendSession(),
    loadMediaHandle: async () => null, rememberMediaHandle: async () => undefined, forgetMediaHandle: async () => undefined,
    queryMediaPermission: async () => 'denied', requestMediaPermission: async () => 'denied', pickMediaFiles: async () => [], pickMediaFolder: async () => [],
    pickProjectFile: async () => { throw new Error('Unexpected picker') }, requestProjectPermission: async () => 'denied',
    getRecentProject: () => null, getRecoveryJournal: () => null, rememberRecentProject: async () => undefined, revokeObjectURL: () => undefined,
  }
  return { storage, deps }
}
test('the real recovery guard reproduces the retained error after direct fixture identity replacement', async () => {
  const { storage, deps } = realLifecycle()
  await createNewProject('Launcher', DEFAULT_PROJECT_SETTINGS, deps)
  await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
  expect((await storage.listRecoveryJournals())[0].documentId).toBe('launcher')
  useDocumentStore.getState().setProject(fixture())
  await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
  expect(useProjectSessionStore.getState().recoveryError).toBe('Could not update the recovery copy: Recovery journal belongs to a different document')
})
test('canonical leave, portable open and activation create a recovery journal for the fixture identity', async () => {
  const { storage, deps } = realLifecycle(), events: SessionEvent[] = []
  observation = observeProjectSession(async (event) => { events.push(event) })
  await createNewProject('Launcher', DEFAULT_PROJECT_SETTINGS, deps)
  await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
  expect(await leaveActiveProject(deps)).toEqual({ status: 'ready' })
  expect(await openProjectFile(new File(['fixture'], 'initial-mixed.myrelith'), deps)).toEqual({ status: 'ready' })
  expect(await activateResumedProject(deps)).toEqual({ status: 'activated' })
  useDocumentStore.getState().setProject({ ...useDocumentStore.getState().project, name: 'Edited fixture' })
  await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
  await observation.flush()
  expect(useProjectSessionStore.getState()).toMatchObject({ screen: 'editor', recoveryPhase: 'idle', recoveryError: null })
  expect(events.flatMap((e) => e.errors)).toEqual([])
  expect((await storage.listRecoveryJournals()).map((j) => j.documentId)).toEqual(['g4'])
})
test('passive observation retains a transient recovery error after the store clears it', async () => {
  const events: SessionEvent[] = [], before = useDocumentStore.getState().project
  observation = observeProjectSession(async (event) => { events.push(event) })
  useProjectSessionStore.setState({ recoveryPhase: 'error', recoveryError: 'quota failure' })
  useProjectSessionStore.setState({ recoveryPhase: 'idle', recoveryError: null })
  await observation.flush()
  expect(events.flatMap((e) => e.errors)).toContain('quota failure')
  expect(events.at(-1)?.errors).toEqual([])
  expect(useDocumentStore.getState().project).toBe(before)
})
test('passive observation records overflow as failure and remains bounded', async () => {
  observation = observeProjectSession(async () => undefined)
  for (let i = 0; i < MAX_SESSION_EVENTS * 2; i++) useProjectSessionStore.setState({ lastRecoveryAt: i })
  await observation.flush()
  expect(observation.snapshot()).toHaveLength(MAX_SESSION_EVENTS)
  expect(observation.snapshot().at(-1)?.errors).toContain('Session observation exceeded 256 transitions')
})
test('passive evidence sink failures remain observable at flush', async () => {
  observation = observeProjectSession(async () => { throw new Error('evidence write failed') })
  await expect(observation.flush()).rejects.toThrow('evidence write failed')
})
