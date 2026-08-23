import {
  getLinkClipsEligibility,
  linkedPartners,
  type LinkClipsRejectionReason,
} from '../domain/linking'
import type { ClipId, TimelineDoc } from '../domain/schema'
import { findClip, trackOfClip } from '../domain/selectors'

export type LinkSelectionReason =
  | 'no-selection'
  | 'one-selected'
  | 'too-many-selected'
  | 'selected-clip-missing'
  | 'same-track-kind'
  | LinkClipsRejectionReason

export type LinkSelectionResolution =
  | {
      readonly eligible: true
      readonly videoClipId: ClipId
      readonly audioClipId: ClipId
    }
  | {
      readonly eligible: false
      readonly reason: LinkSelectionReason
    }

export type UnlinkSelectionResolution =
  | {
      readonly eligible: true
      readonly clipId: ClipId
      readonly linkGroupId: string
    }
  | {
      readonly eligible: false
      readonly message: string
    }

export const LINK_REASON_MESSAGES: Readonly<Record<LinkSelectionReason, string>> = {
  'no-selection': 'Select one video clip and one audio clip to link them.',
  'one-selected':
    'Select one more clip with Ctrl/Cmd-click, or focus it and press Ctrl/Cmd+Enter.',
  'too-many-selected': 'Select exactly two clips: one video and one audio.',
  'selected-clip-missing':
    'A selected clip is no longer available. Reselect the video and audio clips.',
  'same-track-kind':
    'Select one video clip and one audio clip; clips on the same kind of track cannot be linked.',
  'same-clip': 'Choose two different clips to create a link.',
  'video-clip-missing':
    'The selected video clip is no longer available. Reselect both clips.',
  'audio-clip-missing':
    'The selected audio clip is no longer available. Reselect both clips.',
  'first-clip-not-video': 'The first link target must be a video clip.',
  'second-clip-not-audio': 'The second link target must be an audio clip.',
  'video-track-locked': 'Unlock the selected video track before linking.',
  'audio-track-locked': 'Unlock the selected audio track before linking.',
  'video-clip-already-linked':
    'The selected video clip is already linked. Unlink it first.',
  'audio-clip-already-linked':
    'The selected audio clip is already linked. Unlink it first.',
}

/** Resolve selection order into the domain operation's video/audio order. */
export function resolveLinkSelection(
  doc: TimelineDoc,
  selectedClipIds: readonly ClipId[],
): LinkSelectionResolution {
  if (selectedClipIds.length === 0) {
    return { eligible: false, reason: 'no-selection' }
  }

  const selected = selectedClipIds.map((clipId) => ({
    clipId,
    clip: findClip(doc, clipId),
    track: trackOfClip(doc, clipId),
  }))
  if (selected.some(({ clip, track }) => !clip || !track)) {
    return { eligible: false, reason: 'selected-clip-missing' }
  }
  if (selectedClipIds.length === 1) {
    return { eligible: false, reason: 'one-selected' }
  }
  if (selectedClipIds.length > 2) {
    return { eligible: false, reason: 'too-many-selected' }
  }

  const video = selected.find(({ track }) => track?.kind === 'video')
  const audio = selected.find(({ track }) => track?.kind === 'audio')
  if (!video || !audio) return { eligible: false, reason: 'same-track-kind' }

  const eligibility = getLinkClipsEligibility(doc, video.clipId, audio.clipId)
  if (!eligibility.eligible) return eligibility
  return {
    eligible: true,
    videoClipId: video.clipId,
    audioClipId: audio.clipId,
  }
}

/** Resolve the exact linked group and its current lock availability. */
export function resolveUnlinkSelection(
  doc: TimelineDoc,
  selectedClipId: ClipId | null,
): UnlinkSelectionResolution {
  if (selectedClipId === null) {
    return {
      eligible: false,
      message: 'Select a linked clip to unlink its audio/video pair.',
    }
  }
  const clip = findClip(doc, selectedClipId)
  if (!clip) {
    return {
      eligible: false,
      message: 'The selected clip is no longer available. Select a linked clip again.',
    }
  }
  if (clip.linkGroupId === undefined) {
    return {
      eligible: false,
      message: 'The selected clip is no longer linked. Select a linked clip again.',
    }
  }
  for (const member of [clip, ...linkedPartners(doc, selectedClipId)]) {
    const track = trackOfClip(doc, member.id)
    if (track?.locked) {
      return {
        eligible: false,
        message: `Unlock ${track.kind} track ${track.name} before unlinking.`,
      }
    }
  }
  return {
    eligible: true,
    clipId: selectedClipId,
    linkGroupId: clip.linkGroupId,
  }
}
