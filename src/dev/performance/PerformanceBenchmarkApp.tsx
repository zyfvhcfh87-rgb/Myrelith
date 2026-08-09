import { useEffect, useState } from 'react'
import '../../app/layout.css'
import Preview from '../../ui/Preview'
import Timeline from '../../ui/timeline/Timeline'
import TimelineZoomControls from '../../ui/timeline/TimelineZoomControls'
import {
  DEFAULT_PERFORMANCE_RUN_OPTIONS,
  manualChromiumMetadata,
  manualHostMetadata,
  preparePerformanceHarness,
  type PerformanceHarnessApi,
  type PerformanceHarnessRunResult,
} from './runtime'
import './performance.css'

declare global {
  interface Window {
    __myrelithPerformanceHarness?: PerformanceHarnessApi
  }
}

type HarnessStatus = 'preparing' | 'ready' | 'running' | 'complete' | 'error'

function BenchmarkEditorSurface() {
  return (
    <section className="performance-editor" aria-label="Isolated stress editor">
      <div className="performance-preview">
        <Preview />
      </div>
      <div className="performance-transport">
        <span>Isolated stress timeline</span>
        <TimelineZoomControls />
      </div>
      <div className="performance-timeline" data-timeline-scroll>
        <Timeline />
      </div>
    </section>
  )
}

export default function PerformanceBenchmarkApp() {
  const [status, setStatus] = useState<HarnessStatus>('preparing')
  const [api, setApi] = useState<PerformanceHarnessApi | null>(null)
  const [result, setResult] = useState<PerformanceHarnessRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let prepared: PerformanceHarnessApi | null = null
    void preparePerformanceHarness().then((next) => {
      prepared = next
      if (!active) {
        void next.cleanup()
        return
      }
      const exposed: PerformanceHarnessApi = {
        fixture: next.fixture,
        firstUsableFrameMs: () => next.firstUsableFrameMs(),
        run: async (request) => {
          if (active) {
            setStatus('running')
            setError(null)
          }
          try {
            const runResult = await next.run(request)
            if (active) {
              setResult(runResult)
              setStatus('complete')
            }
            return runResult
          } catch (cause) {
            if (active) {
              setError(cause instanceof Error ? cause.message : String(cause))
              setStatus('error')
            }
            throw cause
          }
        },
        formatArtifact: (artifact) => {
          const summaryMarkdown = next.formatArtifact(artifact)
          if (active) setResult({ artifact, summaryMarkdown })
          return summaryMarkdown
        },
        cleanup: () => next.cleanup(),
      }
      window.__myrelithPerformanceHarness = exposed
      setApi(exposed)
      setStatus('ready')
    }, (cause) => {
      if (!active) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    })
    return () => {
      active = false
      delete window.__myrelithPerformanceHarness
      if (prepared) void prepared.cleanup()
    }
  }, [])

  const runManualEvidence = async (): Promise<void> => {
    if (!api || status !== 'ready') return
    try {
      await api.run({
        host: manualHostMetadata(),
        chromium: manualChromiumMetadata(),
        options: DEFAULT_PERFORMANCE_RUN_OPTIONS,
      })
    } catch {
      // The exposed run wrapper owns the visible error state.
    }
  }

  return (
    <main className="performance-harness" data-harness-status={status}>
      <header className="performance-header">
        <div>
          <p className="performance-eyebrow">Opt-in performance evidence route</p>
          <h1>Myrelith performance harness</h1>
          <p>
            Deterministic stress data, real browser pipelines, and zero project
            persistence. The command-line workflow adds source and device provenance.
          </p>
        </div>
        <div className="performance-status" role="status" aria-live="polite">
          {status}
        </div>
      </header>

      {api ? (
        <section className="performance-fixture" aria-label="Fixture coverage">
          <strong>{api.fixture.version}</strong>
          <span>{api.fixture.assetCount} assets</span>
          <span>{api.fixture.trackCount} tracks</span>
          <span>{api.fixture.durationSeconds / 60} minutes</span>
          <span>{api.fixture.representative4kAssetCount} representative 4K sources</span>
          <span>{api.fixture.transitionCount} transitions</span>
          <span>{api.fixture.textClipCount} text clips</span>
        </section>
      ) : null}

      {status === 'preparing' ? (
        <div className="performance-loading">Generating bounded 4K and audio sources…</div>
      ) : null}
      {error ? <div className="performance-error" role="alert">{error}</div> : null}
      {api && status !== 'complete' && status !== 'error'
        ? <BenchmarkEditorSurface />
        : null}

      {api && status === 'ready' ? (
        <section className="performance-actions">
          <button type="button" onClick={() => void runManualEvidence()}>
            Run full browser benchmark
          </button>
          <p>
            For reviewable JSON and Markdown artifacts, use{' '}
            <code>node scripts/performance/run-benchmark.mjs</code>.
          </p>
        </section>
      ) : null}
      {status === 'running' ? (
        <div className="performance-loading" role="status">
          Running scrub, playback, import, media-scheduler, process-memory, and export workloads…
        </div>
      ) : null}
      {result ? (
        <section className="performance-results" aria-label="Benchmark summary">
          <h2>Run summary</h2>
          <pre>{result.summaryMarkdown}</pre>
          <details>
            <summary>Machine-readable artifact</summary>
            <pre>{JSON.stringify(result.artifact, null, 2)}</pre>
          </details>
        </section>
      ) : null}
    </main>
  )
}
