/** Fixture setup and passive browser evidence; excluded from the production graph. */
import { expandedTitleProject } from '../../../src/test/titleOwnerFixtures'
import { readTitleDefinition, readTitleElement } from '../../../src/domain/titleElements'
import { createProjectFileSnapshot, serializeProjectFile } from '../../../src/domain/projectFile'
import { useDocumentStore } from '../../../src/state/documentStore'
import { useTransportStore } from '../../../src/state/transportStore'
import { useTitleEditorStore } from '../../../src/state/titleEditorStore'
import { useProjectSessionStore } from '../../../src/state/projectSessionStore'
import { useTitleTemplateStore } from '../../../src/state/titleTemplateStore'
import { clippedRegion, contrast, healthySession, inside, MAX_NATIVE_KEYS, MAX_SESSION_EVENTS, requireSessionLedger, type PaintLayer, type Rect } from './keyboard-model'

export function fixture() {
  const project = expandedTitleProject(), clip = project.sequences[0].tracks[0].clips[0]
  const definition = readTitleDefinition(clip.title)
  if (definition.status !== 'supported' || definition.title.elements.length !== 1) throw new Error('Unexpected fixture definition')
  const parsed = readTitleElement(definition.title.elements[0])
  if (parsed.status !== 'supported' || parsed.element.kind !== 'text') throw new Error('Expected fixture text')
  const e = parsed.element
  clip.title = { version: 1, elements: [{ ...e, name: 'Text',
    transform: { ...e.transform, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    text: { ...e.text, content: 'Keyboard title', boxWidthPx: 800, boxHeightPx: 180, fontSizePx: 48 },
    font: { family: 'Missing Keyboard Face', fallbackFamily: 'serif' } }] }
  delete clip.animation
  if (project.sequences[0].width !== 1920 || project.sequences[0].height !== 1080 || clip.timelineRange.durationFrames !== 100) throw new Error('Fixture geometry drift')
  return { wire: serializeProjectFile(createProjectFileSnapshot(project, [], [])), frame: 12, elementId: e.id }
}
export function snapshot() {
  const d = useDocumentStore.getState(), t = useTransportStore.getState(), s = useProjectSessionStore.getState(), library = useTitleTemplateStore.getState()
  return { wire: serializeProjectFile(createProjectFileSnapshot(d.project, [], [])), project: structuredClone(d.project),
    history: JSON.stringify({ past: d.past, future: d.future }), past: d.past.length, future: d.future.length,
    clip: structuredClone(d.doc.tracks[0].clips[0]), generation: d.projectGeneration, sequenceId: d.activeSequenceId,
    frame: t.playheadFrame, selectedClip: t.selectedClipId, selectedElements: [...useTitleEditorStore.getState().ids],
    previewOwner: t.effectDocumentPreview?.owner ?? null, preview: structuredClone(t.effectDocumentPreview),
    guides: useTitleEditorStore.getState().safeGuides, session: { screen: s.screen, phase: s.phase, error: s.error,
      savePhase: s.savePhase, saveError: s.saveError, recoveryPhase: s.recoveryPhase, recoveryError: s.recoveryError, lastRecoveryAt: s.lastRecoveryAt },
    library: { entries: structuredClone(library.templates), unavailable: structuredClone(library.unavailable), loaded: library.loaded, busy: library.busy, error: library.error, readOnlyReason: library.readOnlyReason } }
}
const ids = new WeakMap<Element, number>()
let serial = 0
function id(node: Element) { let value = ids.get(node); if (!value) { value = ++serial; ids.set(node, value) } return value }
function rect(node: Element): Rect { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } }
function viewport(): Rect { return { x: 0, y: 0, width: innerWidth, height: innerHeight } }
function styleLayers(node: Element | null): PaintLayer[] {
  const layers: PaintLayer[] = []
  for (let current = node; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (style.filter !== 'none' || style.mixBlendMode !== 'normal') throw new Error('Unresolved CSS filter/blend in contrast evidence')
    layers.push({ background: style.backgroundColor, opacity: Number(style.opacity), image: style.backgroundImage })
  }
  return layers
}
function paintedText(node: Element) {
  const style = getComputedStyle(node), layers = styleLayers(node)
  return { color: style.color, layers, measured: contrast(style.color, layers) }
}
function bounds(node: Element) {
  let region = viewport()
  const ancestors: Array<{ id: number; tag: string; bounds: Rect; overflowX: string; overflowY: string; scrollTop: number; scrollLeft: number }> = []
  for (let current = node.parentElement; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    const x = /auto|scroll|hidden|clip/.test(style.overflowX), y = /auto|scroll|hidden|clip/.test(style.overflowY)
    if (!x && !y) continue
    const b = rect(current), client = { x: b.x + current.clientLeft, y: b.y + current.clientTop, width: current.clientWidth, height: current.clientHeight }
    const clipping = { x: x ? client.x : region.x, y: y ? client.y : region.y, width: x ? client.width : region.width, height: y ? client.height : region.height }
    region = clippedRegion(region, clipping)
    ancestors.push({ id: id(current), tag: current.tagName, bounds: client, overflowX: style.overflowX, overflowY: style.overflowY, scrollTop: current.scrollTop, scrollLeft: current.scrollLeft })
  }
  return { rect: rect(node), region, ancestors, fullyVisible: inside(rect(node), region) }
}
function focusables(root: ParentNode = document) {
  return [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')]
    .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible')
}
function describe(node: Element) {
  const h = node instanceof HTMLElement ? node : null
  return { id: id(node), tag: node.tagName, role: node.getAttribute('role'), ariaLabel: node.getAttribute('aria-label'),
    text: node.textContent?.trim().slice(0, 200) ?? '', tabIndex: h?.tabIndex, focusVisible: node.matches(':focus-visible'),
    order: focusables().indexOf(node as HTMLElement), disabled: node.matches(':disabled'), ...bounds(node) }
}
export function active() { return document.activeElement ? describe(document.activeElement) : null }
export function inspectFocused() {
  const node = document.activeElement
  if (!(node instanceof HTMLElement)) throw new Error('No active HTML control')
  const result = describe(node), style = getComputedStyle(node)
  const labels = 'labels' in node ? [...(node as HTMLInputElement).labels ?? []] : []
  const labelEvidence = labels.map((label) => ({ text: label.textContent?.trim(), ...bounds(label), paint: paintedText(label),
    inlineText: [...label.querySelectorAll('small,span')].filter((child) => child.textContent?.trim() && !child.classList.contains('visually-hidden'))
      .map((child) => ({ text: child.textContent?.trim(), ...bounds(child), paint: paintedText(child) })) }))
  const outlineLayers = styleLayers(node.parentElement), outline = { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), offset: style.outlineOffset,
    color: style.outlineColor, shadow: style.boxShadow, measured: contrast(style.outlineColor, outlineLayers), layers: outlineLayers,
    backdropScope: node.closest('.title-canvas-controls') ? 'computed DOM ancestors; canvas overlay requires retained screenshot review' : 'computed DOM ancestors' }
  return { ...result, labels: labelEvidence, paint: paintedText(node), outline, value: 'value' in node ? String(node.value) : null,
    inputType: node.getAttribute('type'), min: node.getAttribute('min'), max: node.getAttribute('max'), step: node.getAttribute('step') }
}
export function titleLayout() {
  const containers = [...document.querySelectorAll<HTMLElement>('.title-field-grid,.title-actions,.title-element-list,.title-template-list,.title-field')]
    .filter((node) => node.getClientRects().length > 0)
  return { containers: containers.map((node) => ({ tag: node.tagName, className: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth, bounds: rect(node) })),
    workspace: [...document.querySelectorAll<HTMLElement>('.toolbar,.area-timeline,#workspace-inspector-panel')].map((node) => ({ className: node.className, ...bounds(node), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })) }
}
export function modal() {
  const node = document.querySelector<HTMLDialogElement>('dialog[open]')
  if (!node) throw new Error('Missing open native title dialog')
  return { ...describe(node), modal: node.matches(':modal'), focusInside: !!document.activeElement && node.contains(document.activeElement),
    controls: focusables(node).map(describe), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
    clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }
}
export function statuses() {
  return [...document.querySelectorAll<HTMLElement>('.title-inspector [role="status"],dialog[open] [role="status"],dialog[open] [role="alert"]')]
    .map((node) => ({ text: node.textContent?.trim(), role: node.getAttribute('role'), ...bounds(node), paint: paintedText(node) }))
}
export function guides() {
  const canvas = document.querySelector('[data-testid="preview-canvas"]')
  if (!canvas) throw new Error('Missing live Program canvas')
  return { canvas: rect(canvas), guides: [0.9, 0.95].map((ratio) => {
    const node = document.querySelector(`[data-testid="title-safe-${ratio}"]`)
    if (!node) throw new Error('Missing safe guide')
    return { ratio, bounds: rect(node), ariaHidden: node.getAttribute('aria-hidden'), stroke: getComputedStyle(node).borderTopStyle }
  }) }
}
let observer: ReturnType<typeof createObserver> | null = null
function createObserver() {
  const events: Array<{ at: number; healthy: boolean; session: ReturnType<typeof snapshot>['session'] }> = [], issues: string[] = []
  const keys: Array<{ at: number; key: string; trusted: boolean; targetId: number | null; shift: boolean; control: boolean; meta: boolean; alt: boolean }> = []
  let dropped = 0, droppedKeys = 0, disposed = false
  const keydown = (event: KeyboardEvent) => {
    if (keys.length >= MAX_NATIVE_KEYS) { droppedKeys++; return }
    keys.push({ at: performance.now(), key: event.key, trusted: event.isTrusted, targetId: event.target instanceof Element ? id(event.target) : null,
      shift: event.shiftKey, control: event.ctrlKey, meta: event.metaKey, alt: event.altKey })
  }
  document.addEventListener('keydown', keydown, true)
  const record = () => {
    try {
      const session = snapshot().session
      const libraryError = useTitleTemplateStore.getState().error
      if (libraryError) issues.push(`Template library error: ${libraryError}`)
      if (events.length >= MAX_SESSION_EVENTS) { dropped++; return }
      events.push({ at: performance.now(), healthy: healthySession(session), session })
    } catch (cause) { issues.push(String(cause)) }
  }
  const stops = [useProjectSessionStore.subscribe(record), useTitleTemplateStore.subscribe(record), () => document.removeEventListener('keydown', keydown, true)]
  record()
  return { summary() { return { events, issues, dropped, keys, droppedKeys, disposed, subscriptions: stops.length } },
    check() { requireSessionLedger(events, dropped, issues) },
    dispose() { if (!disposed) { record(); for (const stop of stops.splice(0)) stop(); disposed = true } return this.summary() } }
}
export function observe() { if (observer) throw new Error('Observer already installed'); observer = createObserver(); return observer.summary() }
export function sessionEvidence(dispose = false) { if (!observer) throw new Error('Observer missing'); return dispose ? observer.dispose() : observer.summary() }
export function checkSession() { if (!observer) throw new Error('Observer missing'); observer.check() }
