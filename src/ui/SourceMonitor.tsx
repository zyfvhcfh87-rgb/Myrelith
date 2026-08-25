/**
 * ui/SourceMonitor.tsx — Source Monitor chrome and review canvas.
 *
 * Session facts come from sourceMonitorStore. Pixels are painted by
 * app/sourceMonitorPreviewController. This file never opens a Blob.
 */

import { useEffect, useRef } from 'react'
import { CaretLeft, CaretRight, Pause, Play } from '@phosphor-icons/react'
import { shortcutForCommand } from '../app/editorCommands'
import { sourceMonitorOpenRejectionMessage } from '../app/sourceMonitorController'
import {
  closeSource,
  jumpToEnd,
  jumpToIn,
  jumpToOut,
  jumpToStart,
  resetSession,
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
  const asset = useMediaStore((state) => (
    session ? state.assets.get(session.source.assetId) ?? null : null
  ))
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
  const inShortcut = shortcutForCommand('source.mark-in')
  const outShortcut = shortcutForCommand('source.mark-out')
  const playing = (session?.shuttleStep ?? 0) !== 0

  return (
    <section
      className="source-monitor"
      data-testid="source-monitor"
      aria-label="Source Monitor"
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
        {session && !asset ? (
          <div className="source-monitor-hint source-monitor-hint-offline" role="status">
            <strong>Source offline</strong>
            <span>{sourceMonitorOpenRejectionMessage('offline')}</span>
          </div>
        ) : null}
        {lastOpenRejection ? (
          <div className="source-monitor-hint source-monitor-hint-offline" role="status">
            {sourceMonitorOpenRejectionMessage(lastOpenRejection)}
          </div>
        ) : null}
      </div>
      {session ? (
        <>
          <div className="source-monitor-readout" aria-live="polite">
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
          <div className="source-monitor-transport">
            <button type="button" className="transport-button" onClick={jumpToStart}>
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
            <button type="button" className="transport-button" onClick={jumpToEnd}>
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
    </section>
  )
}
