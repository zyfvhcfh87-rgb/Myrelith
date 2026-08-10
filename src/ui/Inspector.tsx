/**
 * ui/Inspector.tsx — Issue #34's contextual static clip authoring surface.
 *
 * Number fields keep a local draft and commit once on blur/Enter; Escape and
 * invalid input revert without polluting history. Sliders and toggles commit
 * immediately, with explicit bounded keyboard behavior. Each reset remains
 * one atomic document-store mutation. Linked A/V selections resolve both
 * document-owned halves. Issue #43 resolves supported visual properties at
 * the integer playhead through the shared pure animation path.
 * Layering: ui/ → state/ + domain selectors only.
 */

import {
  lazy,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { FileAudio, FileVideo, LinkBreak } from '@phosphor-icons/react'
import {
  clipAudioSettings,
  clipVisualSettings,
  DEFAULT_CLIP_AUDIO_SETTINGS,
  DEFAULT_CLIP_VISUAL_SETTINGS,
  MAX_CLIP_SCALE,
  MAX_CROP_SUM,
} from '../domain/clipInspector'
import { resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import {
  getLinkClipsEligibility,
  linkedPartners,
  type LinkClipsRejectionReason,
} from '../domain/linking'
import type {
  ClipAudioPatch,
  ClipVisualPatch,
  TextPropsPatch,
} from '../domain/operations'
import type {
  Clip,
  ClipId,
  TextFontFamily,
  TimelineDoc,
} from '../domain/schema'
import { findClip, trackOfClip } from '../domain/selectors'
import {
  TEXT_FONT_FAMILIES,
  TEXT_OVERLAY_LIMITS,
  textPropsValidationError,
} from '../domain/textOverlay'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { useTransportStore } from '../state/transportStore'
import LazySurfaceBoundary from './LazySurfaceBoundary'
import {
  BLEND_MODE_NAMES,
  clipBlendModeIntent,
  DEFAULT_BLEND_MODE,
  isBlendModeName,
  type BlendModeName,
} from '../domain/blendModes'
import {
  COLOR_ADJUST_EFFECT_TYPE,
  COLOR_ADJUST_EFFECT_VERSION,
  COLOR_ADJUST_LIMITS,
  createColorAdjustEffect,
} from '../domain/effectStack'
import { effectAppendBudgetError } from '../domain/effectBounds'
import {
  clipSourceTimeMap,
  sourceTimeAudioPolicy,
  sourceTimeRateFromPercent,
  sourceTimeRatePercent,
} from '../domain/sourceTimeMap'

const AnimationCurveEditor = lazy(() => import('./AnimationCurveEditor'))

const BLEND_MODE_LABELS: Readonly<Record<BlendModeName, string>> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
}

const ADD_COLOR_BUDGET_PROBE = createColorAdjustEffect('__effect-budget-probe__')
const PENDING_PREVIEW_EFFECT_DETAIL =
  'Preview renderer status has not been projected yet; the effect is preserved and bypassed.'

interface NumberFieldProps {
  label: string
  value: number
  step: number
  testId: string
  onCommit: (value: number) => void
  min?: number
  max?: number
  disabled?: boolean
  clamp?: boolean
}

function NumberField({
  label,
  value,
  step,
  testId,
  onCommit,
  min,
  max,
  disabled = false,
  clamp = false,
}: NumberFieldProps) {
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
    const candidate = clamp
      ? Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed))
      : parsed
    if (candidate === value) {
      setDraft(String(value))
      return
    }
    setDraft(String(candidate))
    onCommit(candidate)
  }

  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
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

interface RangeNumberFieldProps extends Omit<NumberFieldProps, 'onCommit'> {
  onCommit: (value: number) => void
}

/** Slider commits immediately; its paired number field keeps one typed commit. */
function RangeNumberField(props: RangeNumberFieldProps) {
  const { label, value, min, max, step, testId, disabled = false, onCommit } = props
  const commitKey = (key: string): boolean => {
    const minimum = min ?? 0
    const maximum = max ?? 100
    let next: number
    if (key === 'Home') next = minimum
    else if (key === 'End') next = maximum
    else if (key === 'ArrowLeft' || key === 'ArrowDown') next = value - step
    else if (key === 'ArrowRight' || key === 'ArrowUp') next = value + step
    else if (key === 'PageDown') next = value - step * 10
    else if (key === 'PageUp') next = value + step * 10
    else return false
    const decimals = String(step).split('.')[1]?.length ?? 0
    const bounded = Math.min(maximum, Math.max(minimum, next))
    onCommit(Number(bounded.toFixed(decimals)))
    return true
  }
  return (
    <div className="inspector-range-field">
      <input
        type="range"
        aria-label={`${label} slider`}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={`${testId}-slider`}
        onChange={(event) => onCommit(Number(event.target.value))}
        onKeyDown={(event) => {
          if (commitKey(event.key)) event.preventDefault()
        }}
      />
      <NumberField {...props} clamp />
    </div>
  )
}

function InspectorSection({
  title,
  resetLabel,
  disabled,
  onReset,
  children,
}: {
  title: string
  resetLabel: string
  disabled: boolean
  onReset(): void
  children: ReactNode
}) {
  return (
    <section className="inspector-section" aria-label={title}>
      <div className="inspector-section-bar">
        <h3>{title}</h3>
        <button
          type="button"
          className="inspector-reset"
          disabled={disabled}
          aria-label={resetLabel}
          onClick={onReset}
        >
          Reset
        </button>
      </div>
      {children}
    </section>
  )
}

function TextAreaField({
  value,
  disabled,
  onCommit,
}: {
  value: string
  disabled: boolean
  onCommit(value: string): void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <label className="inspector-field inspector-field-wide">
      <span className="inspector-field-label">Content</span>
      <textarea
        data-testid="inspector-text-content"
        value={draft}
        rows={4}
        maxLength={TEXT_OVERLAY_LIMITS.maxCharacters}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(value)
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

function TextOverlayFields({ clip, locked }: { clip: Clip; locked: boolean }) {
  const text = clip.text
  const [message, setMessage] = useState<string | null>(null)
  if (!text) return null

  const commit = (patch: TextPropsPatch): void => {
    if (locked) {
      setMessage('Unlock this video track before editing its text.')
      return
    }
    const error = textPropsValidationError({ ...text, ...patch })
    if (error) {
      setMessage(error)
      return
    }
    useDocumentStore.getState().updateTextClip(clip.id, patch)
    setMessage(null)
  }
  const toggle = (key: 'bold' | 'italic' | 'backgroundEnabled' | 'outlineEnabled' | 'shadowEnabled') => (
    <label className="inspector-toggle">
      <input
        type="checkbox"
        checked={text[key]}
        disabled={locked}
        onChange={(event) => commit({ [key]: event.target.checked })}
      />
      <span>{key === 'backgroundEnabled' ? 'Background' : key === 'outlineEnabled' ? 'Outline' : key === 'shadowEnabled' ? 'Shadow' : key[0].toUpperCase() + key.slice(1)}</span>
    </label>
  )
  const color = (
    label: string,
    key: 'color' | 'backgroundColor' | 'outlineColor' | 'shadowColor',
  ) => (
    <label className="inspector-field inspector-color-field">
      <span className="inspector-field-label">{label}</span>
      <input
        type="color"
        value={text[key].slice(0, 7)}
        disabled={locked}
        onChange={(event) => commit({ [key]: event.target.value })}
      />
    </label>
  )

  return (
    <section className="inspector-text" aria-labelledby="inspector-text-heading">
      <div className="inspector-section-heading" id="inspector-text-heading">Text</div>
      <div className="inspector-grid">
        <TextAreaField value={text.content} disabled={locked} onCommit={(content) => commit({ content })} />
        <label className="inspector-field">
          <span className="inspector-field-label">Font family</span>
          <select
            data-testid="inspector-text-font"
            value={text.fontFamily}
            disabled={locked}
            onChange={(event) => commit({ fontFamily: event.target.value as TextFontFamily })}
          >
            {TEXT_FONT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
          </select>
        </label>
        <NumberField label="Font size" value={text.fontSizePx} step={1} min={TEXT_OVERLAY_LIMITS.minFontSizePx} max={TEXT_OVERLAY_LIMITS.maxFontSizePx} testId="inspector-text-size" disabled={locked} onCommit={(fontSizePx) => commit({ fontSizePx })} />
        <label className="inspector-field">
          <span className="inspector-field-label">Alignment</span>
          <select value={text.align} disabled={locked} onChange={(event) => commit({ align: event.target.value as 'left' | 'center' | 'right' })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        {color('Text color', 'color')}
        <div className="inspector-toggle-row inspector-field-wide">{toggle('bold')}{toggle('italic')}</div>
        <NumberField label="Box width" value={text.boxWidthPx} step={1} min={TEXT_OVERLAY_LIMITS.minBoxSizePx} max={TEXT_OVERLAY_LIMITS.maxBoxSizePx} testId="inspector-text-width" disabled={locked} onCommit={(boxWidthPx) => commit({ boxWidthPx })} />
        <NumberField label="Box height" value={text.boxHeightPx} step={1} min={TEXT_OVERLAY_LIMITS.minBoxSizePx} max={TEXT_OVERLAY_LIMITS.maxBoxSizePx} testId="inspector-text-height" disabled={locked} onCommit={(boxHeightPx) => commit({ boxHeightPx })} />
        <NumberField label="Padding" value={text.paddingPx} step={1} min={0} max={TEXT_OVERLAY_LIMITS.maxPaddingPx} testId="inspector-text-padding" disabled={locked} onCommit={(paddingPx) => commit({ paddingPx })} />
        <div className="inspector-toggle-row">{toggle('backgroundEnabled')}</div>
        {color('Background', 'backgroundColor')}
        <div className="inspector-toggle-row">{toggle('outlineEnabled')}</div>
        {color('Outline color', 'outlineColor')}
        <NumberField label="Outline width" value={text.outlineWidthPx} step={1} min={0} max={TEXT_OVERLAY_LIMITS.maxOutlineWidthPx} testId="inspector-text-outline" disabled={locked} onCommit={(outlineWidthPx) => commit({ outlineWidthPx })} />
        <div className="inspector-toggle-row">{toggle('shadowEnabled')}</div>
        {color('Shadow color', 'shadowColor')}
        <NumberField label="Shadow blur" value={text.shadowBlurPx} step={1} min={0} max={TEXT_OVERLAY_LIMITS.maxShadowBlurPx} testId="inspector-text-shadow-blur" disabled={locked} onCommit={(shadowBlurPx) => commit({ shadowBlurPx })} />
        <NumberField label="Shadow X" value={text.shadowOffsetXPx} step={1} min={-TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} max={TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} testId="inspector-text-shadow-x" disabled={locked} onCommit={(shadowOffsetXPx) => commit({ shadowOffsetXPx })} />
        <NumberField label="Shadow Y" value={text.shadowOffsetYPx} step={1} min={-TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} max={TEXT_OVERLAY_LIMITS.maxShadowOffsetPx} testId="inspector-text-shadow-y" disabled={locked} onCommit={(shadowOffsetYPx) => commit({ shadowOffsetYPx })} />
      </div>
      <div className="inspector-text-status" role={message ? 'alert' : 'status'} aria-live="polite">
        {message ?? (locked ? 'Unlock this video track to edit the overlay.' : 'Ctrl/Cmd+Enter commits multiline text.')}
      </div>
      <button
        type="button"
        className="inspector-delete-text"
        disabled={locked}
        onClick={() => {
          useDocumentStore.getState().rippleDelete(clip.id)
          useTransportStore.getState().setSelectedClip(null)
        }}
      >
        Delete text overlay
      </button>
    </section>
  )
}

function ToggleField({
  label,
  checked,
  disabled,
  testId,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  testId: string
  onChange(checked: boolean): void
}) {
  return (
    <label className="inspector-toggle inspector-toggle-control">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

const SPEED_PERCENT_OPTIONS = Object.freeze(
  Array.from({ length: 16 }, (_value, index) => (index + 1) * 25),
)

/** Constant-speed authoring stays visible regardless of the active video tab. */
function TimingInspectorSection({
  clip,
  doc,
}: {
  clip: Clip
  doc: TimelineDoc
}) {
  const map = clipSourceTimeMap(clip)
  const speedPercent = sourceTimeRatePercent(map.rate)
  const members = [clip, ...linkedPartners(doc, clip.id)]
  const retimable = members.every(
    (member) => member.sourceMode === 'timed' && member.text === undefined,
  )
  const locked = members.some(
    (member) => trackOfClip(doc, member.id)?.locked ?? true,
  )
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setMessage(null)
  }, [clip.id, map.rate.numerator, map.rate.denominator])

  const commit = (percent: number): void => {
    const store = useDocumentStore.getState()
    const before = store.doc
    const latest = findClip(before, clip.id)
    if (!latest) {
      setMessage('This clip is no longer available. Select it again and retry.')
      return
    }
    store.retimeClip(clip.id, sourceTimeRateFromPercent(percent))
    const after = useDocumentStore.getState().doc
    if (after === before) {
      setMessage(
        'Speed change was not applied. Unlock linked tracks or make room beside the clip and try again.',
      )
      return
    }
    const updated = findClip(after, clip.id)
    setMessage(
      updated
        ? `Speed changed to ${percent}%. Timeline duration is now ${updated.timelineRange.durationFrames} frames.`
        : `Speed changed to ${percent}%.`,
    )
  }

  const audioPolicy = sourceTimeAudioPolicy(clip)
  const linkedNote = members.length > 1
    ? ` The ${members.length} linked clips change together.`
    : ''

  return (
    <InspectorSection
      title="Timing"
      resetLabel="Reset clip speed"
      disabled={locked || !retimable || speedPercent === 100}
      onReset={() => commit(100)}
    >
      <label className="inspector-field inspector-field-wide">
        <span className="inspector-field-label">Speed</span>
        <select
          aria-describedby="inspector-speed-detail inspector-speed-audio inspector-speed-status"
          data-testid="inspector-speed"
          value={speedPercent}
          disabled={locked || !retimable}
          onChange={(event) => commit(Number(event.target.value))}
        >
          {SPEED_PERCENT_OPTIONS.map((percent) => (
            <option key={percent} value={percent}>{percent}%</option>
          ))}
        </select>
      </label>
      <span id="inspector-speed-detail" className="inspector-note">
        {retimable
          ? `Timeline ${clip.timelineRange.durationFrames} frames · source ${clip.sourceRange.durationFrames} frames.${linkedNote}`
          : 'Constant-speed retiming is available for timed video and audio clips.'}
      </span>
      <span id="inspector-speed-audio" className="inspector-note">
        {!retimable
          ? 'Still images and text keep their authored duration without decoded source-time mapping.'
          : audioPolicy.status === 'muted'
          ? 'Audio is muted at this speed in preview and export because pitch-safe time-stretch is not available.'
          : 'Audio stays enabled at 100% speed.'}
      </span>
      <span
        id="inspector-speed-status"
        className="inspector-text-status"
        role={message ? 'status' : undefined}
        aria-live="polite"
        aria-atomic="true"
      >
        {message ?? (locked ? 'Unlock this clip and every linked track to change speed.' : '')}
      </span>
    </InspectorSection>
  )
}

function VideoInspectorSections({
  doc,
  clip,
  locked,
  playheadFrame,
  activeTab,
}: {
  doc: TimelineDoc
  clip: Clip
  locked: boolean
  playheadFrame: number
  activeTab: 'transform' | 'crop' | 'effects' | 'animation'
}) {
  const visual = clipVisualSettings(clip)
  const transform = clip.transform
  const patch = (next: ClipVisualPatch): void =>
    useDocumentStore.getState().updateClipVisualAtFrame(
      clip.id,
      playheadFrame,
      next,
    )
  const cropPercent = (value: number): number => Math.round(value * 10_000) / 100
  const cropFraction = (value: number): number => Math.round(value * 100) / 10_000
  const blendModeIntent = clipBlendModeIntent(clip)
  const supportedBlendMode = isBlendModeName(blendModeIntent)

  return (
    <div className="inspector-section-stack" key={`video:${clip.id}`}>
      <div className="inspector-context-label">Video · {clip.name}</div>
      <div
        id="inspector-transform-panel"
        role="tabpanel"
        aria-labelledby="inspector-transform-tab"
        hidden={activeTab !== 'transform'}
      >
        <InspectorSection
        title="Transform"
        resetLabel="Reset video transform"
        disabled={locked}
        onReset={() => patch({
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            anchorX: 0.5,
            anchorY: 0.5,
          },
          visual: {
            scaleLocked: DEFAULT_CLIP_VISUAL_SETTINGS.scaleLocked,
            flipHorizontal: DEFAULT_CLIP_VISUAL_SETTINGS.flipHorizontal,
            flipVertical: DEFAULT_CLIP_VISUAL_SETTINGS.flipVertical,
          },
        })}
      >
        <div className="inspector-grid">
          <NumberField label="Position X" value={transform.x} step={1} testId="inspector-x" disabled={locked} onCommit={(x) => patch({ transform: { x } })} />
          <NumberField label="Position Y" value={transform.y} step={1} testId="inspector-y" disabled={locked} onCommit={(y) => patch({ transform: { y } })} />
          <NumberField label="Scale X" value={transform.scaleX} step={0.05} min={0.01} max={MAX_CLIP_SCALE} testId="inspector-scale-x" disabled={locked} clamp onCommit={(scaleX) => patch({ transform: { scaleX } })} />
          <NumberField label="Scale Y" value={transform.scaleY} step={0.05} min={0.01} max={MAX_CLIP_SCALE} testId="inspector-scale-y" disabled={locked} clamp onCommit={(scaleY) => patch({ transform: { scaleY } })} />
          <ToggleField label="Lock scale ratio" checked={visual.scaleLocked} disabled={locked} testId="inspector-scale-lock" onChange={(scaleLocked) => patch({ visual: { scaleLocked } })} />
          <NumberField label="Rotation °" value={transform.rotation} step={1} testId="inspector-rotation" disabled={locked} onCommit={(rotation) => patch({ transform: { rotation } })} />
          <RangeNumberField label="Anchor X (%)" value={transform.anchorX * 100} step={1} min={0} max={100} testId="inspector-anchor-x" disabled={locked} onCommit={(anchorX) => patch({ transform: { anchorX: anchorX / 100 } })} />
          <RangeNumberField label="Anchor Y (%)" value={transform.anchorY * 100} step={1} min={0} max={100} testId="inspector-anchor-y" disabled={locked} onCommit={(anchorY) => patch({ transform: { anchorY: anchorY / 100 } })} />
          <ToggleField label="Flip horizontally" checked={visual.flipHorizontal} disabled={locked} testId="inspector-flip-horizontal" onChange={(flipHorizontal) => patch({ visual: { flipHorizontal } })} />
          <ToggleField label="Flip vertically" checked={visual.flipVertical} disabled={locked} testId="inspector-flip-vertical" onChange={(flipVertical) => patch({ visual: { flipVertical } })} />
        </div>
        </InspectorSection>

        <InspectorSection
          title="Compositing"
          resetLabel="Reset video blend mode"
          disabled={locked}
          onReset={() => patch({ blendMode: DEFAULT_BLEND_MODE })}
        >
          <label className="inspector-field inspector-field-wide">
            <span className="inspector-field-label">Blend mode</span>
            <select
              value={blendModeIntent}
              disabled={locked}
              data-testid="inspector-blend-mode"
              aria-describedby="inspector-blend-mode-note"
              onChange={(event) => patch({ blendMode: event.target.value })}
            >
              {!supportedBlendMode && (
                <option value={blendModeIntent}>
                  Unsupported: {blendModeIntent || '(empty name)'}
                </option>
              )}
              {BLEND_MODE_NAMES.map((mode) => (
                <option key={mode} value={mode}>{BLEND_MODE_LABELS[mode]}</option>
              ))}
            </select>
          </label>
          <span id="inspector-blend-mode-note" className="inspector-note" aria-live="polite">
            {supportedBlendMode
              ? `${BLEND_MODE_LABELS[blendModeIntent]} is applied after transform, crop, and opacity.`
              : `“${blendModeIntent || '(empty name)'}” is preserved, but preview and export use Normal until it is supported.`}
          </span>
        </InspectorSection>

        <InspectorSection
        title="Opacity"
        resetLabel="Reset video opacity"
        disabled={locked}
        onReset={() => patch({ opacity: 1 })}
      >
        <RangeNumberField label="Opacity" value={clip.opacity} step={0.01} min={0} max={1} testId="inspector-opacity" disabled={locked} onCommit={(opacity) => patch({ opacity })} />
        </InspectorSection>
      </div>

      <div
        id="inspector-crop-panel"
        role="tabpanel"
        aria-labelledby="inspector-crop-tab"
        hidden={activeTab !== 'crop'}
      >
        <InspectorSection
        title="Crop"
        resetLabel="Reset video crop"
        disabled={locked}
        onReset={() => patch({ visual: { crop: { ...DEFAULT_CLIP_VISUAL_SETTINGS.crop } } })}
      >
        <div className="inspector-grid inspector-crop-grid">
          <RangeNumberField label="Crop left (%)" value={cropPercent(visual.crop.left)} step={0.1} min={0} max={cropPercent(MAX_CROP_SUM - visual.crop.right)} testId="inspector-crop-left" disabled={locked} onCommit={(left) => patch({ visual: { crop: { left: cropFraction(left) } } })} />
          <RangeNumberField label="Crop right (%)" value={cropPercent(visual.crop.right)} step={0.1} min={0} max={cropPercent(MAX_CROP_SUM - visual.crop.left)} testId="inspector-crop-right" disabled={locked} onCommit={(right) => patch({ visual: { crop: { right: cropFraction(right) } } })} />
          <RangeNumberField label="Crop top (%)" value={cropPercent(visual.crop.top)} step={0.1} min={0} max={cropPercent(MAX_CROP_SUM - visual.crop.bottom)} testId="inspector-crop-top" disabled={locked} onCommit={(top) => patch({ visual: { crop: { top: cropFraction(top) } } })} />
          <RangeNumberField label="Crop bottom (%)" value={cropPercent(visual.crop.bottom)} step={0.1} min={0} max={cropPercent(MAX_CROP_SUM - visual.crop.top)} testId="inspector-crop-bottom" disabled={locked} onCommit={(bottom) => patch({ visual: { crop: { bottom: cropFraction(bottom) } } })} />
        </div>
        <span className="inspector-note">Crop removes source edges without stretching the remainder.</span>
        </InspectorSection>
      </div>

      <div
        id="inspector-effects-panel"
        role="tabpanel"
        aria-labelledby="inspector-effects-tab"
        hidden={activeTab !== 'effects'}
      >
        <EffectStackInspector doc={doc} clip={clip} locked={locked} />
      </div>
    </div>
  )
}

function EffectStackInspector({
  doc,
  clip,
  locked,
}: {
  doc: TimelineDoc
  clip: Clip
  locked: boolean
}) {
  const effectStatuses = usePreviewStatusStore((state) => state.effectStatuses)
  const addLimitReason = effectAppendBudgetError(doc, clip, ADD_COLOR_BUDGET_PROBE)
  const store = useDocumentStore.getState

  return (
    <section className="inspector-section inspector-effects" aria-labelledby="inspector-effects-heading">
      <div className="inspector-section-bar">
        <h3 id="inspector-effects-heading">Effect stack</h3>
        <button
          type="button"
          className="inspector-effect-add"
          disabled={locked || addLimitReason !== null}
          aria-describedby={addLimitReason ? 'inspector-effect-add-limit' : undefined}
          onClick={() => store().addEffect(
            clip.id,
            createColorAdjustEffect(`fx_${crypto.randomUUID()}`),
          )}
        >
          Add color
        </button>
      </div>
      <span className="inspector-note">
        Effects run from top to bottom before opacity and compositing.
      </span>
      <span className="inspector-note">
        Status describes Program Monitor preview. Export probes its own render context separately.
      </span>
      {addLimitReason && (
        <span id="inspector-effect-add-limit" className="inspector-note" role="status">
          {addLimitReason}.
        </span>
      )}
      {clip.effects.length === 0
        ? <span className="inspector-effect-empty">No effects on this clip.</span>
        : (
            <ol className="inspector-effect-list" aria-label="Ordered clip effects">
              {clip.effects.map((effect, index) => {
                const resolution = effectStatuses.get(effect.id) ?? {
                  label: effect.type,
                  status: 'unsupported' as const,
                  detail: PENDING_PREVIEW_EFFECT_DETAIL,
                }
                const editableColor = effect.type === COLOR_ADJUST_EFFECT_TYPE
                  && effect.version === COLOR_ADJUST_EFFECT_VERSION
                  && (resolution.status === 'ready' || resolution.status === 'disabled')
                return (
                  <li className="inspector-effect-card" key={effect.id}>
                    <div className="inspector-effect-card-heading">
                      <span>
                        <strong>{resolution.label}</strong>
                        <small>{index + 1} of {clip.effects.length}</small>
                      </span>
                      <span
                        className={`inspector-effect-status is-${resolution.status}`}
                        aria-label={`Effect status: ${resolution.status}`}
                      >
                        {resolution.status}
                      </span>
                    </div>
                    <ToggleField
                      label={effect.enabled ? 'Enabled' : 'Bypassed'}
                      checked={effect.enabled}
                      disabled={locked}
                      testId={`inspector-effect-enabled-${effect.id}`}
                      onChange={(enabled) => store().setEffectEnabled(clip.id, effect.id, enabled)}
                    />
                    {editableColor && (
                      <div className="inspector-effect-params">
                        <RangeNumberField
                          label="Exposure (stops)"
                          value={effect.params.exposure as number}
                          step={COLOR_ADJUST_LIMITS.exposure.step}
                          min={COLOR_ADJUST_LIMITS.exposure.min}
                          max={COLOR_ADJUST_LIMITS.exposure.max}
                          testId={`inspector-effect-exposure-${effect.id}`}
                          disabled={locked}
                          onCommit={(exposure) => store().updateEffectParams(
                            clip.id,
                            effect.id,
                            { exposure },
                          )}
                        />
                        <RangeNumberField
                          label="Contrast (%)"
                          value={(effect.params.contrast as number) * 100}
                          step={1}
                          min={COLOR_ADJUST_LIMITS.contrast.min * 100}
                          max={COLOR_ADJUST_LIMITS.contrast.max * 100}
                          testId={`inspector-effect-contrast-${effect.id}`}
                          disabled={locked}
                          onCommit={(contrast) => store().updateEffectParams(
                            clip.id,
                            effect.id,
                            { contrast: contrast / 100 },
                          )}
                        />
                        <RangeNumberField
                          label="Saturation (%)"
                          value={(effect.params.saturation as number) * 100}
                          step={1}
                          min={COLOR_ADJUST_LIMITS.saturation.min * 100}
                          max={COLOR_ADJUST_LIMITS.saturation.max * 100}
                          testId={`inspector-effect-saturation-${effect.id}`}
                          disabled={locked}
                          onCommit={(saturation) => store().updateEffectParams(
                            clip.id,
                            effect.id,
                            { saturation: saturation / 100 },
                          )}
                        />
                      </div>
                    )}
                    <span className="inspector-note">{resolution.detail}</span>
                    <div className="inspector-effect-actions" aria-label={`${resolution.label} actions`}>
                      <button
                        type="button"
                        disabled={locked || index === 0}
                        aria-label={`Move ${resolution.label} up`}
                        onClick={() => store().reorderEffect(clip.id, effect.id, index - 1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        disabled={locked || index === clip.effects.length - 1}
                        aria-label={`Move ${resolution.label} down`}
                        onClick={() => store().reorderEffect(clip.id, effect.id, index + 1)}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        disabled={locked || !editableColor}
                        aria-label={`Reset ${resolution.label}`}
                        onClick={() => store().resetEffect(clip.id, effect.id)}
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        aria-label={`Remove ${resolution.label}`}
                        onClick={() => store().removeEffect(clip.id, effect.id)}
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

function AudioInspectorSection({ clip, locked }: { clip: Clip; locked: boolean }) {
  const audio = clipAudioSettings(clip)
  const channels = useMediaStore((state) =>
    state.assets.get(clip.assetId)?.audioChannels
      ?? state.descriptors.get(clip.assetId)?.audioChannels
      ?? null,
  )
  const balanceApplicable = channels !== 1
  const controlsDisabled = locked || !audio.enabled
  const patch = (next: ClipAudioPatch): void =>
    useDocumentStore.getState().updateClipAudio(clip.id, next)

  return (
    <div className="inspector-section-stack" key={`audio:${clip.id}`}>
      <div className="inspector-context-label">Audio · {clip.name}</div>
      <InspectorSection
        title="Audio"
        resetLabel="Reset audio settings"
        disabled={locked}
        onReset={() => patch({
          volume: 1,
          audio: { ...DEFAULT_CLIP_AUDIO_SETTINGS },
        })}
      >
        <div className="inspector-grid">
          <ToggleField label="Audio enabled" checked={audio.enabled} disabled={locked} testId="inspector-audio-enabled" onChange={(enabled) => patch({ audio: { enabled } })} />
          <RangeNumberField label="Volume" value={clip.volume} step={0.01} min={0} max={2} testId="inspector-volume" disabled={controlsDisabled} onCommit={(volume) => patch({ volume })} />
          <RangeNumberField label="Balance" value={audio.balance} step={0.01} min={-1} max={1} testId="inspector-balance" disabled={controlsDisabled || !balanceApplicable} onCommit={(balance) => patch({ audio: { balance } })} />
          <NumberField label="Fade in (frames)" value={audio.fadeInFrames} step={1} min={0} max={clip.timelineRange.durationFrames} testId="inspector-fade-in" disabled={controlsDisabled} clamp onCommit={(fadeInFrames) => patch({ audio: { fadeInFrames } })} />
          <NumberField label="Fade out (frames)" value={audio.fadeOutFrames} step={1} min={0} max={clip.timelineRange.durationFrames} testId="inspector-fade-out" disabled={controlsDisabled} clamp onCommit={(fadeOutFrames) => patch({ audio: { fadeOutFrames } })} />
        </div>
        <span className="inspector-note">
          {balanceApplicable
            ? 'Balance attenuates the opposite source channel; fades use project frames.'
            : 'This source is mono, so stereo balance is unavailable.'}
        </span>
      </InspectorSection>
    </div>
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
            <LinkBreak aria-hidden="true" size={15} weight="bold" />
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
  const visualPreview = useTransportStore((s) => s.clipVisualPreview)
  const playheadFrame = useTransportStore((s) => s.playheadFrame)
  const timelineDoc = useDocumentStore((s) => s.doc)
  const clip = selectedClipId ? findClip(timelineDoc, selectedClipId) : null
  const [activeVideoTab, setActiveVideoTab] = useState<
    'transform' | 'crop' | 'effects' | 'animation'
  >('transform')
  const [animationSurfaceOpened, setAnimationSurfaceOpened] = useState(false)
  const videoTabs = ['transform', 'crop', 'effects', 'animation'] as const

  useEffect(() => {
    if (activeVideoTab === 'animation') setAnimationSurfaceOpened(true)
  }, [activeVideoTab])

  const handleVideoTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const currentIndex = videoTabs.indexOf(activeVideoTab)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % videoTabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + videoTabs.length) % videoTabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = videoTabs.length - 1
    else return

    event.preventDefault()
    const nextTab = videoTabs[nextIndex]
    setActiveVideoTab(nextTab)
    const buttons = event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[nextIndex]?.focus()
  }

  if (!clip) {
    return (
      <div className="panel-placeholder">
        <span className="placeholder-title inspector-empty-title">Inspector</span>
        <LinkSelectionControls key="linking-controls" />
        <span className="placeholder-note">select a clip to edit it</span>
      </div>
    )
  }

  let videoClip: Clip | null = null
  let audioClip: Clip | null = null
  for (const member of [clip, ...linkedPartners(timelineDoc, clip.id)]) {
    const kind = trackOfClip(timelineDoc, member.id)?.kind
    if (kind === 'video' && videoClip === null) videoClip = member
    if (kind === 'audio' && audioClip === null) audioClip = member
  }
  const videoLocked = videoClip === null
    ? false
    : (trackOfClip(timelineDoc, videoClip.id)?.locked ?? true)
  const audioLocked = audioClip === null
    ? false
    : (trackOfClip(timelineDoc, audioClip.id)?.locked ?? true)
  const resolvedVideoClip = videoClip
    ? resolveClipAnimationAtFrame(videoClip, playheadFrame)
    : null
  const displayedVideoClip = resolvedVideoClip && visualPreview?.clipId === resolvedVideoClip.id
    ? {
        ...resolvedVideoClip,
        transform: visualPreview.transform,
        visual: visualPreview.visual,
      }
    : resolvedVideoClip

  return (
    <div className="inspector-panel" data-testid="inspector-panel">
      <div className="inspector-title">Inspector</div>
      <div className="inspector-clip-summary">
        <span className="inspector-clip-icon" aria-hidden="true">
          {videoClip
            ? <FileVideo size={24} weight="regular" />
            : <FileAudio size={24} weight="regular" />}
        </span>
        <span>
          <strong>{clip.name}</strong>
          <small>{videoClip ? 'Video clip' : 'Audio clip'}</small>
        </span>
      </div>
      {videoClip && (
        <div className="inspector-tabs" role="tablist" aria-label="Video inspector sections">
          {videoTabs.map((tab) => (
            <button
              key={tab}
              id={`inspector-${tab}-tab`}
              type="button"
              role="tab"
              aria-selected={activeVideoTab === tab}
              aria-controls={`inspector-${tab}-panel`}
              tabIndex={activeVideoTab === tab ? 0 : -1}
              className={activeVideoTab === tab ? 'active' : ''}
              onClick={() => setActiveVideoTab(tab)}
              onKeyDown={handleVideoTabKeyDown}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      )}
      <LinkSelectionControls key="linking-controls" />
      <TimingInspectorSection clip={clip} doc={timelineDoc} />
      {videoClip?.text && (
        <TextOverlayFields
          key={`text:${videoClip.id}`}
          clip={videoClip}
          locked={videoLocked}
        />
      )}
      {displayedVideoClip && (
        <VideoInspectorSections
          doc={timelineDoc}
          clip={displayedVideoClip}
          locked={videoLocked}
          playheadFrame={playheadFrame}
          activeTab={activeVideoTab}
        />
      )}
      {videoClip && (
        <div
          id="inspector-animation-panel"
          role="tabpanel"
          aria-labelledby="inspector-animation-tab"
          hidden={activeVideoTab !== 'animation'}
        >
          {videoClip.text
            ? <span className="inspector-note">Animation controls are not available for text overlays yet.</span>
            : animationSurfaceOpened && (
                <LazySurfaceBoundary
                  loadingLabel="Loading animation curves…"
                  failureTitle="Animation curves could not load"
                >
                  <AnimationCurveEditor
                    clip={videoClip}
                    locked={videoLocked}
                    playheadFrame={playheadFrame}
                  />
                </LazySurfaceBoundary>
              )}
        </div>
      )}
      {audioClip && (
        <AudioInspectorSection clip={audioClip} locked={audioLocked} />
      )}
    </div>
  )
}
