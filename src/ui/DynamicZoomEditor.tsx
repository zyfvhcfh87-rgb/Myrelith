/** Accessible dynamic-zoom/reframe shortcut that authors ordinary keyframes. */

import { useEffect, useMemo, useState } from 'react'
import {
  createDynamicZoomPlan,
  DYNAMIC_ZOOM_FRAMING_PROPERTIES,
  DYNAMIC_ZOOM_PRESETS,
  dynamicZoomAvailabilityReason,
  dynamicZoomKeyframeBudgetReason,
  dynamicZoomPreset,
  reverseDynamicZoomRequest,
  type DynamicZoomFraming,
  type DynamicZoomPresetId,
  type DynamicZoomRequest,
  type DynamicZoomSourceDimensions,
} from '../domain/dynamicZoom'
import type { Clip, ClipAnimationEasing } from '../domain/schema'
import { findClip } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'

type EasingChoice = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

const EASING_OPTIONS: readonly { id: EasingChoice; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'ease-in-out', label: 'Ease in and out' },
  { id: 'ease-in', label: 'Ease in' },
  { id: 'ease-out', label: 'Ease out' },
]

function easingForChoice(choice: EasingChoice): ClipAnimationEasing {
  if (choice === 'linear') return { type: 'linear' }
  if (choice === 'ease-in') {
    return { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 1, y2: 1 }
  }
  if (choice === 'ease-out') {
    return { type: 'cubic-bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 }
  }
  return { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
}

function choiceForEasing(easing: ClipAnimationEasing): EasingChoice {
  if (easing.type === 'linear') return 'linear'
  if (easing.type !== 'cubic-bezier') return 'linear'
  if (easing.x1 === 0.42 && easing.x2 === 1) return 'ease-in'
  if (easing.x1 === 0 && easing.x2 === 0.58) return 'ease-out'
  return 'ease-in-out'
}

interface FramingDraft {
  focusXPercent: number
  focusYPercent: number
  zoomPercent: number
}

function draftFromFraming(framing: DynamicZoomFraming): FramingDraft {
  return {
    focusXPercent: framing.focusX * 100,
    focusYPercent: framing.focusY * 100,
    zoomPercent: framing.zoom * 100,
  }
}

function framingFromDraft(draft: FramingDraft): DynamicZoomFraming {
  return {
    focusX: draft.focusXPercent / 100,
    focusY: draft.focusYPercent / 100,
    zoom: draft.zoomPercent / 100,
  }
}

function defaultDuration(clipDurationFrames: number): number {
  return Math.max(2, Math.min(90, clipDurationFrames))
}

function dimensionsFromSources(
  descriptor: { width: number | null; height: number | null } | undefined,
  connectedAsset: { width: number | null; height: number | null } | undefined,
): DynamicZoomSourceDimensions | null {
  const source = descriptor?.width && descriptor.height
    ? descriptor
    : connectedAsset?.width && connectedAsset.height
      ? connectedAsset
      : null
  return source ? { width: source.width as number, height: source.height as number } : null
}

function currentSourceDimensions(clip: Clip): DynamicZoomSourceDimensions | null {
  const media = useMediaStore.getState()
  return dimensionsFromSources(
    media.descriptors.get(clip.assetId),
    media.assets.get(clip.assetId),
  )
}

function NumberDraftField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  return (
    <label className="animation-number-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function FramingFields({
  legend,
  value,
  disabled,
  onChange,
}: {
  legend: string
  value: FramingDraft
  disabled: boolean
  onChange: (value: FramingDraft) => void
}) {
  return (
    <fieldset className="dynamic-zoom-framing">
      <legend>{legend}</legend>
      <NumberDraftField
        label="Horizontal focus (%)"
        value={value.focusXPercent}
        min={-100}
        max={100}
        step={1}
        disabled={disabled}
        onChange={(focusXPercent) => onChange({ ...value, focusXPercent })}
      />
      <NumberDraftField
        label="Vertical focus (%)"
        value={value.focusYPercent}
        min={-100}
        max={100}
        step={1}
        disabled={disabled}
        onChange={(focusYPercent) => onChange({ ...value, focusYPercent })}
      />
      <NumberDraftField
        label="Safe zoom (%)"
        value={value.zoomPercent}
        min={100}
        max={400}
        step={1}
        disabled={disabled}
        onChange={(zoomPercent) => onChange({ ...value, zoomPercent })}
      />
    </fieldset>
  )
}

export default function DynamicZoomEditor({
  clip,
  locked,
}: {
  clip: Clip
  locked: boolean
}) {
  const doc = useDocumentStore((state) => state.doc)
  const descriptor = useMediaStore((state) => state.descriptors.get(clip.assetId))
  const connectedAsset = useMediaStore((state) => state.assets.get(clip.assetId))
  const source = useMemo<DynamicZoomSourceDimensions | null>(() => (
    dimensionsFromSources(descriptor, connectedAsset)
  ), [descriptor, connectedAsset])
  const clipDurationFrames = clip.timelineRange.durationFrames
  const initialPreset = dynamicZoomPreset('gentle-in')
  const [presetId, setPresetId] = useState<DynamicZoomPresetId>('gentle-in')
  const [durationFrames, setDurationFrames] = useState(() => (
    defaultDuration(clipDurationFrames)
  ))
  const [start, setStart] = useState(() => draftFromFraming(initialPreset.start))
  const [end, setEnd] = useState(() => draftFromFraming(initialPreset.end))
  const [easing, setEasing] = useState<EasingChoice>(() => (
    choiceForEasing(initialPreset.easing)
  ))
  const [message, setMessage] = useState('')

  useEffect(() => {
    const preset = dynamicZoomPreset('gentle-in')
    setPresetId('gentle-in')
    setDurationFrames(defaultDuration(clipDurationFrames))
    setStart(draftFromFraming(preset.start))
    setEnd(draftFromFraming(preset.end))
    setEasing(choiceForEasing(preset.easing))
    setMessage('')
  }, [clip.id, clipDurationFrames])

  const request: DynamicZoomRequest = {
    start: framingFromDraft(start),
    end: framingFromDraft(end),
    durationFrames,
    easing: easingForChoice(easing),
  }
  const unavailable = dynamicZoomAvailabilityReason(doc, clip, source)
  const draftResult = unavailable
    ? { ok: false as const, reason: unavailable }
    : createDynamicZoomPlan(doc, clip, source, request)
  const budgetReason = draftResult.ok
    ? dynamicZoomKeyframeBudgetReason(doc, clip, draftResult.plan)
    : null
  const lockedReason = 'Unlock this video track to apply or reset framing.'
  const applyReason = locked
    ? lockedReason
    : !draftResult.ok
      ? draftResult.reason
      : budgetReason
  const disabled = applyReason !== null
  const hasFramingTracks = clip.animation?.tracks.some(({ property }) => (
    DYNAMIC_ZOOM_FRAMING_PROPERTIES.includes(
      property as (typeof DYNAMIC_ZOOM_FRAMING_PROPERTIES)[number],
    )
  )) ?? false
  const resetReason = locked
    ? lockedReason
    : !hasFramingTracks
      ? 'No Position X/Y or Scale X/Y tracks are available to reset.'
      : null
  const readyText = draftResult.ok
    ? `Ready: ${draftResult.plan.durationFrames} frames${draftResult.plan.durationClamped ? ' (clamped to clip)' : ''}.`
    : ''
  const statusText = applyReason ?? (message || readyText)

  useEffect(() => {
    if (applyReason) setMessage('')
  }, [applyReason])

  const reviseDuration = (value: number): void => {
    setDurationFrames(value)
    setMessage('')
  }

  const reviseStart = (value: FramingDraft): void => {
    setStart(value)
    setMessage('')
  }

  const reviseEnd = (value: FramingDraft): void => {
    setEnd(value)
    setMessage('')
  }

  const reviseEasing = (value: EasingChoice): void => {
    setEasing(value)
    setMessage('')
  }

  const selectPreset = (id: DynamicZoomPresetId): void => {
    const preset = dynamicZoomPreset(id)
    setPresetId(id)
    setStart(draftFromFraming(preset.start))
    setEnd(draftFromFraming(preset.end))
    setEasing(choiceForEasing(preset.easing))
    setMessage(`${preset.label} loaded. Adjust either frame, then apply.`)
  }

  const apply = (reverse: boolean): void => {
    const latestDoc = useDocumentStore.getState().doc
    const latestClip = findClip(latestDoc, clip.id)
    const latestSource = latestClip ? currentSourceDimensions(latestClip) : null
    if (!latestClip) {
      setMessage('The selected clip is no longer available.')
      return
    }
    const nextRequest = reverse ? reverseDynamicZoomRequest(request) : request
    const latestUnavailable = dynamicZoomAvailabilityReason(
      latestDoc,
      latestClip,
      latestSource,
    )
    if (latestUnavailable) {
      setMessage(latestUnavailable)
      return
    }
    const preflight = createDynamicZoomPlan(latestDoc, latestClip, latestSource, nextRequest)
    if (!preflight.ok || !latestSource) {
      setMessage(preflight.ok ? 'Source dimensions are no longer available.' : preflight.reason)
      return
    }
    const preflightBudgetReason = dynamicZoomKeyframeBudgetReason(
      latestDoc,
      latestClip,
      preflight.plan,
    )
    if (preflightBudgetReason) {
      setMessage(preflightBudgetReason)
      return
    }
    const result = useDocumentStore.getState().applyDynamicZoom(
      latestClip.id,
      latestSource,
      nextRequest,
    )
    if (!result.ok) {
      setMessage(result.reason)
      return
    }
    if (!result.changed) {
      setMessage('Those framing keyframes are already applied.')
      return
    }
    const clamped = preflight.plan.durationClamped
      ? ` The requested duration was clamped to this ${preflight.plan.durationFrames}-frame clip.`
      : ''
    setMessage(
      `${reverse ? 'Reversed' : 'Applied'} as four ordinary transform tracks.${clamped}`,
    )
  }

  const reset = (): void => {
    const result = useDocumentStore.getState().resetClipFramingAnimation(clip.id)
    if (!result.ok) {
      setMessage(result.reason)
      return
    }
    setMessage(result.changed
      ? 'All Position X/Y and Scale X/Y tracks were removed; static transform, Rotation, and Opacity are unchanged.'
      : 'No position or scale animation was present.')
  }

  return (
    <section className="inspector-section dynamic-zoom-editor" aria-labelledby="dynamic-zoom-heading">
      <div className="inspector-section-bar">
        <h3 id="dynamic-zoom-heading">Dynamic zoom &amp; reframe</h3>
      </div>
      <p className="inspector-note">
        This shortcut writes ordinary Position X/Y and Scale X/Y keyframes. They stay editable below and use the same preview/export evaluator.
      </p>
      <label className="animation-number-field">
        <span>Preset</span>
        <select
          value={presetId}
          disabled={locked}
          onChange={(event) => selectPreset(event.target.value as DynamicZoomPresetId)}
        >
          {DYNAMIC_ZOOM_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.label}</option>
          ))}
        </select>
      </label>
      <NumberDraftField
        label="Duration (frames)"
        value={durationFrames}
        min={2}
        max={1_000_000_000}
        step={1}
        disabled={locked}
        onChange={reviseDuration}
      />
      <FramingFields legend="Start framing" value={start} disabled={locked} onChange={reviseStart} />
      <FramingFields legend="End framing" value={end} disabled={locked} onChange={reviseEnd} />
      <label className="animation-number-field">
        <span>Easing</span>
        <select
          value={easing}
          disabled={locked}
          onChange={(event) => reviseEasing(event.target.value as EasingChoice)}
        >
          {EASING_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </label>
      <div className="animation-toolbar" aria-label="Dynamic zoom operations">
        <button
          type="button"
          disabled={disabled}
          aria-describedby="dynamic-zoom-status"
          onClick={() => apply(false)}
        >
          Apply
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-describedby="dynamic-zoom-status"
          onClick={() => apply(true)}
        >
          Reverse &amp; apply
        </button>
        <button
          type="button"
          disabled={locked || !hasFramingTracks}
          aria-describedby={resetReason
            ? 'dynamic-zoom-reset-reason'
            : 'dynamic-zoom-reset-note'}
          onClick={reset}
        >
          Reset framing tracks
        </button>
      </div>
      <p id="dynamic-zoom-reset-note" className="inspector-note">
        Apply replaces, and Reset removes, every Position X/Y and Scale X/Y track—including later manual edits on those tracks. Rotation, Opacity, crop, and the static transform remain untouched.
      </p>
      {resetReason && (
        <p id="dynamic-zoom-reset-reason" className="animation-status">
          {resetReason}
        </p>
      )}
      <p className="inspector-note">
        Safe zoom is relative to the minimum cover scale for the current project aspect, source size, crop, anchor, flips, and static rotation. Focus values run from -100 (left/top) to 100 (right/bottom).
      </p>
      <p
        id="dynamic-zoom-status"
        className="animation-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusText}
      </p>
    </section>
  )
}
