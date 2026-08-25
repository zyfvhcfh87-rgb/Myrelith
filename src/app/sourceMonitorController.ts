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
import {
  openSourceMonitor,
  type SourceMonitorOpenRejection,
  type SourceMonitorOpenResult,
} from '../domain/sourceMonitor'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { suspendSourcePlayback } from './sourceMonitorPlaybackController'
import {
  resumeSourcePreview,
  suspendSourcePreview,
} from './sourceMonitorPreviewController'

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

/**
 * Keep an open Source session aligned with relinked media, and release its
 * runtime owners while the editor is backgrounded. Session marks stay intact.
 */
export function initSourceMonitorLifecycle(): () => void {
  let pendingRefreshAssetId: string | null = null

  const refreshPendingSource = (): void => {
    const session = useSourceMonitorStore.getState().session
    if (!session || session.source.assetId !== pendingRefreshAssetId) {
      pendingRefreshAssetId = null
      return
    }
    const media = useMediaStore.getState()
    const asset = media.assets.get(pendingRefreshAssetId)
    if (!asset) return
    const compatibility = media.compatibility.get(pendingRefreshAssetId)
    if (compatibility && compatibility.status !== 'ready') {
      if (compatibility.status !== 'checking') pendingRefreshAssetId = null
      return
    }
    const result = useSourceMonitorStore.getState().openSource({
      asset,
      compatibility,
    })
    if (result.status === 'ok') pendingRefreshAssetId = null
  }

  const unsubscribeMedia = useMediaStore.subscribe((current, previous) => {
    const session = useSourceMonitorStore.getState().session
    if (!session) {
      pendingRefreshAssetId = null
      return
    }
    const assetId = session.source.assetId
    if (current.assets.get(assetId) !== previous.assets.get(assetId)) {
      pendingRefreshAssetId = assetId
      suspendSourcePlayback()
    }
    if (pendingRefreshAssetId === assetId) refreshPendingSource()
  })
  const unsubscribeSource = useSourceMonitorStore.subscribe((current) => {
    if (current.session?.source.assetId !== pendingRefreshAssetId) {
      pendingRefreshAssetId = null
    }
  })

  const suspend = (): void => {
    suspendSourcePlayback()
    suspendSourcePreview()
  }
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') suspend()
    else resumeSourcePreview()
  }
  const onPageShow = (): void => resumeSourcePreview()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', suspend)
  window.addEventListener('pageshow', onPageShow)

  return () => {
    unsubscribeMedia()
    unsubscribeSource()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', suspend)
    window.removeEventListener('pageshow', onPageShow)
  }
}
