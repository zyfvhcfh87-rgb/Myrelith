import { useEffect, useMemo, useState } from 'react'
import type {
  Clip,
  SourceTimeSpeedEasing,
  SourceTimeSpeedPoint,
  TimelineDoc,
} from '../../domain/schema'
import {
  clipAudioPresentation,
  clipSourceTimeMap,
  sourceTimeMapUsesSpeedCurve,
  sourceTimeSpeedAtTimelineOffset,
  sourceTimeSpeedPointsAtClip,
  sourceTimeRateFromPercent,
  sourceTimeRatePercent,
  sourceTimeMapWholeClipSpeed,
  sourceTimeSpeedRateFromPercent,
  sourceTimeSpeedRatePercent,
  findClip,
  linkedPartners,
  trackOfClip,
} from '../../state/editorUi'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import { InspectorSection } from './InspectorFields'

const SPEED_PERCENT_OPTIONS = Object.freeze(
  Array.from({ length: 16 }, (_value, index) => (index + 1) * 25),
)
const RAMP_SPEED_PERCENT_OPTIONS = Object.freeze([0, ...SPEED_PERCENT_OPTIONS])

function audioPresentationCopy(
  clip: Clip,
  rampActive: boolean,
): string {
  const presentation = clipAudioPresentation(clip)
  if (presentation.state === 'ready') {
    if (presentation.kind === 'direct') {
      return rampActive
        ? 'Audio stays enabled because every active speed point is exactly 100%.'
        : 'Audio stays enabled at 100% speed.'
    }
    return `Audio plays time-stretched at ${sourceTimeRatePercent(presentation.rate)}% so pitch stays put.`
  }
  if (presentation.state === 'fallback') {
    return `Audio plays time-stretched at ${sourceTimeRatePercent(presentation.rate)}%. Quality is limited at this speed.`
  }
  if (presentation.reason === 'invalid-speed-curve') {
    return 'Audio is muted because the stored speed curve is invalid; video uses the preserved constant fallback.'
  }
  if (presentation.reason === 'speed-ramp-audio-unsupported') {
    return 'Audio is muted because variable speed ramps are not supported for audio.'
  }
  if (presentation.reason === 'freeze-audio-silence') {
    return 'Audio is muted because this timing map contains a freeze.'
  }
  return 'Audio is muted because its source starts between supported audio sample boundaries.'
}

function hasLaterPositiveSpeedPoint(
  points: readonly SourceTimeSpeedPoint[],
  frame: number,
): boolean {
  return points.some((point) => point.frame > frame && point.rate.numerator > 0)
}

const RAMP_EASING_LABELS: Readonly<Record<SourceTimeSpeedEasing, string>> = {
  hold: 'Hold',
  linear: 'Linear',
  smooth: 'Smooth',
}

function speedCurvePolyline(clip: Clip): string {
  const map = clipSourceTimeMap(clip)
  const duration = Math.max(1, clip.timelineRange.durationFrames - 1)
  const samples = Math.min(64, Math.max(2, clip.timelineRange.durationFrames))
  return Array.from({ length: samples }, (_value, index) => {
    const frame = Math.round(index * duration / (samples - 1))
    const speed = sourceTimeSpeedAtTimelineOffset(map, frame)
    const x = frame / duration * 240
    const y = 92 - Math.min(4, Math.max(0, speed)) / 4 * 84
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

function SpeedRampEditor({
  clip,
  locked,
  linkedCount,
}: {
  clip: Clip
  locked: boolean
  linkedCount: number
}) {
  const map = clipSourceTimeMap(clip)
  const points = useMemo(() => sourceTimeSpeedPointsAtClip(map), [map])
  const rampActive = sourceTimeMapUsesSpeedCurve(map)
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const localPlayhead = playheadFrame - clip.timelineRange.startFrame
  const playheadInside = localPlayhead >= 0
    && localPlayhead < clip.timelineRange.durationFrames
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const pointIdentity = points
    .map((point) => `${point.frame}:${point.rate.numerator}/${point.rate.denominator}:${point.easing}`)
    .join('|')
  const selected = selectedFrame === null
    ? null
    : points.find((point) => point.frame === selectedFrame) ?? null

  useEffect(() => {
    if (selectedFrame !== null && points.some((point) => point.frame === selectedFrame)) {
      return
    }
    const atPlayhead = points.find((point) => point.frame === localPlayhead)
    setSelectedFrame(atPlayhead?.frame ?? points[0]?.frame ?? null)
  }, [clip.id, localPlayhead, pointIdentity, points, selectedFrame])

  const afterEdit = (before: TimelineDoc, success: string): boolean => {
    const after = useDocumentStore.getState().doc
    if (after === before) {
      setMessage(
        'Ramp edit was not applied. Keep points inside every linked clip, bound a freeze with a later positive point, unlock tracks, and make room beside the clip.',
      )
      return false
    }
    const updated = findClip(after, clip.id)
    setMessage(updated
      ? `${success} Timeline duration is now ${updated.timelineRange.durationFrames} frames.`
      : success)
    return true
  }

  const commitPoint = (
    frame: number,
    percent: number,
    easing: SourceTimeSpeedEasing,
  ): void => {
    if (percent === 0 && !hasLaterPositiveSpeedPoint(points, frame)) {
      setMessage('Add a later positive speed boundary before choosing 0% (Freeze).')
      return
    }
    const store = useDocumentStore.getState()
    const before = store.doc
    store.setClipSpeedPoint(
      clip.id,
      frame,
      sourceTimeSpeedRateFromPercent(percent),
      easing,
    )
    if (afterEdit(before, `Speed point at frame ${frame} updated to ${percent}%.`)) {
      setSelectedFrame(frame)
    }
  }

  return (
    <div className="animation-editor speed-ramp-editor">
      <div className="animation-toolbar" aria-label="Speed ramp operations">
        <button
          type="button"
          disabled={locked || !playheadInside}
          onClick={() => {
            const existing = points.find((point) => point.frame === localPlayhead)
            if (existing) {
              setSelectedFrame(existing.frame)
              setMessage(`Speed point at frame ${existing.frame} selected.`)
              return
            }
            const percent = Math.min(
              400,
              Math.max(
                0,
                Math.round(sourceTimeSpeedAtTimelineOffset(map, localPlayhead) * 4) * 25,
              ),
            )
            commitPoint(localPlayhead, percent, 'hold')
          }}
        >
          {points.some((point) => point.frame === localPlayhead)
            ? 'Select boundary at playhead'
            : 'Add boundary at playhead'}
        </button>
        <button
          type="button"
          disabled={locked || !rampActive}
          onClick={() => {
            const store = useDocumentStore.getState()
            const before = store.doc
            store.clearClipSpeedRamp(clip.id)
            if (afterEdit(before, 'Speed ramp cleared; the constant fallback was restored.')) {
              setSelectedFrame(null)
            }
          }}
        >
          Clear ramp
        </button>
      </div>

      {rampActive ? (
        <>
          <div
            className="animation-curve"
            role="img"
            aria-label={`Speed ramp with ${points.length} point${points.length === 1 ? '' : 's'}`}
          >
            <svg viewBox="0 0 240 100" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 92H240 M0 50H240 M0 8H240" className="animation-curve-grid" />
              <polyline points={speedCurvePolyline(clip)} className="animation-curve-line" />
            </svg>
          </div>
          <ul className="animation-keyframe-list" aria-label="Speed points">
            {points.map((point) => (
              <li key={point.frame}>
                <button
                  type="button"
                  aria-pressed={selected?.frame === point.frame}
                  onClick={() => {
                    setSelectedFrame(point.frame)
                    useTransportStore.getState().setPlayheadFrame(
                      clip.timelineRange.startFrame + point.frame,
                    )
                  }}
                >
                  Frame {point.frame}: {sourceTimeSpeedRatePercent(point.rate)}%
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="animation-empty">
          Choose a speed at the playhead or add a boundary to start a timed section. The current whole-clip speed becomes frame 0.
        </p>
      )}

      {selected && (
        <div
          className="animation-keyframe-fields"
          aria-label={`Selected speed point at frame ${selected.frame}`}
        >
          <label className="animation-number-field">
            <span>Point speed</span>
            <select
              aria-label="Point speed"
              value={sourceTimeSpeedRatePercent(selected.rate)}
              disabled={locked}
              onChange={(event) => commitPoint(
                selected.frame,
                Number(event.target.value),
                selected.easing,
              )}
            >
              {RAMP_SPEED_PERCENT_OPTIONS.map((percent) => (
                <option
                  key={percent}
                  value={percent}
                  disabled={percent === 0 && !hasLaterPositiveSpeedPoint(points, selected.frame)}
                >
                  {percent === 0 ? '0% (Freeze)' : `${percent}%`}
                </option>
              ))}
            </select>
          </label>
          <label className="animation-number-field">
            <span>Outgoing easing</span>
            <select
              aria-label="Outgoing speed easing"
              value={selected.easing}
              disabled={locked}
              onChange={(event) => commitPoint(
                selected.frame,
                sourceTimeSpeedRatePercent(selected.rate),
                event.target.value as SourceTimeSpeedEasing,
              )}
            >
              {(Object.keys(RAMP_EASING_LABELS) as SourceTimeSpeedEasing[])
                .map((easing) => (
                  <option key={easing} value={easing}>
                    {RAMP_EASING_LABELS[easing]}
                  </option>
                ))}
            </select>
          </label>
          <div className="animation-toolbar">
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                const store = useDocumentStore.getState()
                const before = store.doc
                store.removeClipSpeedPoint(clip.id, selected.frame)
                if (afterEdit(before, `Speed point at frame ${selected.frame} removed.`)) {
                  setSelectedFrame(null)
                }
              }}
            >
              Remove speed point
            </button>
          </div>
        </div>
      )}

      <p className="animation-status" role="status" aria-live="polite">
        {message || (playheadInside
          ? `Playhead: clip frame ${localPlayhead}. A 0% freeze must be bounded by a later positive point.${linkedCount > 1 ? ` ${linkedCount} linked clips edit together.` : ''}`
          : 'Move the playhead inside this clip to add a speed point.')}
      </p>
    </div>
  )
}

/** Constant and piecewise-speed authoring stays visible across video tabs. */
export default function TimingInspectorSection({
  clip,
  doc,
}: {
  clip: Clip
  doc: TimelineDoc
}) {
  const map = clipSourceTimeMap(clip)
  const wholeClipSpeed = sourceTimeMapWholeClipSpeed(map)
  const wholeClipSpeedPercent = wholeClipSpeed.kind === 'constant'
    ? wholeClipSpeed.percent
    : null
  const rampActive = sourceTimeMapUsesSpeedCurve(map)
  const playheadFrame = useTransportStore((state) => state.playheadFrame)
  const localPlayhead = playheadFrame - clip.timelineRange.startFrame
  const playheadInside = localPlayhead >= 0
    && localPlayhead < clip.timelineRange.durationFrames
  const speedPoints = sourceTimeSpeedPointsAtClip(map)
  const pointAtPlayhead = speedPoints
    .find((point) => point.frame === localPlayhead)
  const canFreezeAtPlayhead = hasLaterPositiveSpeedPoint(speedPoints, localPlayhead)
  const playheadSpeedPercent = playheadInside
    ? pointAtPlayhead
      ? sourceTimeSpeedRatePercent(pointAtPlayhead.rate)
      : Math.round(sourceTimeSpeedAtTimelineOffset(map, localPlayhead) * 10_000) / 100
    : wholeClipSpeedPercent ?? sourceTimeRatePercent(map.rate)
  const playheadSpeedIsPreset = RAMP_SPEED_PERCENT_OPTIONS.includes(playheadSpeedPercent)
  const members = [clip, ...linkedPartners(doc, clip.id)]
  const selectedClipIds = useTransportStore((state) => state.selectedClipIds)
  const wholeClipTargets = selectedClipIds.includes(clip.id) && selectedClipIds.length > 1
    ? selectedClipIds
    : [clip.id]
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

  const commitWholeClip = (percent: number): void => {
    const store = useDocumentStore.getState()
    const before = store.doc
    const latest = findClip(before, clip.id)
    if (!latest) {
      setMessage('This clip is no longer available. Select it again and retry.')
      return
    }
    if (wholeClipTargets.length > 1) {
      store.retimeClips(wholeClipTargets, sourceTimeRateFromPercent(percent))
    } else {
      store.retimeClip(clip.id, sourceTimeRateFromPercent(percent))
    }
    const after = useDocumentStore.getState().doc
    if (after === before) {
      setMessage(
        'Speed change was not applied. Unlock later clips and linked tracks, then try again.',
      )
      return
    }
    const updated = findClip(after, clip.id)
    const selectionNote = wholeClipTargets.length > 1
      ? ` Applied to ${wholeClipTargets.length} selected clips.`
      : ''
    setMessage(
      updated
        ? `Whole-clip speed changed to ${percent}%. Timeline duration is now ${updated.timelineRange.durationFrames} frames.${selectionNote}`
        : `Whole-clip speed changed to ${percent}%.${selectionNote}`,
    )
  }

  const commitAtPlayhead = (percent: number): void => {
    const store = useDocumentStore.getState()
    const before = store.doc
    const latest = findClip(before, clip.id)
    if (!latest) {
      setMessage('This clip is no longer available. Select it again and retry.')
      return
    }
    const frame = useTransportStore.getState().playheadFrame - latest.timelineRange.startFrame
    if (frame < 0 || frame >= latest.timelineRange.durationFrames) {
      setMessage('Move the playhead inside this clip to create a speed boundary.')
      return
    }
    const latestPoints = sourceTimeSpeedPointsAtClip(clipSourceTimeMap(latest))
    if (percent === 0 && !hasLaterPositiveSpeedPoint(latestPoints, frame)) {
      setMessage('Add a later positive speed boundary before choosing 0% (Freeze).')
      return
    }
    const existing = latestPoints
      .find((point) => point.frame === frame)
    store.setClipSpeedPoint(
      clip.id,
      frame,
      sourceTimeSpeedRateFromPercent(percent),
      existing?.easing ?? 'hold',
    )
    const after = useDocumentStore.getState().doc
    if (after === before) {
      setMessage(
        'Speed boundary was not applied. Keep it inside every linked clip, unlock tracks, and make room beside the clip.',
      )
      return
    }
    const updated = findClip(after, clip.id)
    setMessage(
      `Speed at clip frame ${frame} is now ${percent}%. Move the playhead and choose another speed to end the section.${updated ? ` Timeline duration is now ${updated.timelineRange.durationFrames} frames.` : ''}`,
    )
  }

  const linkedNote = wholeClipTargets.length > 1
    ? ` The ${wholeClipTargets.length} selected clips change together.`
    : members.length > 1
      ? ` The ${members.length} linked clips change together.`
      : ''

  return (
    <InspectorSection
      title="Timing"
      resetLabel="Reset clip speed"
      disabled={locked || !retimable || (wholeClipSpeedPercent === 100 && !rampActive)}
      onReset={() => commitWholeClip(100)}
    >
      <label className="inspector-field inspector-field-wide">
        <span className="inspector-field-label">Speed at playhead</span>
        <select
          aria-describedby="inspector-speed-playhead-detail inspector-speed-detail inspector-speed-audio inspector-speed-status"
          data-testid="inspector-speed-at-playhead"
          value={playheadSpeedPercent}
          disabled={locked || !retimable || !playheadInside}
          onChange={(event) => commitAtPlayhead(Number(event.target.value))}
        >
          {!playheadSpeedIsPreset && (
            <option value={playheadSpeedPercent}>{playheadSpeedPercent}% (ramp value)</option>
          )}
          {RAMP_SPEED_PERCENT_OPTIONS.map((percent) => (
            <option
              key={percent}
              value={percent}
              disabled={percent === 0 && !canFreezeAtPlayhead}
            >
              {percent === 0 ? '0% (Freeze)' : `${percent}%`}
            </option>
          ))}
        </select>
      </label>
      <span id="inspector-speed-playhead-detail" className="inspector-note">
        {playheadInside
          ? canFreezeAtPlayhead
            ? `Clip frame ${localPlayhead}. Changing this creates or updates a boundary here; move the playhead and choose another speed to close the section.`
            : `Clip frame ${localPlayhead}. Add a later positive speed boundary before choosing 0% (Freeze).`
          : 'Move the playhead inside this clip to author a timed speed section.'}
      </span>
      <label className="inspector-field inspector-field-wide">
        <span className="inspector-field-label">Whole clip speed</span>
        <select
          aria-describedby="inspector-speed-detail inspector-speed-audio inspector-speed-status"
          data-testid="inspector-whole-clip-speed"
          value={wholeClipSpeedPercent ?? 'mixed'}
          disabled={locked || !retimable}
          onChange={(event) => {
            if (event.target.value === 'mixed') return
            commitWholeClip(Number(event.target.value))
          }}
        >
          {wholeClipSpeedPercent === null && (
            <option value="mixed">Multiple speeds</option>
          )}
          {SPEED_PERCENT_OPTIONS.map((percent) => (
            <option key={percent} value={percent}>{percent}%</option>
          ))}
        </select>
      </label>
      <span id="inspector-speed-detail" className="inspector-note">
        {retimable
          ? `Timeline ${clip.timelineRange.durationFrames} frames · source ${clip.sourceRange.durationFrames} frames.${linkedNote}`
          : 'Retiming is available for timed video and audio clips.'}
      </span>
      <span id="inspector-speed-audio" className="inspector-note">
        {!retimable
          ? 'Still images and text keep their authored duration without decoded source-time mapping.'
          : audioPresentationCopy(clip, rampActive)}
      </span>
      {retimable && (
        <SpeedRampEditor clip={clip} locked={locked} linkedCount={members.length} />
      )}
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
