/** Mask review controls send commands; the app owns preview, freshness and Apply. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { beginMaskMotionTrackingReview, planMotionTrackingAttachment, type MaskMotionTrackingReview, type MotionTrackingSession } from '../app/motionTrackingController'
import { MASK_EFFECT_TYPE, MASK_EFFECT_VERSION } from '../domain/effectStack'
import type { MaskTrackingTarget } from '../domain/maskTracking'
import type { MotionTrackingKind } from '../domain/motionTracking'
import { isProceduralTitleClip } from '../domain/textOverlay'
import { rangeOverlap } from '../domain/time'
import type { Clip } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { useTransportStore } from '../state/transportStore'

export default function MaskTrackingAttachmentEditor({ source, session, kind, busy, onApplied }: {
  source: Clip
  session: MotionTrackingSession | null
  kind: MotionTrackingKind
  busy: boolean
  onApplied(changed: boolean): void
}) {
  const doc = useDocumentStore((state) => state.doc)
  const generation = useDocumentStore((state) => state.projectGeneration)
  const assets = useMediaStore((state) => state.assets)
  const selection = useMotionTrackingSelectionStore()
  const playing = useTransportStore((state) => state.isPlaying || state.isScrubbing)
  const [targetKey, setTargetKey] = useState('')
  const [includeSize, setIncludeSize] = useState(true)
  const [consent, setConsent] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [message, setMessage] = useState('Choose an enabled mask, then review the accepted tracking.')
  const active = useRef<MaskMotionTrackingReview | null>(null)
  const targets = useMemo(() => doc.tracks.flatMap((track) => track.kind !== 'video' || track.hidden || track.locked ? [] : track.clips.flatMap((clip) => {
    const asset = assets.get(clip.assetId)
    if (isProceduralTitleClip(clip) || !rangeOverlap(clip.timelineRange, source.timelineRange) || !asset?.objectUrl || !asset.width || !asset.height || (asset.kind !== 'image' && asset.kind !== 'video')) return []
    return clip.effects.flatMap((effect, index) => effect.type !== MASK_EFFECT_TYPE || effect.version !== MASK_EFFECT_VERSION || !effect.enabled ? [] : [{
      key: JSON.stringify([clip.id, effect.id]), label: `${clip.name} · Mask ${index + 1}${clip.id === source.id ? ' (source clip)' : ''}`,
      target: { kind: 'mask-effect', clipId: clip.id, effectId: effect.id } satisfies MaskTrackingTarget,
    }])
  })).sort((a, b) => Number(b.target.clipId === source.id) - Number(a.target.clipId === source.id)), [assets, doc.tracks, source.id, source.timelineRange])
  const selected = targets.find((target) => target.key === targetKey)
  useEffect(() => {
    // Choose a convenient initial mask once. Losing a selected target must not
    // silently retarget a ready attachment to a different clip or effect.
    if (targetKey) return
    setTargetKey(targets[0]?.key ?? ''); setConsent(null)
  }, [targetKey, targets])
  const planned = useMemo(() => {
    void doc; void generation; void assets; void selection
    return session && selected ? planMotionTrackingAttachment(session, selected.target, kind === 'box' && includeSize) : null
  }, [assets, doc, generation, includeSize, kind, selected, selection, session])
  const plan = planned?.ok && planned.kind === 'mask-effect' ? planned.plan : null
  const reviewKey = plan?.reviewKey
  useEffect(() => { setConsent(null) }, [doc, reviewKey, session, targetKey, includeSize, source.id])
  useEffect(() => {
    setPreview(false)
    return () => { const review = active.current; active.current = null; review?.cancel() }
  }, [reviewKey, session, targetKey, includeSize, source.id])
  const cancelPreview = () => {
    const review = active.current; active.current = null; review?.cancel(); setPreview(false)
  }
  function review() {
    if (!session || !plan || !selected) throw new Error('Analyze and review a valid mask attachment first.')
    if (active.current) return active.current
    const next = beginMaskMotionTrackingReview(session, selected.target, kind === 'box' && includeSize, plan.reviewKey, () => {
      if (active.current === next) { active.current = null; setPreview(false) }
    })
    active.current = next
    return next
  }
  function togglePreview(enabled: boolean) {
    if (!enabled) { cancelPreview(); return }
    try {
      const error = review().preview(true)
      if (error) { setMessage(error); cancelPreview() } else { setPreview(true); setMessage('Preview shows the accepted tracking range. The project is unchanged.') }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The mask preview is unavailable.'); cancelPreview() }
  }
  function apply() {
    try {
      const result = review().apply(consent)
      if (!result.ok) { setMessage(result.reason); return }
      onApplied(result.changed)
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The mask attachment could not be applied.'); cancelPreview() }
  }
  const lanes = kind === 'box' && includeSize ? 'Left, Top, Width and Height' : 'Left and Top'
  return <div className="mask-tracking-attachment">
    <label className="animation-number-field">
      <span>Target mask</span>
      <select aria-label="Mask tracking target" value={targetKey} disabled={busy} onChange={(event) => { cancelPreview(); setConsent(null); setTargetKey(event.target.value) }}>
        {targetKey && !selected ? <option value={targetKey} disabled>Selected mask is unavailable</option> : null}
        {targets.length === 0 && !targetKey ? <option value="">No enabled mask on connected media</option> : null}
        {targets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}
      </select>
    </label>
    {kind === 'box' ? <label className="stabilization-confirm">
      <input type="checkbox" checked={includeSize} disabled={busy} onChange={(event) => { cancelPreview(); setConsent(null); setIncludeSize(event.target.checked) }} />
      <span>Track mask size (Width and Height)</span>
    </label> : null}
    <p className="inspector-note">Attach {lanes} to {selected?.label ?? 'the selected mask'}. Masks stay in project space.</p>
    {kind === 'box' && includeSize ? <p className="inspector-note">Box size uses project-axis bounds. The mask does not follow rotation.</p> : null}
    {plan ? <dl className="stabilization-summary">
      <div><dt>Accepted samples</dt><dd>{plan.sampleCount}</dd></div>
      <div><dt>Accepted project frames</dt><dd>{plan.firstAcceptedGlobalFrame}–{plan.lastAcceptedGlobalFrame}</dd></div>
      <div><dt>Minimum confidence</dt><dd>{(plan.confidenceMinimum * 100).toFixed(1)}%</dd></div>
      <div><dt>Mean confidence</dt><dd>{(plan.confidenceMean * 100).toFixed(1)}%</dd></div>
      <div><dt>Stop</dt><dd>{plan.stopped ? `Frame ${plan.stopped.localFrame}` : 'Clip boundary'}</dd></div>
    </dl> : null}
    {plan?.replacementRequired ? <label className="stabilization-confirm">
      <input type="checkbox" checked={consent === plan.reviewKey} onChange={(event) => setConsent(event.target.checked ? plan.reviewKey : null)} />
      <span>Replace all {lanes} keys on {selected?.label}, including keys outside the accepted range</span>
    </label> : null}
    <label className="stabilization-confirm">
      <input type="checkbox" checked={preview} disabled={busy || !plan} onChange={(event) => togglePreview(event.target.checked)} />
      <span>Preview accepted mask tracking at the playhead</span>
    </label>
    <p className="inspector-note" id="mask-tracking-key-semantics">After Apply, keys interpolate linearly between accepted samples and hold the first or last value outside that range. Edit or remove these ordinary mask keys in Animation.</p>
    <div className="animation-toolbar">
      <button type="button" disabled={busy || playing || !plan || (plan.replacementRequired && consent !== plan.reviewKey)} aria-describedby="mask-tracking-key-semantics mask-tracking-status" onClick={apply}>Apply mask tracking</button>
    </div>
    <p id="mask-tracking-status" className="animation-status" role="status" aria-live="polite" aria-atomic="true">{planned && !planned.ok ? planned.reason : message}</p>
  </div>
}
