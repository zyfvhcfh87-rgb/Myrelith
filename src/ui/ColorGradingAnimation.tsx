import type { EffectDescriptor } from '../domain/schema'
import type { ColorGradingTarget } from '../app/colorGradingController'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { documentAnimationKeyframeGrowthAllowed, effectAnimationParameterSpec, MAX_KEYFRAMES_PER_TRACK } from '../state/editorUi'

/** Only the registered scalar vocabulary is offered; tables and points stay static. */
export default function ColorGradingAnimation({ target, effect, parameter, value, disabled }: { target: ColorGradingTarget; effect: EffectDescriptor; parameter: string; value: number; disabled: boolean }) {
  const doc = useDocumentStore((state) => state.doc), frame = useTransportStore((state) => state.playheadFrame)
  if (target.kind !== 'clip' && target.kind !== 'adjustment') return null
  const clip = target.kind === 'clip' ? doc.tracks.flatMap((track) => track.clips).find((clip) => clip.id === target.clipId) : undefined
  if (clip?.text) return null
  const item = clip ?? (target.kind === 'adjustment' ? doc.tracks.flatMap((track) => track.adjustments ?? []).find((item) => item.id === target.adjustmentId) : undefined)
  const spec = effectAnimationParameterSpec(effect, parameter)
  if (!item || !spec) return null
  const localFrame = frame - item.timelineRange.startFrame
  const outside = localFrame < 0 || localFrame >= item.timelineRange.durationFrames
  const keys = item.animation?.effectTracks?.find((track) => track.effectId === effect.id && track.parameter === parameter)
  const grows = !keys?.keyframes.some((key) => key.frame === localFrame)
  const keyLimit = grows && ((keys?.keyframes.length ?? 0) >= MAX_KEYFRAMES_PER_TRACK || !documentAnimationKeyframeGrowthAllowed(doc, 1))
  const store = useDocumentStore.getState
  return <details className="grading-animation"><summary>{spec.label} animation{keys ? ` · ${keys.keyframes.length} keys` : ''}</summary>
    <div className="inspector-effect-actions">
      <button type="button" disabled={disabled || outside || keyLimit} onClick={() => {
        const key = { frame: localFrame, value, easing: { type: 'linear' as const } }
        if (target.kind === 'clip') store().setEffectKeyframe(target.clipId, effect.id, parameter, key)
        else store().setAdjustmentEffectKeyframe(target.adjustmentId, effect.id, parameter, key)
      }}>{keys ? `Add ${spec.label} key at playhead` : `Animate ${spec.label}`}</button>
      {keys && <button type="button" disabled={disabled} onClick={() => {
        if (target.kind === 'clip') store().resetEffectAnimationTrack(target.clipId, effect.id, parameter)
        else store().clearAdjustmentEffectAnimation(target.adjustmentId, effect.id, parameter)
      }}>Clear {spec.label} keys</button>}
    </div>
    {outside && <p>Move the playhead inside this item to add or edit keys.</p>}
    {keyLimit && <p>The animation key limit is reached. Edit an existing key or clear a track first.</p>}
    {keys && <ol aria-label={`${spec.label} keys`}>{keys.keyframes.map((key) => <li key={key.frame}>Frame {key.frame}: {key.value.toFixed(3)} · {key.easing.type}</li>)}</ol>}
  </details>
}
