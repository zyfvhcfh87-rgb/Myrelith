/** Inspector workflow for local point/box tracking and ordinary keyframe apply. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  analyzeMotionTracking,
  applyMotionTracking,
  cancelMotionTracking,
  planMotionTracking,
  type MotionTrackingSession,
} from '../app/motionTrackingController'
import { getMotionAnalysisController } from '../app/motionAnalysisRuntime'
import { clipAnimation, evaluateAnimationTrack, resolveClipAnimationAtFrame } from '../domain/clipAnimation'
import { clipVisualSettings } from '../domain/clipInspector'
import type { MotionTrackingDirection, MotionTrackingKind } from '../domain/motionTracking'
import { findClip } from '../domain/selectors'
import type { Clip, ClipAnimationTrack, Transform } from '../domain/schema'
import { rangeEnd, rangeOverlap } from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useMotionTrackingSelectionStore } from '../state/motionTrackingSelectionStore'
import { useTransportStore } from '../state/transportStore'

type Phase = 'idle' | 'analyzing' | 'ready' | 'error'
const PREVIEW_OWNER = 'motion-tracking' as const

function clearOwnedPreview(): void {
  const transport = useTransportStore.getState()
  if (transport.clipVisualPreview?.owner === PREVIEW_OWNER) {
    transport.setClipVisualPreview(null)
  }
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function previewTransform(
  target: Clip,
  tracks: readonly ClipAnimationTrack[],
  globalFrame: number,
): Transform {
  const resolved = resolveClipAnimationAtFrame(target, globalFrame).transform
  const localFrame = globalFrame - target.timelineRange.startFrame
  const value = (property: 'position-x' | 'position-y' | 'scale-x' | 'scale-y', fallback: number) => {
    const track = tracks.find((candidate) => candidate.property === property)
    return track ? evaluateAnimationTrack(track, localFrame, fallback) : fallback
  }
  return {
    ...resolved,
    x: value('position-x', resolved.x),
    y: value('position-y', resolved.y),
    scaleX: value('scale-x', resolved.scaleX),
    scaleY: value('scale-y', resolved.scaleY),
  }
}

export default function MotionTrackingEditor({
  clip,
  locked,
  playheadFrame,
}: {
  clip: Clip
  locked: boolean
  playheadFrame: number
}) {
  const doc = useDocumentStore((state) => state.doc)
  const descriptors = useMediaStore((state) => state.descriptors)
  const selectionSourceClipId = useMotionTrackingSelectionStore((state) => state.sourceClipId)
  const pickingKind = useMotionTrackingSelectionStore((state) => state.pickingKind)
  const selection = useMotionTrackingSelectionStore((state) => state.selection)
  const selectionGlobalFrame = useMotionTrackingSelectionStore((state) => state.selectionGlobalFrame)
  const [kind, setKind] = useState<MotionTrackingKind>('point')
  const [direction, setDirection] = useState<MotionTrackingDirection>('forward')
  const [targetClipId, setTargetClipId] = useState(clip.id)
  const [includeScale, setIncludeScale] = useState(true)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [preview, setPreview] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [session, setSession] = useState<MotionTrackingSession | null>(null)
  const [message, setMessage] = useState('Choose a point or box in the Program Monitor.')
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])

  const targets = useMemo(() => doc.tracks.flatMap((track) => (
    track.kind !== 'video' || track.hidden
      ? []
      : track.clips.filter((candidate) => {
          if (
            candidate.id === clip.id
            || candidate.text
            || !rangeOverlap(candidate.timelineRange, clip.timelineRange)
          ) return false
          const descriptor = descriptors.get(candidate.assetId)
          return descriptor?.width !== null && descriptor?.height !== null
        }).map((candidate) => ({
          id: candidate.id,
          label: `${candidate.name}${track.locked ? ' (locked)' : ''}`,
        }))
  )), [clip.id, clip.timelineRange, descriptors, doc.tracks])

  useEffect(() => {
    invalidate()
    setPhase('idle')
    setProgress(0)
    setSession(null)
    setTargetClipId(clip.id)
    setReplaceExisting(false)
    setPreview(false)
    setMessage('Choose a point or box in the Program Monitor.')
    clearOwnedPreview()
    useMotionTrackingSelectionStore.getState().clear()
    const sourceClipId = clip.id
    return () => {
      invalidate()
      cancelMotionTracking(sourceClipId)
      clearOwnedPreview()
      useMotionTrackingSelectionStore.getState().clear()
    }
  }, [clip.id, invalidate])

  useEffect(() => {
    if (targets.some((target) => target.id === targetClipId)) return
    setTargetClipId(targets[0]?.id ?? '')
    setReplaceExisting(false)
    setPreview(false)
  }, [targetClipId, targets])

  useEffect(() => {
    const controller = getMotionAnalysisController()
    if (!controller || phase !== 'analyzing') return
    return controller.subscribe((snapshot) => {
      const expectedKind = kind === 'point' ? 'point-tracking' : 'box-tracking'
      const candidates = snapshot.jobs.filter((job) => (
        job.clipId === clip.id
        && job.kind === expectedKind
      ))
      const status = [...candidates].reverse().find((job) => (
        job.phase === 'queued' || job.phase === 'running'
      )) ?? candidates.at(-1)
      if (status) setProgress(status.progress)
    })
  }, [clip.id, kind, phase])

  const planned = useMemo(() => {
    void doc
    return session && targetClipId
      ? planMotionTracking(session, targetClipId, session.analysis.kind === 'box' && includeScale)
      : null
  }, [doc, includeScale, session, targetClipId])

  useEffect(() => {
    if (!preview || !planned?.ok) {
      clearOwnedPreview()
      return
    }
    const target = findClip(doc, planned.plan.targetClipId)
    if (!target) {
      clearOwnedPreview()
      return
    }
    const rangeTrack = planned.plan.tracks.find((track) => track.property === 'position-x')
      ?? planned.plan.tracks[0]
    const firstKey = rangeTrack?.keyframes[0]
    const lastKey = rangeTrack?.keyframes.at(-1)
    if (!firstKey || !lastKey) {
      clearOwnedPreview()
      return
    }
    const acceptedStart = target.timelineRange.startFrame + firstKey.frame
    const acceptedEnd = target.timelineRange.startFrame + lastKey.frame
    if (
      playheadFrame < acceptedStart
      || playheadFrame > acceptedEnd
      || playheadFrame < target.timelineRange.startFrame
      || playheadFrame >= rangeEnd(target.timelineRange)
    ) {
      clearOwnedPreview()
      return
    }
    useTransportStore.getState().setClipVisualPreview({
      owner: PREVIEW_OWNER,
      clipId: target.id,
      transform: previewTransform(target, planned.plan.tracks, playheadFrame),
      visual: clipVisualSettings(target),
    })
    return clearOwnedPreview
  }, [doc, planned, playheadFrame, preview])

  const pick = (nextKind: MotionTrackingKind): void => {
    invalidate()
    cancelMotionTracking(clip.id)
    setKind(nextKind)
    setPhase('idle')
    setSession(null)
    setReplaceExisting(false)
    setPreview(false)
    setMessage(nextKind === 'point'
      ? 'Click one textured point in the Program Monitor.'
      : 'Drag a textured box in the Program Monitor.')
    useMotionTrackingSelectionStore.getState().beginPicking(clip.id, nextKind)
  }

  const analyze = async (): Promise<void> => {
    if (!selection || selectionSourceClipId !== clip.id || selectionGlobalFrame === null) {
      setMessage('Choose a point or box in the Program Monitor first.')
      return
    }
    const runGeneration = ++generation.current
    setSession(null)
    setReplaceExisting(false)
    setPreview(false)
    setPhase('analyzing')
    setProgress(0)
    setMessage(`Tracking ${direction} locally…`)
    try {
      const next = await analyzeMotionTracking({
        sourceClipId: clip.id,
        selectionGlobalFrame,
        direction,
        selection,
      })
      if (runGeneration !== generation.current || next.sourceClipId !== clip.id) return
      setSession(next)
      setPhase('ready')
      setProgress(1)
      setMessage(next.analysis.failure
        ? `Tracking stopped safely: ${next.analysis.failure.detail}`
        : next.fromCache
          ? 'Tracking is ready from the local cache.'
          : 'Tracking is complete and cached locally.')
    } catch (cause) {
      if (runGeneration !== generation.current) return
      setPhase('error')
      setMessage(messageFrom(cause))
    }
  }

  const cancel = (): void => {
    invalidate()
    cancelMotionTracking(clip.id)
    setPhase('idle')
    setSession(null)
    setPreview(false)
    setMessage('Tracking cancelled. Nothing was changed.')
  }

  const apply = (): void => {
    if (!session || !planned?.ok || !targetClipId) return
    if (planned.plan.replacementRequired && !replaceExisting) {
      setMessage('Confirm replacement of the target animation first.')
      return
    }
    const result = applyMotionTracking(
      session,
      targetClipId,
      session.analysis.kind === 'box' && includeScale,
      replaceExisting,
    )
    if (!result.ok) {
      setMessage(result.reason)
      return
    }
    setPreview(false)
    setSession(null)
    setPhase('idle')
    setMessage(result.changed
      ? 'Tracking applied as ordinary keyframes in one undo step.'
      : 'That exact tracking path is already applied.')
  }

  const reset = (): void => {
    if (!targetClipId) return
    setPreview(false)
    const result = useDocumentStore.getState().resetClipFramingAnimation(targetClipId)
    setMessage(result.ok
      ? result.changed
        ? 'Target Position and Scale animation was removed in one undo step.'
        : 'The target has no Position or Scale animation.'
      : result.reason)
  }

  const changeDirection = (next: MotionTrackingDirection): void => {
    if (next === direction) return
    invalidate()
    cancelMotionTracking(clip.id)
    setDirection(next)
    setPhase('idle')
    setSession(null)
    setReplaceExisting(false)
    setPreview(false)
    setMessage('Direction changed. Analyze the pinned selection again.')
  }

  const changeTarget = (next: string): void => {
    setTargetClipId(next)
    setReplaceExisting(false)
    setPreview(false)
  }

  const changeScaleMapping = (next: boolean): void => {
    setIncludeScale(next)
    setReplaceExisting(false)
    setPreview(false)
  }

  const selectionReady = selectionSourceClipId === clip.id && selection?.kind === kind
  const canAnalyze = !locked
    && phase !== 'analyzing'
    && selectionReady
    && selectionGlobalFrame !== null
    && selectionGlobalFrame >= clip.timelineRange.startFrame
    && selectionGlobalFrame < rangeEnd(clip.timelineRange)
  const canApply = phase === 'ready'
    && planned?.ok
    && (!planned.plan.replacementRequired || replaceExisting)
  const target = targetClipId ? findClip(doc, targetClipId) : null
  const hasResettable = target
    ? clipAnimation(target).tracks.some((track) => (
        ['position-x', 'position-y', 'scale-x', 'scale-y'].includes(track.property)
      ))
    : false

  return (
    <section className="inspector-section motion-tracking-editor" aria-labelledby="motion-tracking-heading">
      <div className="inspector-section-bar">
        <h3 id="motion-tracking-heading">Motion tracking</h3>
      </div>
      <p className="inspector-note">
        Track locally from the selected frame, preview the accepted range, then apply ordinary Position and optional Scale keyframes.
      </p>
      {selectionReady && selectionGlobalFrame !== null ? (
        <p className="inspector-note">Selection pinned to project frame {selectionGlobalFrame}.</p>
      ) : null}
      <div className="animation-toolbar" aria-label="Tracking selection">
        <button type="button" disabled={locked} aria-pressed={pickingKind === 'point'} onClick={() => pick('point')}>
          Pick point
        </button>
        <button type="button" disabled={locked} aria-pressed={pickingKind === 'box'} onClick={() => pick('box')}>
          Draw box
        </button>
      </div>
      <label className="animation-number-field">
        <span>Direction</span>
        <select value={direction} disabled={phase === 'analyzing'} onChange={(event) => changeDirection(event.target.value as MotionTrackingDirection)}>
          <option value="forward">Forward</option>
          <option value="backward">Backward</option>
        </select>
      </label>
      <label className="animation-number-field">
        <span>Target clip</span>
        <select aria-label="Motion tracking target clip" value={targetClipId} disabled={phase === 'analyzing'} onChange={(event) => changeTarget(event.target.value)}>
          {targets.length === 0 ? <option value="">No overlapping visual target</option> : null}
          {targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
        </select>
      </label>
      {kind === 'box' ? (
        <label className="stabilization-confirm">
          <input type="checkbox" checked={includeScale} disabled={phase === 'analyzing'} onChange={(event) => changeScaleMapping(event.target.checked)} />
          <span>Apply uniform box scale to Scale X/Y</span>
        </label>
      ) : null}
      <div className="animation-toolbar" aria-label="Motion tracking analysis">
        <button type="button" disabled={!canAnalyze} aria-describedby="motion-tracking-status" onClick={() => void analyze()}>
          {phase === 'error' ? 'Retry tracking' : 'Analyze'}
        </button>
        <button type="button" disabled={phase !== 'analyzing'} aria-describedby="motion-tracking-status" onClick={cancel}>Cancel</button>
      </div>
      {phase === 'analyzing' ? (
        <progress className="stabilization-progress" aria-label="Motion tracking progress" max={1} value={progress} />
      ) : null}
      {planned?.ok ? (
        <dl className="stabilization-summary">
          <div><dt>Accepted samples</dt><dd>{planned.plan.sampleCount}</dd></div>
          <div><dt>Minimum confidence</dt><dd>{(planned.plan.confidenceMinimum * 100).toFixed(1)}%</dd></div>
          <div><dt>Mean confidence</dt><dd>{(planned.plan.confidenceMean * 100).toFixed(1)}%</dd></div>
          <div><dt>Stop</dt><dd>{planned.plan.stopped ? `Frame ${planned.plan.stopped.localFrame}` : 'Clip boundary'}</dd></div>
        </dl>
      ) : null}
      {planned?.ok && planned.plan.replacementRequired ? (
        <label className="stabilization-confirm">
          <input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />
          <span>Replace existing target Position/Scale animation</span>
        </label>
      ) : null}
      <label className="stabilization-confirm">
        <input type="checkbox" checked={preview} disabled={!planned?.ok} onChange={(event) => setPreview(event.target.checked)} />
        <span>Preview accepted tracking at the playhead</span>
      </label>
      <p id="motion-tracking-reset-warning" className="inspector-note">
        Reset removes all Position and Scale animation from the target, including manual keyframes.
      </p>
      <div className="animation-toolbar" aria-label="Motion tracking operations">
        <button type="button" disabled={!canApply} aria-describedby="motion-tracking-status" onClick={apply}>Apply</button>
        <button type="button" disabled={phase === 'analyzing' || !targetClipId || !hasResettable} aria-describedby="motion-tracking-reset-warning motion-tracking-status" onClick={reset}>
          Remove target framing animation
        </button>
      </div>
      <p id="motion-tracking-status" className="animation-status" role="status" aria-live="polite" aria-atomic="true">
        {planned && !planned.ok ? planned.reason : message}
      </p>
    </section>
  )
}
