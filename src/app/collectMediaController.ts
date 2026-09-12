/**
 * Collect-media composition root.
 *
 * Builds a local archive beside ordinary Save/Save As. The current writable
 * project handle is never replaced. Files and directory capabilities stay here.
 */

import {
  assetFactsFromDescriptors,
  collectArchiveIsComplete,
  DEFAULT_COLLECT_MEDIA_POLICY,
  isCollectArchiveProjectFileName,
  manifestItemFromPreflight,
  planCollectMediaPreflight,
  referencedFontFacts,
  type CollectMediaFingerprint,
  type CollectMediaInclusionPolicy,
  type CollectMediaManifest,
  type CollectMediaManifestItem,
  type CollectMediaPreflight,
  type CollectMediaPreflightItem,
  type CollectMediaSourceFact,
} from '../domain/collectMedia'
import {
  createProjectFileSnapshot,
  serializeProjectFile,
  type PortableAssetDescriptor,
} from '../domain/projectFile'
import type { MediaCollection } from '../domain/mediaCollections'
import type { SequenceProject } from '../domain/projectSequences'
import type { MediaAsset } from '../domain/schema'
import type { ProxyCacheEntry } from '../domain/proxyCache'
import type { TitleTemplateLibraryView, TitleTemplateV1 } from '../domain/titleTemplates'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useProxyStore, type ProxyAssetState } from '../state/proxyStore'
import {
  finalizeCollectArchive,
  isCollectMediaAbort,
  isCollectMediaPermissionFailure,
  isCollectMediaQuotaFailure,
  prepareCollectDestination,
  writeBlobAtRelativePath,
  writeTextFile,
  type CollectMediaDirectoryHandle,
} from './collectMediaArchive'
import {
  localMediaHandleRegistry,
  queryLocalMediaPermission,
  type LocalMediaFileHandle,
  type LocalMediaPermission,
} from './localMediaHandles'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { projectFileName } from './projectPersistenceController'
import { proxyStorage } from './proxyStorage'
import { fingerprintLocalMediaSource } from './sourceFingerprint'
import { localTitleTemplateStorage } from './localTitleTemplateStorage'

export type CollectMediaPhase =
  | 'idle'
  | 'preflight'
  | 'copying'
  | 'writing-project'
  | 'writing-manifest'
  | 'complete'
  | 'partial'

export interface CollectMediaProgress {
  readonly phase: CollectMediaPhase
  readonly completedFiles: number
  readonly totalFiles: number
  readonly currentName: string | null
  readonly bytesCopied: number
}

export type CollectMediaResult =
  | {
      readonly status: 'complete'
      readonly manifest: CollectMediaManifest
      readonly projectFileName: string
      readonly destinationName: string
    }
  | {
      readonly status: 'partial'
      readonly manifest: CollectMediaManifest
      readonly projectFileName: string
      readonly destinationName: string
      readonly message: string
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string }

export interface CollectMediaControllerDeps {
  now(): number
  getBindingId(): string | null
  getProject(): SequenceProject
  getDescriptors(): Iterable<PortableAssetDescriptor>
  getCollections(): readonly MediaCollection[]
  getConnectedAsset(id: string): MediaAsset | undefined
  loadMediaHandle(
    bindingId: string,
    assetId: string,
  ): Promise<LocalMediaFileHandle | null>
  queryMediaPermission(handle: LocalMediaFileHandle): Promise<LocalMediaPermission>
  readHandleFile(handle: LocalMediaFileHandle): Promise<File>
  fetchBlob(url: string, signal?: AbortSignal): Promise<Blob>
  listProxyStates(): Iterable<ProxyAssetState>
  readProxyFile(entry: ProxyCacheEntry): Promise<File>
  loadTitleLibrary(): Promise<TitleTemplateLibraryView>
  readTitleTemplate(id: string): Promise<TitleTemplateV1>
  fingerprint(
    blob: Blob,
    identity: Pick<MediaAsset, 'fileName' | 'size' | 'lastModified'>,
  ): Promise<CollectMediaFingerprint>
  prepareDestination(
    root: CollectMediaDirectoryHandle,
  ): ReturnType<typeof prepareCollectDestination>
  writeBlob(
    root: CollectMediaDirectoryHandle,
    relativePath: string,
    blob: Blob,
    signal: AbortSignal,
    onChunk?: (bytes: number) => void,
  ): ReturnType<typeof writeBlobAtRelativePath>
  writeProjectFile(
    root: CollectMediaDirectoryHandle,
    fileName: string,
    text: string,
  ): Promise<void>
  finalize(
    root: CollectMediaDirectoryHandle,
    manifest: CollectMediaManifest,
  ): Promise<boolean>
}

const realDeps: CollectMediaControllerDeps = {
  now: () => Date.now(),
  getBindingId: getActiveLocalProjectBindingId,
  getProject: () => useDocumentStore.getState().project,
  getDescriptors: () => useMediaStore.getState().descriptors.values(),
  getCollections: () => useMediaStore.getState().collections,
  getConnectedAsset: (id) => useMediaStore.getState().assets.get(id),
  loadMediaHandle: (bindingId, assetId) => (
    localMediaHandleRegistry.load(bindingId, assetId)
  ),
  queryMediaPermission: queryLocalMediaPermission,
  readHandleFile: (handle) => handle.getFile(),
  fetchBlob: async (url, signal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`Media source returned HTTP ${response.status}`)
    return response.blob()
  },
  listProxyStates: () => useProxyStore.getState().assets.values(),
  readProxyFile: (entry) => proxyStorage.readEntryFile(entry),
  loadTitleLibrary: () => localTitleTemplateStorage.load(),
  readTitleTemplate: (id) => localTitleTemplateStorage.read(id),
  fingerprint: async (blob, identity) => {
    const fingerprint = await fingerprintLocalMediaSource(blob, identity)
    return { algorithm: fingerprint.algorithm, digest: fingerprint.digest }
  },
  prepareDestination: prepareCollectDestination,
  writeBlob: writeBlobAtRelativePath,
  writeProjectFile: (root, fileName, text) => writeTextFile(root, fileName, text),
  finalize: finalizeCollectArchive,
}

let collectGeneration = 0
let collectAbort: AbortController | null = null

export function cancelCollectMedia(): void {
  collectAbort?.abort()
}

function messageFrom(cause: unknown): string {
  if (isCollectMediaAbort(cause)) return 'The collect-media copy was cancelled.'
  if (isCollectMediaQuotaFailure(cause)) {
    return 'The destination ran out of disk space or quota.'
  }
  if (isCollectMediaPermissionFailure(cause)) {
    return 'Write permission to the destination was lost.'
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function stopRemaining(
  cause: unknown,
): { fatal: boolean; message: string } {
  if (isCollectMediaAbort(cause) || isCollectMediaQuotaFailure(cause) || isCollectMediaPermissionFailure(cause)) {
    return { fatal: true, message: messageFrom(cause) }
  }
  return { fatal: false, message: messageFrom(cause) }
}

async function availableAssetIds(
  descriptors: readonly PortableAssetDescriptor[],
  deps: CollectMediaControllerDeps,
): Promise<Set<string>> {
  const available = new Set<string>()
  const bindingId = deps.getBindingId()
  for (const descriptor of descriptors) {
    if (deps.getConnectedAsset(descriptor.id)) {
      available.add(descriptor.id)
      continue
    }
    if (!bindingId) continue
    try {
      const handle = await deps.loadMediaHandle(bindingId, descriptor.id)
      if (!handle) continue
      if (await deps.queryMediaPermission(handle) !== 'granted') continue
      const file = await deps.readHandleFile(handle)
      if (file.size === descriptor.size) available.add(descriptor.id)
    } catch {
      // Preflight stays silent; the copy pass records a concrete omission.
    }
  }
  return available
}

function proxyFacts(
  descriptors: readonly PortableAssetDescriptor[],
  proxyStates: Iterable<ProxyAssetState>,
): CollectMediaSourceFact[] {
  const byAsset = new Map<string, ProxyAssetState>()
  for (const item of proxyStates) byAsset.set(item.assetId, item)
  return descriptors
    .filter((descriptor) => descriptor.kind === 'video')
    .map((descriptor) => {
      const item = byAsset.get(descriptor.id)
      const entry = item?.entry ?? null
      const ready = item?.phase === 'ready' && entry !== null
      return {
        id: `proxy:${descriptor.id}`,
        kind: 'proxy' as const,
        displayName: `${descriptor.fileName} proxy`,
        originalFileName: entry?.fileName ?? `${descriptor.fileName}.proxy.mp4`,
        size: entry?.byteSize ?? null,
        lastModified: entry?.createdAt ?? null,
        mimeType: 'video/mp4' as const,
        available: ready,
        referenced: true,
      }
    })
}

async function templateFacts(
  deps: CollectMediaControllerDeps,
): Promise<CollectMediaSourceFact[]> {
  try {
    const library = await deps.loadTitleLibrary()
    if (library.readOnlyReason) {
      return [{
        id: 'templates:library',
        kind: 'template',
        displayName: 'Title template library',
        originalFileName: 'title-library.json',
        size: null,
        lastModified: null,
        mimeType: 'application/json',
        available: false,
        referenced: false,
      }]
    }
    return library.templates.map((template) => ({
      id: template.id,
      kind: 'template' as const,
      displayName: template.name,
      originalFileName: `${template.name}.json`,
      size: null,
      lastModified: null,
      mimeType: 'application/json',
      available: true,
      referenced: false,
    }))
  } catch {
    return [{
      id: 'templates:library',
      kind: 'template',
      displayName: 'Title template library',
      originalFileName: 'title-library.json',
      size: null,
      lastModified: null,
      mimeType: 'application/json',
      available: false,
      referenced: false,
    }]
  }
}

export async function preflightCollectMedia(
  inclusionPolicy: CollectMediaInclusionPolicy = DEFAULT_COLLECT_MEDIA_POLICY,
  deps: CollectMediaControllerDeps = realDeps,
): Promise<CollectMediaPreflight> {
  const descriptors = [...deps.getDescriptors()]
  const availableIds = await availableAssetIds(descriptors, deps)
  const facts: CollectMediaSourceFact[] = [
    ...assetFactsFromDescriptors(descriptors, availableIds),
    ...proxyFacts(descriptors, deps.listProxyStates()),
    ...referencedFontFacts(deps.getProject()),
    ...await templateFacts(deps),
  ]
  return planCollectMediaPreflight(facts, inclusionPolicy)
}

async function sourceBlobForItem(
  item: CollectMediaPreflightItem,
  deps: CollectMediaControllerDeps,
  signal: AbortSignal,
): Promise<Blob> {
  if (item.kind === 'asset') {
    const connected = deps.getConnectedAsset(item.id)
    if (connected) return deps.fetchBlob(connected.objectUrl, signal)
    const bindingId = deps.getBindingId()
    if (!bindingId) throw new Error('This source is offline in this session.')
    const handle = await deps.loadMediaHandle(bindingId, item.id)
    if (!handle) throw new Error('This source is offline in this session.')
    return deps.readHandleFile(handle)
  }
  if (item.kind === 'proxy') {
    const assetId = item.id.slice('proxy:'.length)
    const entry = [...deps.listProxyStates()].find((state) => state.assetId === assetId)?.entry
    if (!entry) throw new Error('The editing proxy is no longer available.')
    return deps.readProxyFile(entry)
  }
  if (item.kind === 'template') {
    const template = await deps.readTitleTemplate(item.id)
    return new Blob([JSON.stringify(template)], { type: 'application/json' })
  }
  throw new Error('This item has no collectable file.')
}

function fingerprintIdentity(
  item: CollectMediaPreflightItem,
  blob: Blob,
): Pick<MediaAsset, 'fileName' | 'size' | 'lastModified'> {
  return {
    fileName: item.originalFileName ?? item.id,
    size: item.size ?? blob.size,
    lastModified: item.lastModified ?? 0,
  }
}

export async function collectActiveProject(
  destination: CollectMediaDirectoryHandle,
  inclusionPolicy: CollectMediaInclusionPolicy,
  onProgress: ((progress: CollectMediaProgress) => void) | undefined,
  deps: CollectMediaControllerDeps = realDeps,
): Promise<CollectMediaResult> {
  const generation = ++collectGeneration
  collectAbort?.abort()
  const abort = new AbortController()
  collectAbort = abort
  const publish = (progress: CollectMediaProgress): void => {
    if (generation === collectGeneration) onProgress?.(progress)
  }
  try {
    publish({
      phase: 'preflight',
      completedFiles: 0,
      totalFiles: 0,
      currentName: null,
      bytesCopied: 0,
    })
    const preflight = await preflightCollectMedia(inclusionPolicy, deps)
    if (abort.signal.aborted || generation !== collectGeneration) {
      return { status: 'cancelled' }
    }
    const copyable = preflight.items.filter((item) => (
      item.disposition === 'included' && item.plannedRelativePath
    ))
    await deps.prepareDestination(destination)
    const items: CollectMediaManifestItem[] = preflight.items.map((item) => (
      manifestItemFromPreflight(item)
    ))
    const byId = new Map(items.map((item) => [item.id, item]))
    const errors: string[] = []
    let completedFiles = 0
    let bytesCopied = 0
    let stopMessage: string | null = null

    for (const planned of copyable) {
      if (abort.signal.aborted) {
        stopMessage = 'The collect-media copy was cancelled.'
        break
      }
      publish({
        phase: 'copying',
        completedFiles,
        totalFiles: copyable.length,
        currentName: planned.originalFileName ?? planned.id,
        bytesCopied,
      })
      try {
        const blob = await sourceBlobForItem(planned, deps, abort.signal)
        if (planned.size !== null && blob.size !== planned.size) {
          throw new Error('The live source size no longer matches the project descriptor.')
        }
        const fingerprint = await deps.fingerprint(blob, fingerprintIdentity(planned, blob))
        await deps.writeBlob(
          destination,
          planned.plannedRelativePath!,
          blob,
          abort.signal,
          (bytes) => {
            bytesCopied += bytes
          },
        )
        byId.set(planned.id, manifestItemFromPreflight(planned, { fingerprint }))
        completedFiles += 1
      } catch (cause) {
        const halted = stopRemaining(cause)
        byId.set(planned.id, manifestItemFromPreflight(planned, {
          disposition: 'excluded',
          collectedRelativePath: null,
          error: halted.message,
          reason: 'This file was not collected.',
        }))
        errors.push(`${planned.originalFileName ?? planned.id}: ${halted.message}`)
        if (halted.fatal) {
          stopMessage = halted.message
          break
        }
      }
    }

    if (stopMessage) {
      for (const planned of copyable) {
        const current = byId.get(planned.id)
        if (current?.disposition === 'included' && current.collectedRelativePath) continue
        if (current?.error) continue
        byId.set(planned.id, manifestItemFromPreflight(planned, {
          disposition: 'excluded',
          collectedRelativePath: null,
          error: stopMessage,
          reason: 'Not copied because the archive stopped.',
        }))
      }
    }

    const archiveProjectName = projectFileName(deps.getProject().name)
    const projectFile = isCollectArchiveProjectFileName(archiveProjectName)
      ? archiveProjectName
      : 'project.myrelith'
    publish({
      phase: 'writing-project',
      completedFiles,
      totalFiles: copyable.length,
      currentName: projectFile,
      bytesCopied,
    })
    try {
      const snapshot = createProjectFileSnapshot(
        deps.getProject(),
        deps.getDescriptors(),
        deps.getCollections(),
      )
      await deps.writeProjectFile(
        destination,
        projectFile,
        serializeProjectFile(snapshot),
      )
    } catch (cause) {
      const message = messageFrom(cause)
      errors.push(`Project file: ${message}`)
      stopMessage ??= message
    }

    const copiedAll = copyable.every((planned) => {
      const current = byId.get(planned.id)
      return current?.disposition === 'included'
        && current.collectedRelativePath !== null
        && current.error === null
    })
    const status = !stopMessage && copiedAll && errors.length === 0 ? 'complete' : 'partial'
    const manifest: CollectMediaManifest = {
      format: 'myrelith-collect-media',
      formatVersion: 1,
      status,
      createdAt: deps.now(),
      projectFileName: projectFile,
      inclusionPolicy: { ...inclusionPolicy },
      items: preflight.items.map((item) => byId.get(item.id) ?? manifestItemFromPreflight(item)),
      errors,
    }

    publish({
      phase: 'writing-manifest',
      completedFiles,
      totalFiles: copyable.length,
      currentName: null,
      bytesCopied,
    })
    let complete = false
    try {
      complete = await deps.finalize(destination, manifest)
    } catch (cause) {
      const message = messageFrom(cause)
      return {
        status: 'partial',
        manifest: { ...manifest, status: 'partial', errors: [...errors, message] },
        projectFileName: projectFile,
        destinationName: destination.name,
        message,
      }
    }

    const finalized = complete && collectArchiveIsComplete(manifest, false)
    if (finalized) {
      publish({
        phase: 'complete',
        completedFiles,
        totalFiles: copyable.length,
        currentName: null,
        bytesCopied,
      })
      return {
        status: 'complete',
        manifest,
        projectFileName: projectFile,
        destinationName: destination.name,
      }
    }
    const message = stopMessage
      ?? (errors[0] ?? 'The collected archive is incomplete.')
    publish({
      phase: 'partial',
      completedFiles,
      totalFiles: copyable.length,
      currentName: null,
      bytesCopied,
    })
    return {
      status: 'partial',
      manifest: { ...manifest, status: 'partial' },
      projectFileName: projectFile,
      destinationName: destination.name,
      message,
    }
  } catch (cause) {
    if (isCollectMediaAbort(cause) || abort.signal.aborted) {
      return { status: 'cancelled' }
    }
    return { status: 'failed', message: messageFrom(cause) }
  } finally {
    if (collectAbort === abort) collectAbort = null
  }
}

export { DEFAULT_COLLECT_MEDIA_POLICY }
