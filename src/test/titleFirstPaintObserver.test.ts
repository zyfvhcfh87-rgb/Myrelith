import { expect, test, vi } from 'vitest'
import { expandedTitleProject } from './titleOwnerFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import { subscribePreviewRenderCompletions, subscribePreviewRenderDiagnostics } from '../app/previewController'
import { createProbe } from '../../tests/diagnostics/issue200/first-paint-client'

vi.mock('../app/previewController', () => ({
  subscribePreviewRenderCompletions: vi.fn(() => vi.fn()),
  subscribePreviewRenderDiagnostics: vi.fn(() => vi.fn()),
}))

test('passive observer rejects completion-only readiness and closes pending wait timers on disposal', async () => {
  vi.useFakeTimers()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
  const node = document.createElement('canvas')
  node.dataset.testid = 'preview-canvas'; node.style.width = '640px'; node.style.height = '360px'
  document.body.append(node)
  useDocumentStore.getState().setProject(expandedTitleProject())
  useTransportStore.getState().resetTransport()
  useProjectSessionStore.setState({ screen: 'editor', phase: 'idle', error: null, saveError: null, recoveryError: null })
  const probe = createProbe()
  try {
    const pin = probe.pin(probe.mark('same-canvas-fallback', false))
    const completed = vi.mocked(subscribePreviewRenderCompletions).mock.calls[0][0]
    const presented = vi.mocked(subscribePreviewRenderDiagnostics).mock.calls[0][0]
    const result = { status: 'drawn' as const, drawnClipIds: ['root-text'], missingClipIds: [], renderMs: 1 }
    let settled = false
    const wait = probe.wait(pin).then(() => { settled = true })
    completed({ frame: 0, mode: 'seek', requestedAt: 101, completedAt: 102, result })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(probe.summary().pendingWaits).toBe(1)
    presented({ frame: 0, mode: 'seek', requestedAt: 101, presentedAt: 104, result })
    await wait
    expect(probe.summary().pendingWaits).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    const timed = probe.wait({ ...pin, startedAt: 200 })
    const timeout = expect(timed).rejects.toThrow('within 10 seconds')
    await vi.advanceTimersByTimeAsync(10000)
    await timeout
    expect(vi.getTimerCount()).toBe(0)
    const pending = probe.wait({ ...pin, startedAt: 200 })
    const rejected = expect(pending).rejects.toThrow('observer disposed')
    expect(vi.getTimerCount()).toBe(1)
    const released = probe.dispose()
    await rejected
    expect(released).toMatchObject({ disposed: true, subscriptions: 0, waiters: 0, listeners: 0, liveBuffers: 0 })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    probe.dispose(); node.remove(); clock.mockRestore(); vi.useRealTimers()
  }
})

test('observer retains a recovered error and makes its event cap explicit', () => {
  const probe = createProbe()
  const completed = vi.mocked(subscribePreviewRenderCompletions).mock.calls.at(-1)![0]
  try {
    useProjectSessionStore.setState({ recoveryPhase: 'error', recoveryError: 'transient recovery fault' })
    useProjectSessionStore.setState({ recoveryPhase: 'idle', recoveryError: null })
    expect(probe.summary().issues).toContain('Observed project/save/recovery error')
    expect(() => probe.mark('cannot-hide-error')).toThrow('Observed project/save/recovery error')
    for (let i = 0; i < 300; i++) completed({ frame: 0, mode: 'seek', requestedAt: 101, completedAt: 102,
      result: { status: 'drawn', drawnClipIds: ['root-text'], missingClipIds: [], renderMs: 1 } })
    expect(probe.summary().ledger).toHaveLength(256)
    expect(probe.summary().dropped).toBeGreaterThan(0)
  } finally { probe.dispose() }
})
