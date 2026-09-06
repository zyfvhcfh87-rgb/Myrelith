import {
  BLEND_MODE_NAMES,
  clipBlendModeIntent,
  DEFAULT_BLEND_MODE,
  isBlendModeName,
  type BlendModeName,
} from '../../domain/blendModes'
import {
  clipVisualSettings,
  DEFAULT_CLIP_VISUAL_SETTINGS,
  MAX_CLIP_SCALE,
  MAX_CROP_SUM,
} from '../../domain/clipInspector'
import type { ClipVisualPatch } from '../../domain/operations'
import type { Clip, TimelineDoc } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import EffectStackInspector from '../EffectStackInspector'
import {
  InspectorSection,
  NumberField,
  RangeNumberField,
  ToggleField,
} from './InspectorFields'
import ManualLensCorrectionSection from './ManualLensCorrectionSection'

const BLEND_MODE_LABELS: Readonly<Record<BlendModeName, string>> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  difference: 'Difference',
  exclusion: 'Exclusion',
}

export default function VideoInspectorSections({
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
        <ManualLensCorrectionSection clip={clip} locked={locked} />
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
        <EffectStackInspector
          doc={doc}
          clip={clip}
          locked={locked}
          playheadFrame={playheadFrame}
        />
      </div>
    </div>
  )
}
