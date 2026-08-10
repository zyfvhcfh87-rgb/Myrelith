import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import type {
  Clip,
  ClipAnimationEasing,
  EffectDescriptor,
  EffectParamValue,
  TimelineDoc,
} from '../domain/schema'
import { effectAnimationTrack } from '../domain/clipAnimation'
import {
  CHROMA_KEY_EFFECT_TYPE,
  CHROMA_KEY_EFFECT_VERSION,
  CHROMA_KEY_LIMITS,
  COLOR_ADJUST_EFFECT_TYPE,
  COLOR_ADJUST_EFFECT_VERSION,
  COLOR_ADJUST_LIMITS,
  createChromaKeyEffect,
  createColorAdjustEffect,
  createMaskEffect,
  effectAnimationParameterSpec,
  effectRegistration,
  MASK_EFFECT_TYPE,
  MASK_EFFECT_VERSION,
  MASK_LIMITS,
  type EffectAnimationParameterSpec,
  type MaskShape,
} from '../domain/effectStack'
import { effectAppendBudgetError } from '../domain/effectBounds'
import { useDocumentStore } from '../state/documentStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'

const PENDING_PREVIEW_EFFECT_DETAIL =
  'Preview renderer status has not been projected yet; the effect is preserved and bypassed.'

interface NumericFieldProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  testId: string
  scale?: number
  onCommit: (value: number) => void
}

function NumericField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  testId,
  scale = 1,
  onCommit,
}: NumericFieldProps) {
  const displayed = value * scale
  const [draft, setDraft] = useState(String(displayed))
  useEffect(() => setDraft(String(displayed)), [displayed])
  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed < min * scale || parsed > max * scale) {
      setDraft(String(displayed))
      return
    }
    onCommit(parsed / scale)
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(String(displayed))
      event.currentTarget.blur()
    }
  }
  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="number"
        value={draft}
        min={min * scale}
        max={max * scale}
        step={step * scale}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={keyDown}
      />
    </label>
  )
}

function toggle(
  label: string,
  checked: boolean,
  disabled: boolean,
  testId: string,
  onChange: (checked: boolean) => void,
) {
  return (
    <label className="inspector-field inspector-toggle-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

function updateAtFrame(
  clip: Clip,
  effect: EffectDescriptor,
  playheadFrame: number,
  patch: Readonly<Record<string, EffectParamValue>>,
): void {
  useDocumentStore.getState().updateEffectParamsAtFrame(
    clip.id,
    effect.id,
    playheadFrame,
    patch,
  )
}

function easingFromType(
  type: ClipAnimationEasing['type'],
): ClipAnimationEasing {
  return type === 'cubic-bezier'
    ? { type, x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
    : { type }
}

function EffectParameterAnimation({
  clip,
  effect,
  parameter,
  spec,
  value,
  playheadFrame,
  locked,
}: {
  clip: Clip
  effect: EffectDescriptor
  parameter: string
  spec: EffectAnimationParameterSpec
  value: number
  playheadFrame: number
  locked: boolean
}) {
  const track = effectAnimationTrack(clip.animation ?? { tracks: [] }, effect.id, parameter)
  const localFrame = playheadFrame - clip.timelineRange.startFrame
  const playheadInside = localFrame >= 0 && localFrame < clip.timelineRange.durationFrames
  const actionLabel = track
    ? `Add ${spec.label} keyframe at playhead`
    : `Animate ${spec.label}`
  const store = useDocumentStore.getState
  return (
    <div className="inspector-effect-animation" aria-label={`${spec.label} animation`}>
      <div className="inspector-effect-actions">
        <button
          type="button"
          disabled={locked || !playheadInside}
          onClick={() => store().setEffectKeyframe(
            clip.id,
            effect.id,
            parameter,
            { frame: localFrame, value, easing: { type: 'linear' } },
          )}
        >
          {actionLabel}
        </button>
        {track && (
          <button
            type="button"
            disabled={locked}
            aria-label={`Reset ${spec.label} animation`}
            onClick={() => store().resetEffectAnimationTrack(
              clip.id,
              effect.id,
              parameter,
            )}
          >
            Clear keys
          </button>
        )}
      </div>
      {track && (
        <ol className="animation-keyframe-list" aria-label={`${spec.label} keyframes`}>
          {track.keyframes.map((keyframe, index) => (
            <li key={keyframe.frame} className="animation-keyframe-fields">
              <NumericField
                label={`${spec.label} keyframe ${index + 1} frame`}
                value={keyframe.frame}
                min={-1_000_000_000}
                max={1_000_000_000}
                step={1}
                disabled={locked}
                testId={`effect-keyframe-frame-${effect.id}-${parameter}-${index}`}
                onCommit={(frame) => store().moveEffectKeyframe(
                  clip.id,
                  effect.id,
                  parameter,
                  keyframe.frame,
                  Math.round(frame),
                )}
              />
              <NumericField
                label={`${spec.label} keyframe ${index + 1} value`}
                value={keyframe.value}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                scale={100}
                disabled={locked}
                testId={`effect-keyframe-value-${effect.id}-${parameter}-${index}`}
                onCommit={(nextValue) => store().setEffectKeyframe(
                  clip.id,
                  effect.id,
                  parameter,
                  { ...keyframe, value: nextValue },
                )}
              />
              <label className="inspector-field">
                <span className="inspector-field-label">
                  {spec.label} keyframe {index + 1} easing
                </span>
                <select
                  value={keyframe.easing.type}
                  disabled={locked}
                  onChange={(event) => store().setEffectKeyframe(
                    clip.id,
                    effect.id,
                    parameter,
                    {
                      ...keyframe,
                      easing: easingFromType(event.target.value as ClipAnimationEasing['type']),
                    },
                  )}
                >
                  <option value="linear">Linear</option>
                  <option value="hold">Hold</option>
                  <option value="cubic-bezier">Ease</option>
                </select>
              </label>
              <button
                type="button"
                disabled={locked}
                aria-label={`Remove ${spec.label} keyframe ${index + 1}`}
                onClick={() => store().removeEffectKeyframe(
                  clip.id,
                  effect.id,
                  parameter,
                  keyframe.frame,
                )}
              >
                Remove key
              </button>
            </li>
          ))}
        </ol>
      )}
      {!playheadInside && (
        <span className="inspector-note">Move the playhead inside this clip to add keys.</span>
      )}
    </div>
  )
}

function BezierPathField({
  clip,
  effect,
  playheadFrame,
  locked,
}: {
  clip: Clip
  effect: EffectDescriptor
  playheadFrame: number
  locked: boolean
}) {
  const value = String(effect.params.path)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft === value) return
    const before = useDocumentStore.getState().doc
    updateAtFrame(clip, effect, playheadFrame, { path: draft })
    if (useDocumentStore.getState().doc === before) setDraft(value)
  }
  return (
    <label className="inspector-field inspector-field-wide">
      <span className="inspector-field-label">Bezier path (normalized M/C/Z)</span>
      <textarea
        value={draft}
        disabled={locked}
        rows={4}
        data-testid={`inspector-effect-mask-path-${effect.id}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(value)
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

function MaskFields({
  clip,
  effect,
  playheadFrame,
  locked,
}: {
  clip: Clip
  effect: EffectDescriptor
  playheadFrame: number
  locked: boolean
}) {
  const parameters = ['x', 'y', 'width', 'height', 'feather'] as const
  return (
    <div className="inspector-effect-params">
      <label className="inspector-field">
        <span className="inspector-field-label">Mask shape</span>
        <select
          value={String(effect.params.shape)}
          disabled={locked}
          data-testid={`inspector-effect-mask-shape-${effect.id}`}
          onChange={(event) => updateAtFrame(
            clip,
            effect,
            playheadFrame,
            { shape: event.target.value as MaskShape },
          )}
        >
          <option value="rectangle">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          <option value="bezier">Bezier</option>
        </select>
      </label>
      {parameters.map((parameter) => {
        const spec = effectAnimationParameterSpec(effect, parameter) ?? MASK_LIMITS[parameter]
        const numericValue = Number(effect.params[parameter])
        return (
          <div key={parameter} className="inspector-effect-parameter">
            <NumericField
              label={spec.label}
              value={Number.isFinite(numericValue) ? numericValue : 0}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              scale={100}
              disabled={locked || !Number.isFinite(numericValue)}
              testId={`inspector-effect-mask-${parameter}-${effect.id}`}
              onCommit={(value) => updateAtFrame(
                clip,
                effect,
                playheadFrame,
                { [parameter]: value },
              )}
            />
            {Number.isFinite(numericValue) && clip.text === undefined && (
              <EffectParameterAnimation
                clip={clip}
                effect={effect}
                parameter={parameter}
                spec={spec}
                value={numericValue}
                playheadFrame={playheadFrame}
                locked={locked}
              />
            )}
          </div>
        )
      })}
      {toggle(
        'Invert mask',
        effect.params.invert === true,
        locked,
        `inspector-effect-mask-invert-${effect.id}`,
        (invert) => updateAtFrame(clip, effect, playheadFrame, { invert }),
      )}
      {clip.text !== undefined && (
        <span className="inspector-note">
          Mask keyframes are available on visual media clips; text effect parameters stay static.
        </span>
      )}
      {effect.params.shape === 'bezier' && (
        <BezierPathField
          clip={clip}
          effect={effect}
          playheadFrame={playheadFrame}
          locked={locked}
        />
      )}
    </div>
  )
}

function ChromaKeyFields({
  clip,
  effect,
  playheadFrame,
  locked,
}: {
  clip: Clip
  effect: EffectDescriptor
  playheadFrame: number
  locked: boolean
}) {
  return (
    <div className="inspector-effect-params">
      <label className="inspector-field">
        <span className="inspector-field-label">Key color</span>
        <input
          type="color"
          value={String(effect.params.color)}
          disabled={locked}
          data-testid={`inspector-effect-key-color-${effect.id}`}
          onChange={(event) => updateAtFrame(
            clip,
            effect,
            playheadFrame,
            { color: event.target.value },
          )}
        />
      </label>
      {(['tolerance', 'softness', 'spill'] as const).map((parameter) => {
        const spec = CHROMA_KEY_LIMITS[parameter]
        return (
          <NumericField
            key={parameter}
            label={spec.label}
            value={Number(effect.params[parameter])}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            scale={100}
            disabled={locked}
            testId={`inspector-effect-key-${parameter}-${effect.id}`}
            onCommit={(value) => updateAtFrame(
              clip,
              effect,
              playheadFrame,
              { [parameter]: value },
            )}
          />
        )
      })}
    </div>
  )
}

function ColorFields({
  clip,
  effect,
  playheadFrame,
  locked,
}: {
  clip: Clip
  effect: EffectDescriptor
  playheadFrame: number
  locked: boolean
}) {
  const entries = [
    ['exposure', 'Exposure (stops)', 1],
    ['contrast', 'Contrast (%)', 100],
    ['saturation', 'Saturation (%)', 100],
    ['temperature', 'Temperature (%)', 100],
    ['tint', 'Tint (%)', 100],
  ] as const
  return (
    <div className="inspector-effect-params">
      {entries.map(([parameter, label, scale]) => {
        const limit = COLOR_ADJUST_LIMITS[parameter]
        return (
          <NumericField
            key={parameter}
            label={label}
            value={Number(effect.params[parameter] ?? 0)}
            min={limit.min}
            max={limit.max}
            step={limit.step}
            scale={scale}
            disabled={locked}
            testId={`inspector-effect-${parameter}-${effect.id}`}
            onCommit={(value) => updateAtFrame(
              clip,
              effect,
              playheadFrame,
              { [parameter]: value },
            )}
          />
        )
      })}
    </div>
  )
}

export default function EffectStackInspector({
  doc,
  clip,
  locked,
  playheadFrame,
}: {
  doc: TimelineDoc
  clip: Clip
  locked: boolean
  playheadFrame: number
}) {
  const effectStatuses = usePreviewStatusStore((state) => state.effectStatuses)
  const probes = {
    color: createColorAdjustEffect('__effect-budget-color__'),
    chroma: createChromaKeyEffect('__effect-budget-chroma__'),
    mask: createMaskEffect('__effect-budget-mask__', 'rectangle'),
  }
  const limits = {
    color: effectAppendBudgetError(doc, clip, probes.color),
    chroma: effectAppendBudgetError(doc, clip, probes.chroma),
    mask: effectAppendBudgetError(doc, clip, probes.mask),
  }
  const addBudgetReasonBaseId = useId()
  const addBudgetReasons = [...new Set(
    [limits.color, limits.chroma, limits.mask]
      .filter((reason): reason is string => reason !== null),
  )]
  const addBudgetReasonId = (reason: string | null): string | undefined => {
    if (reason === null) return undefined
    const index = addBudgetReasons.indexOf(reason)
    return index < 0 ? undefined : `${addBudgetReasonBaseId}-${index}`
  }
  const store = useDocumentStore.getState
  const add = (effect: EffectDescriptor): void => store().addEffect(clip.id, effect)
  const newId = (): string => `fx_${crypto.randomUUID()}`

  return (
    <section className="inspector-section inspector-effects" aria-labelledby="inspector-effects-heading">
      <div className="inspector-section-bar">
        <h3 id="inspector-effects-heading">Effect stack</h3>
        <div className="inspector-effect-actions" aria-label="Add effect">
          <button type="button" className="inspector-effect-add" disabled={locked || limits.color !== null} aria-describedby={addBudgetReasonId(limits.color)} onClick={() => add(createColorAdjustEffect(newId()))}>Add color</button>
          <button type="button" className="inspector-effect-add" disabled={locked || limits.chroma !== null} aria-describedby={addBudgetReasonId(limits.chroma)} onClick={() => add(createChromaKeyEffect(newId()))}>Add chroma key</button>
          <button type="button" className="inspector-effect-add" disabled={locked || limits.mask !== null} aria-describedby={addBudgetReasonId(limits.mask)} onClick={() => add(createMaskEffect(newId(), 'rectangle'))}>Add rectangle mask</button>
          <button type="button" className="inspector-effect-add" disabled={locked || limits.mask !== null} aria-describedby={addBudgetReasonId(limits.mask)} onClick={() => add(createMaskEffect(newId(), 'ellipse'))}>Add ellipse mask</button>
          <button type="button" className="inspector-effect-add" disabled={locked || limits.mask !== null} aria-describedby={addBudgetReasonId(limits.mask)} onClick={() => add(createMaskEffect(newId(), 'bezier'))}>Add Bezier mask</button>
        </div>
      </div>
      <span className="inspector-note">
        Effects run from top to bottom in project space after transform and crop, then before opacity and compositing.
      </span>
      <span className="inspector-note">
        Mask positions and sizes are normalized to the project canvas; off-canvas geometry is clipped. Feather is a fraction of the shorter project edge.
      </span>
      <span className="inspector-note">
        Status describes Program Monitor preview. Export probes its own render context separately.
      </span>
      {addBudgetReasons.map((reason, index) => (
        <span
          className="inspector-note"
          id={`${addBudgetReasonBaseId}-${index}`}
          key={reason}
          role="status"
        >
          {reason}.
        </span>
      ))}
      {clip.effects.length === 0
        ? <span className="inspector-effect-empty">No effects on this clip.</span>
        : (
            <ol className="inspector-effect-list" aria-label="Ordered clip effects">
              {clip.effects.map((effect, index) => {
                const resolution = effectStatuses.get(effect.id) ?? {
                  label: effectRegistration(effect.type)?.label ?? effect.type,
                  status: 'unsupported' as const,
                  detail: PENDING_PREVIEW_EFFECT_DETAIL,
                }
                const editableColor = effect.type === COLOR_ADJUST_EFFECT_TYPE
                  && effect.version === COLOR_ADJUST_EFFECT_VERSION
                const editableMask = effect.type === MASK_EFFECT_TYPE
                  && effect.version === MASK_EFFECT_VERSION
                const editableChroma = effect.type === CHROMA_KEY_EFFECT_TYPE
                  && effect.version === CHROMA_KEY_EFFECT_VERSION
                const resettable = effectRegistration(effect.type)?.version === effect.version
                return (
                  <li className="inspector-effect-card" key={effect.id}>
                    <div className="inspector-effect-card-heading">
                      <span><strong>{resolution.label}</strong><small>{index + 1} of {clip.effects.length}</small></span>
                      <span className={`inspector-effect-status is-${resolution.status}`} aria-label={`Effect status: ${resolution.status}`}>{resolution.status}</span>
                    </div>
                    {toggle(
                      effect.enabled ? 'Enabled' : 'Bypassed',
                      effect.enabled,
                      locked,
                      `inspector-effect-enabled-${effect.id}`,
                      (enabled) => store().setEffectEnabled(clip.id, effect.id, enabled),
                    )}
                    {editableColor && <ColorFields clip={clip} effect={effect} playheadFrame={playheadFrame} locked={locked} />}
                    {editableMask && <MaskFields clip={clip} effect={effect} playheadFrame={playheadFrame} locked={locked} />}
                    {editableChroma && <ChromaKeyFields clip={clip} effect={effect} playheadFrame={playheadFrame} locked={locked} />}
                    <span className="inspector-note">{resolution.detail}</span>
                    <div className="inspector-effect-actions" aria-label={`${resolution.label} actions`}>
                      <button type="button" disabled={locked || index === 0} aria-label={`Move ${resolution.label} up`} onClick={() => store().reorderEffect(clip.id, effect.id, index - 1)}>Move up</button>
                      <button type="button" disabled={locked || index === clip.effects.length - 1} aria-label={`Move ${resolution.label} down`} onClick={() => store().reorderEffect(clip.id, effect.id, index + 1)}>Move down</button>
                      <button type="button" disabled={locked || !resettable} aria-label={`Reset ${resolution.label}`} onClick={() => store().resetEffect(clip.id, effect.id)}>Reset</button>
                      <button type="button" disabled={locked} aria-label={`Remove ${resolution.label}`} onClick={() => store().removeEffect(clip.id, effect.id)}>Remove</button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
    </section>
  )
}
