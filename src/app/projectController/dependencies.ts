
import { loadedEditorRuntimeTeardown as loaded } from '../editorRuntimeLifecycle';
import { discardProjectRecoverySession, pauseProjectPersistenceSession, resumeProjectPersistenceSession, startProjectPersistenceSession, suspendProjectPersistenceSession } from '../projectPersistenceController';
import { localMediaHandleRegistry, pickLocalMediaFolder, pickLocalMediaFiles, queryLocalMediaPermission, requestLocalMediaPermission } from '../localMediaHandles';
import { disposeLoadedExport } from '../exportLifecycle';
import { disposeLoadedPlugins } from '../pluginLifecycle';
import { pickLocalProjectFile, requestLocalProjectPermission } from '../localProjectStorage';
import { getRecentProjectRecord, getRecoveryJournalRecord, rememberRecentProjectRecord } from '../projectLibraryController';
import { createLocalProjectBindingId } from '../localProjectProvenance';
import type { ProjectControllerDeps } from './contracts';

export const projectControllerRealDeps: ProjectControllerDeps = {
  createDocumentId: () => `doc_${crypto.randomUUID()}`,
  createProjectBindingId: createLocalProjectBindingId,
  createCompatibilityRequestId: () => `compat_${crypto.randomUUID()}`,
  now: () => Date.now(),
  readText: (file) => file.text(),
  // Resume/relink inspects media on the launcher, before the editor loads.
  // A failed chunk load rejects like any other inspection failure, so the
  // candidate stays unactivated and project truth is untouched.
  inspectMedia: async (file, documentRate, assetId, signal) => {
    const { inspectMediaFileCompatibility } = await import('../mediaInspection')
    return inspectMediaFileCompatibility(file, documentRate, assetId, signal)
  },
  disposeExport: disposeLoadedExport,
  // Editor runtimes register as they load (editorRuntimeLifecycle); one that
  // never loaded owns nothing. The call order inside each step is binding.
  // Every local capture (voiceover, camera, screen) drains before teardown;
  // both owners are always asked, and the first failure blocks the exit.
  disposeVoiceoverCapture: async () => {
    const results = await Promise.allSettled([loaded('voiceoverCapture')?.(), loaded('avCapture')?.()])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  },
  disposeTransport: async () => {
    await loaded('sourcePlayback')?.()
    await loaded('transport')?.()
  },
  disposePreview: async () => {
    loaded('multicamMonitor')?.()
    await loaded('sourcePreview')?.()
    await loaded('preview')?.()
  },
  disposePlugins: disposeLoadedPlugins,
  disposeMediaVisuals: () => loaded('mediaVisuals')?.(),
  resetMediaImport: () => loaded('mediaImport')?.(),
  pauseProjectPersistence: pauseProjectPersistenceSession,
  discardProjectRecovery: discardProjectRecoverySession,
  resumeProjectPersistence: resumeProjectPersistenceSession,
  startProjectPersistence: startProjectPersistenceSession,
  suspendProjectPersistence: suspendProjectPersistenceSession,
  loadMediaHandle: (documentId, assetId) => (
    localMediaHandleRegistry.load(documentId, assetId)
  ),
  rememberMediaHandle: (documentId, assetId, handle) => (
    localMediaHandleRegistry.remember(documentId, assetId, handle)
  ),
  forgetMediaHandle: (documentId, assetId) => (
    localMediaHandleRegistry.forget(documentId, assetId)
  ),
  queryMediaPermission: queryLocalMediaPermission,
  requestMediaPermission: requestLocalMediaPermission,
  pickMediaFiles: pickLocalMediaFiles,
  pickMediaFolder: pickLocalMediaFolder,
  pickProjectFile: pickLocalProjectFile,
  requestProjectPermission: requestLocalProjectPermission,
  getRecentProject: getRecentProjectRecord,
  getRecoveryJournal: getRecoveryJournalRecord,
  rememberRecentProject: rememberRecentProjectRecord,
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
}
