import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaCompatibilityStatus,
} from '../domain/mediaCompatibility'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { FrameRate, MediaAsset } from '../domain/schema'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import type { LocalMediaFileHandle } from './localMediaHandles'
import { compatibilityItemForAsset } from './mediaCompatibilityController'
import {
  compatibilityReportMatchesDescriptor,
  inspectionCandidateForDescriptor,
  relinkedAsset,
} from './projectMediaMatching'

export interface ActiveMediaRelinkSelection {
  kind: 'individual' | 'folder'
  assetId: string
  file: File
  handle: LocalMediaFileHandle | null
  /** Relative folder path for folder scans; file name for individual relinks. */
  displayPath: string
}

export interface ActiveMediaRelinkContext {
  projectBindingId: string
  documentRate: FrameRate
  signal: AbortSignal
}

export type ActiveMediaRelinkTransactionResult =
  | { status: 'connected' }
  | { status: 'cancelled' }
  | { status: 'failed'; message?: string }

interface ActiveMediaRelinkStorePort {
  getDescriptor(assetId: string): PortableAssetDescriptor | null
  hasConnectedAsset(assetId: string): boolean
  startCompatibility(item: MediaCompatibilityItem): boolean
  setCompatibility(
    assetId: string,
    requestId: string,
    status: MediaCompatibilityStatus,
    report: MediaCompatibilityReport,
  ): boolean
  rollbackCompatibility(assetId: string, requestId: string): boolean
  connectAsset(asset: MediaAsset, compatibility: MediaCompatibilityItem): boolean
}

interface ActiveMediaRelinkProgressPort {
  checkingStarted(assetId: string, requestId: string): void
  checkingFinished(assetId: string): void
  connected(): void
  skipped(message?: string): void
  warning(message: string): void
  publishConnected(): void
}

export interface ActiveMediaRelinkCoordinatorDeps {
  createCompatibilityRequestId(): string
  createCheckingItem(
    descriptor: PortableAssetDescriptor,
    requestId: string,
  ): MediaCompatibilityItem
  createFailureReport(fileName: string, cause: unknown): MediaCompatibilityReport
  inspectMedia(
    file: File,
    documentRate: FrameRate,
    assetId: string,
    signal: AbortSignal,
  ): Promise<MediaProbeResult>
  rememberMediaHandle(
    documentId: string,
    assetId: string,
    handle: LocalMediaFileHandle,
  ): Promise<void>
  revokeObjectURL(url: string): void
  isProbeCancellation(cause: unknown): boolean
  isCurrent(): boolean
  /**
   * Revalidate controller-local ownership immediately before the media store
   * takes the accepted URL. Folder relinks remove their staged File/handle here.
   */
  claimForCommit(descriptor: PortableAssetDescriptor): boolean
  /** Release a rejected or failed staged folder selection. Individual relinks noop. */
  releaseSelection(): void
  store: ActiveMediaRelinkStorePort
  progress: ActiveMediaRelinkProgressPort
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function candidateFailureMessage(
  selection: ActiveMediaRelinkSelection,
  descriptor: PortableAssetDescriptor,
  inspection: MediaProbeResult,
): string {
  if (selection.kind === 'folder') {
    return inspection.compatibility.detail
      ?? `"${selection.displayPath}" is not compatible in this browser.`
  }
  return `"${selection.file.name}" could not be verified as "${descriptor.fileName}".`
}

function unavailableCommitResult(
  selection: ActiveMediaRelinkSelection,
): ActiveMediaRelinkTransactionResult {
  if (selection.kind === 'individual') return { status: 'cancelled' }
  return {
    status: 'failed',
    message: `Could not safely reconnect "${selection.displayPath}".`,
  }
}

function connectionFailureMessage(
  descriptor: PortableAssetDescriptor,
): string {
  return `Could not reconnect "${descriptor.fileName}".`
}

/**
 * Own the one high-risk active-project relink transaction: inspect, revalidate,
 * transfer the object URL, publish compatibility, remember the handle, and
 * release every uncommitted resource on rejection, cancellation, or races.
 */
export function createActiveMediaRelinkCoordinator(
  deps: ActiveMediaRelinkCoordinatorDeps,
): {
  connect(
    selection: ActiveMediaRelinkSelection,
    context: ActiveMediaRelinkContext,
  ): Promise<ActiveMediaRelinkTransactionResult>
} {
  return {
    async connect(selection, context) {
      const initialDescriptor = deps.store.getDescriptor(selection.assetId)
      if (
        !initialDescriptor
        || deps.store.hasConnectedAsset(selection.assetId)
      ) return { status: 'cancelled' }

      let analyzed: MediaAsset | null = null
      let requestId: string | null = null
      let checkingStarted = false
      try {
        requestId = deps.createCompatibilityRequestId()
        if (!deps.store.startCompatibility(
          deps.createCheckingItem(initialDescriptor, requestId),
        )) {
          const message = `Could not start rechecking "${initialDescriptor.fileName}".`
          deps.progress.skipped(message)
          return { status: 'failed', message }
        }
        checkingStarted = true
        deps.progress.checkingStarted(selection.assetId, requestId)

        const inspection = await deps.inspectMedia(
          selection.file,
          context.documentRate,
          selection.assetId,
          context.signal,
        )
        if (inspection.asset) analyzed = inspection.asset
        if (!deps.isCurrent()) {
          if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
          return { status: 'cancelled' }
        }

        const initialCandidate = selection.kind === 'individual'
          ? inspectionCandidateForDescriptor(initialDescriptor, inspection)
          : null
        if (selection.kind === 'individual' && !initialCandidate) {
          if (analyzed) {
            deps.revokeObjectURL(analyzed.objectUrl)
            analyzed = null
          }
          deps.releaseSelection()
          deps.progress.checkingFinished(selection.assetId)
          checkingStarted = false
          const reportMatches = inspection.status !== 'ready'
            && compatibilityReportMatchesDescriptor(
              initialDescriptor,
              selection.file,
              inspection.compatibility,
            )
          if (reportMatches) {
            deps.store.setCompatibility(
              selection.assetId,
              requestId,
              inspection.status,
              inspection.compatibility,
            )
          } else {
            deps.store.rollbackCompatibility(selection.assetId, requestId)
          }
          const message = reportMatches
            ? inspection.compatibility.detail
              ?? `"${selection.file.name}" is not compatible in this browser.`
            : candidateFailureMessage(
                selection,
                initialDescriptor,
                inspection,
              )
          deps.progress.skipped(message)
          return { status: 'failed', message }
        }

        const currentDescriptor = deps.store.getDescriptor(selection.assetId)
        if (
          selection.kind === 'individual'
          && (
            !currentDescriptor
            || deps.store.hasConnectedAsset(selection.assetId)
          )
        ) {
          if (analyzed) {
            deps.revokeObjectURL(analyzed.objectUrl)
            analyzed = null
          }
          deps.releaseSelection()
          deps.progress.checkingFinished(selection.assetId)
          checkingStarted = false
          deps.store.rollbackCompatibility(selection.assetId, requestId)
          const result = unavailableCommitResult(selection)
          deps.progress.skipped(result.status === 'failed' ? result.message : undefined)
          return result
        }

        if (!currentDescriptor) {
          if (analyzed) {
            deps.revokeObjectURL(analyzed.objectUrl)
            analyzed = null
          }
          deps.releaseSelection()
          deps.progress.checkingFinished(selection.assetId)
          checkingStarted = false
          deps.store.rollbackCompatibility(selection.assetId, requestId)
          const message = inspection.compatibility.detail
            ?? `"${selection.displayPath}" is not compatible in this browser.`
          deps.progress.skipped(message)
          return { status: 'failed', message }
        }

        const candidate = inspectionCandidateForDescriptor(
          currentDescriptor,
          inspection,
        )
        if (!candidate) {
          if (analyzed) {
            deps.revokeObjectURL(analyzed.objectUrl)
            analyzed = null
          }
          deps.releaseSelection()
          deps.progress.checkingFinished(selection.assetId)
          checkingStarted = false
          if (
            selection.kind === 'folder'
            && inspection.status !== 'ready'
            && compatibilityReportMatchesDescriptor(
              currentDescriptor,
              selection.file,
              inspection.compatibility,
            )
          ) {
            deps.store.setCompatibility(
              selection.assetId,
              requestId,
              inspection.status,
              inspection.compatibility,
            )
          } else {
            deps.store.rollbackCompatibility(selection.assetId, requestId)
          }
          const message = selection.kind === 'individual' && initialCandidate
            ? `"${selection.file.name}" does not match "${currentDescriptor.fileName}".`
            : candidateFailureMessage(selection, currentDescriptor, inspection)
          deps.progress.skipped(message)
          return { status: 'failed', message }
        }

        if (!deps.claimForCommit(currentDescriptor)) {
          deps.revokeObjectURL(candidate.asset.objectUrl)
          analyzed = null
          deps.releaseSelection()
          deps.progress.checkingFinished(selection.assetId)
          checkingStarted = false
          deps.store.rollbackCompatibility(selection.assetId, requestId)
          const result = unavailableCommitResult(selection)
          deps.progress.skipped(result.status === 'failed' ? result.message : undefined)
          return result
        }

        const connected = relinkedAsset(
          currentDescriptor,
          candidate.asset,
          context.documentRate,
        )
        const readyItem = compatibilityItemForAsset(
          connected,
          requestId,
          'ready',
          candidate.compatibility,
        )
        if (!deps.store.connectAsset(connected, readyItem)) {
          const message = connectionFailureMessage(currentDescriptor)
          deps.revokeObjectURL(candidate.asset.objectUrl)
          analyzed = null
          deps.progress.checkingFinished(selection.assetId)
          checkingStarted = false
          deps.store.rollbackCompatibility(selection.assetId, requestId)
          deps.progress.skipped(message)
          return { status: 'failed', message }
        }

        analyzed = null // mediaStore now owns the accepted connection URL
        deps.progress.checkingFinished(selection.assetId)
        checkingStarted = false
        deps.progress.connected()
        deps.progress.publishConnected()

        if (selection.handle) {
          try {
            await deps.rememberMediaHandle(
              context.projectBindingId,
              currentDescriptor.id,
              selection.handle,
            )
          } catch (cause) {
            if (deps.isCurrent()) {
              deps.progress.warning(
                `Reconnected "${currentDescriptor.fileName}", but could not remember it: ${messageFrom(cause)}`,
              )
            }
          }
        }
        return deps.isCurrent()
          ? { status: 'connected' }
          : { status: 'cancelled' }
      } catch (cause) {
        if (analyzed) deps.revokeObjectURL(analyzed.objectUrl)
        if (!deps.isCurrent()) return { status: 'cancelled' }
        deps.releaseSelection()
        if (checkingStarted && requestId) {
          deps.progress.checkingFinished(selection.assetId)
          checkingStarted = false
          deps.store.setCompatibility(
            selection.assetId,
            requestId,
            'error',
            deps.createFailureReport(selection.file.name, cause),
          )
        }
        const message = selection.kind === 'folder'
          ? `Could not reconnect "${selection.displayPath}": ${messageFrom(cause)}`
          : `Could not reconnect "${initialDescriptor.fileName}": ${messageFrom(cause)}`
        const visibleMessage = selection.kind === 'folder'
          && deps.isProbeCancellation(cause)
            ? undefined
            : message
        deps.progress.skipped(visibleMessage)
        return { status: 'failed', ...(visibleMessage ? { message } : {}) }
      }
    },
  }
}
