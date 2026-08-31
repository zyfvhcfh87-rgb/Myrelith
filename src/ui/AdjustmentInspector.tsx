import { useEffect, useState, type KeyboardEvent } from 'react'
import { StackSimple } from '@phosphor-icons/react'
import type { AdjustmentItem, EffectDescriptor, TimelineDoc } from '../domain/schema'
import {
  COLOR_ADJUST_EFFECT_TYPE,
  COLOR_ADJUST_LIMITS,
  createColorAdjustEffect,
  effectAnimationParameterSpec,
  resolvePostCompositeEffectStack,
  locateAdjustment,
  rangeEnd,
  resolveAdjustmentAtFrame,
} from '../state/editorUi'
import { useDocumentStore } from '../state/documentStore'

interface AdjustmentInspectorProps {
  adjustment: AdjustmentItem
  doc: TimelineDoc
  playheadFrame: number
}

function NumericDraft({
  label,
  value,
  min,
  max,
  step,
  disabled,
  testId,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  testId: string
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
    onCommit(parsed)
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(String(value))
      event.currentTarget.blur()
    }
  }
  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={keyDown}
      />
    </label>
  )
}

function ColorEffectFields({
  adjustment,
  effect,
  playheadFrame,
  locked,
}: {
  adjustment: AdjustmentItem
  effect: EffectDescriptor
  playheadFrame: number
  locked: boolean
}) {
  const store = useDocumentStore.getState
  const localFrame = playheadFrame - adjustment.timelineRange.startFrame
  const playheadInside = localFrame >= 0
    && localFrame < adjustment.timelineRange.durationFrames
  return (
    <div className="inspector-effect-params">
      {(Object.keys(COLOR_ADJUST_LIMITS) as Array<keyof typeof COLOR_ADJUST_LIMITS>)
        .map((parameter) => {
          const spec = effectAnimationParameterSpec(effect, parameter)
            ?? { ...COLOR_ADJUST_LIMITS[parameter], label: parameter }
          const value = Number(effect.params[parameter])
          const animationTrack = adjustment.animation.effectTracks.find((track) => (
            track.effectId === effect.id && track.parameter === parameter
          ))
          return (
            <div key={parameter} className="inspector-effect-parameter">
              <NumericDraft
                label={spec.label}
                value={Number.isFinite(value) ? value : 0}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                disabled={locked || !Number.isFinite(value)}
                testId={`adjustment-effect-${parameter}-${effect.id}`}
                onCommit={(next) => store().updateAdjustmentEffectParamsAtFrame(
                  adjustment.id,
                  effect.id,
                  playheadFrame,
                  { [parameter]: next },
                )}
              />
              <div className="inspector-effect-actions">
                <button
                  type="button"
                  disabled={locked || !playheadInside || !Number.isFinite(value)}
                  onClick={() => store().setAdjustmentEffectKeyframe(
                    adjustment.id,
                    effect.id,
                    parameter,
                    { frame: localFrame, value, easing: { type: 'linear' } },
                  )}
                >
                  {animationTrack ? 'Add key' : 'Animate'}
                </button>
                {animationTrack && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => store().clearAdjustmentEffectAnimation(
                      adjustment.id,
                      effect.id,
                      parameter,
                    )}
                  >
                    Clear keys
                  </button>
                )}
              </div>
              {animationTrack && (
                <span className="inspector-note">
                  Keys: {animationTrack.keyframes.map((keyframe) => keyframe.frame).join(', ')}
                </span>
              )}
            </div>
          )
        })}
    </div>
  )
}

function AdjustmentEffectCard({
  adjustment,
  effect,
  index,
  playheadFrame,
  locked,
}: {
  adjustment: AdjustmentItem
  effect: EffectDescriptor
  index: number
  playheadFrame: number
  locked: boolean
}) {
  const resolution = resolvePostCompositeEffectStack([effect], true).effects[0]!
  const store = useDocumentStore.getState
  return (
    <article
      className="inspector-effect-card"
      data-effect-status={resolution.status}
      data-testid={`adjustment-effect-${effect.id}`}
    >
      <header className="inspector-effect-header">
        <label className="inspector-effect-title">
          <input
            type="checkbox"
            checked={effect.enabled}
            disabled={locked}
            aria-label={`Enable ${resolution.label}`}
            onChange={(event) => store().setAdjustmentEffectEnabled(
              adjustment.id,
              effect.id,
              event.target.checked,
            )}
          />
          <span>{resolution.label}</span>
        </label>
        <div className="inspector-effect-actions">
          <button
            type="button"
            aria-label={`Move ${resolution.label} up`}
            disabled={locked || index === 0}
            onClick={() => store().reorderAdjustmentEffect(adjustment.id, effect.id, index - 1)}
          >↑</button>
          <button
            type="button"
            aria-label={`Move ${resolution.label} down`}
            disabled={locked || index === adjustment.effects.length - 1}
            onClick={() => store().reorderAdjustmentEffect(adjustment.id, effect.id, index + 1)}
          >↓</button>
          <button
            type="button"
            disabled={locked || effect.type !== COLOR_ADJUST_EFFECT_TYPE}
            onClick={() => store().resetAdjustmentEffect(adjustment.id, effect.id)}
          >Reset</button>
          <button
            type="button"
            disabled={locked}
            onClick={() => store().removeAdjustmentEffect(adjustment.id, effect.id)}
          >Remove</button>
        </div>
      </header>
      <p className="inspector-effect-status" role="status">
        <strong>{resolution.status}</strong> · {resolution.detail}
      </p>
      {effect.type === COLOR_ADJUST_EFFECT_TYPE && resolution.status !== 'invalid' && (
        <ColorEffectFields
          adjustment={adjustment}
          effect={effect}
          playheadFrame={playheadFrame}
          locked={locked}
        />
      )}
      {effect.type !== COLOR_ADJUST_EFFECT_TYPE && (
        <span className="inspector-note">
          Its complete descriptor stays in the project for a compatible renderer.
        </span>
      )}
    </article>
  )
}

export default function AdjustmentInspector({
  adjustment,
  doc,
  playheadFrame,
}: AdjustmentInspectorProps) {
  const location = locateAdjustment(doc, adjustment.id)
  const track = location?.track ?? null
  const locked = track?.locked ?? true
  const resolved = resolveAdjustmentAtFrame(adjustment, playheadFrame)
  const [nameDraft, setNameDraft] = useState(adjustment.name)
  useEffect(() => setNameDraft(adjustment.name), [adjustment.name])
  const store = useDocumentStore.getState
  const localFrame = playheadFrame - adjustment.timelineRange.startFrame
  const playheadInside = localFrame >= 0
    && localFrame < adjustment.timelineRange.durationFrames
  const opacityTrack = adjustment.animation.tracks[0]
  const videoTracks = doc.tracks.filter((candidate) => candidate.kind === 'video')

  if (!track) return null
  return (
    <div className="inspector-panel adjustment-inspector" data-testid="adjustment-inspector">
      <div className="inspector-title">Inspector</div>
      <div className="inspector-clip-summary">
        <span className="inspector-clip-icon" aria-hidden="true">
          <StackSimple size={24} weight="regular" />
        </span>
        <span>
          <strong>{adjustment.name}</strong>
          <small>Adjustment layer · affects tracks below</small>
        </span>
      </div>

      <section className="inspector-section" aria-labelledby="adjustment-timing-title">
        <h3 id="adjustment-timing-title">Adjustment</h3>
        <label className="inspector-field inspector-field-wide">
          <span className="inspector-field-label">Name</span>
          <input
            value={nameDraft}
            disabled={locked}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => {
              store().renameAdjustment(adjustment.id, nameDraft)
              setNameDraft(useDocumentStore.getState().doc === doc ? adjustment.name : nameDraft.trim())
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                setNameDraft(adjustment.name)
                event.currentTarget.blur()
              }
            }}
          />
        </label>
        <label className="inspector-field inspector-toggle-field">
          <span className="inspector-field-label">Enabled</span>
          <input
            type="checkbox"
            checked={adjustment.enabled}
            disabled={locked}
            onChange={(event) => store().setAdjustmentEnabled(
              adjustment.id,
              event.target.checked,
            )}
          />
        </label>
        <label className="inspector-field inspector-field-wide">
          <span className="inspector-field-label">Video track</span>
          <select
            value={track.id}
            disabled={locked}
            onChange={(event) => store().moveAdjustment(
              adjustment.id,
              event.target.value,
              adjustment.timelineRange.startFrame,
            )}
          >
            {videoTracks.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={candidate.locked}>
                {candidate.name}{candidate.locked ? ' (locked)' : ''}
              </option>
            ))}
          </select>
        </label>
        <NumericDraft
          label="Start frame"
          value={adjustment.timelineRange.startFrame}
          min={0}
          max={Number.MAX_SAFE_INTEGER}
          step={1}
          disabled={locked}
          testId="adjustment-start-frame"
          onCommit={(value) => store().moveAdjustment(
            adjustment.id,
            track.id,
            Math.round(value),
          )}
        />
        <NumericDraft
          label="Duration (frames)"
          value={adjustment.timelineRange.durationFrames}
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          step={1}
          disabled={locked}
          testId="adjustment-duration-frames"
          onCommit={(value) => store().trimAdjustment(
            adjustment.id,
            'end',
            Math.round(value) - adjustment.timelineRange.durationFrames,
          )}
        />
        <NumericDraft
          label="Opacity (%)"
          value={Math.round(resolved.opacity * 1000) / 10}
          min={0}
          max={100}
          step={1}
          disabled={locked}
          testId="adjustment-opacity"
          onCommit={(value) => store().setAdjustmentOpacityAtFrame(
            adjustment.id,
            playheadFrame,
            value / 100,
          )}
        />
        <div className="inspector-effect-actions">
          <button
            type="button"
            disabled={locked || !playheadInside}
            onClick={() => store().setAdjustmentOpacityKeyframe(adjustment.id, {
              frame: localFrame,
              value: resolved.opacity,
              easing: { type: 'linear' },
            })}
          >
            {opacityTrack ? 'Add opacity key' : 'Animate opacity'}
          </button>
          {opacityTrack && (
            <button
              type="button"
              disabled={locked}
              onClick={() => store().clearAdjustmentOpacityAnimation(adjustment.id)}
            >Clear opacity keys</button>
          )}
        </div>
        {opacityTrack && (
          <span className="inspector-note">
            Opacity keys: {opacityTrack.keyframes.map((keyframe) => keyframe.frame).join(', ')}
          </span>
        )}
        {!playheadInside && (
          <span className="inspector-note">Move the playhead inside frames {adjustment.timelineRange.startFrame}–{rangeEnd(adjustment.timelineRange) - 1} to animate.</span>
        )}
        <div className="inspector-effect-actions adjustment-item-actions">
          <button
            type="button"
            disabled={locked || !playheadInside || localFrame === 0}
            onClick={() => store().splitAdjustmentAt(adjustment.id, playheadFrame)}
          >Split at playhead</button>
          <button
            type="button"
            disabled={locked}
            onClick={() => store().duplicateAdjustment(adjustment.id)}
          >Duplicate</button>
          <button
            type="button"
            disabled={locked}
            className="danger"
            onClick={() => store().removeAdjustment(adjustment.id)}
          >Delete</button>
        </div>
      </section>

      <section className="inspector-section" aria-labelledby="adjustment-effects-title">
        <div className="inspector-section-heading">
          <h3 id="adjustment-effects-title">Full-frame effects</h3>
          <button
            type="button"
            disabled={locked}
            onClick={() => store().addAdjustmentEffect(
              adjustment.id,
              createColorAdjustEffect(`fx_${crypto.randomUUID()}`),
            )}
          >Add color</button>
        </div>
        <p className="inspector-note">
          Source geometry, masks, chroma keys, and plugins are intentionally unavailable here.
        </p>
        {resolved.effects.length === 0
          ? <p className="inspector-note">No effects yet. The layer is currently a no-op.</p>
          : resolved.effects.map((effect, index) => (
              <AdjustmentEffectCard
                key={effect.id}
                adjustment={resolved}
                effect={effect}
                index={index}
                playheadFrame={playheadFrame}
                locked={locked}
              />
            ))}
      </section>
    </div>
  )
}
