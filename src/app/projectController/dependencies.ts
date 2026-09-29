
import { inspectMediaFileCompatibility } from '../mediaInspection';
import { resetMediaImportController } from '../mediaImportController';
import { disposeMediaVisuals } from '../mediaVisualsController';
import { discardProjectRecoverySession, pauseProjectPersistenceSession, resumeProjectPersistenceSession, startProjectPersistenceSession, suspendProjectPersistenceSession } from '../projectPersistenceController';
import { disposePreview } from '../previewController';
import { disposeMulticamMonitor } from '../multicamMonitorController';
import { disposeSourcePreview } from '../sourceMonitorPreviewController';
import { disposeSourcePlayback } from '../sourceMonitorPlaybackController';
import { disposeTransport } from '../transportController';
import { localMediaHandleRegistry, pickLocalMediaFolder, pickLocalMediaFiles, queryLocalMediaPermission, requestLocalMediaPermission } from '../localMediaHandles';
import { disposeLoadedExport } from '../exportLifecycle';
import { disposeLoadedPlugins } from '../pluginLifecycle';
import { pickLocalProjectFile, requestLocalProjectPermission } from '../localProjectStorage';
import { getRecentProjectRecord, getRecoveryJournalRecord, rememberRecentProjectRecord } from '../projectLibraryController';
import { createLocalProjectBindingId } from '../localProjectProvenance';
import { teardownVoiceoverForProjectChange } from '../voiceoverCaptureOwner';
import { teardownAvCaptureForProjectChange } from '../avCaptureOwner';
import type { ProjectControllerDeps } from './contracts';

export const projectControllerRealDeps: ProjectControllerDeps = {
  createDocumentId: () => `doc_${crypto.randomUUID()}`,
  createProjectBindingId: createLocalProjectBindingId,
  createCompatibilityRequestId: () => `compat_${crypto.randomUUID()}`,
  now: () => Date.now(),
  readText: (file) => file.text(),
  inspectMedia: inspectMediaFileCompatibility,
  disposeExport: disposeLoadedExport,
  // Every local capture (voiceover, camera, screen) drains before teardown;
  // both owners are always asked, and the first failure blocks the exit.
  disposeVoiceoverCapture: async () => {
    const results = await Promise.allSettled([teardownVoiceoverForProjectChange(), teardownAvCaptureForProjectChange()])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  },
  disposeTransport: async () => {
    await disposeSourcePlayback()
    await disposeTransport()
  },
  disposePreview: async () => {
    disposeMulticamMonitor()
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
