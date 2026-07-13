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
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
}

interface PendingResume {
  project: ProjectFile
  projectFileName: string
  assets: Map<string, MediaAsset>
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
      status: pending.assets.has(asset.id) ? 'ready' : 'missing',
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
    }
    pendingResume = pending
    publishResumeCandidate(pending)
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

/** Analyze selected source files once and attach only exact relink matches. */
export async function connectProjectMedia(
  files: readonly File[],
  deps: ProjectControllerDeps = realDeps,
): Promise<ProjectActionResult> {
  const pending = pendingResume
  if (!pending) {
    const message = 'Choose a valid .webcut project before reconnecting media'
    useProjectSessionStore.setState({ phase: 'error', error: message })
    return { status: 'failed', message }
  }
  if (files.length === 0) return { status: 'ready' }

  const generation = operationGeneration
  useProjectSessionStore.setState({ phase: 'relinking', error: null })
  const errors: string[] = []

  for (const file of files) {
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
      analyzed = null // ownership moved to the pending candidate
      useProjectSessionStore.setState({ candidate: resumeSummary(pending) })
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

/** Activate only after every portable asset descriptor has a live source. */
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
    (descriptor) => !pending.assets.has(descriptor.id),
  )
  if (missing.length > 0) {
    const message = `Reconnect ${missing.length} missing source${missing.length === 1 ? '' : 's'} before opening`
    publishResumeCandidate(pending, message)
    return Promise.resolve({ status: 'failed', message })
  }
  return activateProject(
    pending.project.document,
    [...pending.assets.values()],
    pending.projectFileName,
    operationGeneration,
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
