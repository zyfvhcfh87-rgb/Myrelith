/** Accessible product surface for bounded local similarity stabilization. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  analyzeVideoStabilization,
  applyVideoStabilization,
  cancelVideoStabilization,
  planVideoStabilization,
  type VideoStabilizationSession,
} from '../app/videoStabilizationController'
import { getMotionAnalysisController } from '../app/motionAnalysisRuntime'
import { clipAnimation, evaluateAnimationTrack } from '../domain/clipAnimation'
import { clipVisualSettings } from '../domain/clipInspector'
import type { Clip, Transform } from '../domain/schema'
import {
  VIDEO_STABILIZATION_PROPERTIES,
  type VideoStabilizationPlan,
  type VideoStabilizationSettings,
} from '../domain/videoStabilization'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

type Phase = 'idle' | 'analyzing' | 'ready' | 'error'

function previewTransform(plan: VideoStabilizationPlan, localFrame: number): Transform {
  const first = plan.frames[0]!.transform
  const value = (property: (typeof VIDEO_STABILIZATION_PROPERTIES)[number], fallback: number) => {
    const track = plan.tracks.find((candidate) => candidate.property === property)
    return track ? evaluateAnimationTrack(track, localFrame, fallback) : fallback
  }
  return {
    ...first,
    x: value('position-x', first.x),
    y: value('position-y', first.y),
    rotation: value('rotation', first.rotation),
    scaleX: value('scale-x', first.scaleX),
    scaleY: value('scale-y', first.scaleY),
  }
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export default function StabilizationEditor({
  clip,
  locked,
  playheadFrame,
}: {
  clip: Clip
  locked: boolean
  playheadFrame: number
}) {
  const doc = useDocumentStore((state) => state.doc)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [session, setSession] = useState<VideoStabilizationSession | null>(null)
  const [strengthPercent, setStrengthPercent] = useState(50)
  const [smoothingRadiusFrames, setSmoothingRadiusFrames] = useState(4)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [preview, setPreview] = useState(false)
  const [message, setMessage] = useState('Analyze this clip to calculate a safe correction path.')
  const analysisGeneration = useRef(0)
  const invalidateAnalysis = useCallback(() => {
    analysisGeneration.current++
  }, [])

  useEffect(() => {
    invalidateAnalysis()
    setPhase('idle')
    setProgress(0)
    setSession(null)
    setReplaceExisting(false)
    setPreview(false)
    setMessage('Analyze this clip to calculate a safe correction path.')
    useTransportStore.getState().setClipVisualPreview(null)
    const analyzedClipId = clip.id
    return () => {
      invalidateAnalysis()
      cancelVideoStabilization(analyzedClipId)
      useTransportStore.getState().setClipVisualPreview(null)
    }
  }, [clip.id, invalidateAnalysis])

  useEffect(() => {
    const controller = getMotionAnalysisController()
    if (!controller || phase !== 'analyzing') return
    return controller.subscribe((snapshot) => {
      const status = snapshot.jobs.find((job) => (
        job.clipId === clip.id && job.kind === 'stabilization'
      ))
      if (status) setProgress(status.progress)
    })
  }, [clip.id, phase])

  const settings = useMemo<VideoStabilizationSettings>(() => ({
    strengthPercent,
    smoothingRadiusFrames,
  }), [strengthPercent, smoothingRadiusFrames])
  const planned = useMemo(() => {
    // The planner reads the store's latest document; this subscription makes
    // unrelated React render timing unable to leave a stale readiness result.
    void doc
    return session ? planVideoStabilization(session, settings) : null
  }, [doc, session, settings])

  useEffect(() => {
    if (!preview || !planned?.ok) {
      useTransportStore.getState().setClipVisualPreview(null)
      return
    }
    const localFrame = Math.max(
      0,
      Math.min(clip.timelineRange.durationFrames - 1, playheadFrame - clip.timelineRange.startFrame),
    )
    useTransportStore.getState().setClipVisualPreview({
      clipId: clip.id,
      transform: previewTransform(planned.plan, localFrame),
      visual: clipVisualSettings(clip),
    })
    return () => useTransportStore.getState().setClipVisualPreview(null)
  }, [clip, planned, playheadFrame, preview])

  const analyze = async (): Promise<void> => {
    const generation = ++analysisGeneration.current
    const analyzedClipId = clip.id
    setPreview(false)
    setSession(null)
    setPhase('analyzing')
    setProgress(0)
    setMessage('Analyzing locally…')
    try {
      const next = await analyzeVideoStabilization(analyzedClipId)
      if (
        generation !== analysisGeneration.current
        || next.clipId !== analyzedClipId
      ) return
      setSession(next)
      setPhase('ready')
      setProgress(1)
      setMessage(next.fromCache ? 'Ready from the local analysis cache.' : 'Analysis complete and cached locally.')
    } catch (cause) {
      if (generation !== analysisGeneration.current) return
      setPhase('error')
      setMessage(failureMessage(cause))
    }
  }

  const cancel = (): void => {
    invalidateAnalysis()
    cancelVideoStabilization(clip.id)
    setPreview(false)
    setPhase('idle')
    setMessage('Analysis cancelled. Nothing was changed.')
  }

  const apply = (): void => {
    if (!session || !planned?.ok) return
    if (planned.plan.replacementRequired && !replaceExisting) {
      setMessage('Confirm replacement of the existing Position, Rotation, and Scale tracks first.')
      return
    }
    const result = applyVideoStabilization(session, settings, replaceExisting)
    if (!result.ok) {
      setMessage(result.reason)
      return
    }
    setPreview(false)
    setSession(null)
    setPhase('idle')
    setMessage(result.changed
      ? 'Stabilization applied as five ordinary animation tracks in one undo step.'
      : 'That exact stabilization path is already applied.')
  }

  const reset = (): void => {
    setPreview(false)
    const result = useDocumentStore.getState().resetVideoStabilization(clip.id)
    setMessage(result.ok
      ? result.changed
        ? 'All Position, Rotation, and Scale animation tracks were removed in one undo step.'
        : 'No Position, Rotation, or Scale animation tracks were present.'
      : result.reason)
  }

  const hasResettableTracks = clipAnimation(clip).tracks.some((track) => (
    VIDEO_STABILIZATION_PROPERTIES.includes(
      track.property as (typeof VIDEO_STABILIZATION_PROPERTIES)[number],
    )
  ))
  const planReason = planned && !planned.ok ? planned.reason : null
  const canApply = !locked && phase === 'ready' && planned?.ok
    && (!planned.plan.replacementRequired || replaceExisting)
  const readinessReason = locked
    ? 'Unlock this video track to analyze, apply, or reset stabilization.'
    : planned?.ok && planned.plan.replacementRequired && !replaceExisting
      ? 'Confirm replacement of the existing Position, Rotation, and Scale tracks before applying.'
      : planReason ?? message

  return (
    <section className="inspector-section stabilization-editor" aria-labelledby="stabilization-heading">
      <div className="inspector-section-bar">
        <h3 id="stabilization-heading">Video stabilization</h3>
      </div>
      <p className="inspector-note">
        Runs locally and writes ordinary Position, Rotation, and equal Scale keyframes. Unsupported footage stops without changing the project.
      </p>
      <div className="animation-toolbar" aria-label="Stabilization analysis">
        <button
          type="button"
          disabled={locked || phase === 'analyzing'}
          aria-describedby="stabilization-status"
          onClick={() => void analyze()}
        >
          {phase === 'error' ? 'Retry analysis' : 'Analyze'}
        </button>
        <button
          type="button"
          disabled={phase !== 'analyzing'}
          aria-describedby="stabilization-status"
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
      {phase === 'analyzing' && (
        <progress
          className="stabilization-progress"
          aria-label="Stabilization analysis progress"
          max={1}
          value={progress}
        />
      )}
      <label className="animation-number-field">
        <span>Strength (%)</span>
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={strengthPercent}
          disabled={!session}
          onChange={(event) => setStrengthPercent(Number(event.target.value))}
        />
      </label>
      <label className="animation-number-field">
        <span>Smoothing radius (frames)</span>
        <input
          type="number"
          min={1}
          max={120}
          step={1}
          value={smoothingRadiusFrames}
          disabled={!session}
          onChange={(event) => setSmoothingRadiusFrames(Number(event.target.value))}
        />
      </label>
      {planned?.ok && (
        <dl className="stabilization-summary">
          <div><dt>Required crop</dt><dd>{(planned.plan.requiredCropRatio * 100).toFixed(2)}%</dd></div>
          <div><dt>Safe zoom</dt><dd>{planned.plan.safeZoom.toFixed(4)}×</dd></div>
          <div><dt>Keys per track</dt><dd>{planned.plan.retainedKeyframeCount}</dd></div>
          <div><dt>Modeled jitter cut</dt><dd>{(planned.plan.jitterReductionRatio * 100).toFixed(1)}%</dd></div>
        </dl>
      )}
      {planned?.ok && planned.plan.replacementRequired && (
        <label className="stabilization-confirm">
          <input
            type="checkbox"
            checked={replaceExisting}
            onChange={(event) => setReplaceExisting(event.target.checked)}
          />
          <span>Replace existing Position, Rotation, and Scale animation</span>
        </label>
      )}
      <label className="stabilization-confirm">
        <input
          type="checkbox"
          checked={preview}
          disabled={!planned?.ok}
          onChange={(event) => setPreview(event.target.checked)}
        />
        <span>Preview at the playhead</span>
      </label>
      <p id="stabilization-reset-warning" className="inspector-note">
        Reset removes all Position, Rotation, and Scale animation on this clip,
        including keyframes created manually or by another tool.
      </p>
      <div className="animation-toolbar" aria-label="Stabilization operations">
        <button
          type="button"
          disabled={!canApply}
          aria-describedby="stabilization-status"
          onClick={apply}
        >Apply</button>
        <button
          type="button"
          disabled={locked || !hasResettableTracks}
          aria-describedby="stabilization-reset-warning stabilization-status"
          onClick={reset}
        >
          Remove transform animation
        </button>
      </div>
      <p
        id="stabilization-status"
        className="animation-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {readinessReason}
      </p>
    </section>
  )
}
