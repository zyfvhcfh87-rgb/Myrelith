/** Exact visual/audio crossfade authoring at one timeline cut. */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  Clip,
  TrackId,
  Transition,
  TransitionAudioCurve,
} from '../../domain/schema'
import {
  createSourceBoundsCatalog,
  evaluateCrossfadeDraft,
  evaluateCrossfadeUpdate,
  type CrossfadePlanResolution,
} from '../../domain/crossfadePlan'
import type { CrossfadeSettings } from '../../domain/operations'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import { frameToTimelineLocalPx } from './timelineViewport'

const DEFAULT_CROSSFADE_FRAMES = 15

interface TransitionSeamProps {
  trackId: TrackId
  locked: boolean
  from: Clip
  to: Clip
  transition?: Transition
  timelineOriginFrame?: number
}

/** Timeline-only ceiling; source handles may lower it further. */
function centeredFitMaximum(from: Clip, to: Clip): number {
  const fromDuration = from.timelineRange.durationFrames
  const toDuration = to.timelineRange.durationFrames
  if (
    !Number.isSafeInteger(fromDuration)
    || fromDuration < 1
    || !Number.isSafeInteger(toDuration)
    || toDuration < 1
  ) return 0
  const outgoingCapacity = fromDuration > (Number.MAX_SAFE_INTEGER - 1) / 2
    ? Number.MAX_SAFE_INTEGER
    : fromDuration * 2 + 1
  const incomingCapacity = toDuration > Number.MAX_SAFE_INTEGER / 2
    ? Number.MAX_SAFE_INTEGER
    : toDuration * 2
  return Math.min(outgoingCapacity, incomingCapacity)
}

function resolutionMaximum(
  resolution: CrossfadePlanResolution | null,
  fallback: number,
): number {
  if (resolution?.status === 'available') {
    return resolution.plan.maximumDurationFrames
  }
  if (
    resolution?.status === 'unavailable'
    && resolution.maximumDurationFrames !== null
  ) return resolution.maximumDurationFrames
  return fallback
}

function unavailableVideoText(
  resolution: Extract<CrossfadePlanResolution, { status: 'unavailable' }>,
): string {
  if (
    resolution.reason === 'duration-exceeds-video-capacity'
    && resolution.maximumDurationFrames !== null
  ) {
    return `Visual crossfade unavailable at this duration; maximum is ${resolution.maximumDurationFrames} frames.`
  }
  const detail = {
    'source-catalog-missing': 'source information is missing',
    'source-stream-absent': 'an endpoint has no video stream',
    'source-bounds-unknown': 'exact source bounds are unknown; relink the media to analyze it',
    'source-boundary-unsafe': 'an endpoint has unsafe source timing',
    'duration-exceeds-video-capacity': 'the source handles are too short',
  }[resolution.reason]
  return `Visual crossfade unavailable: ${detail}.`
}

function invalidVideoText(
  resolution: Extract<CrossfadePlanResolution, { status: 'invalid' }>,
): string {
  const detail = {
    'track-not-found': 'the video track no longer exists',
    'transition-not-found': 'the transition no longer exists',
    'ambiguous-transition-id': 'the transition identity is ambiguous',
    'not-video-track': 'this is not a video track',
    'invalid-duration': 'the duration is invalid',
    'endpoint-missing-or-ambiguous': 'an endpoint is missing or ambiguous',
    'endpoints-not-ordered-adjacent': 'the clips are no longer adjacent',
    'text-endpoint': 'text clips cannot be crossfaded here',
    'invalid-source-range': 'an endpoint has an invalid source range',
    'invalid-timeline-range': 'an endpoint has an invalid timeline range',
    'clips-do-not-touch': 'the clips no longer touch',
    'unsafe-window': 'the transition window is unsafe',
    'overlapping-transition': 'the window overlaps a neighboring transition',
    'seam-already-has-transition': 'this seam already has a transition',
  }[resolution.reason]
  return `Visual crossfade unavailable: ${detail}.`
}

function unavailableAudioText(
  reason: Extract<
    Extract<CrossfadePlanResolution, { status: 'available' }>['plan']['audio'],
    { status: 'unavailable' }
  >['reason'],
): string {
  const detail = {
    'linked-audio-partner-missing': 'each video clip needs one linked audio partner',
    'linked-audio-partner-ambiguous': 'a linked audio partner is ambiguous',
    'linked-audio-partners-not-distinct': 'the two video clips need distinct audio partners',
    'linked-audio-partner-misaligned': 'the linked audio partners do not meet at this cut',
    'linked-audio-source-range-invalid': 'a linked audio source range is invalid',
    'audio-source-catalog-missing': 'linked audio source information is missing',
    'audio-source-stream-absent': 'a linked source has no audio stream',
    'audio-source-bounds-unknown': 'exact linked audio bounds are unknown; relink the media to analyze it',
    'audio-source-boundary-unsafe': 'a linked audio endpoint has unsafe source timing',
    'retimed-audio-unsupported': 'constant-speed audio is muted until pitch-safe time-stretch is available',
    'duration-exceeds-audio-capacity': 'the linked audio handles are too short',
  }[reason]
  return `Linked audio unavailable: ${detail}. The visual crossfade remains available.`
}

function availabilityText(
  resolution: CrossfadePlanResolution | null,
  timelineMaximum: number,
): string {
  if (!resolution) {
    return `Enter a whole number from 1 to ${timelineMaximum} frames to check availability.`
  }
  if (resolution.status === 'invalid') return invalidVideoText(resolution)
  if (resolution.status === 'unavailable') return unavailableVideoText(resolution)
  const visual = `Visual crossfade available up to ${resolution.plan.maximumDurationFrames} frames.`
  const audio = resolution.plan.audio
  if (audio.status === 'disabled') {
    return `${visual} Linked audio crossfade is off.`
  }
  if (audio.status === 'unavailable') {
    return `${visual} ${unavailableAudioText(audio.reason)}`
  }
  return `${visual} Linked audio available up to ${audio.maximumDurationFrames} frames.`
}

export default function TransitionSeam({
  trackId,
  locked,
  from,
  to,
  transition,
  timelineOriginFrame = 0,
}: TransitionSeamProps) {
  const zoom = useTransportStore((state) => state.zoom)
  const doc = useDocumentStore((state) => state.doc)
  const descriptors = useMediaStore((state) => state.descriptors)
  const catalog = useMemo(
    () => createSourceBoundsCatalog(descriptors.values()),
    [descriptors],
  )
  const timelineMaximum = centeredFitMaximum(from, to)
  const defaultDuration = Math.min(DEFAULT_CROSSFADE_FRAMES, timelineMaximum)
  const committedDuration = transition?.durationFrames ?? defaultDuration
  const committedAudioEnabled = transition?.audio.enabled ?? true
  const committedCurve = transition?.audio.curve ?? 'equal-power'
  const endpointLabel = `${from.id} to ${to.id}`
  const editorId = useId()
  const availabilityId = useId()
  const errorId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previousTransitionId = useRef(transition?.id)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(committedDuration))
  const [audioEnabled, setAudioEnabled] = useState(committedAudioEnabled)
  const [curve, setCurve] = useState<TransitionAudioCurve>(committedCurve)
  const [error, setError] = useState<string | null>(null)

  const draftDuration = (() => {
    const trimmed = draft.trim()
    const value = Number(trimmed)
    return trimmed !== '' && Number.isSafeInteger(value) && value >= 1
      ? value
      : null
  })()
  const draftSettings: CrossfadeSettings | null = draftDuration === null
    ? null
    : {
        durationFrames: draftDuration,
        audio: { enabled: audioEnabled, curve },
      }
  const resolution = !draftSettings
    ? null
    : transition
      ? evaluateCrossfadeUpdate(
          doc,
          trackId,
          transition.id,
          draftSettings.durationFrames,
          catalog,
          draftSettings.audio,
        )
      : evaluateCrossfadeDraft(
          doc,
          trackId,
          from.id,
          to.id,
          draftSettings.durationFrames,
          catalog,
          draftSettings.audio,
        )
  const maximum = resolutionMaximum(resolution, timelineMaximum)
  const available = resolution?.status === 'available'
  const liveExplanation = availabilityText(resolution, timelineMaximum)

  const resetDraft = (): void => {
    setDraft(String(committedDuration))
    setAudioEnabled(committedAudioEnabled)
    setCurve(committedCurve)
    setError(null)
  }

  // External removal/replacement makes an open editor stale. Duration/audio
  // undo/redo keeps the same id, so that editor stays open and resynchronizes.
  useEffect(() => {
    if (previousTransitionId.current !== transition?.id) setOpen(false)
    previousTransitionId.current = transition?.id
    setDraft(String(committedDuration))
    setAudioEnabled(committedAudioEnabled)
    setCurve(committedCurve)
    setError(null)
  }, [
    committedAudioEnabled,
    committedCurve,
    committedDuration,
    transition?.id,
  ])

  useEffect(() => {
    if (locked && open) setOpen(false)
  }, [locked, open])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setDraft(String(committedDuration))
        setAudioEnabled(committedAudioEnabled)
        setCurve(committedCurve)
        setError(null)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  }, [
    committedAudioEnabled,
    committedCurve,
    committedDuration,
    open,
  ])

  const closeEditor = (restoreFocus: boolean): void => {
    setOpen(false)
    resetDraft()
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const submitSettings = (): void => {
    if (!draftSettings || draftSettings.durationFrames > maximum) {
      setError(`Enter a whole number from 1 to ${maximum} frames.`)
      return
    }
    if (!available) {
      setError('This crossfade is not currently available. Check the explanation above.')
      return
    }
    const store = useDocumentStore.getState()
    const before = store.doc
    if (transition) {
      store.setCrossfadeSettings(
        trackId,
        transition.id,
        draftSettings,
        catalog,
      )
    } else {
      store.addCrossfadeWithSourceBounds(
        from.id,
        to.id,
        draftSettings,
        catalog,
      )
    }
    if (useDocumentStore.getState().doc === before) {
      const unchanged = transition
        && transition.durationFrames === draftSettings.durationFrames
        && transition.audio.enabled === draftSettings.audio.enabled
        && transition.audio.curve === draftSettings.audio.curve
      setError(unchanged ? null : 'The crossfade changed before this edit could be applied.')
      return
    }
    setError(null)
    if (!transition) setOpen(false)
  }

  const seamFrame = from.timelineRange.startFrame
    + from.timelineRange.durationFrames
  const active = transition !== undefined
  const durationTestId = active
    ? `transition-duration-${transition.id}`
    : `transition-duration-${from.id}-${to.id}`

  return (
    <div
      ref={rootRef}
      className={`transition-seam${open ? ' is-open' : ''}`}
      data-testid={`transition-seam-${from.id}-${to.id}`}
      style={{
        left: frameToTimelineLocalPx(seamFrame, timelineOriginFrame, zoom),
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          closeEditor(true)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`transition-trigger${active ? ' is-active' : ''}`}
        data-testid={
          active
            ? `transition-toggle-${transition.id}`
            : `transition-add-${from.id}-${to.id}`
        }
        aria-label={`${active ? 'Edit' : 'Add'} crossfade ${endpointLabel}`}
        aria-expanded={open}
        aria-controls={open ? editorId : undefined}
        title={
          locked
            ? `Unlock the track to ${active ? 'edit' : 'add'} this crossfade`
            : `${open ? 'Close' : active ? 'Edit' : 'Add'} crossfade`
        }
        disabled={locked || timelineMaximum < 1}
        onClick={() => {
          const nextOpen = !open
          setOpen(nextOpen)
          resetDraft()
          if (nextOpen) requestAnimationFrame(() => inputRef.current?.select())
        }}
      >
        {active ? 'CF' : '+'}
      </button>

      {open && (
        <form
          id={editorId}
          className="transition-editor"
          aria-label={`${active ? 'Edit' : 'Add'} crossfade ${endpointLabel}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            submitSettings()
          }}
        >
          <label className="transition-editor-field">
            <span>Crossfade duration in frames</span>
            <input
              ref={inputRef}
              className="transition-duration"
              data-testid={durationTestId}
              aria-label="Crossfade duration in frames"
              aria-invalid={draftDuration === null || !available || error !== null}
              aria-describedby={`${availabilityId}${error ? ` ${errorId}` : ''}`}
              type="number"
              min={1}
              max={maximum}
              step={1}
              inputMode="numeric"
              value={draft}
              disabled={locked}
              onChange={(event) => {
                setDraft(event.target.value)
                setError(null)
              }}
            />
          </label>

          <label className="transition-audio-toggle">
            <input
              type="checkbox"
              aria-label="Crossfade linked audio"
              aria-describedby={availabilityId}
              checked={audioEnabled}
              disabled={locked}
              onChange={(event) => {
                setAudioEnabled(event.target.checked)
                setError(null)
              }}
            />
            <span>Crossfade linked audio</span>
          </label>

          <label className="transition-editor-field">
            <span>Audio crossfade curve</span>
            <select
              className="transition-audio-curve"
              aria-label="Audio crossfade curve"
              aria-describedby={availabilityId}
              value={curve}
              disabled={locked || !audioEnabled}
              onChange={(event) => {
                setCurve(event.target.value as TransitionAudioCurve)
                setError(null)
              }}
            >
              <option value="equal-power">Equal power</option>
              <option value="linear">Linear</option>
            </select>
          </label>

          <p
            id={availabilityId}
            className={`transition-availability${available ? ' is-available' : ''}`}
            role="status"
            aria-live="polite"
          >
            {liveExplanation}
          </p>

          {error && (
            <span
              id={errorId}
              className="transition-error"
              role="alert"
            >
              {error}
            </span>
          )}

          <div className="transition-editor-actions">
            <button
              type="submit"
              className="transition-apply"
              data-testid={`transition-submit-${from.id}-${to.id}`}
              disabled={locked || !available}
            >
              {active ? 'Apply' : 'Add'}
            </button>
            {active && (
              <button
                type="button"
                className="transition-remove"
                data-testid={`transition-remove-${transition.id}`}
                aria-label={`Remove crossfade ${endpointLabel}`}
                disabled={locked}
                onClick={() => {
                  const store = useDocumentStore.getState()
                  const before = store.doc
                  store.removeTransition(trackId, transition.id)
                  if (useDocumentStore.getState().doc === before) {
                    setError('This crossfade could not be removed.')
                  } else {
                    closeEditor(false)
                  }
                }}
              >
                Remove
              </button>
            )}
            <button
              type="button"
              className="transition-cancel"
              onClick={() => closeEditor(true)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
