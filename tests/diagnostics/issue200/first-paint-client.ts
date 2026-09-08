/** Passive browser diagnostic. Never imported by the production application. */
import { subscribePreviewRenderCompletions, subscribePreviewRenderDiagnostics, type PreviewRenderDiagnostic } from '../../../src/app/previewController'
import { useDocumentStore } from '../../../src/state/documentStore'
import { useTransportStore } from '../../../src/state/transportStore'
import { usePreviewStatusStore } from '../../../src/state/previewStatusStore'
import { usePreviewQualityStore } from '../../../src/state/previewQualityStore'
import { useProjectSessionStore } from '../../../src/state/projectSessionStore'
import { resolvePresentationProfile } from '../../../src/domain/presentationProfile'
import { projectTitleExportError } from '../../../src/domain/titleExport'
import { CHECKPOINTS, MAX_EVENTS, MAX_PIXELS, matchesPresentation, sameOwner, wireOf, type Checkpoint, type Owner, type Target } from './first-paint-model'

type Mark = { label: string; startedAt: number; priorCanvasId: number | null; replaceCanvas: boolean }
type Pin = Target & { wire: string; history: string }
type Event = { sequence: number; at: number; kind: string; owner: Owner; detail: unknown; diagnostic?: PreviewRenderDiagnostic }
type Capture = ReturnType<typeof takePixels>
let probe: ReturnType<typeof createProbe> | null = null
const ids = new WeakMap<HTMLCanvasElement, number>()
let serial = 0
function canvas() { return document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]') }
function canvasId(node = canvas()) {
  if (!node) return null
  let id = ids.get(node)
  if (id === undefined) { id = ++serial; ids.set(node, id) }
  return id
}
function owner(): Owner {
  const d = useDocumentStore.getState(), t = useTransportStore.getState(), s = useProjectSessionStore.getState(), node = canvas()
  return { generation: d.projectGeneration, sequenceId: d.activeSequenceId, clipId: d.doc.tracks[0]?.clips[0]?.id ?? null,
    frame: t.playheadFrame, canvasId: canvasId(node), connected: node?.isConnected ?? false, screen: s.screen, phase: s.phase }
}
function snapshot() {
  const d = useDocumentStore.getState(), s = useProjectSessionStore.getState(), t = useTransportStore.getState(), node = canvas()
  const viewport = node ? { widthCssPx: Number.parseFloat(node.style.width), heightCssPx: Number.parseFloat(node.style.height), devicePixelRatio: devicePixelRatio || 1 } : null
  const profile = resolvePresentationProfile(d.doc, { qualityMode: usePreviewQualityStore.getState().qualityMode, reason: 'paused', viewport })
  return { owner: owner(), profile, viewport, width: node?.width ?? null, height: node?.height ?? null,
    project: structuredClone(d.project), wire: wireOf(d.project), history: JSON.stringify({ past: d.past, future: d.future }),
    notices: usePreviewStatusStore.getState().titleNotices, selectedClipIds: t.selectedClipIds,
    session: { screen: s.screen, phase: s.phase, error: s.error, savePhase: s.savePhase, saveError: s.saveError,
      recoveryPhase: s.recoveryPhase, recoveryError: s.recoveryError, lastRecoveryAt: s.lastRecoveryAt },
    titleExportError: projectTitleExportError(d.project, d.activeSequenceId) }
}
function takePixels(name: string) {
  const at = performance.now(), state = snapshot(), node = canvas()
  if (!node || node.width * node.height > MAX_PIXELS || node.width <= 0 || node.height <= 0) throw new Error('Invalid/missing live canvas')
  const profileMatches = state.profile.outputWidth === node.width && state.profile.outputHeight === node.height
  if (!profileMatches && name !== 'reopened-at-notice') throw new Error('Observed settled canvas and resolved presentation profile disagree')
  const readback = new OffscreenCanvas(node.width, node.height)
  try {
    const requested = { colorSpace: 'srgb', willReadFrequently: true } as const
    const ctx = readback.getContext('2d', requested)
    if (!ctx) throw new Error('Readback context unavailable')
    const attributes = (ctx as typeof ctx & { getContextAttributes?: () => CanvasRenderingContext2DSettings }).getContextAttributes
    const actual = attributes?.call(ctx)
    if (!actual) throw new Error('Readback context attributes unavailable')
    if (actual.colorSpace !== 'srgb' || actual.willReadFrequently !== true) throw new Error('Readback context policy mismatch')
    ctx.drawImage(node, 0, 0)
    const rgba = ctx.getImageData(0, 0, readback.width, readback.height).data
    return { name, at, capturedAt: performance.now(), state, profileMatches, requested, actual, width: node.width, height: node.height, rgba }
  } finally { readback.width = readback.height = 0 }
}
function base64(bytes: Uint8Array | Uint8ClampedArray) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(binary)
}
async function encodeCapture(capture: Capture) {
  const png = new OffscreenCanvas(capture.width, capture.height)
  try {
    const ctx = png.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    if (!ctx) throw new Error('PNG encoding context unavailable')
    ctx.putImageData(new ImageData(new Uint8ClampedArray(capture.rgba), capture.width, capture.height), 0, 0)
    const blob = await png.convertToBlob({ type: 'image/png' })
    const { rgba, ...metadata } = capture
    return { metadata, rgbaBase64: base64(rgba), pngBase64: base64(new Uint8Array(await blob.arrayBuffer())) }
  } finally { png.width = png.height = 0 }
}

export function createProbe() {
  const ledger: Event[] = [], issues: string[] = [], captures = new Map<string, Capture>()
  const listeners = new Set<() => void>(), waits = new Set<(cause: Error) => void>(), stops: Array<() => void> = []
  let dropped = 0, disposed = false
  function record(kind: string, detail: unknown = null, diagnostic?: PreviewRenderDiagnostic) {
    if (disposed) return
    try {
      if (ledger.length >= MAX_EVENTS) { dropped++; return }
      ledger.push({ sequence: ledger.length, at: performance.now(), kind, owner: owner(), detail, diagnostic })
      const s = useProjectSessionStore.getState()
      if (s.error || s.saveError || s.recoveryError || s.phase === 'error' || s.savePhase === 'error' || s.recoveryPhase === 'error') issues.push('Observed project/save/recovery error')
      for (const listener of listeners) listener()
    } catch (cause) { issues.push(`Observer failure: ${String(cause)}`) }
  }
  function healthy() {
    if (disposed || dropped || issues.length) throw new Error(JSON.stringify({ disposed, dropped, issues }))
    const s = useProjectSessionStore.getState()
    if (s.error || s.saveError || s.recoveryError || s.phase === 'error' || s.savePhase === 'error' || s.recoveryPhase === 'error') throw new Error('Project/save/recovery state failed')
  }
  stops.push(subscribePreviewRenderCompletions((d) => record('completion', d)))
  stops.push(subscribePreviewRenderDiagnostics((d) => record('presentation', null, d)))
  stops.push(useDocumentStore.subscribe((s, p) => { if (s.project !== p.project || s.projectGeneration !== p.projectGeneration || s.activeSequenceId !== p.activeSequenceId) record('document') }))
  stops.push(useTransportStore.subscribe((s, p) => { if (s.playheadFrame !== p.playheadFrame || s.selectedClipIds !== p.selectedClipIds || s.effectDocumentPreview !== p.effectDocumentPreview) record('transport') }))
  stops.push(useProjectSessionStore.subscribe((s) => record('session', { screen: s.screen, phase: s.phase, savePhase: s.savePhase, saveError: s.saveError, recoveryPhase: s.recoveryPhase, recoveryError: s.recoveryError, error: s.error })))
  stops.push(usePreviewStatusStore.subscribe((s, p) => { if (s.titleNotices !== p.titleNotices) record('notices', s.titleNotices) }))
  stops.push(usePreviewQualityStore.subscribe(() => record('quality')))
  let lastCanvas = canvasId()
  const mutation = new MutationObserver(() => {
    const next = canvasId()
    if (next !== lastCanvas) { record('canvas-replacement', { previous: lastCanvas, next }); lastCanvas = next }
  })
  mutation.observe(document.body, { childList: true, subtree: true })
  stops.push(() => mutation.disconnect())
  record('installed')
  function validatePin(pin: Pin) {
    healthy()
    const current = snapshot()
    if (!sameOwner(current.owner, pin.owner) || current.wire !== pin.wire || current.history !== pin.history) throw new Error(`Owner/project/history changed during ${pin.label}`)
    return current
  }
  return {
    mark(label: string, replaceCanvas = true): Mark {
      healthy()
      const mark = { label, startedAt: performance.now(), priorCanvasId: canvasId(), replaceCanvas }
      record('transition-start', mark)
      return mark
    },
    pin(mark: Mark): Pin {
      healthy()
      const state = snapshot()
      if (!state.owner.canvasId || !sameOwner(state.owner, state.owner) || state.owner.frame !== 0) throw new Error('Cannot pin the target editor canvas/frame')
      if (mark.replaceCanvas && state.owner.canvasId === mark.priorCanvasId) throw new Error('Canonical reopen did not replace the prior canvas')
      if (!mark.replaceCanvas && state.owner.canvasId !== mark.priorCanvasId) throw new Error('UI fallback unexpectedly replaced the canvas')
      const pin = { label: mark.label, startedAt: mark.startedAt, owner: state.owner, wire: state.wire, history: state.history }
      record('transition-pinned', pin)
      return pin
    },
    wait(pin: Pin): Promise<Event> {
      validatePin(pin)
      return new Promise((resolve, reject) => {
        const finish = (event?: Event, error?: unknown) => { clearTimeout(timer); listeners.delete(check); waits.delete(cancel); if (error) reject(error); else resolve(event!) }
        const cancel = (cause: Error) => finish(undefined, cause)
        const check = () => {
          try { validatePin(pin); const event = ledger.find((item) => matchesPresentation(item, pin)); if (event) finish(event) }
          catch (error) { finish(undefined, error) }
        }
        const timer = setTimeout(() => finish(undefined, new Error(`No matching presentation within 10 seconds: ${pin.label}`)), 10000)
        waits.add(cancel); listeners.add(check); check()
      })
    },
    capture(name: Checkpoint, pin: Pin, requirePresentation: boolean) {
      validatePin(pin)
      if (!CHECKPOINTS.includes(name) || captures.has(name) || captures.size >= CHECKPOINTS.length) throw new Error('Invalid/repeated checkpoint')
      const presentation = ledger.find((event) => matchesPresentation(event, pin))
      if (requirePresentation && !presentation) throw new Error('Canvas capture lacks its matching presentation')
      const result = takePixels(name)
      captures.set(name, result); record('capture', { name, at: result.at, presentationSequence: presentation?.sequence ?? null })
      return { name, at: result.at, state: result.state, presentationSequence: presentation?.sequence ?? null }
    },
    async stable(pin: Pin) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      validatePin(pin)
    },
    async encoded(name: string) {
      const capture = captures.get(name)
      if (!capture) throw new Error(`Missing captured pixels: ${name}`)
      return encodeCapture(capture)
    },
    async compare() {
      healthy()
      if (captures.size !== CHECKPOINTS.length) throw new Error('The complete six-checkpoint ledger is required')
      const { compareFirstPaint } = await import('./first-paint-reference')
      return compareFirstPaint(captures)
    },
    summary() {
      return { ledger, issues, dropped, disposed, captureNames: [...captures.keys()], liveBuffers: captures.size, pendingWaits: waits.size, current: snapshot() }
    },
    dispose() {
      for (const stop of stops.splice(0)) stop()
      for (const cancel of [...waits]) cancel(new Error('First-paint observer disposed'))
      mutation.takeRecords(); listeners.clear(); captures.clear(); disposed = true
      return { disposed, subscriptions: stops.length, waiters: waits.size, listeners: listeners.size, liveBuffers: captures.size, issues, dropped }
    },
  }
}
export function install() {
  if (probe) throw new Error('Only one first-paint observer may be installed')
  probe = createProbe()
}
export function currentProbe() {
  if (!probe) throw new Error('First-paint observer is not installed')
  return probe
}
export type FirstPaintCapture = Capture
