import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PerformanceArtifact } from './contract'
import PerformanceBenchmarkApp from './PerformanceBenchmarkApp'

const runtime = vi.hoisted(() => ({
  cleanup: vi.fn(async () => undefined),
  firstUsableFrameMs: vi.fn(async () => 1),
  formatArtifact: vi.fn(),
  preparePerformanceHarness: vi.fn(),
  run: vi.fn(),
}))

vi.mock('./runtime', () => ({
  DEFAULT_PERFORMANCE_RUN_OPTIONS: {},
  manualChromiumMetadata: () => ({}),
  manualHostMetadata: () => ({}),
  preparePerformanceHarness: runtime.preparePerformanceHarness,
}))

vi.mock('../../ui/Preview', () => ({ default: () => <div>Preview</div> }))
vi.mock('../../ui/timeline/Timeline', () => ({
  default: () => <div>Timeline</div>,
}))
vi.mock('../../ui/timeline/TimelineZoomControls', () => ({
  default: () => <div>Timeline zoom</div>,
}))

function artifact(consoleProblems: readonly string[]): PerformanceArtifact {
  return { consoleProblems } as unknown as PerformanceArtifact
}

describe('PerformanceBenchmarkApp browser evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtime.preparePerformanceHarness.mockResolvedValue({
      fixture: {
        version: 'fixture-v1',
        assetCount: 100,
        trackCount: 8,
        durationSeconds: 1_800,
        representative4kAssetCount: 25,
        transitionCount: 39,
        textClipCount: 20,
      },
      cleanup: runtime.cleanup,
      firstUsableFrameMs: runtime.firstUsableFrameMs,
      formatArtifact: runtime.formatArtifact,
      run: runtime.run,
    })
  })

  test('renders the finalized artifact before the runner captures evidence', async () => {
    const initialArtifact = artifact([])
    runtime.run.mockResolvedValue({
      artifact: initialArtifact,
      summaryMarkdown: 'Initial summary without late console evidence',
    })
    runtime.formatArtifact.mockImplementation((next: PerformanceArtifact) => (
      `Final summary: ${next.consoleProblems.join(', ')}`
    ))
    render(<PerformanceBenchmarkApp />)

    await waitFor(() => expect(window.__webcutPerformanceHarness).toBeDefined())
    await act(async () => {
      await window.__webcutPerformanceHarness?.run({} as never)
    })
    expect(screen.getByText('Initial summary without late console evidence'))
      .toBeInTheDocument()

    const finalizedArtifact = artifact(['warning: late console evidence'])
    act(() => {
      expect(window.__webcutPerformanceHarness?.formatArtifact(finalizedArtifact))
        .toBe('Final summary: warning: late console evidence')
    })

    expect(screen.getByText('Final summary: warning: late console evidence'))
      .toBeInTheDocument()
    expect(screen.queryByText('Initial summary without late console evidence'))
      .not.toBeInTheDocument()
  })

  test('rethrows benchmark regressions to the command-line caller', async () => {
    runtime.run.mockRejectedValue(new Error('simulated export preflight regression'))
    render(<PerformanceBenchmarkApp />)

    await waitFor(() => expect(window.__webcutPerformanceHarness).toBeDefined())
    let caught: unknown
    await act(async () => {
      try {
        await window.__webcutPerformanceHarness?.run({} as never)
      } catch (cause) {
        caught = cause
      }
    })

    expect(caught).toEqual(new Error('simulated export preflight regression'))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'simulated export preflight regression',
    )
    expect(document.querySelector('[data-harness-status="error"]')).not.toBeNull()
  })
})
