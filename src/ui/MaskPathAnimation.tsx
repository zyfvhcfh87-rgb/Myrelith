import { useState } from 'react'
import type { Clip, EffectDescriptor } from '../domain/schema'
import { commitMaskPathKey } from '../app/maskEditingController'
import { maskEditingTarget, maskPathAnimationStatus } from '../state/maskEditor'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

export default function MaskPathAnimation({ clip, effect, playheadFrame, locked }: {
  clip: Clip; effect: EffectDescriptor; playheadFrame: number; locked: boolean
}) {
  const doc = useDocumentStore((state) => state.doc)
  const playing = useTransportStore((state) => state.isPlaying || state.isScrubbing)
  const [error, setError] = useState('')
  const target = { sequenceId: doc.id, clipId: clip.id, effectId: effect.id }
  const status = maskPathAnimationStatus(clip, effect)
  let reason = status.reason ?? (playing ? 'Pause playback before editing path keys.' : '')
  try { maskEditingTarget(doc, target, playheadFrame) }
  catch (cause) { reason ||= cause instanceof Error ? cause.message : 'This mask is unavailable.' }
  const keys = status.track?.keyframes ?? [], localFrame = playheadFrame - clip.timelineRange.startFrame
  const onKey = keys.some((key) => key.frame === localFrame)
  const previous = keys.findLast((key) => key.frame < localFrame && key.frame >= 0)
  const next = keys.find((key) => key.frame > localFrame && key.frame < clip.timelineRange.durationFrames)
  const act = (action: 'set' | 'remove' | 'clear') => setError(commitMaskPathKey(target, action) ?? '')
  if (status.dormant && !status.track) return null
  return <div className="inspector-effect-animation" aria-label="Mask path animation">
    <span className="inspector-note">{status.track ? `${keys.length} held path ${keys.length === 1 ? 'key' : 'keys'}.` : 'Path is static.'} Each path holds until the next key.</span>
    {status.dormant && status.track && <span className="inspector-note">Path keys are dormant while this mask is not Bezier.</span>}
    <div className="inspector-effect-actions">
      <button type="button" disabled={locked || !!reason || status.dormant} onClick={() => act('set')}>{status.track ? 'Set path key at playhead' : 'Animate mask path'}</button>
      {status.track && <>
        <button type="button" disabled={locked || !!reason || !onKey} onClick={() => act('remove')}>Remove path key at playhead</button>
        <button type="button" disabled={locked || !!reason} onClick={() => act('clear')}>Clear path keys</button>
      </>}
    </div>
    {status.track && <>
      <div className="inspector-effect-actions">
        <button type="button" disabled={playing || !previous} onClick={() => { if (previous) useTransportStore.getState().setPlayheadFrame(clip.timelineRange.startFrame + previous.frame) }}>Previous path key</button>
        <button type="button" disabled={playing || !next} onClick={() => { if (next) useTransportStore.getState().setPlayheadFrame(clip.timelineRange.startFrame + next.frame) }}>Next path key</button>
      </div>
      <span className="inspector-note">Program and path-field edits set a key at the playhead. Clearing keys restores the saved static path.</span>
    </>}
    {reason && <span role="status">{reason}</span>}
    {error && <span role="alert">{error}</span>}
  </div>
}
