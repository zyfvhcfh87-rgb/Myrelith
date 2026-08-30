import { useId, type KeyboardEvent } from 'react'
import type { AudioEffectDescriptor, TimelineDoc } from '../domain/schema'
import type { AudioEffectTarget } from '../domain/operations'
import {
  clipAudioEffects,
  masterAudioEffects,
  trackAudioEffects,
  audioEffectAppendBudgetError,
} from '../domain/audioEffectBounds'
import {
  COMPRESSOR_EFFECT_TYPE,
  COMPRESSOR_EFFECT_VERSION,
  COMPRESSOR_LIMITS,
  createCompressorEffect,
  createLimiterEffect,
  createParametricEqEffect,
  EQ_BAND_GAIN_LIMITS,
  EQ_BAND_FREQ_LIMITS,
  EQ_BAND_Q_LIMITS,
  EQ_BAND_TYPES,
  LIMITER_EFFECT_TYPE,
  LIMITER_EFFECT_VERSION,
  LIMITER_LIMITS,
  PARAMETRIC_EQ_EFFECT_TYPE,
  PARAMETRIC_EQ_EFFECT_VERSION,
  audioEffectRegistration,
  type EqBandType,
} from '../domain/audioEffectStack'
import {
  PENDING_AUDIO_EFFECT_DETAIL,
  useAudioEffectStatusStore,
} from '../state/audioEffectStatusStore'
import { useDocumentStore } from '../state/documentStore'
import { AUDIO_EFFECT_PRESETS } from '../domain/audioEffectPresets'
import { NumberField } from './inspector/InspectorFields'

function stackForTarget(
  doc: TimelineDoc,
  target: AudioEffectTarget,
): readonly AudioEffectDescriptor[] {
  if (target.kind === 'master') return masterAudioEffects(doc.masterAudio)
  if (target.kind === 'track') {
    const track = doc.tracks.find((item) => item.id === target.trackId)
    return track ? trackAudioEffects(track) : []
  }
  for (const track of doc.tracks) {
    const clip = track.clips.find((item) => item.id === target.clipId)
    if (clip) return clipAudioEffects(clip)
  }
  return []
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
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  )
}

function bandTypeLabel(type: EqBandType): string {
  if (type === 'lowshelf') return 'Low shelf'
  if (type === 'highshelf') return 'High shelf'
  if (type === 'lowpass') return 'Low pass'
  if (type === 'highpass') return 'High pass'
  if (type === 'notch') return 'Notch'
  return 'Peak'
}

function EqFields({
  effect,
  locked,
  onPatch,
}: {
  effect: AudioEffectDescriptor
  locked: boolean
  onPatch: (patch: Record<string, string | number>) => void
}) {
  return (
    <div className="inspector-effect-params">
      {([1, 2, 3, 4] as const).map((band) => {
        const typeKey = `band${band}Type`
        const freqKey = `band${band}Freq`
        const qKey = `band${band}Q`
        const gainKey = `band${band}Gain`
        const typeValue = String(effect.params[typeKey])
        return (
          <div className="inspector-audio-eq-band" key={band}>
            <label className="inspector-field">
              <span className="inspector-field-label">{`Band ${band} type`}</span>
              <select
                value={typeValue}
                disabled={locked}
                data-testid={`inspector-audio-effect-${typeKey}-${effect.id}`}
                onChange={(event) => onPatch({ [typeKey]: event.currentTarget.value })}
              >
                {EQ_BAND_TYPES.map((type) => (
                  <option key={type} value={type}>{bandTypeLabel(type)}</option>
                ))}
              </select>
            </label>
            <NumberField
              label={EQ_BAND_FREQ_LIMITS.label}
              value={Number(effect.params[freqKey])}
              min={EQ_BAND_FREQ_LIMITS.min}
              max={EQ_BAND_FREQ_LIMITS.max}
              step={EQ_BAND_FREQ_LIMITS.step}
              disabled={locked}
              testId={`inspector-audio-effect-${freqKey}-${effect.id}`}
              clamp
              onCommit={(value) => onPatch({ [freqKey]: value })}
            />
            <NumberField
              label={EQ_BAND_Q_LIMITS.label}
              value={Number(effect.params[qKey])}
              min={EQ_BAND_Q_LIMITS.min}
              max={EQ_BAND_Q_LIMITS.max}
              step={EQ_BAND_Q_LIMITS.step}
              disabled={locked}
              testId={`inspector-audio-effect-${qKey}-${effect.id}`}
              clamp
              onCommit={(value) => onPatch({ [qKey]: value })}
            />
            <NumberField
              label={EQ_BAND_GAIN_LIMITS.label}
              value={Number(effect.params[gainKey])}
              min={EQ_BAND_GAIN_LIMITS.min}
              max={EQ_BAND_GAIN_LIMITS.max}
              step={EQ_BAND_GAIN_LIMITS.step}
              disabled={locked}
              testId={`inspector-audio-effect-${gainKey}-${effect.id}`}
              clamp
              onCommit={(value) => onPatch({ [gainKey]: value })}
            />
          </div>
        )
      })}
    </div>
  )
}

function CompressorFields({
  effect,
  locked,
  onPatch,
}: {
  effect: AudioEffectDescriptor
  locked: boolean
  onPatch: (patch: Record<string, number>) => void
}) {
  return (
    <div className="inspector-effect-params">
      {(Object.keys(COMPRESSOR_LIMITS) as (keyof typeof COMPRESSOR_LIMITS)[]).map((parameter) => {
        const spec = COMPRESSOR_LIMITS[parameter]
        return (
          <NumberField
            key={parameter}
            label={spec.label}
            value={Number(effect.params[parameter])}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            disabled={locked}
            testId={`inspector-audio-effect-${parameter}-${effect.id}`}
            clamp
            onCommit={(value) => onPatch({ [parameter]: value })}
          />
        )
      })}
    </div>
  )
}

function LimiterFields({
  effect,
  locked,
  onPatch,
}: {
  effect: AudioEffectDescriptor
  locked: boolean
  onPatch: (patch: Record<string, number>) => void
}) {
  return (
    <div className="inspector-effect-params">
      {(Object.keys(LIMITER_LIMITS) as (keyof typeof LIMITER_LIMITS)[]).map((parameter) => {
        const spec = LIMITER_LIMITS[parameter]
        return (
          <NumberField
            key={parameter}
            label={spec.label}
            value={Number(effect.params[parameter])}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            disabled={locked}
            testId={`inspector-audio-effect-${parameter}-${effect.id}`}
            clamp
            onCommit={(value) => onPatch({ [parameter]: value })}
          />
        )
      })}
    </div>
  )
}

export default function AudioEffectStackInspector({
  doc,
  target,
  locked,
  heading,
}: {
  doc: TimelineDoc
  target: AudioEffectTarget
  locked: boolean
  heading: string
}) {
  const stack = stackForTarget(doc, target)
  const statuses = useAudioEffectStatusStore((state) => state.statuses)
  const probes = {
    eq: createParametricEqEffect('__audio-effect-budget-eq__'),
    compressor: createCompressorEffect('__audio-effect-budget-compressor__'),
    limiter: createLimiterEffect('__audio-effect-budget-limiter__'),
  }
  const limits = {
    eq: audioEffectAppendBudgetError(doc, stack, probes.eq),
    compressor: audioEffectAppendBudgetError(doc, stack, probes.compressor),
    limiter: audioEffectAppendBudgetError(doc, stack, probes.limiter),
  }
  const addBudgetReasonBaseId = useId()
  const addBudgetReasons = [...new Set(
    [limits.eq, limits.compressor, limits.limiter]
      .filter((reason): reason is string => reason !== null),
  )]
  const addBudgetReasonId = (reason: string | null): string | undefined => {
    if (reason === null) return undefined
    const index = addBudgetReasons.indexOf(reason)
    return index < 0 ? undefined : `${addBudgetReasonBaseId}-${index}`
  }
  const store = useDocumentStore.getState
  const add = (effect: AudioEffectDescriptor): void => store().addAudioEffect(target, effect)
  const newId = (): string => `afx_${crypto.randomUUID()}`
  const headingId = useId()
  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') event.currentTarget.blur()
  }

  return (
    <section className="inspector-section inspector-effects" aria-labelledby={headingId}>
      <div className="inspector-section-bar">
        <h3 id={headingId}>{heading}</h3>
        <div className="inspector-effect-actions" aria-label={`Add ${heading.toLowerCase()}`}>
          <button
            type="button"
            className="inspector-effect-add"
            disabled={locked || limits.eq !== null}
            aria-describedby={addBudgetReasonId(limits.eq)}
            onClick={() => add(createParametricEqEffect(newId()))}
          >
            Add EQ
          </button>
          <button
            type="button"
            className="inspector-effect-add"
            disabled={locked || limits.compressor !== null}
            aria-describedby={addBudgetReasonId(limits.compressor)}
            onClick={() => add(createCompressorEffect(newId()))}
          >
            Add compressor
          </button>
          <button
            type="button"
            className="inspector-effect-add"
            disabled={locked || limits.limiter !== null}
            aria-describedby={addBudgetReasonId(limits.limiter)}
            onClick={() => add(createLimiterEffect(newId()))}
          >
            Add limiter
          </button>
          {AUDIO_EFFECT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="inspector-effect-add"
              disabled={locked}
              title={preset.detail}
              onClick={() => store().applyAudioEffectPreset(target, preset.id)}
            >
              {preset.label} preset
            </button>
          ))}
        </div>
      </div>
      <span className="inspector-note">
        Audio effects run in authored order at this mix stage. Live playback and
        export share the same processors; bypass, reorder, reset, and unknown
        descriptors are preserved.
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
      {stack.length === 0
        ? <span className="inspector-effect-empty">No audio effects on this stack.</span>
        : (
            <ol className="inspector-effect-list" aria-label={`Ordered ${heading.toLowerCase()}`}>
              {stack.map((effect, index) => {
                const resolution = statuses.get(effect.id) ?? {
                  label: audioEffectRegistration(effect.type)?.label ?? effect.type,
                  status: 'unsupported' as const,
                  detail: PENDING_AUDIO_EFFECT_DETAIL,
                }
                const editableEq = effect.type === PARAMETRIC_EQ_EFFECT_TYPE
                  && effect.version === PARAMETRIC_EQ_EFFECT_VERSION
                const editableCompressor = effect.type === COMPRESSOR_EFFECT_TYPE
                  && effect.version === COMPRESSOR_EFFECT_VERSION
                const editableLimiter = effect.type === LIMITER_EFFECT_TYPE
                  && effect.version === LIMITER_EFFECT_VERSION
                const resettable = audioEffectRegistration(effect.type)?.version === effect.version
                const patch = (next: Record<string, string | number>): void => {
                  store().updateAudioEffectParams(target, effect.id, next)
                }
                return (
                  <li
                    className="inspector-effect-card"
                    key={effect.id}
                    onKeyDown={onCardKeyDown}
                  >
                    <div className="inspector-effect-card-heading">
                      <span>
                        <strong>{resolution.label}</strong>
                        <small>{index + 1} of {stack.length}</small>
                      </span>
                      <span
                        className={`inspector-effect-status is-${resolution.status}`}
                        aria-label={`Audio effect status: ${resolution.status}`}
                      >
                        {resolution.status}
                      </span>
                    </div>
                    {toggle(
                      effect.enabled ? 'Enabled' : 'Bypassed',
                      effect.enabled,
                      locked,
                      `inspector-audio-effect-enabled-${effect.id}`,
                      (enabled) => store().setAudioEffectEnabled(target, effect.id, enabled),
                    )}
                    {editableEq && <EqFields effect={effect} locked={locked} onPatch={patch} />}
                    {editableCompressor && (
                      <CompressorFields effect={effect} locked={locked} onPatch={patch} />
                    )}
                    {editableLimiter && (
                      <LimiterFields effect={effect} locked={locked} onPatch={patch} />
                    )}
                    <span className="inspector-note">{resolution.detail}</span>
                    <div className="inspector-effect-actions" aria-label={`${resolution.label} actions`}>
                      <button
                        type="button"
                        disabled={locked || index === 0}
                        aria-label={`Move ${resolution.label} up`}
                        onClick={() => store().reorderAudioEffect(target, effect.id, index - 1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        disabled={locked || index === stack.length - 1}
                        aria-label={`Move ${resolution.label} down`}
                        onClick={() => store().reorderAudioEffect(target, effect.id, index + 1)}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        disabled={locked || !resettable}
                        aria-label={`Reset ${resolution.label}`}
                        onClick={() => store().resetAudioEffect(target, effect.id)}
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        aria-label={`Remove ${resolution.label}`}
                        onClick={() => store().removeAudioEffect(target, effect.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
    </section>
  )
}
