import { expect, type Page } from '@playwright/test'

interface Presentation {
  frame: number
  requestedAt: number
  presentedAt: number
  result: { status: string; drawnClipIds: string[]; missingClipIds: string[] }
}
interface PresentationProbe {
  records: Presentation[]
  lastCheck: { reason: string; expectedFrame: number | null; actionAfter: number | null;
    stateChangedAt: number; presentation: Presentation | null; differentContext: string[]; reused: boolean;
    observedSize: (number | null)[]; currentSize: (number | null)[]; expectedOfflineCanvasSize: readonly [number, number] | null } | null
  arm(frame: number, connected: boolean, allowCurrent: boolean, event?: 'click' | 'change', expectedOfflineCanvasSize?: readonly [number, number]): void
  mark(): void
  ready(): boolean
  cancelArm(): void
  dispose(): void
}
declare global { interface Window { __issue198Presentation?: PresentationProbe } }

/** Observe the real post-paint diagnostic; never request or replace a render. */
export async function observePresentations(page: Page) {
  await page.evaluate(async () => {
    const p = '/src/app/previewController.ts', d = '/src/state/documentStore.ts'
    const t = '/src/state/transportStore.ts', m = '/src/state/mediaStore.ts'
    const { subscribePreviewRenderDiagnostics } = await import(p)
    const document = (await import(d)).useDocumentStore, transport = (await import(t)).useTransportStore
    const media = (await import(m)).useMediaStore
    window.__issue198Presentation?.dispose()
    const storeContext = () => {
      const doc = document.getState(), state = transport.getState(), sources = media.getState()
      return [doc.projectGeneration, state.effectDocumentPreview?.document ?? doc.doc,
        sources.assets, sources.descriptors, state.playheadFrame]
    }
    const context = () => {
      const canvas = window.document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]')
      return [...storeContext(), canvas, canvas?.width, canvas?.height]
    }
    let latest: { event: Presentation; context: unknown[] } | null = null
    let lastContext = storeContext(), changedAt = performance.now()
    const observeState = () => {
      // DOM mount/resize is checked against the presented canvas separately.
      // An unrelated store notification must not timestamp that earlier DOM
      // change as if it were a new document/media/frame mutation.
      const current = storeContext()
      if (current.some((value, index) => value !== lastContext[index])) {
        lastContext = current; changedAt = performance.now()
      }
    }
    const unsubscribeStores = [document.subscribe(observeState), transport.subscribe(observeState), media.subscribe(observeState)]
    let armed: { frame: number; connected: boolean; allowCurrent: boolean; after: number; current: Presentation | null;
      expectedOfflineCanvasSize?: readonly [number, number] } | null = null
    let removeTrigger = () => {}
    const records: Presentation[] = []
    const unsubscribe = subscribePreviewRenderDiagnostics((event: Presentation) => {
      latest = { event, context: context() }
      records.push(event); if (records.length > 128) records.shift()
    })
    const probe: PresentationProbe = {
      records, lastCheck: null,
      arm(frame, connected, allowCurrent, event, expectedOfflineCanvasSize) {
        probe.cancelArm()
        armed = { frame, connected, allowCurrent, expectedOfflineCanvasSize, after: Number.POSITIVE_INFINITY, current: null }
        if (event) {
          // Set the action watermark at the native event, after locator scroll/
          // actionability work and before React handles this visual mutation.
          const mark = () => probe.mark()
          window.document.addEventListener(event, mark, { capture: true, once: true })
          removeTrigger = () => window.document.removeEventListener(event, mark, true)
        }
      },
      mark() {
        if (!armed) return
        armed.after = performance.now()
        if (armed.allowCurrent && latest && latest.event.requestedAt >= changedAt
          && context().every((value, index) => value === latest!.context[index])) {
          armed.current = latest.event
        }
      },
      ready() {
        const names = ['projectGeneration', 'document', 'assets', 'descriptors', 'frame', 'canvas', 'canvas.width', 'canvas.height']
        const current = context()
        const differentContext = latest ? current.flatMap((value, index) => value === latest!.context[index] ? [] : [names[index]!]) : []
        const dimensions = (values: unknown[]) => values.slice(6).map((value) => typeof value === 'number' ? value : null)
        const finish = (reason: string) => {
          probe.lastCheck = { reason, expectedFrame: armed?.frame ?? null,
            actionAfter: armed && Number.isFinite(armed.after) ? armed.after : null,
            stateChangedAt: changedAt, presentation: latest?.event ?? null, differentContext,
            reused: latest !== null && latest.event === armed?.current,
            observedSize: dimensions(latest?.context ?? []), currentSize: dimensions(current),
            expectedOfflineCanvasSize: armed?.expectedOfflineCanvasSize ?? null }
          return reason === 'ready'
        }
        if (!armed) return finish('not-armed')
        if (!latest) return finish('no-presentation')
        if (!Number.isFinite(armed.after)) return finish('unmarked-action')
        const { event } = latest
        const offlineSize = armed.expectedOfflineCanvasSize
        if (offlineSize) {
          if (armed.connected || armed.allowCurrent || offlineSize.some((value) => !Number.isSafeInteger(value) || value <= 0)) return finish('invalid-offline-size-mode')
          // Offline Open qualifies UI/retained data, not source pixels. The
          // new HTML placeholder may reflect its intrinsic dimensions after
          // the worker diagnostic. Require the independently expected size,
          // while preserving every other identity and fresh-request check.
          if (differentContext.some((name) => name !== 'canvas.width' && name !== 'canvas.height')) return finish('context-changed')
          if (current[6] !== offlineSize[0] || current[7] !== offlineSize[1]) return finish('offline-canvas-size-pending')
        } else if (differentContext.length > 0) return finish('context-changed')
        // A late old request must not inherit new store identities merely
        // because its post-paint callback runs after that state change.
        if (event.requestedAt < changedAt) return finish('request-before-state')
        if (event.frame !== armed.frame) return finish('wrong-frame')
        if (event.result.status !== 'drawn') return finish('render-not-drawn')
        if (armed.connected && (event.result.missingClipIds.length > 0 || !event.result.drawnClipIds.includes('mask-tracking-source'))) return finish('source-not-drawn')
        // A genuine synchronous no-op may reuse an already-qualified image,
        // but only for the exact same document/source/frame/canvas identities.
        return finish(event.requestedAt >= armed.after || event === armed.current ? 'ready' : 'request-before-action')
      },
      cancelArm() { removeTrigger(); removeTrigger = () => {}; armed = null },
      dispose() { probe.cancelArm(); unsubscribe(); unsubscribeStores.forEach((stop) => stop()) },
    }
    window.__issue198Presentation = probe
  })
}

export async function presentedAction(page: Page, frame: number, action: () => Promise<unknown>, options: {
  event?: 'click' | 'change'
  connected?: boolean
  allowCurrent?: boolean
  expectedOfflineCanvasSize?: readonly [number, number]
} = {}) {
  await page.evaluate(({ frame, options }) => {
    const probe = window.__issue198Presentation
    if (!probe) throw new Error('Presentation observer was not installed')
    probe.arm(frame, options.connected ?? true, options.allowCurrent ?? false, options.event, options.expectedOfflineCanvasSize)
  }, { frame, options })
  const cancelArm = () => page.evaluate(() => window.__issue198Presentation?.cancelArm())
  try {
    await action()
    await expect.poll(() => page.evaluate(() => window.__issue198Presentation?.ready() ?? false), {
      timeout: 10_000, message: `Program must present the requested frame ${frame} and visual state`,
    }).toBe(true)
  } catch (error) {
    // A test deadline may close the target before cleanup runs. Keep the
    // original action/assertion failure; afterEach also disposes probes.
    await cancelArm().catch(() => undefined)
    throw error
  }
  await cancelArm()
}
