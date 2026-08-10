/** Lightweight UI renderer for render-worker scope analysis. */

import { useEffect, useRef } from 'react'
import type { VideoScopeAnalysis } from '../domain/videoScopes'
import {
  useVideoScopesStore,
  type VideoScopeMode,
} from '../state/videoScopesStore'

const SCOPE_WIDTH = 320
const SCOPE_HEIGHT = 144
const MODES: readonly VideoScopeMode[] = [
  'histogram',
  'waveform',
  'vectorscope',
]

function paintGrid(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#071019'
  ctx.fillRect(0, 0, SCOPE_WIDTH, SCOPE_HEIGHT)
  ctx.strokeStyle = 'rgb(125 155 184 / 20%)'
  ctx.lineWidth = 1
  for (let quarter = 1; quarter < 4; quarter++) {
    const x = quarter * SCOPE_WIDTH / 4
    const y = quarter * SCOPE_HEIGHT / 4
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, SCOPE_HEIGHT)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(SCOPE_WIDTH, y)
    ctx.stroke()
  }
}

function paintHistogram(
  ctx: CanvasRenderingContext2D,
  analysis: VideoScopeAnalysis,
): void {
  const series = [
    { bins: analysis.histogram.luma, color: '#eaf3ff' },
    { bins: analysis.histogram.red, color: '#ff6677' },
    { bins: analysis.histogram.green, color: '#63dd95' },
    { bins: analysis.histogram.blue, color: '#669dff' },
  ]
  let maximum = 1
  for (const { bins } of series) {
    for (const count of bins) maximum = Math.max(maximum, count)
  }
  ctx.globalAlpha = 0.75
  for (const { bins, color } of series) {
    ctx.strokeStyle = color
    ctx.beginPath()
    for (let bin = 0; bin < bins.length; bin++) {
      const x = bin / (bins.length - 1) * (SCOPE_WIDTH - 1)
      const y = SCOPE_HEIGHT - 1 - bins[bin] / maximum * (SCOPE_HEIGHT - 8)
      if (bin === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function paintDensity(
  ctx: CanvasRenderingContext2D,
  density: Uint16Array,
  width: number,
  height: number,
  color: string,
): void {
  let maximum = 1
  for (const count of density) maximum = Math.max(maximum, count)
  const cellWidth = SCOPE_WIDTH / width
  const cellHeight = SCOPE_HEIGHT / height
  ctx.fillStyle = color
  for (let index = 0; index < density.length; index++) {
    const count = density[index]
    if (count === 0) continue
    ctx.globalAlpha = Math.max(0.12, Math.sqrt(count / maximum))
    ctx.fillRect(
      index % width * cellWidth,
      Math.floor(index / width) * cellHeight,
      Math.max(1, cellWidth),
      Math.max(1, cellHeight),
    )
  }
  ctx.globalAlpha = 1
}

function paintScope(
  ctx: CanvasRenderingContext2D,
  mode: VideoScopeMode,
  analysis: VideoScopeAnalysis | null,
): void {
  paintGrid(ctx)
  if (!analysis) return
  if (mode === 'histogram') paintHistogram(ctx, analysis)
  else if (mode === 'waveform') {
    paintDensity(
      ctx,
      analysis.waveform.density,
      analysis.waveform.width,
      analysis.waveform.height,
      '#72e6b1',
    )
  } else {
    paintDensity(
      ctx,
      analysis.vectorscope.density,
      analysis.vectorscope.width,
      analysis.vectorscope.height,
      '#75d8ff',
    )
  }
}

export default function VideoScopesPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mode = useVideoScopesStore((state) => state.mode)
  const status = useVideoScopesStore((state) => state.status)
  const analysis = useVideoScopesStore((state) => state.analysis)
  const frame = useVideoScopesStore((state) => state.frame)
  const setMode = useVideoScopesStore((state) => state.setMode)

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d')
    if (context) paintScope(context, mode, analysis)
  }, [analysis, mode])

  const statusText = status === 'unsupported'
    ? 'Pixel sampling is unavailable in this browser.'
    : status === 'ready'
      ? `${analysis?.sampleCount ?? 0} visible samples from frame ${frame ?? 0}.`
      : 'Waiting for the next completed preview frame.'

  return (
    <section className="video-scopes" aria-labelledby="video-scopes-heading">
      <div className="video-scopes-heading">
        <strong id="video-scopes-heading">Video scopes</strong>
        <span>4 Hz max</span>
      </div>
      <div className="video-scopes-tabs" role="tablist" aria-label="Video scope type">
        {MODES.map((item, index) => (
          <button
            key={item}
            id={`video-scope-${item}-tab`}
            type="button"
            role="tab"
            aria-selected={mode === item}
            aria-controls="video-scope-panel"
            tabIndex={mode === item ? 0 : -1}
            onClick={() => setMode(item)}
            onKeyDown={(event) => {
              const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
              if (delta === 0) return
              event.preventDefault()
              const next = (index + delta + MODES.length) % MODES.length
              setMode(MODES[next])
              const tabs = event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              tabs?.[next]?.focus()
            }}
          >
            {item}
          </button>
        ))}
      </div>
      <div
        id="video-scope-panel"
        role="tabpanel"
        aria-labelledby={`video-scope-${mode}-tab`}
      >
        <canvas
          ref={canvasRef}
          className="video-scopes-canvas"
          width={SCOPE_WIDTH}
          height={SCOPE_HEIGHT}
          role="img"
          aria-label={`${mode} scope. ${statusText}`}
        />
      </div>
      <span className="video-scopes-status" role="status" aria-live="polite">
        {statusText}
      </span>
    </section>
  )
}
