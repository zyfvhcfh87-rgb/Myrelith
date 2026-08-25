/**
 * app/sourceMonitorController.ts — composition-root open path for Source
 * Monitor. Looks up the Media Pool catalog, records session facts, and
 * never opens a Blob from UI. Program playhead and TimelineDoc stay put.
 */

import {
  MEDIA_OFFLINE_STATUS,
  mediaCompatibilityRemediationLines,
  mediaCompatibilityStatusText,
} from '../domain/mediaCompatibility'
import type { MediaAsset } from '../domain/schema'
import {
  openSourceMonitor,
  sourceMonitorSourceFacts,
  type SourceMonitorOpenRejection,
  type SourceMonitorOpenResult,
  type SourceMonitorSession,
} from '../domain/sourceMonitor'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'

const OPEN_REJECTION_MESSAGES: Readonly<
  Record<SourceMonitorOpenRejection, string>
> = Object.freeze({
  offline: MEDIA_OFFLINE_STATUS,
  incompatible: mediaCompatibilityStatusText(undefined),
  'invalid-duration': 'This source has no reviewable duration.',
})

export interface SourceMonitorStatusCopy {
  readonly kind: 'offline' | 'incompatible' | 'invalid-duration' | 'runtime'
  readonly lines: readonly string[]
}

let selectedPoolAssetId: string | null = null
let lastStatusAssetId: string | null = null

export function sourceMonitorOpenRejectionMessage(
  reason: SourceMonitorOpenRejection,
): string {
  return OPEN_REJECTION_MESSAGES[reason]
}

export function sourceMonitorStatusCopy(): SourceMonitorStatusCopy | null {
  const { session, lastOpenRejection } = useSourceMonitorStore.getState()
  const media = useMediaStore.getState()
  const liveAssetId = session?.source.assetId ?? null
  const liveAsset = liveAssetId ? media.assets.get(liveAssetId) ?? null : null
  const liveItem = liveAssetId
    ? media.compatibility.get(liveAssetId)
    : undefined
  const rejectedItem = lastStatusAssetId
    ? media.compatibility.get(lastStatusAssetId)
    : undefined

  if (session && !liveAsset) {
    return { kind: 'offline', lines: [MEDIA_OFFLINE_STATUS] }
  }
  if (lastOpenRejection === 'offline') {
    return { kind: 'offline', lines: [MEDIA_OFFLINE_STATUS] }
  }
  if (lastOpenRejection === 'invalid-duration') {
    return {
      kind: 'invalid-duration',
      lines: [OPEN_REJECTION_MESSAGES['invalid-duration']],
    }
  }
  if (lastOpenRejection === 'incompatible') {
    return {
      kind: 'incompatible',
      lines: mediaCompatibilityRemediationLines(rejectedItem),
    }
  }
  if (session && liveItem?.report?.runtimeFailures?.length) {
    return { kind: 'runtime', lines: mediaCompatibilityRemediationLines(liveItem) }
  }
  return null
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
    if (probe.reason === 'incompatible') {
      return mediaCompatibilityStatusText(media.compatibility.get(assetId))
    }
    return sourceMonitorOpenRejectionMessage(probe.reason)
  }
  return null
}

export function openSourceAsset(assetId: string): SourceMonitorOpenResult {
  lastStatusAssetId = assetId
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

function sourceFactsNeedRemap(
  session: SourceMonitorSession,
  asset: MediaAsset,
): boolean {
  const next = sourceMonitorSourceFacts(asset)
  const current = session.source
  return current.kind !== next.kind
    || current.fileName !== next.fileName
    || current.rate.num !== next.rate.num
    || current.rate.den !== next.rate.den
    || current.durationFrames !== next.durationFrames
    || current.hasAudio !== next.hasAudio
}

function syncOpenSourceWithConnectedMedia(): void {
  const session = useSourceMonitorStore.getState().session
  if (!session) return
  const asset = useMediaStore.getState().assets.get(session.source.assetId)
  if (!asset || !sourceFactsNeedRemap(session, asset)) return
  openSourceAsset(session.source.assetId)
}

useMediaStore.subscribe(syncOpenSourceWithConnectedMedia)
