/**
 * Active-project composition root.
 *
 * Project files and relinked MediaAssets remain controller-local until the
 * entire candidate is valid. Activation then drains every outgoing consumer,
 * resets session-owned stores, and commits the new document/media together.
 */

import {
  PROJECT_FILE_LIMITS,
  parseProjectFile,
  type PortableAssetDescriptor,
  type ProjectFile,
} from '../domain/projectFile'
import {
  createTimelineDoc,
  type ProjectSettings,
} from '../domain/projectSettings'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaCompatibilityStatus,
} from '../domain/mediaCompatibility'
import type {
  FrameRate,
  MediaAsset,
  TimelineDoc,
} from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_ACTIVE_MEDIA_RELINK,
  INITIAL_PROJECT_SESSION_STATE,
  type MediaRelinkAmbiguitySummary,
  type ResumeProjectSummary,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import {
  compatibilityItemForAsset,
  checkingCompatibilityItem,
} from './mediaCompatibilityController'
import { inspectMediaFileCompatibility } from './mediaInspection'
import {
  createActiveMediaRelinkCoordinator,
  type ActiveMediaRelinkTransactionResult,
} from './activeMediaRelinkCoordinator'
import {
  inspectionCandidateForDescriptor,
  matchingDescriptorCandidates,
  narrowedFolderCandidateIds,
  relinkedAsset,
  selectDescriptor,
  selectDescriptorByCompatibilityReport,
  selectDescriptorByFileIdentity,
} from './projectMediaMatching'
import {
  isMediaProbeCancellation,
  type MediaProbeResult,
} from '../pipeline/mediaCompatibilityProbe'
import { resetMediaImportController } from './mediaImportController'
import { disposeMediaVisuals } from './mediaVisualsController'
import {
  discardProjectRecoverySession,
  pauseProjectPersistenceSession,
  resumeProjectPersistenceSession,
  startProjectPersistenceSession,
  suspendProjectPersistenceSession,
  type ProjectPersistenceSession,
} from './projectPersistenceController'
import { disposePreview } from './previewController'
import { disposeTransport } from './transportController'
import {
  isLocalMediaPickerCancellation,
  localMediaHandleRegistry,
  pickLocalMediaFolder,
  pickLocalMediaFiles,
  queryLocalMediaPermission,
  requestLocalMediaPermission,
  supportsLocalMediaFolders,
  supportsLocalMediaHandles,
  type LocalMediaFileHandle,
  type LocalMediaFolderSelection,
  type LocalMediaPermission,
  type LocalMediaSelection,
} from './localMediaHandles'
import { disposeLoadedExport } from './exportLifecycle'
import {
  isLocalProjectPickerCancellation,
  pickLocalProjectFile,
  requestLocalProjectPermission,
  supportsLocalProjectFiles,
  type LocalProjectFileHandle,
  type LocalProjectPermission,
  type LocalProjectSelection,
  type RecentProjectRecord,
  type RecoveryJournalRecord,
} from './localProjectStorage'
import {
  getRecentProjectRecord,
  getRecoveryJournalRecord,
  rememberRecentProjectRecord,
} from './projectLibraryController'

export interface ProjectControllerDeps {
  createDocumentId(): string
  createCompatibilityRequestId(): string
  now(): number
  readText(file: File): Promise<string>
  inspectMedia(
    file: File,
    documentRate: FrameRate,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<MediaProbeResult>
  disposeExport(): Promise<void>
  disposeTransport(): Promise<void>
  disposePreview(): void
  disposeMediaVisuals(): void
  resetMediaImport(): void
  pauseProjectPersistence(): Promise<void>
  discardProjectRecovery(): Promise<void>
  resumeProjectPersistence(): void
  startProjectPersistence(session: ProjectPersistenceSession): void
  suspendProjectPersistence(): void
  loadMediaHandle(
    documentId: string,
    assetId: string,
  ): Promise<LocalMediaFileHandle | null>
  rememberMediaHandle(
    documentId: string,
    assetId: string,
    handle: LocalMediaFileHandle,
  ): Promise<void>
  forgetMediaHandle(documentId: string, assetId: string): Promise<void>
  queryMediaPermission(handle: LocalMediaFileHandle): Promise<LocalMediaPermission>
  requestMediaPermission(handle: LocalMediaFileHandle): Promise<LocalMediaPermission>
  pickMediaFiles(multiple: boolean): Promise<LocalMediaSelection[]>
  pickMediaFolder(): Promise<LocalMediaFolderSelection[]>
  pickProjectFile(): Promise<LocalProjectSelection>
  requestProjectPermission(
    handle: LocalProjectFileHandle,
  ): Promise<LocalProjectPermission>
  getRecentProject(documentId: string): RecentProjectRecord | null
  getRecoveryJournal(journalId: string): RecoveryJournalRecord | null
  rememberRecentProject(
    project: Omit<RecentProjectRecord, 'version'>,
  ): Promise<void>
  revokeObjectURL(url: string): void
}

export type ProjectActionResult =
  | { status: 'ready' }
  | { status: 'activated' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

const realDeps: ProjectControllerDeps = {
  createDocumentId: () => `doc_${crypto.randomUUID()}`,
  createCompatibilityRequestId: () => `compat_${crypto.randomUUID()}`,
  now: () => Date.now(),
  readText: (file) => file.text(),
  inspectMedia: inspectMediaFileCompatibility,
  disposeExport: disposeLoadedExport,
  disposeTransport,
  disposePreview,
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

interface PendingResume {
  project: ProjectFile
  projectFileName: string | null
  displayFileName: string
  origin: ResumeProjectSummary['origin']
  persisted: boolean
  recoveryJournalId?: string
  recoveryCapturedAt?: number
  assets: Map<string, MediaAsset>
  compatibility: Map<string, MediaCompatibilityItem>
  rememberedHandles: Map<string, LocalMediaFileHandle>
  abortController: AbortController
}

let pendingResume: PendingResume | null = null
let operationGeneration = 0

interface StagedFolderMedia {
  token: string
  file: File
  handle: LocalMediaFileHandle
  relativePath: string
  candidateIds: Set<string>
}

interface ActiveMediaRelinkWork {
  generation: number
  documentId: string
  documentRate: FrameRate
  outcome: 'running' | 'complete' | 'cancelled'
  scannedFileCount: number
  connectedCount: number
  skippedCount: number
  errors: string[]
  ambiguityToken: string | null
  staged: StagedFolderMedia[]
  checkingRequests: Map<string, string>
  abortController: AbortController
}

let activeMediaRelinkWork: ActiveMediaRelinkWork | null = null
let activeMediaRelinkGeneration = 0
let activeMediaRelinkToken = 0

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function compatibilityFailureReport(
  fileName: string,
  cause: unknown,
): MediaCompatibilityReport {
  return {
    status: 'error',
    container: null,
    durationMicroseconds: null,
    tracks: [],
    reason: 'decode-failed',
    detail: `Could not check "${fileName}": ${messageFrom(cause)}`,
  }
}

function compatibilityItemForDescriptor(
  descriptor: PortableAssetDescriptor,
  requestId: string,
  status: MediaCompatibilityStatus,
  report: MediaCompatibilityReport | null,
): MediaCompatibilityItem {
  return {
    id: descriptor.id,
    requestId,
    fileName: descriptor.fileName,
    declaredMimeType: descriptor.mimeType,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
    status,
    report,
  }
}

function checkingItemForDescriptor(
  descriptor: PortableAssetDescriptor,
  requestId: string,
): MediaCompatibilityItem {
  return checkingCompatibilityItem(descriptor.id, requestId, {
    name: descriptor.fileName,
    type: descriptor.mimeType,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
  })
}

function temporaryProbeId(requestId: string): string {
  return `probe_${requestId}`
}

/**
 * Roll back only the descriptor-backed check generation that still owns this
 * offline row. A preserved settled report remains actionable after a cancelled
 * or rejected relink; otherwise the transient Checking row is simply removed.
 */
function rollbackDescriptorCompatibility(
  id: string,
  requestId: string,
): boolean {
  const media = useMediaStore.getState()
  const current = media.compatibility.get(id)
  if (
    !current
    || current.requestId !== requestId
    || current.status !== 'checking'
  ) return false

  if (
    media.descriptors.has(id)
    && !media.assets.has(id)
    && current.report
    && current.report.status !== 'ready'
  ) {
    return media.setCompatibility(
      id,
      requestId,
      current.report.status,
      current.report,
    )
  }
  return media.removeCompatibility(id, requestId)
}

function discardAssets(
  assets: ReadonlyMap<string, MediaAsset>,
  deps: Pick<ProjectControllerDeps, 'revokeObjectURL'> = realDeps,
): void {
  for (const asset of assets.values()) {
    deps.revokeObjectURL(asset.objectUrl)
  }
}

function invalidateActiveMediaRelink(
  _deps: Pick<ProjectControllerDeps, 'revokeObjectURL'> = realDeps,
): void {
  activeMediaRelinkGeneration++
  const work = activeMediaRelinkWork
  activeMediaRelinkWork = null
  if (work) {
    work.abortController.abort()
    for (const [id, requestId] of work.checkingRequests) {
      rollbackDescriptorCompatibility(id, requestId)
    }
    work.checkingRequests.clear()
    work.outcome = 'cancelled'
    work.staged.length = 0
  }
  useProjectSessionStore.setState({
    activeMediaRelink: INITIAL_ACTIVE_MEDIA_RELINK,
  })
}

function invalidatePending(
  deps: Pick<ProjectControllerDeps, 'revokeObjectURL'> = realDeps,
): void {
  operationGeneration++
  invalidateActiveMediaRelink(deps)
  if (pendingResume) {
    pendingResume.abortController.abort()
    discardAssets(pendingResume.assets, deps)
  }
  pendingResume = null
}

function resumeSummary(pending: PendingResume): ResumeProjectSummary {
  const { document, assets } = pending.project
  return {
    origin: pending.origin,
    projectFileName: pending.displayFileName,
    projectName: document.name,
    width: document.width,
    height: document.height,
    frameRate: { ...document.frameRate },
    audioSampleRate: document.audioSampleRate,
    assets: assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      kind: asset.kind,
      ...(asset.partialTrackSelection === undefined
        ? {}
        : { partialTrackSelection: asset.partialTrackSelection }),
      status: pending.assets.has(asset.id)
        ? 'ready'
        : pending.rememberedHandles.has(asset.id)
          ? 'remembered'
          : 'missing',
    })),
  }
}

function publishResumeCandidate(
  pending: PendingResume,
  error: string | null = null,
): void {
  useProjectSessionStore.setState({
    screen: 'resume',
    phase: error ? 'error' : 'idle',
    candidate: resumeSummary(pending),
    error,
  })
}

export function showNewProject(): void {
  invalidatePending()
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'new-project',
  })
}

export function showResumeProject(): void {
  invalidatePending()
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'resume',
  })
}

/** Cancel an uncommitted candidate and return to the launch screen. */
export function returnToProjectHome(): void {
  invalidatePending()
  suspendProjectPersistenceSession()
  useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE })
}

/**
 * Leave an active editor only after every Blob consumer has released it.
 * Launch-screen Back buttons use returnToProjectHome because no editor-owned
 * transport, workers, or media exist on those screens.
 */
export async function leaveActiveProject(
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  invalidatePending(deps)
  const generation = operationGeneration
  useProjectSessionStore.setState({ phase: 'closing', error: null })
  try {
    // Pause synchronously before the first await: no queued live save may
    // cross the slower export/audio teardown below.
    await deps.pauseProjectPersistence()
    if (generation !== operationGeneration) return { status: 'cancelled' }
    // A confirmed return to Projects is an intentional discard, not a crash.
    // Remove its recovery lineage before revoking any media resources.
    await deps.discardProjectRecovery()
    if (generation !== operationGeneration) return { status: 'cancelled' }
    await deps.disposeExport()
    await deps.disposeTransport()
    if (generation !== operationGeneration) return { status: 'cancelled' }

    deps.disposePreview()
    deps.disposeMediaVisuals()
    deps.resetMediaImport()
    deps.suspendProjectPersistence()
    if (generation !== operationGeneration) return { status: 'cancelled' }

    useMediaStore.getState().clearAssets()
    useTransportStore.getState().resetTransport()
    useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE })
    return { status: 'ready' }
  } catch (cause) {
    if (generation !== operationGeneration) return { status: 'cancelled' }
    const message = `Could not return to Projects: ${messageFrom(cause)}`
    deps.resumeProjectPersistence()
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return { status: 'failed', message }
  }
}

async function activateProject(
  document: TimelineDoc,
  descriptors: readonly PortableAssetDescriptor[],
  assets: readonly MediaAsset[],
  compatibility: readonly MediaCompatibilityItem[],
  persistence: ProjectPersistenceSession,
  generation: number,
  deps: ProjectControllerDeps,
): Promise<ProjectActionResult> {
  useProjectSessionStore.setState({ phase: 'activating', error: null })
  try {
    await deps.pauseProjectPersistence()
    if (generation !== operationGeneration) return { status: 'cancelled' }
    // Export and audio are the asynchronous consumers. They must release the
    // old Blobs before mediaStore revokes their URLs.
    await deps.disposeExport()
    await deps.disposeTransport()
    if (generation !== operationGeneration) return { status: 'cancelled' }

    deps.disposePreview()
    deps.disposeMediaVisuals()
    deps.resetMediaImport()
    deps.suspendProjectPersistence()
    if (generation !== operationGeneration) return { status: 'cancelled' }

    if (!useMediaStore.getState().replaceAssets(
      descriptors,
      assets,
      compatibility,
    )) {
      throw new Error('Could not install the project media catalog')
    }
    // Ownership of candidate URLs moved into mediaStore with replaceAssets.
    pendingResume = null
    useDocumentStore.getState().setDoc(document)
    useTransportStore.getState().resetTransport()
    useProjectSessionStore.setState({
      screen: 'editor',
      phase: 'idle',
      activeProjectName: document.name,
      activeProjectFileName: persistence.fileName,
      activeMediaRelink: INITIAL_ACTIVE_MEDIA_RELINK,
      candidate: null,
      error: null,
    })
    deps.startProjectPersistence(persistence)
    return { status: 'activated' }
  } catch (cause) {
    if (generation !== operationGeneration) return { status: 'cancelled' }
    const message = `Could not open the project: ${messageFrom(cause)}`
    deps.resumeProjectPersistence()
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return { status: 'failed', message }
  }
}

/** Create and activate a new empty document from explicit project settings. */
export async function createNewProject(
  name: string,
  settings: ProjectSettings,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  invalidatePending(deps)
  const generation = operationGeneration
  let document: TimelineDoc
  try {
    document = createTimelineDoc(name, settings, deps.createDocumentId())
  } catch (cause) {
    const message = `Could not create the project: ${messageFrom(cause)}`
    useProjectSessionStore.setState({
      screen: 'new-project',
      phase: 'error',
      error: message,
    })
    return { status: 'failed', message }
  }
  return activateProject(
    document,
    [],
    [],
    [],
    { fileName: null, persisted: false },
    generation,
    deps,
  )
}

interface ProjectCandidateSource {
  origin: PendingResume['origin']
  displayFileName: string
  projectFileName: string | null
  persisted: boolean
  expectedDocumentId?: string
  handle?: LocalProjectFileHandle
  recoveryJournalId?: string
  recoveryCapturedAt?: number
}

function beginProjectRead(deps: ProjectControllerDeps): number {
  invalidatePending(deps)
  const generation = operationGeneration
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'resume',
    phase: 'reading-project',
  })
  return generation
}

async function prepareProjectCandidate(
  serialized: string,
  source: ProjectCandidateSource,
  generation: number,
  deps: ProjectControllerDeps,
): Promise<ProjectActionResult> {
  const project = parseProjectFile(serialized)
  if (source.expectedDocumentId && project.document.id !== source.expectedDocumentId) {
    throw new Error('The local project entry now points to a different project')
  }
  if (generation !== operationGeneration) return { status: 'cancelled' }

  const pending: PendingResume = {
    project,
    projectFileName: source.projectFileName,
    displayFileName: source.displayFileName,
    origin: source.origin,
    persisted: source.persisted,
    recoveryJournalId: source.recoveryJournalId,
    recoveryCapturedAt: source.recoveryCapturedAt,
    assets: new Map(),
    compatibility: new Map(),
    rememberedHandles: new Map(),
    abortController: new AbortController(),
  }
  pendingResume = pending

  if (source.handle) {
    void deps.rememberRecentProject({
      documentId: project.document.id,
      projectName: project.document.name,
      fileName: source.handle.name,
      lastOpenedAt: deps.now(),
      handle: source.handle,
    }).catch((cause) => {
      console.warn('Could not update the recent-project entry', cause)
    })
  }
  if (project.assets.length > 0) {
    useProjectSessionStore.setState({
      screen: 'resume',
      phase: 'relinking',
      candidate: resumeSummary(pending),
      error: null,
    })
  }
  const restored = await restoreRememberedMedia(pending, generation, deps)
  if (restored.status === 'cancelled') return restored
  publishResumeCandidate(
    pending,
    restored.errors.length > 0 ? restored.errors.join(' ') : null,
  )
  return { status: 'ready' }
}

async function readProjectCandidateFile(
  file: File,
  source: ProjectCandidateSource,
  generation: number,
  deps: ProjectControllerDeps,
): Promise<ProjectActionResult> {
  try {
    if (!file.name.toLowerCase().endsWith('.webcut')) {
      throw new Error('Choose a file ending in .webcut')
    }
    if (file.size > PROJECT_FILE_LIMITS.maxSerializedCharacters) {
      throw new Error('This project file is too large to open safely')
    }
    const serialized = await deps.readText(file)
    if (generation !== operationGeneration) return { status: 'cancelled' }
    return await prepareProjectCandidate(serialized, source, generation, deps)
  } catch (cause) {
    if (generation !== operationGeneration) return { status: 'cancelled' }
    const message = `Could not read "${file.name}": ${messageFrom(cause)}`
    useProjectSessionStore.setState({
      screen: 'resume',
      phase: 'error',
      candidate: null,
      error: message,
    })
    return { status: 'failed', message }
  }
}

/** Parse and validate a portable project from the compatibility file input. */
export function openProjectFile(
  file: File,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const generation = beginProjectRead(deps)
  return readProjectCandidateFile(file, {
    origin: 'file',
    displayFileName: file.name,
    projectFileName: file.name,
    persisted: true,
  }, generation, deps)
}

export function canRememberProjectFiles(): boolean {
  return supportsLocalProjectFiles()
}

/** Choose a reusable `.webcut` handle directly from the Resume click. */
export async function chooseProjectFile(
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const generation = beginProjectRead(deps)
  try {
    const selection = await deps.pickProjectFile()
    if (generation !== operationGeneration) return { status: 'cancelled' }
    return readProjectCandidateFile(selection.file, {
      origin: 'file',
      displayFileName: selection.file.name,
      projectFileName: selection.file.name,
      persisted: true,
      handle: selection.handle,
    }, generation, deps)
  } catch (cause) {
    if (generation !== operationGeneration) return { status: 'cancelled' }
    if (isLocalProjectPickerCancellation(cause)) {
      useProjectSessionStore.setState({ phase: 'idle', error: null })
      return { status: 'cancelled' }
    }
    const message = `Could not choose a project: ${messageFrom(cause)}`
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return { status: 'failed', message }
  }
}

async function finishRecentProjectOpen(
  record: RecentProjectRecord,
  permission: Promise<LocalProjectPermission>,
  generation: number,
  deps: ProjectControllerDeps,
): Promise<ProjectActionResult> {
  try {
    if (await permission !== 'granted') {
      throw new Error('Access to this recent project was not granted')
    }
    if (generation !== operationGeneration) return { status: 'cancelled' }
    const file = await record.handle.getFile()
    if (generation !== operationGeneration) return { status: 'cancelled' }
    return readProjectCandidateFile(file, {
      origin: 'recent',
      displayFileName: file.name,
      projectFileName: file.name,
      persisted: true,
      expectedDocumentId: record.documentId,
      handle: record.handle,
    }, generation, deps)
  } catch (cause) {
    if (generation !== operationGeneration) return { status: 'cancelled' }
    const message = `Could not open "${record.fileName}": ${messageFrom(cause)}`
    useProjectSessionStore.setState({
      screen: 'resume',
      phase: 'error',
      candidate: null,
      error: message,
    })
    return { status: 'failed', message }
  }
}

/** Open a cached recent handle; permission starts synchronously in this click. */
export function openRecentProject(
  documentId: string,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const record = deps.getRecentProject(documentId)
  if (!record) {
    const message = 'This recent project is no longer available locally'
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return Promise.resolve({ status: 'failed', message })
  }
  const generation = beginProjectRead(deps)
  let permission: Promise<LocalProjectPermission>
  try {
    // Keep the permission request before the first await so Chrome retains the
    // user activation from this Recent project's Open button.
    permission = deps.requestProjectPermission(record.handle)
  } catch (cause) {
    permission = Promise.reject(cause)
  }
  return finishRecentProjectOpen(record, permission, generation, deps)
}

/** Offer, but never silently activate, the newest valid local recovery copy. */
export async function openRecoveryProject(
  journalId: string,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const record = deps.getRecoveryJournal(journalId)
  if (!record) {
    const message = 'This recovery copy is no longer available locally'
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return { status: 'failed', message }
  }
  const generation = beginProjectRead(deps)
  const generations = [...record.generations].reverse()
  let lastError: unknown = new Error('No complete recovery snapshot is available')
  for (const recovery of generations) {
    try {
      return await prepareProjectCandidate(recovery.serializedProject, {
        origin: 'recovery',
        displayFileName: record.projectFileName ?? 'Local recovery copy',
        projectFileName: record.projectFileName,
        persisted: false,
        expectedDocumentId: record.documentId,
        recoveryJournalId: record.journalId,
        recoveryCapturedAt: recovery.capturedAt,
      }, generation, deps)
    } catch (cause) {
      lastError = cause
    }
  }
  if (generation !== operationGeneration) return { status: 'cancelled' }
  const message = `Could not open the recovery copy: ${messageFrom(lastError)}`
  useProjectSessionStore.setState({
    screen: 'resume',
    phase: 'error',
    candidate: null,
    error: message,
  })
  return { status: 'failed', message }
}

function activeRelinkIsCurrent(work: ActiveMediaRelinkWork): boolean {
  const session = useProjectSessionStore.getState()
  return activeMediaRelinkWork === work
    && work.generation === activeMediaRelinkGeneration
    && session.screen === 'editor'
    && useDocumentStore.getState().doc.id === work.documentId
}

function publishActiveMediaRelink(
  work: ActiveMediaRelinkWork,
  phase: 'scanning' | 'awaiting-choice' | 'complete',
  ambiguity: MediaRelinkAmbiguitySummary | null = null,
): void {
  if (!activeRelinkIsCurrent(work)) return
  useProjectSessionStore.setState({
    activeMediaRelink: {
      phase,
      scannedFileCount: work.scannedFileCount,
      connectedCount: work.connectedCount,
      skippedCount: work.skippedCount,
      errors: [...work.errors],
      ambiguity,
    },
  })
}

function createActiveMediaRelinkWork(
  scannedFileCount: number,
  deps: Pick<ProjectControllerDeps, 'revokeObjectURL'>,
): ActiveMediaRelinkWork | null {
  const session = useProjectSessionStore.getState()
  if (session.screen !== 'editor') return null
  invalidateActiveMediaRelink(deps)
  const document = useDocumentStore.getState().doc
  const work: ActiveMediaRelinkWork = {
    generation: activeMediaRelinkGeneration,
    documentId: document.id,
    documentRate: { ...document.frameRate },
    outcome: 'running',
    scannedFileCount,
    connectedCount: 0,
    skippedCount: 0,
    errors: [],
    ambiguityToken: null,
    staged: [],
    checkingRequests: new Map(),
    abortController: new AbortController(),
  }
  activeMediaRelinkWork = work
  publishActiveMediaRelink(work, 'scanning')
  return work
}

function currentOfflineDescriptors(): PortableAssetDescriptor[] {
  const media = useMediaStore.getState()
  return [...media.descriptors.values()].filter(
    (descriptor) => !media.assets.has(descriptor.id),
  )
}

function narrowedFolderCandidates(
  file: File,
  inspection: MediaProbeResult,
): Set<string> {
  const media = useMediaStore.getState()
  return narrowedFolderCandidateIds(
    [...media.descriptors.values()],
    media.assets,
    file,
    inspection,
  )
}

function pruneStagedFolderMedia(work: ActiveMediaRelinkWork): void {
  const media = useMediaStore.getState()
  const retained: StagedFolderMedia[] = []
  for (const staged of work.staged) {
    staged.candidateIds = new Set(
      [...staged.candidateIds].filter(
        (id) => media.descriptors.has(id) && !media.assets.has(id),
      ),
    )
    if (staged.candidateIds.size > 0) {
      retained.push(staged)
    } else {
      work.skippedCount++
    }
  }
  work.staged = retained
}

async function runActiveMediaRelinkTransaction(
  work: ActiveMediaRelinkWork,
  selection: {
    kind: 'individual' | 'folder'
    assetId: string
    file: File
    handle: LocalMediaFileHandle | null
    displayPath: string
  },
  deps: Pick<
    ProjectControllerDeps,
    | 'createCompatibilityRequestId'
    | 'inspectMedia'
    | 'rememberMediaHandle'
    | 'revokeObjectURL'
  >,
  ownership: {
    claimForCommit(descriptor: PortableAssetDescriptor): boolean
    releaseSelection(): void
  },
): Promise<ActiveMediaRelinkTransactionResult> {
  const coordinator = createActiveMediaRelinkCoordinator({
    createCompatibilityRequestId: deps.createCompatibilityRequestId,
    createCheckingItem: checkingItemForDescriptor,
    createFailureReport: compatibilityFailureReport,
    inspectMedia: deps.inspectMedia,
    rememberMediaHandle: deps.rememberMediaHandle,
    revokeObjectURL: deps.revokeObjectURL,
    isProbeCancellation: isMediaProbeCancellation,
    isCurrent: () => activeRelinkIsCurrent(work),
    claimForCommit: ownership.claimForCommit,
    releaseSelection: ownership.releaseSelection,
    store: {
      getDescriptor: (assetId) => (
        useMediaStore.getState().descriptors.get(assetId) ?? null
      ),
      hasConnectedAsset: (assetId) => (
        useMediaStore.getState().assets.has(assetId)
      ),
      startCompatibility: (item) => (
        useMediaStore.getState().startCompatibility(item)
      ),
      setCompatibility: (assetId, requestId, status, report) => (
        useMediaStore.getState().setCompatibility(
          assetId,
          requestId,
          status,
          report,
        )
      ),
      rollbackCompatibility: rollbackDescriptorCompatibility,
      connectAsset: (asset, compatibility) => (
        useMediaStore.getState().connectAsset(asset, compatibility)
      ),
    },
    progress: {
      checkingStarted: (assetId, requestId) => {
        work.checkingRequests.set(assetId, requestId)
      },
      checkingFinished: (assetId) => {
        work.checkingRequests.delete(assetId)
      },
      connected: () => {
        work.connectedCount++
      },
      skipped: (message) => {
        work.skippedCount++
        if (message) work.errors.push(message)
      },
      warning: (message) => {
        work.errors.push(message)
      },
      publishConnected: () => {
        if (selection.kind === 'folder') {
          publishActiveMediaRelink(work, 'scanning')
        }
      },
    },
  })
  return coordinator.connect(selection, {
    documentId: work.documentId,
    documentRate: work.documentRate,
    signal: work.abortController.signal,
  })
}

async function connectStagedFolderMedia(
  work: ActiveMediaRelinkWork,
  staged: StagedFolderMedia,
  assetId: string,
  deps: Pick<
    ProjectControllerDeps,
    | 'createCompatibilityRequestId'
    | 'inspectMedia'
    | 'rememberMediaHandle'
    | 'revokeObjectURL'
  >,
): Promise<boolean> {
  if (!activeRelinkIsCurrent(work)) return false
  if (!staged.candidateIds.has(assetId)) return false

  const releaseSelection = (): void => {
    const index = work.staged.indexOf(staged)
    if (index >= 0) work.staged.splice(index, 1)
  }
  const result = await runActiveMediaRelinkTransaction(
    work,
    {
      kind: 'folder',
      assetId,
      file: staged.file,
      handle: staged.handle,
      displayPath: staged.relativePath,
    },
    deps,
    {
      claimForCommit: (descriptor) => {
        if (!activeRelinkIsCurrent(work)) return false
        const index = work.staged.indexOf(staged)
        const media = useMediaStore.getState()
        if (
          index < 0
          || !staged.candidateIds.has(descriptor.id)
          || media.descriptors.get(descriptor.id) !== descriptor
          || media.assets.has(descriptor.id)
        ) return false

        // Remove controller ownership before the store takes the URL.
        work.staged.splice(index, 1)
        return true
      },
      releaseSelection,
    },
  )
  return result.status === 'connected'
}

async function connectUniqueFolderMatches(
  work: ActiveMediaRelinkWork,
  deps: Pick<
    ProjectControllerDeps,
    | 'createCompatibilityRequestId'
    | 'inspectMedia'
    | 'rememberMediaHandle'
    | 'revokeObjectURL'
  >,
): Promise<void> {
  while (activeRelinkIsCurrent(work)) {
    pruneStagedFolderMedia(work)
    const descriptorDegrees = new Map<string, number>()
    for (const staged of work.staged) {
      for (const id of staged.candidateIds) {
        descriptorDegrees.set(id, (descriptorDegrees.get(id) ?? 0) + 1)
      }
    }
    const unique = work.staged.find((staged) => {
      if (staged.candidateIds.size !== 1) return false
      const id = staged.candidateIds.values().next().value as string
      return descriptorDegrees.get(id) === 1
    })
    if (!unique) return
    const assetId = unique.candidateIds.values().next().value as string
    await connectStagedFolderMedia(work, unique, assetId, deps)
  }
}

function finishActiveMediaRelink(work: ActiveMediaRelinkWork): void {
  if (!activeRelinkIsCurrent(work)) return
  work.outcome = 'complete'
  activeMediaRelinkWork = null
  useProjectSessionStore.setState({
    activeMediaRelink: {
      phase: 'complete',
      scannedFileCount: work.scannedFileCount,
      connectedCount: work.connectedCount,
      skippedCount: work.skippedCount,
      errors: [...work.errors],
      ambiguity: null,
    },
  })
}

function publishNextFolderAmbiguity(work: ActiveMediaRelinkWork): void {
  if (!activeRelinkIsCurrent(work)) return
  pruneStagedFolderMedia(work)
  if (work.staged.length === 0) {
    finishActiveMediaRelink(work)
    return
  }
  const descriptors = useMediaStore.getState().descriptors
  for (const descriptor of descriptors.values()) {
    if (useMediaStore.getState().assets.has(descriptor.id)) continue
    const candidates = work.staged.filter(
      (staged) => staged.candidateIds.has(descriptor.id),
    )
    if (candidates.length === 0) continue
    const token = `ambiguity-${work.generation}-${++activeMediaRelinkToken}`
    work.ambiguityToken = token
    publishActiveMediaRelink(work, 'awaiting-choice', {
      token,
      assetId: descriptor.id,
      assetFileName: descriptor.fileName,
      candidates: candidates.map((staged) => ({
        token: staged.token,
        fileName: staged.file.name,
        relativePath: staged.relativePath,
      })),
    })
    return
  }

  work.skippedCount += work.staged.length
  work.staged = []
  finishActiveMediaRelink(work)
}

async function settleActiveMediaRelink(
  work: ActiveMediaRelinkWork,
  deps: Pick<
    ProjectControllerDeps,
    | 'createCompatibilityRequestId'
    | 'inspectMedia'
    | 'rememberMediaHandle'
    | 'revokeObjectURL'
  >,
): Promise<void> {
  await connectUniqueFolderMatches(work, deps)
  if (activeRelinkIsCurrent(work)) publishNextFolderAmbiguity(work)
}

type RememberedRestoreResult =
  | { status: 'ready' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

function pendingIsCurrent(
  pending: PendingResume,
  generation: number,
): boolean {
  return generation === operationGeneration && pending === pendingResume
}

function pendingPersistenceSession(
  pending: PendingResume,
): ProjectPersistenceSession {
  const session: ProjectPersistenceSession = {
    fileName: pending.projectFileName,
    persisted: pending.persisted,
  }
  if (pending.recoveryJournalId) {
    session.recoveryJournalId = pending.recoveryJournalId
  }
  if (pending.recoveryCapturedAt !== undefined) {
    session.recoveryCapturedAt = pending.recoveryCapturedAt
  }
  return session
}

function forgetStaleHandle(
  pending: PendingResume,
  descriptor: PortableAssetDescriptor,
  deps: ProjectControllerDeps,
): void {
  void deps.forgetMediaHandle(
    pending.project.document.id,
    descriptor.id,
  ).catch((cause) => {
    console.warn('Could not forget a stale remembered media file', cause)
  })
}

async function restoreRememberedDescriptor(
  pending: PendingResume,
  descriptor: PortableAssetDescriptor,
  handle: LocalMediaFileHandle,
  generation: number,
  deps: ProjectControllerDeps,
): Promise<RememberedRestoreResult> {
  let analyzed: MediaAsset | null = null
  let fileRead = false
  let identityMismatch = false
  try {
    const file = await handle.getFile()
    fileRead = true
    if (!pendingIsCurrent(pending, generation)) {
      return { status: 'cancelled' }
    }
    if (
      file.size !== descriptor.size
      || file.lastModified !== descriptor.lastModified
    ) {
      identityMismatch = true
      throw new Error('the remembered file changed since this project was saved')
    }
    const requestId = deps.createCompatibilityRequestId()
    const inspection = await deps.inspectMedia(
      file,
      pending.project.document.frameRate,
      descriptor.id,
      pending.abortController.signal,
    )
    if (inspection.asset) analyzed = inspection.asset
    if (!pendingIsCurrent(pending, generation)) {
      if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
      return { status: 'cancelled' }
    }
    const candidate = inspectionCandidateForDescriptor(descriptor, inspection)
    if (!candidate) {
      if (analyzed) {
        deps.revokeObjectURL(analyzed.objectUrl)
        analyzed = null
      }
      if (inspection.status === 'ready') {
        identityMismatch = true
        throw new Error('the remembered file changed since this project was saved')
      }
      pending.compatibility.set(
        descriptor.id,
        compatibilityItemForDescriptor(
          descriptor,
          requestId,
          inspection.status,
          inspection.compatibility,
        ),
      )
      pending.rememberedHandles.delete(descriptor.id)
      useProjectSessionStore.setState({ candidate: resumeSummary(pending) })
      return {
        status: 'failed',
        message: inspection.compatibility.detail
          ?? `"${descriptor.fileName}" is not compatible in this browser. Open offline to relink it later.`,
      }
    }
    if (descriptor.lastModified !== candidate.asset.lastModified) {
      identityMismatch = true
      throw new Error('the remembered file changed since this project was saved')
    }
    const connected = relinkedAsset(
      descriptor,
      candidate.asset,
      pending.project.document.frameRate,
    )
    pending.assets.set(descriptor.id, connected)
    pending.compatibility.set(
      descriptor.id,
      compatibilityItemForAsset(
        connected,
        requestId,
        'ready',
        candidate.compatibility,
      ),
    )
    pending.rememberedHandles.delete(descriptor.id)
    analyzed = null // ownership moved to the pending candidate
    useProjectSessionStore.setState({ candidate: resumeSummary(pending) })
    return { status: 'ready' }
  } catch (cause) {
    if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
    if (!pendingIsCurrent(pending, generation)) {
      return { status: 'cancelled' }
    }
    pending.rememberedHandles.delete(descriptor.id)
    if (fileRead && !isMediaProbeCancellation(cause)) {
      pending.compatibility.set(
        descriptor.id,
        compatibilityItemForDescriptor(
          descriptor,
          deps.createCompatibilityRequestId(),
          'error',
          compatibilityFailureReport(descriptor.fileName, cause),
        ),
      )
    }
    if (
      !isMediaProbeCancellation(cause)
      && (!fileRead || identityMismatch)
    ) forgetStaleHandle(pending, descriptor, deps)
    return {
      status: 'failed',
      message: `Could not reopen "${descriptor.fileName}": ${messageFrom(cause)}. Reconnect it manually.`,
    }
  }
}

async function restoreRememberedMedia(
  pending: PendingResume,
  generation: number,
  deps: ProjectControllerDeps,
): Promise<
  | { status: 'ready'; errors: string[] }
  | { status: 'cancelled' }
> {
  const documentId = pending.project.document.id
  const loaded = await Promise.all(pending.project.assets.map(
    async (descriptor) => {
      try {
        return {
          descriptor,
          handle: await deps.loadMediaHandle(documentId, descriptor.id),
          error: null,
        }
      } catch (cause) {
        return { descriptor, handle: null, error: cause }
      }
    },
  ))
  if (!pendingIsCurrent(pending, generation)) return { status: 'cancelled' }

  const errors: string[] = []
  for (const entry of loaded) {
    if (entry.error) {
      console.warn('Could not load remembered media', entry.error)
      continue
    }
    if (!entry.handle) continue

    let permission: LocalMediaPermission
    try {
      permission = await deps.queryMediaPermission(entry.handle)
    } catch (cause) {
      errors.push(
        `Could not check access to "${entry.descriptor.fileName}": ${messageFrom(cause)}.`,
      )
      continue
    }
    if (!pendingIsCurrent(pending, generation)) return { status: 'cancelled' }
    if (permission === 'prompt') {
      pending.rememberedHandles.set(entry.descriptor.id, entry.handle)
      useProjectSessionStore.setState({ candidate: resumeSummary(pending) })
      continue
    }
    if (permission !== 'granted') continue

    const restored = await restoreRememberedDescriptor(
      pending,
      entry.descriptor,
      entry.handle,
      generation,
      deps,
    )
    if (restored.status === 'cancelled') return restored
    if (restored.status === 'failed') errors.push(restored.message)
  }
  return { status: 'ready', errors }
}

interface ProjectMediaSelection {
  file: File
  handle: LocalMediaFileHandle | null
}

/** Analyze selected source files once and attach only exact relink matches. */
async function connectProjectMediaSelections(
  selections: readonly ProjectMediaSelection[],
  deps: ProjectControllerDeps,
): Promise<ProjectActionResult> {
  const pending = pendingResume
  if (!pending) {
    const message = 'Choose a valid .webcut project before reconnecting media'
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return { status: 'failed', message }
  }
  if (selections.length === 0) return { status: 'ready' }

  const generation = operationGeneration
  useProjectSessionStore.setState({ phase: 'relinking', error: null })
  const errors: string[] = []

  for (const { file, handle } of selections) {
    let analyzed: MediaAsset | null = null
    const requestId = deps.createCompatibilityRequestId()
    try {
      const inspection = await deps.inspectMedia(
        file,
        pending.project.document.frameRate,
        temporaryProbeId(requestId),
        pending.abortController.signal,
      )
      if (inspection.asset) analyzed = inspection.asset
      if (generation !== operationGeneration || pending !== pendingResume) {
        if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
        return { status: 'cancelled' }
      }
      const descriptorMatchesInspection = matchingDescriptorCandidates(
        pending.project.assets,
        pending.assets,
        inspection,
      ).length > 0
      if (!descriptorMatchesInspection) {
        if (analyzed) {
          deps.revokeObjectURL(analyzed.objectUrl)
          analyzed = null
        }
        if (inspection.status === 'ready') {
          throw new Error(`"${file.name}" does not match any missing project source`)
        }
        const descriptor = selectDescriptorByCompatibilityReport(
          pending.project.assets,
          pending.assets,
          file,
          inspection.compatibility,
        )
        if (descriptor) {
          // This explicit selection supersedes any permission-prompt handle
          // loaded for the same descriptor. Keep the new incompatible handle
          // persisted for a future capability change, but open this candidate
          // offline rather than restoring the stale in-memory handle.
          pending.rememberedHandles.delete(descriptor.id)
          pending.compatibility.set(
            descriptor.id,
            compatibilityItemForDescriptor(
              descriptor,
              requestId,
              inspection.status,
              inspection.compatibility,
            ),
          )
          useProjectSessionStore.setState({ candidate: resumeSummary(pending) })
          if (handle) {
            try {
              await deps.rememberMediaHandle(
                pending.project.document.id,
                descriptor.id,
                handle,
              )
            } catch (cause) {
              console.warn('Could not remember the incompatible media file', cause)
            }
            if (!pendingIsCurrent(pending, generation)) {
              return { status: 'cancelled' }
            }
          }
        }
        errors.push(
          inspection.compatibility.detail
            ?? `"${file.name}" is not compatible in this browser.`,
        )
        continue
      }
      const { descriptor, candidate } = selectDescriptor(
        pending.project.assets,
        pending.assets,
        file,
        inspection,
      )
      const connected = relinkedAsset(
        descriptor,
        candidate.asset,
        pending.project.document.frameRate,
      )
      pending.assets.set(descriptor.id, connected)
      pending.compatibility.set(
        descriptor.id,
        compatibilityItemForAsset(
          connected,
          requestId,
          'ready',
          candidate.compatibility,
        ),
      )
      pending.rememberedHandles.delete(descriptor.id)
      analyzed = null // ownership moved to the pending candidate
      useProjectSessionStore.setState({ candidate: resumeSummary(pending) })
      if (handle) {
        try {
          await deps.rememberMediaHandle(
            pending.project.document.id,
            descriptor.id,
            handle,
          )
        } catch (cause) {
          console.warn('Could not remember the reconnected media file', cause)
        }
        if (!pendingIsCurrent(pending, generation)) {
          return { status: 'cancelled' }
        }
      }
    } catch (cause) {
      if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
      if (generation !== operationGeneration || pending !== pendingResume) {
        return { status: 'cancelled' }
      }
      if (!isMediaProbeCancellation(cause)) {
        const descriptor = selectDescriptorByFileIdentity(
          pending.project.assets,
          pending.assets,
          file,
        )
        if (descriptor) {
          pending.compatibility.set(
            descriptor.id,
            compatibilityItemForDescriptor(
              descriptor,
              requestId,
              'error',
              compatibilityFailureReport(file.name, cause),
            ),
          )
        }
      }
      errors.push(messageFrom(cause))
    }
  }

  if (generation !== operationGeneration || pending !== pendingResume) {
    return { status: 'cancelled' }
  }
  if (errors.length > 0) {
    const message = errors.join(' ')
    publishResumeCandidate(pending, message)
    return { status: 'failed', message }
  }
  publishResumeCandidate(pending)
  return { status: 'ready' }
}

/** Compatibility fallback for ordinary file inputs without reusable handles. */
export function connectProjectMedia(
  files: readonly File[],
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  return connectProjectMediaSelections(
    files.map((file) => ({ file, handle: null })),
    deps,
  )
}

export function canRememberProjectMedia(): boolean {
  return supportsLocalMediaHandles()
}

/** Pick reusable handles and seed future automatic resumes after validation. */
export async function chooseProjectMedia(
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const pending = pendingResume
  if (!pending) {
    const message = 'Choose a valid .webcut project before reconnecting media'
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return { status: 'failed', message }
  }
  try {
    const selections = await deps.pickMediaFiles(true)
    return connectProjectMediaSelections(
      selections.map(({ file, handle }) => ({ file, handle })),
      deps,
    )
  } catch (cause) {
    if (isLocalMediaPickerCancellation(cause)) return { status: 'ready' }
    const message = `Could not choose source media: ${messageFrom(cause)}`
    publishResumeCandidate(pending, message)
    return { status: 'failed', message }
  }
}

interface ActiveMediaSelection {
  file: File
  handle: LocalMediaFileHandle | null
}

interface ActiveMediaPickerContext {
  documentId: string
  generation: number
}

function beginActiveMediaPicker(
  deps: Pick<ProjectControllerDeps, 'revokeObjectURL'>,
): ActiveMediaPickerContext | null {
  if (useProjectSessionStore.getState().screen !== 'editor') return null
  const documentId = useDocumentStore.getState().doc.id
  invalidateActiveMediaRelink(deps)
  return { documentId, generation: activeMediaRelinkGeneration }
}

function activeMediaPickerIsCurrent(
  context: ActiveMediaPickerContext,
): boolean {
  return context.generation === activeMediaRelinkGeneration
    && useProjectSessionStore.getState().screen === 'editor'
    && useDocumentStore.getState().doc.id === context.documentId
}

async function connectActiveAssetSelection(
  assetId: string,
  selection: ActiveMediaSelection,
  deps: ProjectControllerDeps,
): Promise<ProjectActionResult> {
  const media = useMediaStore.getState()
  const descriptor = media.descriptors.get(assetId)
  if (
    useProjectSessionStore.getState().screen !== 'editor'
    || !descriptor
    || media.assets.has(assetId)
  ) {
    const message = 'That source is no longer offline in the active project.'
    return { status: 'failed', message }
  }

  const work = createActiveMediaRelinkWork(1, deps)
  if (!work) {
    return { status: 'failed', message: 'Open a project before reconnecting media.' }
  }
  const result = await runActiveMediaRelinkTransaction(
    work,
    {
      kind: 'individual',
      assetId,
      file: selection.file,
      handle: selection.handle,
      displayPath: selection.file.name,
    },
    deps,
    {
      claimForCommit: (currentDescriptor) => {
        if (!activeRelinkIsCurrent(work)) return false
        const current = useMediaStore.getState()
        return current.descriptors.get(assetId) === currentDescriptor
          && !current.assets.has(assetId)
      },
      releaseSelection: () => {},
    },
  )
  if (activeRelinkIsCurrent(work)) finishActiveMediaRelink(work)
  if (result.status === 'connected') return { status: 'ready' }
  if (result.status === 'cancelled') return result
  return {
    status: 'failed',
    message: result.message
      ?? `Could not reconnect "${descriptor.fileName}".`,
  }
}

/** Compatibility path for browsers that expose only an ordinary file input. */
export function connectActiveAssetMedia(
  assetId: string,
  file: File,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  return connectActiveAssetSelection(assetId, { file, handle: null }, deps)
}

/** Pick one reusable source handle for a specific offline editor asset. */
export async function chooseActiveAssetMedia(
  assetId: string,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const context = beginActiveMediaPicker(deps)
  if (!context) {
    return { status: 'failed', message: 'Open a project before reconnecting media.' }
  }
  try {
    // Invoke before the first await so the click retains user activation.
    const selections = await deps.pickMediaFiles(false)
    if (!activeMediaPickerIsCurrent(context)) return { status: 'cancelled' }
    const selection = selections[0]
    return selection
      ? connectActiveAssetSelection(assetId, selection, deps)
      : { status: 'ready' }
  } catch (cause) {
    if (!activeMediaPickerIsCurrent(context)) return { status: 'cancelled' }
    if (isLocalMediaPickerCancellation(cause)) return { status: 'ready' }
    const message = `Could not choose source media: ${messageFrom(cause)}`
    useProjectSessionStore.setState({
      activeMediaRelink: {
        ...INITIAL_ACTIVE_MEDIA_RELINK,
        phase: 'complete',
        errors: [message],
      },
    })
    return { status: 'failed', message }
  }
}

/** Analyze one selected folder and stage only safe matches for offline assets. */
export async function connectActiveMediaFolder(
  selections: readonly LocalMediaFolderSelection[],
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const work = createActiveMediaRelinkWork(selections.length, deps)
  if (!work) {
    return { status: 'failed', message: 'Open a project before reconnecting media.' }
  }
  if (currentOfflineDescriptors().length === 0 || selections.length === 0) {
    finishActiveMediaRelink(work)
    return { status: 'ready' }
  }

  for (const selection of selections) {
    if (!activeRelinkIsCurrent(work)) return { status: 'cancelled' }
    const possibleBySize = currentOfflineDescriptors().some(
      (descriptor) => descriptor.size === selection.file.size,
    )
    if (!possibleBySize) {
      work.skippedCount++
      continue
    }

    let analyzed: MediaAsset | null = null
    try {
      const probeRequestId = deps.createCompatibilityRequestId()
      const inspection = await deps.inspectMedia(
        selection.file,
        work.documentRate,
        temporaryProbeId(probeRequestId),
        work.abortController.signal,
      )
      if (inspection.asset) analyzed = inspection.asset
      if (!activeRelinkIsCurrent(work)) {
        if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
        return { status: 'cancelled' }
      }
      if (!inspection.asset) {
        work.skippedCount++
        work.errors.push(
          inspection.compatibility.detail
            ?? `Could not use "${selection.relativePath}" in this browser.`,
        )
        publishActiveMediaRelink(work, 'scanning')
        continue
      }
      const candidateIds = narrowedFolderCandidates(selection.file, inspection)
      deps.revokeObjectURL(inspection.asset.objectUrl)
      analyzed = null
      if (candidateIds.size === 0) {
        work.skippedCount++
        continue
      }
      work.staged.push({
        token: `source-${work.generation}-${++activeMediaRelinkToken}`,
        file: selection.file,
        handle: selection.handle,
        relativePath: selection.relativePath,
        candidateIds,
      })
    } catch (cause) {
      if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
      if (!activeRelinkIsCurrent(work)) return { status: 'cancelled' }
      if (!isMediaProbeCancellation(cause)) {
        work.skippedCount++
        work.errors.push(
          `Could not inspect "${selection.relativePath}": ${messageFrom(cause)}`,
        )
      }
    }
    publishActiveMediaRelink(work, 'scanning')
  }

  await settleActiveMediaRelink(work, deps)
  return activeRelinkIsCurrent(work) || work.outcome === 'complete'
    ? { status: 'ready' }
    : { status: 'cancelled' }
}

export function canChooseActiveMediaFolder(): boolean {
  return supportsLocalMediaFolders()
}

/** Pick a reusable folder handle, then run conservative batch matching. */
export async function chooseActiveMediaFolder(
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const context = beginActiveMediaPicker(deps)
  if (!context) {
    return { status: 'failed', message: 'Open a project before reconnecting media.' }
  }
  useProjectSessionStore.setState({
    activeMediaRelink: {
      ...INITIAL_ACTIVE_MEDIA_RELINK,
      phase: 'scanning',
    },
  })
  try {
    // Invoke before the first await so the click retains user activation.
    const selections = await deps.pickMediaFolder()
    if (!activeMediaPickerIsCurrent(context)) return { status: 'cancelled' }
    return connectActiveMediaFolder(selections, deps)
  } catch (cause) {
    if (!activeMediaPickerIsCurrent(context)) return { status: 'cancelled' }
    if (isLocalMediaPickerCancellation(cause)) {
      useProjectSessionStore.setState({
        activeMediaRelink: INITIAL_ACTIVE_MEDIA_RELINK,
      })
      return { status: 'ready' }
    }
    const message = `Could not scan the media folder: ${messageFrom(cause)}`
    useProjectSessionStore.setState({
      activeMediaRelink: {
        ...INITIAL_ACTIVE_MEDIA_RELINK,
        phase: 'complete',
        errors: [message],
      },
    })
    return { status: 'failed', message }
  }
}

/** Explicitly map one staged folder file to the shown offline asset. */
export async function resolveActiveMediaAmbiguity(
  ambiguityToken: string,
  sourceToken: string,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const work = activeMediaRelinkWork
  const ambiguity = useProjectSessionStore.getState().activeMediaRelink.ambiguity
  if (
    !work
    || !activeRelinkIsCurrent(work)
    || work.ambiguityToken !== ambiguityToken
    || ambiguity?.token !== ambiguityToken
  ) {
    return { status: 'cancelled' }
  }
  const staged = work.staged.find((entry) => entry.token === sourceToken)
  if (!staged || !staged.candidateIds.has(ambiguity.assetId)) {
    const message = 'That folder match is no longer available.'
    return { status: 'failed', message }
  }
  work.ambiguityToken = null
  await connectStagedFolderMedia(work, staged, ambiguity.assetId, deps)
  if (!activeRelinkIsCurrent(work)) return { status: 'cancelled' }
  await settleActiveMediaRelink(work, deps)
  return { status: 'ready' }
}

/** Leave the displayed asset offline and continue resolving the batch. */
export async function skipActiveMediaAmbiguity(
  ambiguityToken: string,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const work = activeMediaRelinkWork
  const ambiguity = useProjectSessionStore.getState().activeMediaRelink.ambiguity
  if (
    !work
    || !activeRelinkIsCurrent(work)
    || work.ambiguityToken !== ambiguityToken
    || ambiguity?.token !== ambiguityToken
  ) {
    return { status: 'cancelled' }
  }
  for (const staged of work.staged) {
    staged.candidateIds.delete(ambiguity.assetId)
  }
  work.ambiguityToken = null
  await settleActiveMediaRelink(work, deps)
  return activeRelinkIsCurrent(work) || work.outcome === 'complete'
    ? { status: 'ready' }
    : { status: 'cancelled' }
}

/** Cancel only unresolved folder choices; already connected sources stay online. */
export function cancelActiveMediaRelink(
  _deps: Pick<ProjectControllerDeps, 'revokeObjectURL'> = realDeps,
): void {
  const work = activeMediaRelinkWork
  if (!work || !activeRelinkIsCurrent(work)) return
  work.abortController.abort()
  for (const [id, requestId] of work.checkingRequests) {
    rollbackDescriptorCompatibility(id, requestId)
  }
  work.checkingRequests.clear()
  work.skippedCount += work.staged.length
  work.staged = []
  activeMediaRelinkWork = null
  activeMediaRelinkGeneration++
  work.outcome = 'cancelled'
  useProjectSessionStore.setState({
    activeMediaRelink: {
      phase: 'complete',
      scannedFileCount: work.scannedFileCount,
      connectedCount: work.connectedCount,
      skippedCount: work.skippedCount,
      errors: [...work.errors],
      ambiguity: null,
    },
  })
}

interface PermissionRequest {
  descriptor: PortableAssetDescriptor
  handle: LocalMediaFileHandle
  permission: Promise<LocalMediaPermission>
}

async function restoreRequestedMediaAndActivate(
  pending: PendingResume,
  generation: number,
  requests: readonly PermissionRequest[],
  deps: ProjectControllerDeps,
): Promise<ProjectActionResult> {
  const permissions = await Promise.allSettled(
    requests.map((request) => request.permission),
  )
  if (!pendingIsCurrent(pending, generation)) return { status: 'cancelled' }

  const errors: string[] = []
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]
    const permission = permissions[index]
    if (permission.status === 'rejected') {
      pending.rememberedHandles.delete(request.descriptor.id)
      errors.push(
        `Could not request access to "${request.descriptor.fileName}": ${messageFrom(permission.reason)}.`,
      )
      continue
    }
    if (permission.value !== 'granted') {
      pending.rememberedHandles.delete(request.descriptor.id)
      errors.push(`Access to "${request.descriptor.fileName}" was not granted.`)
      continue
    }
    const restored = await restoreRememberedDescriptor(
      pending,
      request.descriptor,
      request.handle,
      generation,
      deps,
    )
    if (restored.status === 'cancelled') return restored
    if (restored.status === 'failed') errors.push(restored.message)
  }

  const result = await activateProject(
    pending.project.document,
    pending.project.assets,
    [...pending.assets.values()],
    [...pending.compatibility.values()],
    pendingPersistenceSession(pending),
    generation,
    deps,
  )
  if (result.status === 'activated' && errors.length > 0) {
    useProjectSessionStore.setState({
      activeMediaRelink: {
        ...INITIAL_ACTIVE_MEDIA_RELINK,
        phase: 'complete',
        errors,
      },
    })
  }
  return result
}

/** Activate after ready sources, requesting remembered permission from this click. */
export function activateResumedProject(
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const pending = pendingResume
  if (!pending) {
    const message = 'Choose a valid .webcut project first'
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return Promise.resolve({ status: 'failed', message })
  }
  const generation = operationGeneration
  const remembered = pending.project.assets.flatMap((descriptor) => {
    const handle = pending.rememberedHandles.get(descriptor.id)
    return handle ? [{ descriptor, handle }] : []
  })
  if (remembered.length === 0) {
    return activateProject(
      pending.project.document,
      pending.project.assets,
      [...pending.assets.values()],
      [...pending.compatibility.values()],
      pendingPersistenceSession(pending),
      generation,
      deps,
    )
  }

  useProjectSessionStore.setState({ phase: 'relinking', error: null })
  // Start every permission request synchronously inside the Open click. Awaiting
  // first would lose the browser's transient user activation.
  const requests: PermissionRequest[] = remembered.map(({ descriptor, handle }) => {
    let permission: Promise<LocalMediaPermission>
    try {
      permission = deps.requestMediaPermission(handle)
    } catch (cause) {
      permission = Promise.reject(cause)
    }
    return { descriptor, handle, permission }
  })
  return restoreRequestedMediaAndActivate(
    pending,
    generation,
    requests,
    deps,
  )
}

/** Test/HMR seam: discard uncommitted resources and restore launch state. */
export function resetProjectController(
  deps: Pick<ProjectControllerDeps, 'revokeObjectURL'> = realDeps,
): void {
  invalidatePending(deps)
  suspendProjectPersistenceSession()
  useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE })
}
