/**
 * app/sourceMonitorController.ts — composition-root open path for Source
 * Monitor. Looks up the Media Pool catalog, records session facts, and
 * never opens a Blob from UI. Program playhead and TimelineDoc stay put.
 */

import {
  openSourceMonitor,
  type SourceMonitorOpenRejection,
  type SourceMonitorOpenResult,
} from '../domain/sourceMonitor'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'

const OPEN_REJECTION_MESSAGES: Readonly<
  Record<SourceMonitorOpenRejection, string>
> = Object.freeze({
  offline: 'This source is offline. Reconnect it in the Media panel.',
  incompatible:
    'This source is not ready for review. Check compatibility in the Media panel.',
  'invalid-duration': 'This source has no reviewable duration.',
})

let selectedPoolAssetId: string | null = null

export function sourceMonitorOpenRejectionMessage(
  reason: SourceMonitorOpenRejection,
): string {
  return OPEN_REJECTION_MESSAGES[reason]
}

export function getSelectedPoolAssetId(): string | null {
  return selectedPoolAssetId
}

export function setSelectedPoolAssetId(assetId: string | null): void {
  selectedPoolAssetId = assetId
}

export function clearSelectedPoolAssetId(): void {
  selectedPoolAssetId = null
}

export function sourceOpenDisabledReason(
  assetId: string | null = getSelectedPoolAssetId(),
): string | null {
  if (!assetId) return 'Select a Media Pool asset first.'
  const media = useMediaStore.getState()
  if (
    !media.descriptors.has(assetId)
    && !media.assets.has(assetId)
    && !media.compatibility.has(assetId)
  ) {
    return 'This Media Pool asset no longer exists.'
  }
  const probe = openSourceMonitor(null, {
    asset: media.assets.get(assetId) ?? null,
    compatibility: media.compatibility.get(assetId),
  })
  if (probe.status === 'rejected') {
    return sourceMonitorOpenRejectionMessage(probe.reason)
  }
  return null
}

export function openSourceAsset(assetId: string): SourceMonitorOpenResult {
  const media = useMediaStore.getState()
  return useSourceMonitorStore.getState().openSource({
    asset: media.assets.get(assetId) ?? null,
    compatibility: media.compatibility.get(assetId),
  })
}

export function openSelectedSource(): SourceMonitorOpenResult {
  const assetId = getSelectedPoolAssetId()
  if (!assetId) {
    return {
      status: 'rejected',
      reason: 'offline',
      session: useSourceMonitorStore.getState().session,
    }
  }
  return openSourceAsset(assetId)
}
