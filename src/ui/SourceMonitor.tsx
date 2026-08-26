/**
 * ui/SourceMonitor.tsx — Source Monitor chrome and review canvas.
 *
 * Session facts come from sourceMonitorStore. Pixels are painted by
 * app/sourceMonitorPreviewController. This file never opens a Blob.
 */

import { useEffect, useRef } from 'react'
import { CaretLeft, CaretRight, Pause, Play } from '@phosphor-icons/react'
import {
  executeEditorCommand,
  resolveEditorCommand,
  shortcutForCommand,
} from '../app/editorCommands'
import { focusSourceMonitor } from '../app/sequenceEditController'
import { sourceMonitorStatusCopy } from '../app/sourceMonitorController'
import {
  closeSource,
  jumpToEnd,
  jumpToIn,
  jumpToOut,
  jumpToStart,
  resetSession,
  scrubPlayhead,
  stepFrame,
  stepShuttle,
} from '../app/sourceMonitorPlaybackController'
import {
  disposeSourcePreview,
  initSourcePreview,
  setSourcePreviewViewport,
} from '../app/sourceMonitorPreviewController'
import { formatTimecode } from '../domain/time'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'

function markLabel(
  frame: number | null,
  rate: { num: number; den: number },
  exclusive: boolean,
): string {
  if (frame === null) return '—'
  return formatTimecode(exclusive ? Math.max(0, frame - 1) : frame, rate)
}

export default function SourceMonitor() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const session = useSourceMonitorStore((state) => state.session)
  const lastOpenRejection = useSourceMonitorStore((state) => state.lastOpenRejection)
  const playbackOwner = useSourceMonitorStore((state) => state.playbackOwner)
  const patchVideo = useSourceMonitorStore((state) => state.patchVideo)
  const patchAudio = useSourceMonitorStore((state) => state.patchAudio)
  useTransportStore((state) => state.videoTargetTrackId)
  useTransportStore((state) => state.audioTargetTrackId)
  useTransportStore((state) => state.trackTargetsTouched)
  useTransportStore((state) => state.timelineInFrame)
  useTransportStore((state) => state.timelineOutExclusive)
  useTransportStore((state) => state.selectedClipId)
  const asset = useMediaStore((state) => (
    session ? state.assets.get(session.source.assetId) ?? null : null
  ))
  useMediaStore((state) => state.assets)
  useMediaStore((state) => state.compatibility)
  const statusCopy = sourceMonitorStatusCopy()
  const showCanvas = Boolean(
    session
    && (session.source.kind === 'video' || session.source.kind === 'image'),
  )

  useEffect(() => {
    if (!showCanvas) return
    const canvas = canvasRef.current
    if (!canvas) return
    initSourcePreview(canvas)
    return () => {
      void disposeSourcePreview()
    }
  }, [showCanvas])

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage || !showCanvas) return
    const sourceWidth = Math.max(1, asset?.width ?? 1920)
    const sourceHeight = Math.max(1, asset?.height ?? 1080)
    const publish = () => {
      const styles = getComputedStyle(stage)
      const availableWidth = stage.clientWidth
        - Number.parseFloat(styles.paddingLeft || '0')
        - Number.parseFloat(styles.paddingRight || '0')
      const availableHeight = stage.clientHeight
        - Number.parseFloat(styles.paddingTop || '0')
        - Number.parseFloat(styles.paddingBottom || '0')
      if (availableWidth <= 0 || availableHeight <= 0) {
        setSourcePreviewViewport(null)
        return
      }
      const displayScale = Math.min(
        availableWidth / sourceWidth,
        availableHeight / sourceHeight,
      )
      const widthCssPx = Math.max(1, Math.floor(sourceWidth * displayScale))
      const heightCssPx = Math.max(1, Math.floor(sourceHeight * displayScale))
      canvas.style.width = `${widthCssPx}px`
      canvas.style.height = `${heightCssPx}px`
      setSourcePreviewViewport({
        widthCssPx,
        heightCssPx,
        devicePixelRatio: window.devicePixelRatio || 1,
      })
    }
    publish()
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(publish)
      : null
    observer?.observe(stage)
    window.addEventListener('resize', publish)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', publish)
    }
  }, [asset?.height, asset?.width, showCanvas])

  if (!session && !lastOpenRejection) return null

  const openShortcut = shortcutForCommand('source.open')
  const inShortcut = shortcutForCommand('marks.mark-in')
  const outShortcut = shortcutForCommand('marks.mark-out')
  const startShortcut = shortcutForCommand('source.jump-start')
  const endShortcut = shortcutForCommand('source.jump-end')
  const insertCommand = resolveEditorCommand('timeline.insert')
  const overwriteCommand = resolveEditorCommand('timeline.overwrite')
  const replaceCommand = resolveEditorCommand('timeline.replace')
  const insertDisabled = insertCommand.enabled ? null : insertCommand.disabledReason
  const overwriteDisabled = overwriteCommand.enabled ? null : overwriteCommand.disabledReason
  const replaceDisabled = replaceCommand.enabled ? null : replaceCommand.disabledReason
  const playing = (session?.shuttleStep ?? 0) !== 0

  return (
    <section
      className="source-monitor"
      data-testid="source-monitor"
      aria-label="Source Monitor"
      onPointerDown={focusSourceMonitor}
    >
      <header className="source-monitor-header">
        <h2 className="source-monitor-title">
          {session?.source.fileName ?? 'Source Monitor'}
        </h2>
        <button
          type="button"
          className="source-monitor-close"
          onClick={() => closeSource()}
        >
          Close
        </button>
      </header>
      <div className="source-monitor-stage" ref={stageRef}>
        {showCanvas ? (
          <canvas
            ref={canvasRef}
            className="source-monitor-canvas"
            data-testid="source-monitor-canvas"
          />
        ) : null}
        {session?.source.kind === 'audio' ? (
          <div className="source-monitor-hint" role="status">Audio source</div>
        ) : null}
        {statusCopy ? (
          <div className="source-monitor-hint source-monitor-hint-offline" role="status">
            {statusCopy.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
      </div>
      {session ? (
        <>
          <div className="source-monitor-readout">
            <span>{formatTimecode(session.playheadFrame, session.source.rate)}</span>
            <span aria-hidden="true">/</span>
            <span>
              {formatTimecode(
                Math.max(0, session.source.durationFrames - 1),
                session.source.rate,
              )}
            </span>
            <span>In {markLabel(session.inFrame, session.source.rate, false)}</span>
            <span>
              Out {markLabel(session.outFrameExclusive, session.source.rate, true)}
            </span>
            {playbackOwner === 'source' ? (
              <span>Source Monitor owns playback. Program is paused.</span>
            ) : null}
          </div>
          <label className="source-monitor-scrubber">
            <span className="visually-hidden">Source playhead</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, session.source.durationFrames - 1)}
              step={1}
              value={session.playheadFrame}
              onChange={(event) => scrubPlayhead(Number(event.currentTarget.value))}
            />
          </label>
          <div className="source-monitor-transport">
            <button
              type="button"
              className="transport-button"
              aria-keyshortcuts={startShortcut?.ariaKeyShortcuts}
              onClick={jumpToStart}
            >
              Start
            </button>
            <button
              type="button"
              className="transport-button"
              aria-label="one source frame back"
              onClick={() => stepFrame(-1)}
            >
              <CaretLeft aria-hidden="true" size={16} weight="fill" />
            </button>
            <button
              type="button"
              className="transport-button"
              aria-label="shuttle reverse"
              aria-keyshortcuts={shortcutForCommand('source.shuttle-j')?.ariaKeyShortcuts}
              onClick={() => stepShuttle('j')}
            >
              J
            </button>
            <button
              type="button"
              className="transport-button transport-play"
              aria-label={playing ? 'pause source' : 'play source'}
              aria-keyshortcuts={shortcutForCommand('source.shuttle-k')?.ariaKeyShortcuts}
              onClick={() => playing ? stepShuttle('k') : stepShuttle('l')}
            >
              {playing
                ? <Pause aria-hidden="true" size={16} weight="fill" />
                : <Play aria-hidden="true" size={16} weight="fill" />}
            </button>
            <button
              type="button"
              className="transport-button"
              aria-label="shuttle forward"
              aria-keyshortcuts={shortcutForCommand('source.shuttle-l')?.ariaKeyShortcuts}
              onClick={() => stepShuttle('l')}
            >
              L
            </button>
            <button
              type="button"
              className="transport-button"
              aria-label="one source frame forward"
              onClick={() => stepFrame(1)}
            >
              <CaretRight aria-hidden="true" size={16} weight="fill" />
            </button>
            <button
              type="button"
              className="transport-button"
              aria-keyshortcuts={endShortcut?.ariaKeyShortcuts}
              onClick={jumpToEnd}
            >
              End
            </button>
            <button
              type="button"
              className="transport-button"
              aria-keyshortcuts={inShortcut?.ariaKeyShortcuts}
              title={inShortcut ? `Mark In (${inShortcut.label})` : 'Mark In'}
              onClick={() => useSourceMonitorStore.getState().setIn()}
            >
              I
            </button>
            <button
              type="button"
              className="transport-button"
              aria-keyshortcuts={outShortcut?.ariaKeyShortcuts}
              title={outShortcut ? `Mark Out (${outShortcut.label})` : 'Mark Out'}
              onClick={() => useSourceMonitorStore.getState().setOut()}
            >
              O
            </button>
            <button type="button" className="transport-button" onClick={jumpToIn}>
              Go to In
            </button>
            <button type="button" className="transport-button" onClick={jumpToOut}>
              Go to Out
            </button>
            <button type="button" className="transport-button" onClick={resetSession}>
              Reset
            </button>
          </div>
        </>
      ) : openShortcut ? (
        <p className="source-monitor-hint">
          Open a Media Pool asset ({openShortcut.label})
        </p>
      ) : null}
      <div className="source-monitor-edits">
        <button
          type="button"
          className={`transport-button${patchVideo ? ' active' : ''}`}
          title="Patch source video onto the targeted video track"
          aria-pressed={patchVideo}
          aria-label="source video patch"
          onClick={() => useSourceMonitorStore.getState().setSourcePatch({ video: !patchVideo })}
        >
          V
        </button>
        <button
          type="button"
          className={`transport-button${patchAudio ? ' active' : ''}`}
          title="Patch source audio onto the targeted audio track"
          aria-pressed={patchAudio}
          aria-label="source audio patch"
          onClick={() => useSourceMonitorStore.getState().setSourcePatch({ audio: !patchAudio })}
        >
          A
        </button>
        <button
          type="button"
          className="transport-button"
          aria-keyshortcuts={shortcutForCommand('timeline.insert')?.ariaKeyShortcuts}
          title={insertDisabled ?? 'Insert the marked source at the playhead'}
          aria-disabled={insertDisabled !== null}
          onClick={() => {
            if (insertDisabled) return
            executeEditorCommand('timeline.insert')
          }}
        >
          Insert
        </button>
        <button
          type="button"
          className="transport-button"
          aria-keyshortcuts={shortcutForCommand('timeline.overwrite')?.ariaKeyShortcuts}
          title={overwriteDisabled ?? 'Overwrite the targeted tracks with the marked source'}
          aria-disabled={overwriteDisabled !== null}
          onClick={() => {
            if (overwriteDisabled) return
            executeEditorCommand('timeline.overwrite')
          }}
        >
          Overwrite
        </button>
        <button
          type="button"
          className="transport-button"
          aria-label="Replace edit"
          aria-keyshortcuts={shortcutForCommand('timeline.replace')?.ariaKeyShortcuts}
          title={replaceDisabled ?? 'Replace the selected clip from the Source Monitor'}
          aria-disabled={replaceDisabled !== null}
          onClick={() => {
            if (replaceDisabled) return
            executeEditorCommand('timeline.replace')
          }}
        >
          Replace
        </button>
      </div>
    </section>
  )
}
