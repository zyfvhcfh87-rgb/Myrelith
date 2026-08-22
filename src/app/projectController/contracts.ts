
import type { FrameRate } from '../../domain/schema';
import { type MediaProbeResult } from '../../pipeline/mediaCompatibilityProbe';
import { type ProjectPersistenceSession } from '../projectPersistenceController';
import { type LocalMediaFileHandle, type LocalMediaFolderSelection, type LocalMediaPermission, type LocalMediaSelection } from '../localMediaHandles';
import { type LocalProjectFileHandle, type LocalProjectPermission, type LocalProjectSelection, type RecentProjectRecord, type RecoveryJournalRecord } from '../localProjectStorage';

export interface ProjectControllerDeps {
  createDocumentId(): string
  createProjectBindingId(): string
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
  disposePreview(): Promise<void>
  disposePlugins(): Promise<void>
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
