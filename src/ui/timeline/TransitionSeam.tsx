/**
 * ui/timeline/TransitionSeam.tsx — Minimal crossfade authoring at a cut.
 *
 * Track owns seam discovery from its committed snapshot; this component
 * owns a small marker and one temporary editor. All writes go through the
 * existing documentStore actions, and explicit form submission keeps each
 * Add/Apply/Remove gesture to exactly one history entry.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { Clip, TrackId, Transition } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
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

/** Largest centered duration that fits the two endpoint clips individually.
 * Neighboring transition windows remain the domain operation's authority. */
function centeredFitMaximum(from: Clip, to: Clip): number {
  const fromDuration = from.timelineRange.durationFrames
  const toDuration = to.timelineRange.durationFrames
  if (
    !Number.isSafeInteger(fromDuration) ||
    fromDuration < 1 ||
    !Number.isSafeInteger(toDuration) ||
    toDuration < 1
  ) {
    return 0
  }

  const outgoingCapacity =
    fromDuration > (Number.MAX_SAFE_INTEGER - 1) / 2
      ? Number.MAX_SAFE_INTEGER
      : fromDuration * 2 + 1
  const incomingCapacity =
    toDuration > Number.MAX_SAFE_INTEGER / 2
      ? Number.MAX_SAFE_INTEGER
      : toDuration * 2
  return Math.min(outgoingCapacity, incomingCapacity)
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
  const maximum = centeredFitMaximum(from, to)
  const defaultDuration = Math.min(DEFAULT_CROSSFADE_FRAMES, maximum)
  const committedDuration = transition?.durationFrames ?? defaultDuration
  const endpointLabel = `${from.id} to ${to.id}`
  const editorId = useId()
  const errorId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(committedDuration))
  const [error, setError] = useState<string | null>(null)

  // Undo/redo and accepted edits replace the committed transition snapshot.
  // Keep an in-progress draft local, but resync once that value changes.
  useEffect(() => {
    setDraft(String(committedDuration))
    setError(null)
  }, [committedDuration, transition?.id])

  // The popover is non-modal: an outside pointer closes it, while events
  // inside stop at the seam root so clip gestures never begin underneath it.
  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setDraft(String(committedDuration))
        setError(null)
      }
    }
    // Capture sees a click on ANOTHER seam before that seam deliberately
    // stops bubbling, so only one temporary editor stays open at a time.
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  }, [committedDuration, open])

  const closeEditor = (restoreFocus: boolean): void => {
    setOpen(false)
    setDraft(String(committedDuration))
    setError(null)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const parsedDraft = (): number | null => {
    const trimmed = draft.trim()
    const parsed = Number(trimmed)
    if (
      trimmed === '' ||
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > maximum
    ) {
      setError(`Enter a whole number from 1 to ${maximum} frames.`)
      return null
    }
    return parsed
  }

  const submitDuration = (): void => {
    const parsed = parsedDraft()
    if (parsed === null) return
    const store = useDocumentStore.getState()

    if (!transition) {
      const before = store.doc
      store.addCrossfade(from.id, to.id, parsed)
      if (useDocumentStore.getState().doc === before) {
        setError(
          'That duration overlaps a neighboring transition. Try fewer frames.',
        )
      } else {
        setError(null)
      }
      return
    }

    if (parsed === transition.durationFrames) {
      setError(null)
      return
    }
    const before = store.doc
    store.setCrossfadeDuration(trackId, transition.id, parsed)
    if (useDocumentStore.getState().doc === before) {
      setError(
        'That duration overlaps a neighboring transition. Try fewer frames.',
      )
    } else {
      setError(null)
    }
  }

  const seamFrame =
    from.timelineRange.startFrame + from.timelineRange.durationFrames
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
        disabled={locked || maximum < 1}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen)
          setDraft(String(committedDuration))
          setError(null)
          if (!open) requestAnimationFrame(() => inputRef.current?.select())
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
            submitDuration()
          }}
        >
          <label className="transition-editor-field">
            <span>Duration (frames)</span>
            <input
              ref={inputRef}
              className="transition-duration"
              data-testid={durationTestId}
              aria-label={`Crossfade duration ${endpointLabel} in frames`}
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
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

          {error && (
            <span
              id={errorId}
              className="transition-error"
              role="status"
              aria-live="polite"
            >
              {error}
            </span>
          )}

          <div className="transition-editor-actions">
            <button
              type="submit"
              className="transition-apply"
              data-testid={`transition-submit-${from.id}-${to.id}`}
              disabled={locked || maximum < 1}
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
