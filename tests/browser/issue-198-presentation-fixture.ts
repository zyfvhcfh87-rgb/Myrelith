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
    stateChangedAt: number; presentation: Presentation | null; differentContext: string[]; reused: boolean } | null
  arm(frame: number, connected: boolean, allowCurrent: boolean, event?: 'click' | 'change'): void
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
    let armed: { frame: number; connected: boolean; allowCurrent: boolean; after: number; current: Presentation | null } | null = null
    let removeTrigger = () => {}
    const records: Presentation[] = []
    const unsubscribe = subscribePreviewRenderDiagnostics((event: Presentation) => {
      latest = { event, context: context() }
      records.push(event); if (records.length > 128) records.shift()
    })
    const probe: PresentationProbe = {
      records, lastCheck: null,
      arm(frame, connected, allowCurrent, event) {
        probe.cancelArm()
        armed = { frame, connected, allowCurrent, after: Number.POSITIVE_INFINITY, current: null }
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
        const differentContext = latest ? context().flatMap((value, index) => value === latest!.context[index] ? [] : [names[index]!]) : []
        const finish = (reason: string) => {
          probe.lastCheck = { reason, expectedFrame: armed?.frame ?? null,
            actionAfter: armed && Number.isFinite(armed.after) ? armed.after : null,
            stateChangedAt: changedAt, presentation: latest?.event ?? null, differentContext,
            reused: latest !== null && latest.event === armed?.current }
          return reason === 'ready'
        }
        if (!armed) return finish('not-armed')
        if (!latest) return finish('no-presentation')
        if (!Number.isFinite(armed.after)) return finish('unmarked-action')
        const { event } = latest
        if (differentContext.length > 0) return finish('context-changed')
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
} = {}) {
  await page.evaluate(({ frame, options }) => {
    const probe = window.__issue198Presentation
    if (!probe) throw new Error('Presentation observer was not installed')
    probe.arm(frame, options.connected ?? true, options.allowCurrent ?? false, options.event)
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
