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
import type { FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import { microsecondsToFrames, rateEquals } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  type ResumeProjectSummary,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import { inspectMediaFile } from './mediaInspection'
import { resetMediaImportController } from './mediaImportController'
import { disposeMediaVisuals } from './mediaVisualsController'
import {
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
  pickLocalMediaFiles,
  queryLocalMediaPermission,
  requestLocalMediaPermission,
  supportsLocalMediaHandles,
  type LocalMediaFileHandle,
  type LocalMediaPermission,
  type LocalMediaSelection,
} from './localMediaHandles'

export interface ProjectControllerDeps {
  createDocumentId(): string
  readText(file: File): Promise<string>
  inspectMedia(file: File, documentRate: FrameRate): Promise<MediaAsset>
  disposeExport(): Promise<void>
  disposeTransport(): Promise<void>
  disposePreview(): void
  disposeMediaVisuals(): void
  resetMediaImport(): void
  pauseProjectPersistence(): Promise<void>
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
  revokeObjectURL(url: string): void
}

export type ProjectActionResult =
  | { status: 'ready' }
  | { status: 'activated' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

const realDeps: ProjectControllerDeps = {
  createDocumentId: () => `doc_${crypto.randomUUID()}`,
  readText: (file) => file.text(),
  inspectMedia: inspectMediaFile,
  disposeExport: async () => {
    const { disposeExport } = await import('./exportController')
    await disposeExport()
  },
  disposeTransport,
  disposePreview,
  disposeMediaVisuals,
  resetMediaImport: resetMediaImportController,
  pauseProjectPersistence: pauseProjectPersistenceSession,
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
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
}

interface PendingResume {
  project: ProjectFile
  projectFileName: string
  assets: Map<string, MediaAsset>
  rememberedHandles: Map<string, LocalMediaFileHandle>
}

let pendingResume: PendingResume | null = null
let operationGeneration = 0

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function discardAssets(
  assets: ReadonlyMap<string, MediaAsset>,
  deps: Pick<ProjectControllerDeps, 'revokeObjectURL'> = realDeps,
): void {
  for (const asset of assets.values()) {
    deps.revokeObjectURL(asset.objectUrl)
  }
}

function invalidatePending(
  deps: Pick<ProjectControllerDeps, 'revokeObjectURL'> = realDeps,
): void {
  operationGeneration++
  if (pendingResume) discardAssets(pendingResume.assets, deps)
  pendingResume = null
}

function resumeSummary(pending: PendingResume): ResumeProjectSummary {
  const { document, assets } = pending.project
  return {
    projectFileName: pending.projectFileName,
    projectName: document.name,
    width: document.width,
    height: document.height,
    frameRate: { ...document.frameRate },
    audioSampleRate: document.audioSampleRate,
    assets: assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      kind: asset.kind,
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
  assets: readonly MediaAsset[],
  projectFileName: string | null,
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

    useMediaStore.getState().clearAssets()
    useDocumentStore.getState().setDoc(document)
    useTransportStore.getState().resetTransport()
    for (const asset of assets) {
      if (!useMediaStore.getState().addAsset(asset)) {
        throw new Error(`Could not activate duplicate media id ${asset.id}`)
      }
    }

    // Ownership of candidate URLs has moved into mediaStore.
    pendingResume = null
    useProjectSessionStore.setState({
      screen: 'editor',
      phase: 'idle',
      activeProjectName: document.name,
      activeProjectFileName: projectFileName,
      candidate: null,
      error: null,
    })
    deps.startProjectPersistence({
      fileName: projectFileName,
      persisted: projectFileName !== null,
    })
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
  return activateProject(document, [], null, generation, deps)
}

/** Parse and validate a portable project without changing the active editor. */
export async function openProjectFile(
  file: File,
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  invalidatePending(deps)
  const generation = operationGeneration
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'resume',
    phase: 'reading-project',
  })

  try {
    if (!file.name.toLowerCase().endsWith('.webcut')) {
      throw new Error('Choose a file ending in .webcut')
    }
    if (file.size > PROJECT_FILE_LIMITS.maxSerializedCharacters) {
      throw new Error('This project file is too large to open safely')
    }
    const serialized = await deps.readText(file)
    if (generation !== operationGeneration) return { status: 'cancelled' }
    const project = parseProjectFile(serialized)
    if (project.assets.some((asset) => asset.kind === 'image')) {
      throw new Error(
        'This project contains image sources, which this WebCut build cannot reconnect yet',
      )
    }
    const pending: PendingResume = {
      project,
      projectFileName: file.name,
      assets: new Map(),
      rememberedHandles: new Map(),
    }
    pendingResume = pending
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

function ratesMatch(
  descriptor: FrameRate | null,
  analyzed: FrameRate | null,
): boolean {
  if (descriptor === null || analyzed === null) return descriptor === analyzed
  return rateEquals(descriptor, analyzed)
}

function descriptorMatches(
  descriptor: PortableAssetDescriptor,
  analyzed: MediaAsset,
): boolean {
  return descriptor.size === analyzed.size
    && descriptor.kind === analyzed.kind
    && descriptor.durationMicroseconds === analyzed.durationMicroseconds
    && ratesMatch(descriptor.nativeFrameRate, analyzed.frameRate)
    && descriptor.width === analyzed.width
    && descriptor.height === analyzed.height
    && descriptor.hasAudio === analyzed.hasAudio
    && descriptor.audioSampleRate === analyzed.audioSampleRate
    && descriptor.audioChannels === analyzed.audioChannels
}

function selectDescriptor(
  pending: PendingResume,
  file: File,
  analyzed: MediaAsset,
): PortableAssetDescriptor {
  const matches = pending.project.assets.filter(
    (descriptor) =>
      !pending.assets.has(descriptor.id)
      && descriptorMatches(descriptor, analyzed),
  )
  if (matches.length === 0) {
    throw new Error(`"${file.name}" does not match any missing project source`)
  }
  if (matches.length === 1) return matches[0]

  const nameMatches = matches.filter(
    (descriptor) => descriptor.fileName === file.name,
  )
  if (nameMatches.length === 1) return nameMatches[0]
  const timestampMatches = (nameMatches.length > 0 ? nameMatches : matches)
    .filter((descriptor) => descriptor.lastModified === file.lastModified)
  if (timestampMatches.length === 1) return timestampMatches[0]
  throw new Error(
    `"${file.name}" matches more than one missing source; reconnect those files individually`,
  )
}

function relinkedAsset(
  descriptor: PortableAssetDescriptor,
  analyzed: MediaAsset,
  documentRate: FrameRate,
): MediaAsset {
  return {
    ...analyzed,
    id: descriptor.id,
    fileName: descriptor.fileName,
    mimeType: descriptor.mimeType,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
    kind: descriptor.kind,
    durationFrames: microsecondsToFrames(
      descriptor.durationMicroseconds,
      documentRate,
    ),
    durationMicroseconds: descriptor.durationMicroseconds,
    frameRate: descriptor.nativeFrameRate
      ? { ...descriptor.nativeFrameRate }
      : null,
    width: descriptor.width,
    height: descriptor.height,
    hasAudio: descriptor.hasAudio,
    audioSampleRate: descriptor.audioSampleRate,
    audioChannels: descriptor.audioChannels,
  }
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
  try {
    const file = await handle.getFile()
    if (!pendingIsCurrent(pending, generation)) {
      return { status: 'cancelled' }
    }
    analyzed = await deps.inspectMedia(
      file,
      pending.project.document.frameRate,
    )
    if (!pendingIsCurrent(pending, generation)) {
      deps.revokeObjectURL(analyzed.objectUrl)
      return { status: 'cancelled' }
    }
    if (
      !descriptorMatches(descriptor, analyzed)
      || descriptor.lastModified !== analyzed.lastModified
    ) {
      throw new Error('the remembered file changed since this project was saved')
    }
    const connected = relinkedAsset(
      descriptor,
      analyzed,
      pending.project.document.frameRate,
    )
    pending.assets.set(descriptor.id, connected)
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
    forgetStaleHandle(pending, descriptor, deps)
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
    try {
      analyzed = await deps.inspectMedia(file, pending.project.document.frameRate)
      if (generation !== operationGeneration || pending !== pendingResume) {
        deps.revokeObjectURL(analyzed.objectUrl)
        return { status: 'cancelled' }
      }
      const descriptor = selectDescriptor(pending, file, analyzed)
      const connected = relinkedAsset(
        descriptor,
        analyzed,
        pending.project.document.frameRate,
      )
      pending.assets.set(descriptor.id, connected)
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

  if (errors.length > 0) {
    const message = errors.join(' ')
    publishResumeCandidate(pending, message)
    return { status: 'failed', message }
  }
  const missing = pending.project.assets.filter(
    (descriptor) => !pending.assets.has(descriptor.id),
  )
  if (missing.length > 0) {
    const message = `Reconnect ${missing.length} missing source${missing.length === 1 ? '' : 's'} before opening`
    publishResumeCandidate(pending, message)
    return { status: 'failed', message }
  }
  return activateProject(
    pending.project.document,
    [...pending.assets.values()],
    pending.projectFileName,
    generation,
    deps,
  )
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
  const missing = pending.project.assets.filter(
    (descriptor) => (
      !pending.assets.has(descriptor.id)
      && !pending.rememberedHandles.has(descriptor.id)
    ),
  )
  if (missing.length > 0) {
    const message = `Reconnect ${missing.length} missing source${missing.length === 1 ? '' : 's'} before opening`
    publishResumeCandidate(pending, message)
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
      [...pending.assets.values()],
      pending.projectFileName,
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
