/**
 * ui/Inspector.tsx — Transform + opacity editing for the selected clip.
 * Phase 4.3.
 *
 * Commit model (plan-mandated): fields hold a local DRAFT while typing and
 * commit on blur/Enter — never per keystroke — via ONE
 * documentStore.updateClipTransform call per change (= one undo entry).
 * Escape reverts the draft; junk/empty input reverts on commit; a
 * no-change commit is skipped entirely so blurring an untouched field
 * never pollutes history. Out-of-range opacity is clamped by the domain
 * op (the doc can never hold invalid values, whatever gets typed).
 *
 * Subscriptions: selectedClipId (primitive) + the selected clip resolved
 * through domain findClip — structural sharing keeps its reference stable
 * across unrelated edits, so the Inspector re-renders only when ITS clip
 * changes. It never reads playheadFrame (invariant 6 stays intact).
 * Layering: ui/ → state/ + domain selectors only.
 */

import { useEffect, useRef, useState } from 'react'
import {
  getLinkClipsEligibility,
  linkedPartners,
  type LinkClipsRejectionReason,
} from '../domain/linking'
import type { ClipTransformPatch } from '../domain/operations'
import type { ClipId, TimelineDoc } from '../domain/schema'
import { findClip, trackOfClip } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

interface NumberFieldProps {
  label: string
  value: number
  step: number
  testId: string
  onCommit: (value: number) => void
}

function NumberField({ label, value, step, testId, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value))
  // Re-sync whenever the committed value changes under us (undo/redo, a
  // gesture on the canvas, switching clips) — but never while typing.
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = (): void => {
    const trimmed = draft.trim()
    const parsed = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setDraft(String(value)) // junk: revert, commit nothing
      return
    }
    if (parsed === value) return // unchanged: no history entry
    onCommit(parsed)
  }

  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="number"
        step={step}
        value={draft}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            setDraft(String(value))
          }
        }}
      />
    </label>
  )
}

type LinkSelectionReason =
  | 'no-selection'
  | 'one-selected'
  | 'too-many-selected'
  | 'selected-clip-missing'
  | 'same-track-kind'
  | LinkClipsRejectionReason

type LinkSelectionResolution =
  | {
      eligible: true
      videoClipId: ClipId
      audioClipId: ClipId
    }
  | {
      eligible: false
      reason: LinkSelectionReason
    }

type UnlinkSelectionResolution =
  | {
      eligible: true
      clipId: ClipId
      linkGroupId: string
    }
  | {
      eligible: false
      message: string
    }

type LinkingActionFeedback = {
  kind: 'link' | 'unlink'
  doc: TimelineDoc
  selectedClipIds: readonly ClipId[]
  message: string
}

const LINK_REASON_MESSAGES: Record<LinkSelectionReason, string> = {
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

/**
 * Convert the ephemeral timeline selection into the domain operation's
 * explicit (video, audio) argument order. Selection order is deliberately
 * irrelevant: Ctrl/Cmd-clicking audio then video is just as valid as the
 * reverse order.
 */
function resolveLinkSelection(
  doc: TimelineDoc,
  selectedClipIds: readonly ClipId[],
): LinkSelectionResolution {
  if (selectedClipIds.length === 0) return { eligible: false, reason: 'no-selection' }

  const selected = selectedClipIds.map((clipId) => ({
    clipId,
    clip: findClip(doc, clipId),
    track: trackOfClip(doc, clipId),
  }))
  if (selected.some(({ clip, track }) => !clip || !track)) {
    return { eligible: false, reason: 'selected-clip-missing' }
  }
  if (selectedClipIds.length === 1) return { eligible: false, reason: 'one-selected' }
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

/**
 * Keep Unlink availability live without duplicating the mutation itself.
 * The domain operation rejects when any member's track is locked; resolving
 * that same condition here prevents a silent no-op/console warning and gives
 * the user an actionable reason before dispatch.
 */
function resolveUnlinkSelection(
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

function clipsShareLinkGroup(
  doc: TimelineDoc,
  videoClipId: ClipId,
  audioClipId: ClipId,
): boolean {
  const video = findClip(doc, videoClipId)
  const audio = findClip(doc, audioClipId)
  return (
    video?.linkGroupId !== undefined &&
    audio?.linkGroupId === video.linkGroupId
  )
}

/**
 * Shared manual A/V command section. Link stays visible and focusable even
 * when unavailable, while Unlink appears for the current primary clip's
 * group. Both activation paths resolve the latest store snapshots rather
 * than trusting render-time state, so stale/locked changes fail closed with
 * visible status instead of dispatching a known rejection.
 */
function LinkSelectionControls() {
  const selectedClipIds = useTransportStore((s) => s.selectedClipIds)
  const selectedClipId = useTransportStore((s) => s.selectedClipId)
  const timelineDoc = useDocumentStore((s) => s.doc)
  const resolution = resolveLinkSelection(timelineDoc, selectedClipIds)
  const selectedClip =
    selectedClipId === null ? null : findClip(timelineDoc, selectedClipId)
  const showUnlink = selectedClip?.linkGroupId !== undefined
  const unlinkResolution = resolveUnlinkSelection(timelineDoc, selectedClipId)
  const [actionFeedback, setActionFeedback] =
    useState<LinkingActionFeedback | null>(null)
  const linkButtonRef = useRef<HTMLButtonElement>(null)

  const currentFeedback =
    actionFeedback?.doc === timelineDoc &&
    actionFeedback.selectedClipIds === selectedClipIds
      ? actionFeedback
      : null

  useEffect(() => {
    if (actionFeedback !== null && currentFeedback === null) {
      setActionFeedback(null)
    }
  }, [actionFeedback, currentFeedback])

  const linkStatusMessage = resolution.eligible
    ? 'Ready to link the selected video and audio clips.'
    : LINK_REASON_MESSAGES[resolution.reason]
  const unlinkStatusMessage = unlinkResolution.eligible
    ? 'Ready to unlink this audio/video pair.'
    : unlinkResolution.message

  const linkSelectedClips = (): void => {
    const latestDocStore = useDocumentStore.getState()
    const latestSelection = useTransportStore.getState().selectedClipIds
    const latestResolution = resolveLinkSelection(latestDocStore.doc, latestSelection)

    if (!resolution.eligible) {
      setActionFeedback({
        kind: 'link',
        doc: latestDocStore.doc,
        selectedClipIds: latestSelection,
        message: latestResolution.eligible
          ? 'Link availability changed. Review the selected clips, then activate Link again.'
          : LINK_REASON_MESSAGES[latestResolution.reason],
      })
      return
    }

    if (!latestResolution.eligible) {
      setActionFeedback({
        kind: 'link',
        doc: latestDocStore.doc,
        selectedClipIds: latestSelection,
        message: LINK_REASON_MESSAGES[latestResolution.reason],
      })
      return
    }

    if (
      latestResolution.videoClipId !== resolution.videoClipId ||
      latestResolution.audioClipId !== resolution.audioClipId
    ) {
      setActionFeedback({
        kind: 'link',
        doc: latestDocStore.doc,
        selectedClipIds: latestSelection,
        message:
          'Linking was not completed because the selection changed. Review the selected clips and try again.',
      })
      return
    }

    latestDocStore.linkClips(
      latestResolution.videoClipId,
      latestResolution.audioClipId,
    )
    const afterDoc = useDocumentStore.getState().doc
    if (
      !clipsShareLinkGroup(
        afterDoc,
        latestResolution.videoClipId,
        latestResolution.audioClipId,
      )
    ) {
      const afterSelection = useTransportStore.getState().selectedClipIds
      const afterResolution = resolveLinkSelection(afterDoc, afterSelection)
      setActionFeedback({
        kind: 'link',
        doc: afterDoc,
        selectedClipIds: afterSelection,
        message: afterResolution.eligible
          ? 'Linking was rejected because the project changed. Reselect both clips and try again.'
          : LINK_REASON_MESSAGES[afterResolution.reason],
      })
    }
  }

  const unlinkSelectedClip = (): void => {
    const latestDocStore = useDocumentStore.getState()
    const latestTransport = useTransportStore.getState()
    const latestResolution = resolveUnlinkSelection(
      latestDocStore.doc,
      latestTransport.selectedClipId,
    )

    if (!showUnlink || !unlinkResolution.eligible) {
      setActionFeedback({
        kind: 'unlink',
        doc: latestDocStore.doc,
        selectedClipIds: latestTransport.selectedClipIds,
        message: latestResolution.eligible
          ? 'Unlink availability changed. Review the selected clip, then activate Unlink again.'
          : latestResolution.message,
      })
      return
    }

    if (!latestResolution.eligible) {
      setActionFeedback({
        kind: 'unlink',
        doc: latestDocStore.doc,
        selectedClipIds: latestTransport.selectedClipIds,
        message: latestResolution.message,
      })
      return
    }

    if (
      latestResolution.clipId !== unlinkResolution.clipId ||
      latestResolution.linkGroupId !== unlinkResolution.linkGroupId
    ) {
      setActionFeedback({
        kind: 'unlink',
        doc: latestDocStore.doc,
        selectedClipIds: latestTransport.selectedClipIds,
        message:
          'Unlinking was not completed because the linked pair changed. Review the selected clip and try again.',
      })
      return
    }

    latestDocStore.unlinkClip(latestResolution.clipId)
    const afterDoc = useDocumentStore.getState().doc
    const afterClip = findClip(afterDoc, latestResolution.clipId)
    if (afterClip?.linkGroupId !== undefined) {
      const afterTransport = useTransportStore.getState()
      const afterResolution = resolveUnlinkSelection(
        afterDoc,
        afterTransport.selectedClipId,
      )
      setActionFeedback({
        kind: 'unlink',
        doc: afterDoc,
        selectedClipIds: afterTransport.selectedClipIds,
        message: afterResolution.eligible
          ? 'Unlinking was rejected because the project changed. Select the linked clip and try again.'
          : afterResolution.message,
      })
      return
    }

    setActionFeedback(null)
    linkButtonRef.current?.focus()
  }

  return (
    <div
      className="inspector-linking"
      data-testid="inspector-linking"
      role="group"
      aria-label="Audio/video linking"
    >
      <button
        ref={linkButtonRef}
        type="button"
        className="inspector-link"
        aria-disabled={!resolution.eligible}
        aria-describedby="inspector-link-status"
        onClick={linkSelectedClips}
      >
        Link selected audio and video clips
      </button>
      <span
        id="inspector-link-status"
        className="inspector-link-status"
        aria-live="polite"
        aria-atomic="true"
      >
        {linkStatusMessage}
      </span>
      {showUnlink && (
        <>
          <button
            type="button"
            className="inspector-unlink"
            data-testid="inspector-unlink"
            aria-disabled={!unlinkResolution.eligible}
            aria-describedby="inspector-unlink-status"
            onClick={unlinkSelectedClip}
          >
            <span aria-hidden="true">🔗 </span>
            Unlink audio/video
          </button>
          <span
            id="inspector-unlink-status"
            className="inspector-link-status"
            aria-live="polite"
            aria-atomic="true"
          >
            {unlinkStatusMessage}
          </span>
        </>
      )}
      <span
        className="inspector-link-status"
        data-testid="inspector-linking-action-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {currentFeedback?.message ?? ''}
      </span>
    </div>
  )
}

export default function Inspector() {
  const selectedClipId = useTransportStore((s) => s.selectedClipId)
  const clip = useDocumentStore((s) =>
    selectedClipId ? findClip(s.doc, selectedClipId) : null,
  )
  // Lane kind decides the field set: audio clips edit VOLUME, video clips
  // the visual transform. A primitive slice, so unrelated edits skip us.
  const laneKind = useDocumentStore((s) =>
    selectedClipId ? (trackOfClip(s.doc, selectedClipId)?.kind ?? null) : null,
  )

  if (!clip) {
    return (
      <div className="panel-placeholder">
        <span className="placeholder-title">Inspector</span>
        <LinkSelectionControls />
        <span className="placeholder-note">select a clip to edit it</span>
      </div>
    )
  }

  if (laneKind === 'audio') {
    return (
      <div className="inspector-panel" data-testid="inspector-panel">
        <div className="inspector-title">{clip.name}</div>
        <LinkSelectionControls />
        <div className="inspector-grid" key={`${clip.id}:${laneKind}`}>
          <NumberField
            label="Volume"
            value={clip.volume}
            step={0.05}
            testId="inspector-volume"
            onCommit={(volume) =>
              useDocumentStore.getState().setClipVolume(clip.id, volume)
            }
          />
        </div>
        <span className="inspector-note">0 = silent · 1 = original · 2 = max</span>
      </div>
    )
  }

  const patch = (p: ClipTransformPatch): void =>
    useDocumentStore.getState().updateClipTransform(clip.id, p)
  const t = clip.transform

  return (
    <div className="inspector-panel" data-testid="inspector-panel">
      <div className="inspector-title">{clip.name}</div>
      <LinkSelectionControls />
      {/* Switching clips remounts only the draft fields. The shared command
          section stays mounted so a raced action can announce its result. */}
      <div className="inspector-grid" key={`${clip.id}:${laneKind}`}>
        <NumberField
          label="Position X"
          value={t.x}
          step={1}
          testId="inspector-x"
          onCommit={(x) => patch({ transform: { x } })}
        />
        <NumberField
          label="Position Y"
          value={t.y}
          step={1}
          testId="inspector-y"
          onCommit={(y) => patch({ transform: { y } })}
        />
        <NumberField
          label="Scale X"
          value={t.scaleX}
          step={0.1}
          testId="inspector-scale-x"
          onCommit={(scaleX) => patch({ transform: { scaleX } })}
        />
        <NumberField
          label="Scale Y"
          value={t.scaleY}
          step={0.1}
          testId="inspector-scale-y"
          onCommit={(scaleY) => patch({ transform: { scaleY } })}
        />
        <NumberField
          label="Rotation °"
          value={t.rotation}
          step={1}
          testId="inspector-rotation"
          onCommit={(rotation) => patch({ transform: { rotation } })}
        />
        <NumberField
          label="Opacity"
          value={clip.opacity}
          step={0.05}
          testId="inspector-opacity"
          onCommit={(opacity) => patch({ opacity })}
        />
      </div>
    </div>
  )
}
