import { useEffect, useMemo, useState } from 'react'
import {
  ANIMATABLE_CLIP_PROPERTIES,
  animationPropertyValueError,
  clipAnimationPropertyLabel,
  clipAnimationTrack,
  evaluateAnimationTrack,
  LINEAR_ANIMATION_EASING,
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  readClipAnimationProperty,
  resolveClipAnimationAtFrame,
} from '../domain/clipAnimation'
import { MAX_CLIP_SCALE, MIN_CLIP_SCALE } from '../domain/clipInspector'
import type {
  Clip,
  ClipAnimationEasing,
  ClipAnimationKeyframe,
  ClipAnimationProperty,
} from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

type EasingPreset = 'hold' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'custom'

const EASING_PRESETS: Record<Exclude<EasingPreset, 'custom'>, ClipAnimationEasing> = {
  hold: { type: 'hold' },
  linear: LINEAR_ANIMATION_EASING,
  'ease-in': { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 1, y2: 1 },
  'ease-out': { type: 'cubic-bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 },
  'ease-in-out': { type: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
}

const CUSTOM_EASING_DEFAULT: ClipAnimationEasing = {
  type: 'cubic-bezier',
  x1: 0.25,
  y1: 0.1,
  x2: 0.25,
  y2: 1,
}

function sameEasing(left: ClipAnimationEasing, right: ClipAnimationEasing): boolean {
  if (left.type !== right.type) return false
  return left.type !== 'cubic-bezier'
    || (
      right.type === 'cubic-bezier'
      && left.x1 === right.x1
      && left.y1 === right.y1
      && left.x2 === right.x2
      && left.y2 === right.y2
    )
}

function easingPreset(easing: ClipAnimationEasing): EasingPreset {
  for (const [preset, candidate] of Object.entries(EASING_PRESETS) as Array<
    [Exclude<EasingPreset, 'custom'>, ClipAnimationEasing]
  >) {
    if (sameEasing(easing, candidate)) return preset
  }
  return 'custom'
}

function propertyBounds(property: ClipAnimationProperty): {
  min: number
  max: number
  step: number
} {
  if (property === 'opacity') return { min: 0, max: 1, step: 0.01 }
  if (property === 'scale-x' || property === 'scale-y') {
    return { min: MIN_CLIP_SCALE, max: MAX_CLIP_SCALE, step: 0.01 }
  }
  return {
    min: -MAX_ANIMATED_FINITE_MAGNITUDE,
    max: MAX_ANIMATED_FINITE_MAGNITUDE,
    step: property === 'rotation' ? 1 : 1,
  }
}

function DraftNumber({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  onCommit(value: number): void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraft(String(value))
      return
    }
    if (parsed !== value) onCommit(parsed)
  }
  return (
    <label className="animation-number-field">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            setDraft(String(value))
          }
        }}
      />
    </label>
  )
}

function curvePoints(
  clip: Clip,
  property: ClipAnimationProperty,
  track: NonNullable<ReturnType<typeof clipAnimationTrack>>,
): string {
  const duration = clip.timelineRange.durationFrames
  const endFrame = Math.max(1, duration - 1)
  const sampleCount = Math.min(64, Math.max(2, duration))
  const fallback = readClipAnimationProperty(clip, property)
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const frame = Math.round(index * endFrame / (sampleCount - 1))
    return {
      frame,
      value: evaluateAnimationTrack(track, frame, fallback),
    }
  })
  let minimum = Math.min(...samples.map((sample) => sample.value))
  let maximum = Math.max(...samples.map((sample) => sample.value))
  if (minimum === maximum) {
    minimum -= 0.5
    maximum += 0.5
  }
  return samples.map((sample) => {
    const x = sample.frame / endFrame * 240
    const y = 92 - (sample.value - minimum) / (maximum - minimum) * 84
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

export default function AnimationCurveEditor({
  clip,
  locked,
  playheadFrame,
}: {
  clip: Clip
  locked: boolean
  playheadFrame: number
}) {
  const [property, setProperty] = useState<ClipAnimationProperty>('position-x')
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const track = clipAnimationTrack(clip, property)
  const keyframes = useMemo(() => track?.keyframes ?? [], [track])
  const localPlayhead = playheadFrame - clip.timelineRange.startFrame
  const playheadInside = localPlayhead >= 0
    && localPlayhead < clip.timelineRange.durationFrames
  const selected = selectedFrame === null
    ? null
    : keyframes.find((keyframe) => keyframe.frame === selectedFrame) ?? null

  useEffect(() => {
    if (selectedFrame !== null && keyframes.some((item) => item.frame === selectedFrame)) {
      return
    }
    const atPlayhead = keyframes.find((item) => item.frame === localPlayhead)
    setSelectedFrame(atPlayhead?.frame ?? keyframes[0]?.frame ?? null)
  }, [clip.id, keyframes, localPlayhead, property, selectedFrame])

  const points = useMemo(
    () => track ? curvePoints(clip, property, track) : '',
    [clip, property, track],
  )
  const bounds = propertyBounds(property)

  const seekKeyframe = (frame: number): void => {
    setSelectedFrame(frame)
    useTransportStore.getState().setPlayheadFrame(
      clip.timelineRange.startFrame + frame,
    )
  }

  const setKeyframe = (keyframe: ClipAnimationKeyframe): void => {
    useDocumentStore.getState().setClipKeyframe(clip.id, property, keyframe)
    setSelectedFrame(keyframe.frame)
  }

  const addAtPlayhead = (): void => {
    if (!playheadInside || locked) return
    const resolved = resolveClipAnimationAtFrame(clip, playheadFrame)
    const value = readClipAnimationProperty(resolved, property)
    setKeyframe({ frame: localPlayhead, value, easing: LINEAR_ANIMATION_EASING })
    setMessage(`${clipAnimationPropertyLabel(property)} keyframe added at frame ${localPlayhead}.`)
  }

  const setSelectedEasing = (easing: ClipAnimationEasing): void => {
    if (!selected) return
    setKeyframe({ ...selected, easing })
    setMessage('Outgoing curve updated.')
  }

  const selectedIndex = selected
    ? keyframes.findIndex((keyframe) => keyframe.frame === selected.frame)
    : -1
  const previous = selectedIndex > 0 ? keyframes[selectedIndex - 1] : null
  const next = selectedIndex >= 0 && selectedIndex < keyframes.length - 1
    ? keyframes[selectedIndex + 1]
    : null

  return (
    <section className="inspector-section animation-editor" aria-labelledby="animation-editor-heading">
      <div className="inspector-section-bar">
        <h3 id="animation-editor-heading">Animation</h3>
        <button
          type="button"
          className="inspector-reset"
          disabled={locked || !track}
          aria-label={`Reset ${clipAnimationPropertyLabel(property)} animation`}
          onClick={() => {
            useDocumentStore.getState().resetClipAnimationTrack(clip.id, property)
            setSelectedFrame(null)
            setMessage(`${clipAnimationPropertyLabel(property)} animation reset; the static value is unchanged.`)
          }}
        >
          Reset
        </button>
      </div>

      <label className="inspector-field inspector-field-wide">
        <span className="inspector-field-label">Animated property</span>
        <select
          aria-label="Animated property"
          value={property}
          disabled={locked}
          onChange={(event) => {
            setProperty(event.target.value as ClipAnimationProperty)
            setSelectedFrame(null)
            setMessage('')
          }}
        >
          {ANIMATABLE_CLIP_PROPERTIES.map((item) => (
            <option key={item} value={item}>
              {clipAnimationPropertyLabel(item)}{clipAnimationTrack(clip, item) ? ' • animated' : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="animation-toolbar" aria-label="Keyframe operations">
        <button type="button" disabled={locked || !playheadInside} onClick={addAtPlayhead}>
          {keyframes.some((item) => item.frame === localPlayhead) ? 'Replace at playhead' : 'Add at playhead'}
        </button>
        <button type="button" disabled={!previous} onClick={() => previous && seekKeyframe(previous.frame)}>
          Previous
        </button>
        <button type="button" disabled={!next} onClick={() => next && seekKeyframe(next.frame)}>
          Next
        </button>
      </div>

      {track ? (
        <>
          <div
            className="animation-curve"
            role="img"
            aria-label={`${clipAnimationPropertyLabel(property)} curve with ${keyframes.length} keyframe${keyframes.length === 1 ? '' : 's'}`}
          >
            <svg viewBox="0 0 240 100" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 92H240 M0 50H240 M0 8H240" className="animation-curve-grid" />
              <polyline points={points} className="animation-curve-line" />
            </svg>
          </div>
          <ul className="animation-keyframe-list" aria-label="Keyframes">
            {keyframes.map((keyframe) => (
              <li key={keyframe.frame}>
                <button
                  type="button"
                  aria-pressed={selected?.frame === keyframe.frame}
                  onClick={() => seekKeyframe(keyframe.frame)}
                >
                  Frame {keyframe.frame}: {keyframe.value}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="animation-empty">This property uses its static value until you add a keyframe.</p>
      )}

      {selected && (
        <div className="animation-keyframe-fields" aria-label={`Selected keyframe at frame ${selected.frame}`}>
          <DraftNumber
            label="Keyframe frame"
            value={selected.frame}
            min={-MAX_KEYFRAME_FRAME}
            max={MAX_KEYFRAME_FRAME}
            step={1}
            disabled={locked}
            onCommit={(frame) => {
              useDocumentStore.getState().moveClipKeyframe(
                clip.id,
                property,
                selected.frame,
                Math.round(frame),
              )
              seekKeyframe(Math.round(frame))
              setMessage('Keyframe moved. An existing keyframe at that frame is replaced.')
            }}
          />
          <DraftNumber
            label="Keyframe value"
            value={selected.value}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            disabled={locked}
            onCommit={(value) => {
              if (!animationPropertyValueError(property, value)) {
                setKeyframe({ ...selected, value })
                setMessage('Keyframe value updated.')
              }
            }}
          />
          <label className="animation-number-field">
            <span>Outgoing interpolation</span>
            <select
              value={easingPreset(selected.easing)}
              disabled={locked}
              onChange={(event) => {
                const preset = event.target.value as EasingPreset
                setSelectedEasing(
                  preset === 'custom' ? CUSTOM_EASING_DEFAULT : EASING_PRESETS[preset],
                )
              }}
            >
              <option value="hold">Hold</option>
              <option value="linear">Linear</option>
              <option value="ease-in">Ease in</option>
              <option value="ease-out">Ease out</option>
              <option value="ease-in-out">Ease in/out</option>
              <option value="custom">Custom cubic Bézier</option>
            </select>
          </label>
          {selected.easing.type === 'cubic-bezier' && (
            <div className="animation-bezier-grid" aria-label="Custom cubic Bézier controls">
              {(['x1', 'y1', 'x2', 'y2'] as const).map((key) => (
                <DraftNumber
                  key={key}
                  label={key.toUpperCase()}
                  value={selected.easing.type === 'cubic-bezier' ? selected.easing[key] : 0}
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={locked}
                  onCommit={(value) => {
                    if (selected.easing.type !== 'cubic-bezier') return
                    setSelectedEasing({ ...selected.easing, [key]: value })
                  }}
                />
              ))}
              <button type="button" disabled={locked} onClick={() => setSelectedEasing(LINEAR_ANIMATION_EASING)}>
                Reset curve to linear
              </button>
            </div>
          )}
          <div className="animation-toolbar">
            <button
              type="button"
              disabled={locked || !playheadInside || localPlayhead === selected.frame}
              onClick={() => {
                setKeyframe({ ...selected, frame: localPlayhead })
                setMessage(`Keyframe copied to frame ${localPlayhead}.`)
              }}
            >
              Copy to playhead
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                useDocumentStore.getState().removeClipKeyframe(
                  clip.id,
                  property,
                  selected.frame,
                )
                setSelectedFrame(null)
                setMessage('Keyframe removed.')
              }}
            >
              Remove keyframe
            </button>
          </div>
        </div>
      )}

      <p className="animation-status" role="status" aria-live="polite">
        {message || (playheadInside
          ? `Playhead: clip frame ${localPlayhead}. Static values remain available when animation is reset.`
          : 'Move the playhead onto this clip to add or edit animated values.')}
      </p>
    </section>
  )
}
