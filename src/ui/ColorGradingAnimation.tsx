import type { EffectDescriptor } from '../domain/schema'
import type { ColorGradingTarget } from '../app/colorGradingController'
import { useDocumentStore } from '../state/documentStore'
import { effectAnimationParameterSpec } from '../state/editorUi'
import AnimationEntry from './animation/AnimationEntry'

/** Registered grading properties enter the same workspace as every scalar lane. */
export default function ColorGradingAnimation({ target, effect, parameter }: { target: ColorGradingTarget; effect: EffectDescriptor; parameter: string; value: number; disabled: boolean }) {
  const doc = useDocumentStore((state) => state.doc)
  if (target.kind !== 'clip' && target.kind !== 'adjustment') return null
  const owner = target.kind === 'clip' ? { kind: 'clip' as const, id: target.clipId } : { kind: 'adjustment' as const, id: target.adjustmentId }
  const item = target.kind === 'clip' ? doc.tracks.flatMap((track) => track.clips).find((clip) => clip.id === target.clipId)
    : doc.tracks.flatMap((track) => track.adjustments ?? []).find((item) => item.id === target.adjustmentId)
  const spec = effectAnimationParameterSpec(effect, parameter)
  if (!item || !spec) return null
  const keys = item.animation?.effectTracks?.find((track) => track.effectId === effect.id && track.parameter === parameter)
  return <details className="grading-animation"><summary>{spec.label} animation{keys ? ` · ${keys.keyframes.length} keys` : ''}</summary>
    <AnimationEntry lane={{ owner, kind: 'effect', effectId: effect.id, parameter }} label={`Open ${spec.label} animation`} />
  </details>
}
