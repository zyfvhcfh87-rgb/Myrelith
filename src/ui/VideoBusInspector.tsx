import { useState } from 'react'
import { useDocumentStore } from '../state/documentStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { effectRegistration } from '../domain/effectStack'
import { applyVideoBusEdit, openVideoBusEdit, videoBusOwner, type VideoBusTarget } from '../app/videoBusController'
import type { VideoBusEdit } from '../domain/videoBusEffects'
import EffectBrowser from './EffectBrowser'
import { NumericField } from './EffectStackInspector'

export default function VideoBusInspector() {
  const project = useDocumentStore((state) => state.project), sequenceId = useDocumentStore((state) => state.activeSequenceId)
  const sequence = project.sequences.find((sequence) => sequence.id === sequenceId)!
  const [selection, setSelection] = useState('master'), [error, setError] = useState<string | null>(null)
  const statuses = usePreviewStatusStore((state) => state.effectStatuses)
  const track = sequence.tracks.find((track) => track.id === selection && track.kind === 'video')
  const target: VideoBusTarget = track ? { kind: 'track', trackId: track.id, sequenceId } : { kind: 'master', sequenceId }
  const owner = videoBusOwner(project, target)!
  const edit = (command: VideoBusEdit) => setError(applyVideoBusEdit(openVideoBusEdit(target), command))
  return <details className="inspector-section inspector-effects video-bus-inspector">
    <summary>Track and master video effects</summary>
    <label className="inspector-field"><span>Video effect target</span><select aria-label="Video effect target" value={track?.id ?? 'master'} onChange={(event) => { setSelection(event.target.value); setError(null) }}>
      <option value="master">Sequence master video</option>
      {sequence.tracks.filter((track) => track.kind === 'video').map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
    </select></label>
    <p className="inspector-note">{target.kind === 'master' ? 'Runs after this sequence’s tracks and captions. Nested sequences finish their own master first.' : 'Runs after clip opacity and transitions, before this track blends with lower tracks. Adjustment items keep their own lower-picture processing.'} Use adjustment items for effects over a chosen time range.</p>
    <div className="inspector-effect-actions"><EffectBrowser key={`${sequenceId}:${track?.id ?? 'master'}`} busTarget={target} hasEffects={owner.effects.length > 0} /></div>
    {owner.locked && <p>This video track is locked.</p>}
    {error && <p role="alert">{error}</p>}
    <ol className="inspector-effect-list" aria-label={`${owner.name} effect stack`}>
      {owner.effects.map((effect, index) => {
        const registration = effectRegistration(effect.type), supported = registration?.version === effect.version && registration.surfaces.includes('post-composite') && registration.preservesOpaqueInput
        const status = statuses.get(effect.id)
        return <li key={effect.id} className="inspector-effect-card">
          <strong>{registration?.label ?? effect.type}</strong><p className="inspector-note">{status ? `${status.status}: ${status.detail}` : 'Waiting for preview capability status.'}</p>
          <label className="inspector-field"><span>Enabled</span><input type="checkbox" aria-label={`Enable ${registration?.label ?? effect.type}`} checked={effect.enabled} disabled={owner.locked} onChange={(event) => edit({ kind: 'enabled', effectId: effect.id, enabled: event.target.checked })} /></label>
          {supported && Object.entries(registration.animatableParams).map(([parameter, spec]) => <NumericField key={parameter}
            label={'label' in spec ? String(spec.label) : parameter[0].toUpperCase() + parameter.slice(1)}
            value={Number(effect.params[parameter] ?? registration.defaultParams[parameter])} min={spec.min} max={spec.max}
            step={'step' in spec ? Number(spec.step) : 0.01} disabled={owner.locked} testId={`video-bus-${effect.id}-${parameter}`}
            onCommit={(value) => edit({ kind: 'params', effectId: effect.id, patch: { [parameter]: value } })} />)}
          {supported && typeof registration.defaultParams.color === 'string' && <label className="inspector-field"><span>Color</span><input type="color" value={String(effect.params.color ?? registration.defaultParams.color)} disabled={owner.locked} onChange={(event) => edit({ kind: 'params', effectId: effect.id, patch: { color: event.target.value } })} /></label>}
          <div className="inspector-effect-actions">
            <button type="button" disabled={owner.locked || index === 0} aria-label={`Move ${registration?.label ?? effect.type} up`} onClick={() => edit({ kind: 'reorder', effectId: effect.id, index: index - 1 })}>Up</button>
            <button type="button" disabled={owner.locked || index === owner.effects.length - 1} aria-label={`Move ${registration?.label ?? effect.type} down`} onClick={() => edit({ kind: 'reorder', effectId: effect.id, index: index + 1 })}>Down</button>
            <button type="button" disabled={owner.locked || !supported} onClick={() => edit({ kind: 'reset', effectId: effect.id })}>Reset</button>
            <button type="button" disabled={owner.locked} onClick={() => edit({ kind: 'remove', effectId: effect.id })}>Remove</button>
          </div>
        </li>
      })}
    </ol>
  </details>
}
