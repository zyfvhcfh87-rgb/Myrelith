import { useState } from 'react'
import { docDurationFrames } from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import {
  renderPreviewFrameForDevBenchmark,
  subscribePreviewRenderCompletions,
  subscribePreviewRenderDiagnostics,
  type PreviewRenderCompletionDiagnostic,
  type PreviewRenderDiagnostic,
} from '../app/previewController'
import { previewRepresentationDecision } from '../app/proxyController'
import { pause, play } from '../app/transportController'

const PLAYBACK_SAMPLE_MS = 4_000
const SEEK_SAMPLE_COUNT = 10
const DIAGNOSTIC_TIMEOUT_MS = 15_000

interface ProxyEditingBenchmarkResult {
  readonly representation: 'original' | 'proxy'
  readonly assetId: string
  readonly seekSamples: number
  readonly seekCompletionMedianMs: number
  readonly seekCompletionP95Ms: number
  readonly seekWorkerRenderMedianMs: number
  readonly seekWorkerRenderP95Ms: number
  readonly presentationBoundaryMs: number
  readonly throughputBudgetMs: number
  readonly throughputWallMs: number
  readonly throughputExpectedFrames: number
  readonly throughputFramesDrawn: number
  readonly throughputFramesDropped: number
  readonly throughputDropPercent: number
  readonly achievedDrawnFps: number
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

function waitForCompletion(frame: number): Promise<PreviewRenderCompletionDiagnostic> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for preview frame ${frame}`))
    }, DIAGNOSTIC_TIMEOUT_MS)
    const unsubscribe = subscribePreviewRenderCompletions((diagnostic) => {
      if (
        diagnostic.mode !== 'seek' || diagnostic.frame !== frame
      ) return
      if (diagnostic.result.status === 'superseded') return
      window.clearTimeout(timeout)
      unsubscribe()
      if (diagnostic.result.status === 'drawn') resolve(diagnostic)
      else reject(new Error(diagnostic.result.message ?? `Preview frame ${frame} failed`))
    })
    useTransportStore.getState().setPlayheadFrame(frame)
  })
}

function waitForPresentation(frame: number): Promise<PreviewRenderDiagnostic> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for presented preview frame ${frame}`))
    }, DIAGNOSTIC_TIMEOUT_MS)
    const unsubscribe = subscribePreviewRenderDiagnostics((diagnostic) => {
      if (
        diagnostic.mode !== 'seek'
        || diagnostic.frame !== frame
        || diagnostic.result.status !== 'drawn'
      ) return
      window.clearTimeout(timeout)
      unsubscribe()
      resolve(diagnostic)
    })
    useTransportStore.getState().setPlayheadFrame(frame)
  })
}

async function measureCurrentRepresentation(): Promise<ProxyEditingBenchmarkResult> {
  const media = useMediaStore.getState()
  const document = useDocumentStore.getState().doc
  const timelineClip = document.tracks
    .filter((track) => track.kind === 'video' && !track.hidden)
    .flatMap((track) => track.clips)
    .find((clip) => media.descriptors.get(clip.assetId)?.kind === 'video')
  if (!timelineClip) {
    throw new Error('Place one connected video fixture on a visible timeline track')
  }
  const assetId = timelineClip.assetId
  const decision = previewRepresentationDecision(assetId)
  if (decision.representation !== 'original' && decision.representation !== 'proxy') {
    throw new Error(decision.reason)
  }
  const durationFrames = docDurationFrames(document)
  if (
    durationFrames < SEEK_SAMPLE_COUNT + 2
    || timelineClip.timelineRange.durationFrames < SEEK_SAMPLE_COUNT + 2
  ) {
    throw new Error('The benchmark video clip is too short for representative seek samples')
  }

  const transport = useTransportStore.getState()
  const priorFrame = transport.playheadFrame
  const priorPlaying = transport.isPlaying
  pause()
  try {
    const clipStart = timelineClip.timelineRange.startFrame
    const clipDuration = timelineClip.timelineRange.durationFrames
    const seekFrame = (fraction: number): number => clipStart + Math.min(
      clipDuration - 1,
      Math.max(0, Math.floor(fraction * clipDuration)),
    )

    // Two warm-ups load the exact selected original/proxy worker source path.
    await waitForCompletion(seekFrame(0.05))
    await waitForCompletion(seekFrame(0.5))
    const seekCompletionLatencies: number[] = []
    const seekWorkerRenderTimes: number[] = []
    for (let index = 0; index < SEEK_SAMPLE_COUNT; index++) {
      const frame = seekFrame((index + 1) / (SEEK_SAMPLE_COUNT + 1))
      const diagnostic = await waitForCompletion(frame)
      seekCompletionLatencies.push(diagnostic.completedAt - diagnostic.requestedAt)
      seekWorkerRenderTimes.push(diagnostic.result.renderMs)
    }

    // Keep browser-paint scheduling visible, but separate from worker/source
    // cost because background Chromium tabs throttle animation-frame delivery.
    const presentation = await waitForPresentation(seekFrame(0.03))

    // Serialize unpaced requests through the live bridge for up to four
    // seconds. This isolates selected-source worker capacity from background
    // tab rAF/timer throttling while retaining the real planner and decoder.
    const frameRate = document.frameRate.num / document.frameRate.den
    const frameBudgetMs = 1_000 / frameRate
    const expectedFrames = Math.min(
      clipDuration,
      Math.max(1, Math.floor(PLAYBACK_SAMPLE_MS / frameBudgetMs)),
    )
    const startedAt = performance.now()
    let drawnFrames = 0
    let requestedFrames = 0
    while (
      requestedFrames < expectedFrames
      && performance.now() - startedAt < PLAYBACK_SAMPLE_MS
    ) {
      const result = await renderPreviewFrameForDevBenchmark(
        clipStart + requestedFrames,
      )
      requestedFrames++
      if (result.status === 'drawn') drawnFrames++
      else if (result.status === 'error') {
        throw new Error(result.message ?? 'The preview worker failed during the throughput trial')
      }
    }
    const wallMs = performance.now() - startedAt
    const dropped = Math.max(0, expectedFrames - drawnFrames)
    return {
      representation: decision.representation,
      assetId,
      seekSamples: seekCompletionLatencies.length,
      seekCompletionMedianMs: percentile(seekCompletionLatencies, 0.5),
      seekCompletionP95Ms: percentile(seekCompletionLatencies, 0.95),
      seekWorkerRenderMedianMs: percentile(seekWorkerRenderTimes, 0.5),
      seekWorkerRenderP95Ms: percentile(seekWorkerRenderTimes, 0.95),
      presentationBoundaryMs: presentation.presentedAt - presentation.requestedAt,
      throughputBudgetMs: PLAYBACK_SAMPLE_MS,
      throughputWallMs: wallMs,
      throughputExpectedFrames: expectedFrames,
      throughputFramesDrawn: drawnFrames,
      throughputFramesDropped: dropped,
      throughputDropPercent: dropped / expectedFrames * 100,
      achievedDrawnFps: wallMs <= 0 ? 0 : drawnFrames / wallMs * 1_000,
    }
  } finally {
    pause()
    useTransportStore.getState().setPlayheadFrame(priorFrame)
    if (priorPlaying) play()
  }
}

const panelStyle = {
  position: 'fixed',
  inset: '12px 12px auto auto',
  zIndex: 10_000,
  width: 'min(430px, calc(100vw - 24px))',
  maxHeight: 'calc(100vh - 24px)',
  overflow: 'auto',
  padding: '12px',
  border: '1px solid #9d8cff',
  borderRadius: '10px',
  background: '#171522ee',
  color: '#f6f2ff',
  font: '12px/1.4 ui-monospace, monospace',
  boxShadow: '0 12px 40px #0009',
} as const

export default function ProxyEditingBenchmarkPanel() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ProxyEditingBenchmarkResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      setResult(await measureCurrentRepresentation())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }
  return (
    <aside style={panelStyle} aria-label="Proxy editing benchmark">
      <strong>Proxy editing benchmark</strong>
      <p>10 worker-complete seeks + 4 s worker throughput. Run once original, once proxy.</p>
      <button type="button" disabled={running} onClick={() => { void run() }}>
        {running ? 'Measuring...' : 'Measure current representation'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <output
        data-testid="proxy-editing-benchmark-result"
        style={{ display: 'block', marginTop: 8, whiteSpace: 'pre-wrap' }}
      >
        {result ? JSON.stringify(result, null, 2) : 'No sample yet.'}
      </output>
    </aside>
  )
}
