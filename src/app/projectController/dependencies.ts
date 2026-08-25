
import { inspectMediaFileCompatibility } from '../mediaInspection';
import { resetMediaImportController } from '../mediaImportController';
import { disposeMediaVisuals } from '../mediaVisualsController';
import { discardProjectRecoverySession, pauseProjectPersistenceSession, resumeProjectPersistenceSession, startProjectPersistenceSession, suspendProjectPersistenceSession } from '../projectPersistenceController';
import { disposePreview } from '../previewController';
import { disposeSourcePreview } from '../sourceMonitorPreviewController';
import { disposeSourcePlayback } from '../sourceMonitorPlaybackController';
import { disposeTransport } from '../transportController';
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
  inspectMedia: inspectMediaFileCompatibility,
  disposeExport: disposeLoadedExport,
  disposeTransport: async () => {
    await disposeSourcePlayback()
    await disposeTransport()
  },
  disposePreview: async () => {
    await disposeSourcePreview()
    await disposePreview()
  },
  disposePlugins: disposeLoadedPlugins,
  disposeMediaVisuals,
  resetMediaImport: resetMediaImportController,
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
