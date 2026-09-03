import { linkedPartners } from '../domain/linking'
import { PROJECT_FILE_LIMITS } from '../domain/projectFile'
import type {
  Clip,
  ClipId,
  TimelineDoc,
  TimelineMarkerId,
  Track,
  TrackId,
  TransitionId,
} from '../domain/schema'
import { findClip, trackOfClip } from '../domain/selectors'
import {
  createDefaultTimelineMarker,
  createTimelineMarkerId,
  findTimelineMarker,
  MAX_TIMELINE_MARKER_FRAME,
  MAX_TIMELINE_MARKERS,
  timelineMarkers,
} from '../domain/timelineMarkers'
import { rangeEnd } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaImportStore } from '../state/mediaImportStore'
import { useMediaStore } from '../state/mediaStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useProxyStore, type ProxyAssetState } from '../state/proxyStore'
import {
  getTransportResetRevision,
  useTransportStore,
} from '../state/transportStore'
import { canRememberImportedMedia } from './mediaImportController'
import {
  mediaAssetRemovalDisabledReason,
  removeMediaAssetFromProject,
} from './mediaAssetActions'
import {
  LINK_REASON_MESSAGES,
  resolveLinkSelection,
  resolveUnlinkSelection,
} from './linkSelection'
import { chooseActiveAssetMedia } from './projectController'
import {
  cancelProxyGeneration,
  removeProxy,
  requestProxyGeneration,
} from './proxyController'
import {
  openSourceAsset,
  sourceOpenDisabledReason,
} from './sourceMonitorController'
import {
  executeSequenceEdit,
  sequenceEditDisabledReason,
} from './sequenceEditController'

interface EditorContextTargetIdentity {
  readonly documentId: string
  readonly sessionRevision: number
}

export type EditorContextMenuTarget =
  | (EditorContextTargetIdentity & {
      readonly kind: 'clip'
      readonly clipId: ClipId
      readonly frame: number
    })
  | (EditorContextTargetIdentity & {
      readonly kind: 'ruler'
      readonly frame: number
    })
  | (EditorContextTargetIdentity & {
      readonly kind: 'lane'
      readonly trackId: TrackId
      readonly frame: number
    })
  | (EditorContextTargetIdentity & {
      readonly kind: 'track'
      readonly trackId: TrackId
    })
  | (EditorContextTargetIdentity & {
      readonly kind: 'marker'
      readonly markerId: TimelineMarkerId
    })
  | (EditorContextTargetIdentity & {
      readonly kind: 'transition'
      readonly trackId: TrackId
      readonly fromClipId: ClipId
      readonly toClipId: ClipId
      readonly transitionId: TransitionId | null
    })
  | (EditorContextTargetIdentity & {
      readonly kind: 'asset'
      readonly assetId: string
    })

export interface EditorContextMenuUiActions {
  readonly openTrackRename?: () => boolean
  readonly openTransitionEditor?: () => boolean
  readonly openAssetCollections?: () => boolean
  /** Must synchronously invoke the existing hidden file input. */
  readonly openRelinkOnce?: () => boolean
}

export type EditorContextMenuItemId =
  | 'clip.split'
  | 'clip.link'
  | 'clip.unlink'
  | 'clip.replace'
  | 'clip.roll-left'
  | 'clip.roll-right'
  | 'clip.ripple-delete'
  | 'timeline.move-playhead'
  | 'timeline.add-marker'
  | 'timeline.split'
  | 'timeline.lift'
  | 'timeline.extract'
  | 'timeline.add-video-track'
  | 'timeline.add-audio-track'
  | 'track.rename'
  | 'track.visibility'
  | 'track.mute'
  | 'track.solo'
  | 'track.lock'
  | 'track.delete'
  | 'marker.edit'
  | 'marker.duplicate'
  | 'marker.delete'
  | 'transition.edit'
  | 'transition.remove'
  | 'asset.relink-remember'
  | 'asset.relink-once'
  | 'asset.organize'
  | 'asset.proxy-primary'
  | 'asset.proxy-remove'
  | 'asset.remove'
  | 'asset.open-source'

export interface ResolvedEditorContextMenuItem {
  readonly id: EditorContextMenuItemId
  readonly label: string
  readonly disabledReason: string | null
  readonly danger?: boolean
  readonly separatorBefore?: boolean
  readonly restoreFocusAfterActivation?: boolean
}

export interface ResolvedEditorContextMenu {
  readonly label: string
  readonly items: readonly ResolvedEditorContextMenuItem[]
}

export interface EditorContextMenuExecution {
  readonly executed: boolean
  readonly reason: string | null
}

export function editorContextMenuIdentity(): EditorContextTargetIdentity {
  return {
    documentId: useDocumentStore.getState().doc.id,
    sessionRevision: getTransportResetRevision(),
  }
}

function projectReason(target: EditorContextMenuTarget): string | null {
  if (
    target.documentId !== useDocumentStore.getState().doc.id
    || target.sessionRevision !== getTransportResetRevision()
  ) return 'This command belongs to a project that is no longer active.'
  return useProjectSessionStore.getState().phase === 'closing'
    ? 'Wait until the project finishes closing.'
    : null
}

function item(
  id: EditorContextMenuItemId,
  label: string,
  disabledReason: string | null,
  options: Pick<
    ResolvedEditorContextMenuItem,
    'danger' | 'separatorBefore' | 'restoreFocusAfterActivation'
  > = {},
): ResolvedEditorContextMenuItem {
  return { id, label, disabledReason, ...options }
}

function strictRangeContains(clip: Clip, frame: number): boolean {
  return frame > clip.timelineRange.startFrame
    && frame < rangeEnd(clip.timelineRange)
}

function splitClipReason(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
): string | null {
  const clip = findClip(doc, clipId)
  if (!clip) return 'This clip is no longer in the Timeline.'
  if (!Number.isSafeInteger(frame) || !strictRangeContains(clip, frame)) {
    return 'Choose a frame strictly inside the clip, not on its boundary.'
  }
  for (const member of [clip, ...linkedPartners(doc, clipId)]) {
    if (member.id !== clipId && !strictRangeContains(member, frame)) continue
    const track = trackOfClip(doc, member.id)
    if (track?.locked) {
      return member.id === clipId
        ? `Unlock track ${track.name} before splitting this clip.`
        : `Unlock linked track ${track.name} before splitting this clip.`
    }
  }
  return null
}

function splitEligibleClipsReason(doc: TimelineDoc, frame: number): string | null {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    return 'The invoked Timeline frame is invalid.'
  }
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (strictRangeContains(clip, frame) && !splitClipReason(doc, clip.id, frame)) {
        return null
      }
    }
  }
  return 'No editable clip crosses this frame.'
}

function rippleDeleteReason(doc: TimelineDoc, clipId: ClipId): string | null {
  const clip = findClip(doc, clipId)
  if (!clip) return 'This clip is no longer in the Timeline.'
  for (const member of [clip, ...linkedPartners(doc, clipId)]) {
    const track = trackOfClip(doc, member.id)
    if (track?.locked) {
      return member.id === clipId
        ? `Unlock track ${track.name} before ripple deleting this clip.`
        : `Unlock linked track ${track.name} before ripple deleting this clip.`
    }
  }
  return null
}

function markerAddReason(doc: TimelineDoc, frame: number): string | null {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame > MAX_TIMELINE_MARKER_FRAME) {
    return `Markers must use a whole frame from 0 to ${MAX_TIMELINE_MARKER_FRAME}.`
  }
  return timelineMarkers(doc).length >= MAX_TIMELINE_MARKERS
    ? `This project already has ${MAX_TIMELINE_MARKERS} markers.`
    : null
}

function addTrackReason(doc: TimelineDoc): string | null {
  return doc.tracks.length >= PROJECT_FILE_LIMITS.maxTracks
    ? `This project already has ${PROJECT_FILE_LIMITS.maxTracks} tracks.`
    : null
}

function removeTrackReason(doc: TimelineDoc, track: Track): string | null {
  if (track.locked) return `Unlock track ${track.name} before deleting it.`
  const touchedGroups = new Set(
    track.clips.flatMap((clip) => clip.linkGroupId ? [clip.linkGroupId] : []),
  )
  for (const groupId of touchedGroups) {
    const survivors = doc.tracks.flatMap((candidate) => (
      candidate.id === track.id
        ? []
        : candidate.clips
          .filter((clip) => clip.linkGroupId === groupId)
          .map((clip) => ({ clip, track: candidate }))
    ))
    if (survivors.length === 1 && survivors[0]?.track.locked) {
      return `Unlock linked track ${survivors[0].track.name} before deleting this track.`
    }
  }
  return null
}

function transitionAtTarget(
  doc: TimelineDoc,
  target: Extract<EditorContextMenuTarget, { kind: 'transition' }>,
) {
  const track = doc.tracks.find((candidate) => candidate.id === target.trackId)
  if (!track || track.kind !== 'video') return null
  const fromIndex = track.clips.findIndex((clip) => clip.id === target.fromClipId)
  const from = track.clips[fromIndex]
  const to = track.clips[fromIndex + 1]
  if (
    !from
    || !to
    || to.id !== target.toClipId
    || from.text !== undefined
    || to.text !== undefined
    || rangeEnd(from.timelineRange) !== to.timelineRange.startFrame
  ) return null
  const transition = track.transitions.find((candidate) => (
    candidate.fromClipId === from.id && candidate.toClipId === to.id
  ))
  if ((transition?.id ?? null) !== target.transitionId) return null
  return { track, from, to, transition }
}

function mediaBusyReason(): string | null {
  if (useMediaImportStore.getState().phase !== 'idle') {
    return 'Finish or cancel the current media import first.'
  }
  const phase = useProjectSessionStore.getState().activeMediaRelink.phase
  return phase === 'scanning' || phase === 'awaiting-choice'
    ? 'Finish or cancel the current relink first.'
    : null
}

function proxyPrimary(itemState: ProxyAssetState | undefined): {
  label: string
  reason: string | null
} {
  if (!itemState) {
    return { label: 'Generate proxy', reason: 'Proxy capability is still loading.' }
  }
  if (itemState.phase === 'queued' || itemState.phase === 'generating') {
    return { label: 'Cancel proxy', reason: null }
  }
  const label = itemState.entry
    ? 'Regenerate proxy'
    : itemState.phase === 'error' ? 'Retry proxy' : 'Generate proxy'
  return {
    label,
    reason: itemState.canGenerate ? null : itemState.detail,
  }
}

export function editorContextMenuTargetExists(
  target: EditorContextMenuTarget,
): boolean {
  if (projectReason(target)) return false
  const doc = useDocumentStore.getState().doc
  switch (target.kind) {
    case 'clip': return findClip(doc, target.clipId) !== null
    case 'ruler': return true
    case 'lane': return doc.tracks.some((track) => track.id === target.trackId)
    case 'track': return doc.tracks.some((track) => track.id === target.trackId)
    case 'marker': return findTimelineMarker(doc, target.markerId) !== null
    case 'transition': return transitionAtTarget(doc, target) !== null
    case 'asset': {
      const media = useMediaStore.getState()
      return media.descriptors.has(target.assetId)
        || media.compatibility.has(target.assetId)
    }
  }
}

export function resolveEditorContextMenu(
  target: EditorContextMenuTarget,
  actions: EditorContextMenuUiActions = {},
): ResolvedEditorContextMenu {
  const doc = useDocumentStore.getState().doc
  const common = projectReason(target)
  switch (target.kind) {
    case 'clip': {
      const clip = findClip(doc, target.clipId)
      const selection = useTransportStore.getState().selectedClipIds
      const linkingItem = (() => {
        if (clip?.linkGroupId) {
          const unlink = resolveUnlinkSelection(doc, target.clipId)
          return item(
            'clip.unlink',
            'Unlink audio/video',
            common ?? (unlink.eligible ? null : unlink.message),
          )
        }
        const link = resolveLinkSelection(doc, selection)
        return item(
          'clip.link',
          'Link selected clips',
          common ?? (link.eligible ? null : LINK_REASON_MESSAGES[link.reason]),
        )
      })()
      return {
        label: clip ? `${clip.name} clip` : 'Timeline clip',
        items: [
          item(
            'clip.split',
            'Split clip here',
            common ?? splitClipReason(doc, target.clipId, target.frame),
          ),
          linkingItem,
          item(
            'clip.replace',
            'Replace edit',
            common ?? sequenceEditDisabledReason('replace', {
              selectedClipId: target.clipId,
            }),
            { separatorBefore: true },
          ),
          item(
            'clip.roll-left',
            'Roll seam left',
            common ?? sequenceEditDisabledReason('roll', {
              selectedClipId: target.clipId,
              playheadFrame: target.frame,
              rollDeltaFrames: -1,
            }),
          ),
          item(
            'clip.roll-right',
            'Roll seam right',
            common ?? sequenceEditDisabledReason('roll', {
              selectedClipId: target.clipId,
              playheadFrame: target.frame,
              rollDeltaFrames: 1,
            }),
          ),
          item(
            'clip.ripple-delete',
            'Ripple delete',
            common ?? rippleDeleteReason(doc, target.clipId),
            { danger: true, separatorBefore: true },
          ),
        ],
      }
    }
    case 'ruler':
    case 'lane': {
      const isRuler = target.kind === 'ruler'
      const frame = target.frame
      const laneMissing = target.kind === 'lane'
        && !doc.tracks.some((track) => track.id === target.trackId)
        ? 'This Timeline lane no longer exists.'
        : null
      const unavailable = common ?? laneMissing
      return {
        label: `${isRuler ? 'Timeline ruler' : 'Timeline lane'} at frame ${frame}`,
        items: [
          ...(isRuler
            ? [item('timeline.move-playhead', 'Move playhead here', unavailable)]
            : []),
          item(
            'timeline.add-marker',
            'Add marker here',
            unavailable ?? markerAddReason(doc, frame),
          ),
          item(
            'timeline.split',
            'Split eligible clips here',
            unavailable ?? splitEligibleClipsReason(doc, frame),
          ),
          item(
            'timeline.lift',
            'Lift In/Out',
            unavailable ?? sequenceEditDisabledReason('lift'),
            { separatorBefore: true },
          ),
          item(
            'timeline.extract',
            'Extract In/Out',
            unavailable ?? sequenceEditDisabledReason('extract'),
          ),
          ...(!isRuler
            ? [
                item(
                  'timeline.add-video-track',
                  'Add video track',
                  unavailable ?? addTrackReason(doc),
                  { separatorBefore: true },
                ),
                item(
                  'timeline.add-audio-track',
                  'Add audio track',
                  unavailable ?? addTrackReason(doc),
                ),
              ]
            : []),
        ],
      }
    }
    case 'track': {
      const track = doc.tracks.find((candidate) => candidate.id === target.trackId)
      const missing = track ? null : 'This track no longer exists.'
      const unavailable = common ?? missing
      return {
        label: track ? `${track.name} track` : 'Timeline track',
        items: [
          item(
            'track.rename',
            'Rename…',
            unavailable ?? (actions.openTrackRename ? null : 'Rename is unavailable.'),
            { restoreFocusAfterActivation: false },
          ),
          ...(track?.kind === 'video'
            ? [item(
                'track.visibility',
                track.hidden ? 'Show track' : 'Hide track',
                unavailable,
              )]
            : [
                item('track.mute', track?.muted ? 'Unmute track' : 'Mute track', unavailable),
                item('track.solo', track?.solo ? 'Unsolo track' : 'Solo track', unavailable),
              ]),
          item(
            'track.lock',
            track?.locked ? 'Unlock track' : 'Lock track',
            unavailable,
            { separatorBefore: true },
          ),
          item(
            'track.delete',
            'Delete track',
            unavailable ?? (track ? removeTrackReason(doc, track) : missing),
            { danger: true },
          ),
        ],
      }
    }
    case 'marker': {
      const marker = findTimelineMarker(doc, target.markerId)
      const unavailable = common ?? (marker ? null : 'This marker no longer exists.')
      return {
        label: marker ? `Marker ${marker.label}` : 'Timeline marker',
        items: [
          item('marker.edit', 'Edit…', unavailable, {
            restoreFocusAfterActivation: false,
          }),
          item('marker.duplicate', 'Duplicate', unavailable, {
            restoreFocusAfterActivation: false,
          }),
          item('marker.delete', 'Delete', unavailable, {
            danger: true,
            separatorBefore: true,
          }),
        ],
      }
    }
    case 'transition': {
      const seam = transitionAtTarget(doc, target)
      const missing = seam ? null : 'This transition seam is no longer available.'
      const locked = seam?.track.locked
        ? `Unlock track ${seam.track.name} first.`
        : null
      const unavailable = common ?? missing ?? locked
      return {
        label: seam
          ? `Transition seam from ${seam.from.name} to ${seam.to.name}`
          : 'Transition seam',
        items: [
          item(
            'transition.edit',
            seam?.transition ? 'Edit crossfade…' : 'Add crossfade…',
            unavailable ?? (actions.openTransitionEditor
              ? null
              : 'The crossfade editor is unavailable.'),
            { restoreFocusAfterActivation: false },
          ),
          item(
            'transition.remove',
            'Remove crossfade',
            unavailable ?? (seam?.transition
              ? null
              : 'There is no crossfade at this seam.'),
            { danger: true },
          ),
        ],
      }
    }
    case 'asset': {
      const media = useMediaStore.getState()
      const descriptor = media.descriptors.get(target.assetId)
      const compatibility = media.compatibility.get(target.assetId)
      const exists = descriptor !== undefined || compatibility !== undefined
      const connected = media.assets.has(target.assetId)
      const missing = exists ? null : 'This Media Pool asset no longer exists.'
      const unavailable = common ?? missing
      const busy = mediaBusyReason()
      const relinkBase = unavailable ?? busy ?? (descriptor
        ? connected ? 'This source is already connected.' : null
        : 'Only imported project media can be relinked.')
      const proxy = descriptor?.kind === 'video'
        ? proxyPrimary(useProxyStore.getState().assets.get(target.assetId))
        : null
      return {
        label: descriptor?.fileName ?? compatibility?.fileName ?? 'Media asset',
        items: [
          item(
            'asset.open-source',
            'Open in Source Monitor',
            unavailable ?? busy ?? sourceOpenDisabledReason(target.assetId),
          ),
          item(
            'asset.relink-remember',
            'Relink & remember…',
            relinkBase ?? (canRememberImportedMedia()
              ? null
              : 'This browser cannot remember local file access.'),
            { restoreFocusAfterActivation: false },
          ),
          item(
            'asset.relink-once',
            'Relink once…',
            relinkBase ?? (actions.openRelinkOnce
              ? null
              : 'The local file picker is unavailable.'),
            { restoreFocusAfterActivation: false },
          ),
          item(
            'asset.organize',
            'Organize in collections…',
            unavailable ?? (!descriptor
              ? 'Import this media before organizing it.'
              : media.collections.length === 0
                ? 'Create a collection first.'
                : actions.openAssetCollections
                  ? null
                  : 'Collection controls are unavailable.'),
            { separatorBefore: true, restoreFocusAfterActivation: false },
          ),
          ...(proxy
            ? [
                item(
                  'asset.proxy-primary',
                  proxy.label,
                  unavailable ?? proxy.reason,
                  { separatorBefore: true },
                ),
                item(
                  'asset.proxy-remove',
                  'Remove proxy',
                  unavailable ?? (useProxyStore.getState().assets.get(target.assetId)?.entry
                    ? null
                    : 'This asset has no cached proxy.'),
                  { danger: true },
                ),
              ]
            : []),
          item(
            'asset.remove',
            'Remove from project',
            unavailable ?? mediaAssetRemovalDisabledReason(
              useDocumentStore.getState().project,
              target.assetId,
            ),
            { danger: true, separatorBefore: true },
          ),
        ],
      }
    }
  }
}

function executionFailure(reason: string | null): EditorContextMenuExecution {
  return { executed: false, reason: reason ?? 'This command is no longer available.' }
}

export function executeEditorContextMenuItem(
  target: EditorContextMenuTarget,
  itemId: EditorContextMenuItemId,
  actions: EditorContextMenuUiActions = {},
): EditorContextMenuExecution {
  const resolved = resolveEditorContextMenu(target, actions)
  const command = resolved.items.find((candidate) => candidate.id === itemId)
  if (!command || command.disabledReason) {
    return executionFailure(command?.disabledReason ?? null)
  }
  const document = useDocumentStore.getState()
  const before = document.doc
  switch (itemId) {
    case 'clip.split': document.splitClipAt(target.kind === 'clip' ? target.clipId : '', target.kind === 'clip' ? target.frame : -1); break
    case 'clip.link': {
      const selection = resolveLinkSelection(before, useTransportStore.getState().selectedClipIds)
      if (!selection.eligible) return executionFailure(LINK_REASON_MESSAGES[selection.reason])
      document.linkClips(selection.videoClipId, selection.audioClipId)
      break
    }
    case 'clip.unlink': document.unlinkClip(target.kind === 'clip' ? target.clipId : ''); break
    case 'clip.replace':
      if (target.kind !== 'clip') return executionFailure(null)
      return executeSequenceEdit('replace', { selectedClipId: target.clipId })
    case 'clip.roll-left':
    case 'clip.roll-right':
      if (target.kind !== 'clip') return executionFailure(null)
      return executeSequenceEdit('roll', {
        selectedClipId: target.clipId,
        playheadFrame: target.frame,
        rollDeltaFrames: itemId === 'clip.roll-left' ? -1 : 1,
      })
    case 'clip.ripple-delete': document.rippleDelete(target.kind === 'clip' ? target.clipId : ''); break
    case 'timeline.move-playhead':
      if (target.kind !== 'ruler') return executionFailure(null)
      useTransportStore.getState().setPlayheadFrame(target.frame)
      return { executed: true, reason: null }
    case 'timeline.add-marker': {
      if (target.kind !== 'ruler' && target.kind !== 'lane') return executionFailure(null)
      const marker = createDefaultTimelineMarker(before, target.frame)
      document.addTimelineMarker(marker)
      if (useDocumentStore.getState().doc === before) return executionFailure(null)
      useTransportStore.getState().setSelectedMarker(marker.id)
      return { executed: true, reason: null }
    }
    case 'timeline.split':
      if (target.kind !== 'ruler' && target.kind !== 'lane') return executionFailure(null)
      document.splitClipAtPlayhead(target.frame)
      break
    case 'timeline.lift':
      return executeSequenceEdit('lift')
    case 'timeline.extract':
      return executeSequenceEdit('extract')
    case 'timeline.add-video-track': document.addTrack('video'); break
    case 'timeline.add-audio-track': document.addTrack('audio'); break
    case 'track.rename': return actions.openTrackRename?.()
      ? { executed: true, reason: null }
      : executionFailure('The track rename control is no longer available.')
    case 'track.visibility': {
      if (target.kind !== 'track') return executionFailure(null)
      const track = before.tracks.find((candidate) => candidate.id === target.trackId)
      if (!track) return executionFailure('This track no longer exists.')
      document.setTrackFlags(track.id, { hidden: !track.hidden })
      break
    }
    case 'track.mute': {
      if (target.kind !== 'track') return executionFailure(null)
      const track = before.tracks.find((candidate) => candidate.id === target.trackId)
      if (!track) return executionFailure('This track no longer exists.')
      document.setTrackFlags(track.id, { muted: !track.muted })
      break
    }
    case 'track.solo': {
      if (target.kind !== 'track') return executionFailure(null)
      const track = before.tracks.find((candidate) => candidate.id === target.trackId)
      if (!track) return executionFailure('This track no longer exists.')
      document.setTrackFlags(track.id, { solo: !track.solo })
      break
    }
    case 'track.lock': {
      if (target.kind !== 'track') return executionFailure(null)
      const track = before.tracks.find((candidate) => candidate.id === target.trackId)
      if (!track) return executionFailure('This track no longer exists.')
      document.setTrackFlags(track.id, { locked: !track.locked })
      break
    }
    case 'track.delete': document.removeTrack(target.kind === 'track' ? target.trackId : ''); break
    case 'marker.edit':
      if (target.kind !== 'marker') return executionFailure(null)
      useTransportStore.getState().setSelectedMarker(target.markerId)
      useTransportStore.getState().setEditingMarker(target.markerId)
      return { executed: true, reason: null }
    case 'marker.duplicate': {
      if (target.kind !== 'marker') return executionFailure(null)
      const duplicateId = createTimelineMarkerId(before)
      document.duplicateTimelineMarker(target.markerId, duplicateId)
      if (useDocumentStore.getState().doc === before) return executionFailure(null)
      useTransportStore.getState().setSelectedMarker(duplicateId)
      useTransportStore.getState().setEditingMarker(duplicateId)
      return { executed: true, reason: null }
    }
    case 'marker.delete': document.deleteTimelineMarker(target.kind === 'marker' ? target.markerId : ''); break
    case 'transition.edit': return actions.openTransitionEditor?.()
      ? { executed: true, reason: null }
      : executionFailure('The crossfade editor is no longer available.')
    case 'transition.remove':
      if (target.kind !== 'transition' || !target.transitionId) return executionFailure(null)
      document.removeTransition(target.trackId, target.transitionId)
      break
    case 'asset.open-source':
      if (target.kind !== 'asset') return executionFailure(null)
      return openSourceAsset(target.assetId).status === 'ok'
        ? { executed: true, reason: null }
        : executionFailure(sourceOpenDisabledReason(target.assetId))
    case 'asset.relink-remember':
      if (target.kind !== 'asset') return executionFailure(null)
      // The facade is invoked synchronously here, before its first await.
      void chooseActiveAssetMedia(target.assetId)
      return { executed: true, reason: null }
    case 'asset.relink-once': return actions.openRelinkOnce?.()
      ? { executed: true, reason: null }
      : executionFailure('The local file picker is no longer available.')
    case 'asset.organize': return actions.openAssetCollections?.()
      ? { executed: true, reason: null }
      : executionFailure('Collection controls are no longer available.')
    case 'asset.proxy-primary': {
      if (target.kind !== 'asset') return executionFailure(null)
      const proxy = useProxyStore.getState().assets.get(target.assetId)
      const executed = proxy?.phase === 'queued' || proxy?.phase === 'generating'
        ? cancelProxyGeneration(target.assetId)
        : requestProxyGeneration(target.assetId)
      return executed ? { executed: true, reason: null } : executionFailure(null)
    }
    case 'asset.proxy-remove':
      if (target.kind !== 'asset') return executionFailure(null)
      void removeProxy(target.assetId)
      return { executed: true, reason: null }
    case 'asset.remove':
      if (target.kind !== 'asset') return executionFailure(null)
      return removeMediaAssetFromProject(document.project, target.assetId)
        ? { executed: true, reason: null }
        : executionFailure(mediaAssetRemovalDisabledReason(document.project, target.assetId))
  }
  return useDocumentStore.getState().doc === before
    ? executionFailure('The project changed before this command could be applied.')
    : { executed: true, reason: null }
}
