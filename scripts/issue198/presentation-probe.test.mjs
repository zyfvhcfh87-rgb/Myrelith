import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

// Exercise the actual browser observer. Replace only its module/browser hosts;
// keep its context comparison, timestamps, subscriptions and readiness logic.
const source = fs.readFileSync(new URL('../../tests/browser/issue-198-presentation-fixture.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
assert.equal((compiled.match(/^import .* from ['"]@playwright\/test['"];?$/gm) ?? []).length, 1)
const observerSource = compiled.replace(/^import .* from ['"]@playwright\/test['"];?\n/m, '')
  .replace(/^export /gm, '').replace(/\bimport\(/g, 'modules(')

function store(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    update: (patch) => { const before = state; state = { ...state, ...patch }; for (const listener of listeners) listener(state, before) },
    subscriberCount: () => listeners.size,
  }
}

async function harness(t) {
  let now = 0, canvas = null
  const listeners = new Set(), nativeEvents = new Map()
  const document = store({ projectGeneration: 1, doc: {} })
  const transport = store({ effectDocumentPreview: null, playheadFrame: 0, selectedClipIds: [] })
  const media = store({ assets: new Map(), descriptors: new Map() })
  const window = { document: {
    querySelector: () => canvas,
    addEventListener: (name, callback) => nativeEvents.set(name, callback),
    removeEventListener: (name) => nativeEvents.delete(name),
  } }
  const modules = async (path) => {
    if (path.endsWith('/previewController.ts')) return { subscribePreviewRenderDiagnostics: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } }
    if (path.endsWith('/documentStore.ts')) return { useDocumentStore: document }
    if (path.endsWith('/transportStore.ts')) return { useTransportStore: transport }
    if (path.endsWith('/mediaStore.ts')) return { useMediaStore: media }
    throw new Error(path)
  }
  const observe = vm.runInNewContext(`${observerSource}\nobservePresentations`, { window, performance: { now: () => now }, modules })
  await observe({ evaluate: (fn) => fn() })
  const probe = window.__issue198Presentation
  t.after(() => {
    probe.dispose()
    assert.equal(listeners.size, 0)
    assert.equal(nativeEvents.size, 0)
    for (const state of [document, transport, media]) assert.equal(state.subscriberCount(), 0)
  })
  const emit = (event) => { for (const listener of listeners) listener(event) }
  const event = { frame: 0, requestedAt: 12, presentedAt: 20,
    result: { status: 'drawn', drawnClipIds: [], missingClipIds: ['mask-tracking-source'] } }
  probe.arm(0, false, false, 'click')
  now = 5; nativeEvents.get('click')()
  now = 10; document.update({ projectGeneration: 2, doc: {} })
  now = 11; canvas = { width: 640, height: 360 }
  return { probe, document, transport, media, event, emit,
    at: (time) => { now = time },
    replaceCanvas: () => { canvas = { width: 640, height: 360 } },
    resizeCanvas: () => { canvas.width = 1280 },
    present: () => { now = 20; emit(event) },
  }
}

test('a fresh offline presentation qualifies after canvas mount', async (t) => {
  const h = await harness(t); h.present(); assert.equal(h.probe.ready(), true)
})

for (const ordering of ['before', 'after']) {
  test(`unrelated store notification ${ordering} presentation cannot misdate the canvas mount`, async (t) => {
    const h = await harness(t)
    if (ordering === 'after') { h.present(); assert.equal(h.probe.ready(), true) }
    h.at(ordering === 'before' ? 15 : 25)
    h.transport.update({ selectedClipIds: ['unrelated-selection'] })
    if (ordering === 'before') h.present()
    assert.equal(h.probe.ready(), true)
  })
}

for (const field of ['document', 'project-generation', 'preview-document', 'assets', 'descriptors', 'frame']) {
  test(`a real late ${field} change rejects an older request even when its callback arrives later`, async (t) => {
    const h = await harness(t); h.at(15)
    if (field === 'document') h.document.update({ doc: {} })
    if (field === 'project-generation') h.document.update({ projectGeneration: 3 })
    if (field === 'preview-document') h.transport.update({ effectDocumentPreview: { document: {} } })
    if (field === 'assets') h.media.update({ assets: new Map() })
    if (field === 'descriptors') h.media.update({ descriptors: new Map() })
    if (field === 'frame') h.transport.update({ playheadFrame: 1 })
    h.present(); assert.equal(h.probe.ready(), false)
  })
}

for (const change of ['identity', 'dimensions']) {
  test(`a canvas ${change} change after publication refuses the earlier presentation`, async (t) => {
    const h = await harness(t); h.present(); assert.equal(h.probe.ready(), true)
    if (change === 'identity') h.replaceCanvas(); else h.resizeCanvas()
    assert.equal(h.probe.ready(), false)
  })
}

test('fresh actions cannot reuse an earlier presentation', async (t) => {
  const h = await harness(t); h.present(); h.at(25)
  h.probe.arm(0, false, false); h.probe.mark()
  assert.equal(h.probe.ready(), false)
})

test('same-frame no-op reuses a qualified presentation only while its context remains current', async (t) => {
  const h = await harness(t); h.present(); h.at(25)
  h.probe.arm(0, false, true); h.probe.mark(); assert.equal(h.probe.ready(), true)
  h.document.update({ doc: {} }); assert.equal(h.probe.ready(), false)
})

test('connected waits refuse offline and unrelated source results', async (t) => {
  const h = await harness(t)
  h.probe.arm(0, true, false); h.probe.mark(); h.present()
  assert.equal(h.probe.ready(), false)
  h.emit({ ...h.event, result: { status: 'drawn', drawnClipIds: ['other'], missingClipIds: [] } })
  assert.equal(h.probe.ready(), false)
  h.emit({ ...h.event, result: { status: 'drawn', drawnClipIds: ['mask-tracking-source'], missingClipIds: [] } })
  assert.equal(h.probe.ready(), true)
})

test('wrong-frame and render-error results cannot qualify', async (t) => {
  const h = await harness(t); h.at(20)
  h.emit({ ...h.event, frame: 1 }); assert.equal(h.probe.ready(), false)
  h.emit({ ...h.event, result: { ...h.event.result, status: 'error' } }); assert.equal(h.probe.ready(), false)
})
