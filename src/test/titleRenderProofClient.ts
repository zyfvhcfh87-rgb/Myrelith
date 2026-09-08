/** Browser proof coordinator. Production paths never import this module. */
import { animatedTitleProofProject, compareTitleProof, exportTitleProof, renderTitleProof, TEXT_FONT_FAMILIES, TITLE_PROOF_CASES, titleProofProject, upgradeProofProject, type TitleProofPixels } from './titleRenderProof'
import { RenderWorkerBridge, createRenderWorker } from '../engine/render-bridge'
import { createProjectVideoCompositionPlanner } from '../domain/projectVideoCompositionPlan'
import { resolvePresentationProfile, type PresentationResolvedQuality } from '../domain/presentationProfile'
import type { SequenceProject } from '../domain/projectSequences'
import type { compositeFrame } from '../pipeline/render'
import type { createVideoCompositionPlanner } from '../domain/videoCompositionPlan'
import { createMaskEffect } from '../domain/effectStack'
import { defaultSourceTimeMap } from '../domain/sourceTimeMap'
import { scalarKey } from './animationFoundationFixtures'
import { upgradeLegacyTextTitle } from '../domain/titleUpgrade'
import { readTitleDefinition } from '../domain/titleElements'
import { createProjectFileSnapshot, serializeProjectFile, parseProjectFile } from '../domain/projectFile'
import { titleProjectFromFile } from './titleFileBoundaryFixtures'

function proofWorker() {
  const worker = new Worker(new URL('./titleRenderProof.worker.ts', import.meta.url), { type: 'module' })
  let serial = 0
  const pending = new Map<number, { resolve(value: TitleProofPixels): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  worker.onmessage = (event: MessageEvent<{ id: number; result: TitleProofPixels; error?: string }>) => {
    const waiter = pending.get(event.data.id)
    if (!waiter) return
    pending.delete(event.data.id); clearTimeout(waiter.timer)
    if (event.data.error) waiter.reject(new Error(event.data.error))
    else waiter.resolve(event.data.result)
  }
  worker.onerror = (event) => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(event.message)) }; pending.clear() }
  return {
    render(project: SequenceProject, frame: number, quality: PresentationResolvedQuality): Promise<TitleProofPixels> {
      const id = ++serial
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Title proof worker timed out')) }, 30_000)
        pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, project, frame, quality })
      })
    },
    close() { worker.terminate(); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Title proof worker closed')) }; pending.clear() },
  }
}
const qualityModes: readonly PresentationResolvedQuality[] = ['full', 'half', 'quarter']
// Match the actual compositor host: Offscreen destination sRGB/default readback
// policy, reusable leg/group sRGB + willReadFrequently. HTML controls stay below.
const productionCanvas = { offscreen: true, canvasPolicy: 'production' } as const
const clean = (result: TitleProofPixels) => result.scratchCleared && result.requests === 0 && result.liveCanvases === 0 && result.peakCanvases <= 3
function matchesContexts(result: TitleProofPixels, production: boolean) {
  return result.contexts.length === result.peakCanvases && result.contexts.every((context, index) => {
    const frequent = !production || index > 0
    return context.kind === (production ? 'OffscreenCanvas' : 'HTMLCanvasElement')
      && context.role === ['destination', 'leg', 'group'][index]
      && context.width === result.width && context.height === result.height
      && context.requested.colorSpace === 'srgb'
      && context.requested.willReadFrequently === (frequent ? true : undefined)
      && context.actual?.colorSpace === 'srgb' && context.actual.willReadFrequently === frequent
  })
}


export async function proveTitleLegacyMatrix(baseline: { compositeFrame: typeof compositeFrame; createVideoCompositionPlanner: typeof createVideoCompositionPlanner }) {
  const worker = proofWorker(), rows = []
  try {
    for (const family of TEXT_FONT_FAMILIES) for (const proof of TITLE_PROOF_CASES) {
      const legacy = titleProofProject(family, proof), upgraded = upgradeProofProject(legacy), doc = legacy.sequences[0]
      const baselinePlan = baseline.createVideoCompositionPlanner(doc, new Map()).planFrame(0)
      for (const quality of qualityModes) {
        const original = await renderTitleProof(legacy, 0, quality, { compositor: baseline.compositeFrame, plan: baselinePlan })
        const current = await renderTitleProof(legacy, 0, quality), expanded = await renderTitleProof(upgraded, 0, quality)
        const productionOriginal = await renderTitleProof(legacy, 0, quality, { ...productionCanvas, compositor: baseline.compositeFrame, plan: baselinePlan })
        const productionCurrent = await renderTitleProof(legacy, 0, quality, productionCanvas)
        const productionExpanded = await renderTitleProof(upgraded, 0, quality, productionCanvas)
        const background = await worker.render(upgraded, 0, quality)
        const exported = quality === 'full' ? await exportTitleProof(upgraded, 'production') : null
        rows.push({ family, case: proof.name, quality, baseline: compareTitleProof(original, current), upgrade: compareTitleProof(current, expanded),
          productionBaseline: compareTitleProof(productionOriginal, productionCurrent), productionUpgrade: compareTitleProof(productionCurrent, productionExpanded),
          contextsMatch: [original, current, expanded].every((result) => matchesContexts(result, false))
            && [productionOriginal, productionCurrent, productionExpanded, background, ...(exported?.frames ?? [])].every((result) => matchesContexts(result, true)),
          worker: compareTitleProof(productionExpanded, background), export: exported ? compareTitleProof(productionExpanded, exported.frames[0]) : null,
          clean: [original, current, expanded, productionOriginal, productionCurrent, productionExpanded, background, ...(exported?.frames ?? [])].every(clean),
          exportClosed: exported ? exported.finalized && exported.leases === exported.closed : true })
      }
    }
    return rows
  } finally { worker.close() }
}

export async function proveTitleAnimationFrames() {
  const worker = proofWorker(), rows = []
  try {
    for (const easing of ['linear', 'hold', 'cubic-bezier'] as const) for (const nested of [false, true]) {
      const project = animatedTitleProofProject(easing, nested), exported = await exportTitleProof(project, 'production')
      for (const quality of qualityModes) {
        const sequential = []
        for (let frame = 0; frame < 13; frame++) sequential.push(await renderTitleProof(project, frame, quality, productionCanvas))
        for (const frame of [12, 0, 6, 2, 11, 1, 10, 5, 3, 9, 4, 8, 7]) {
          const seek = await renderTitleProof(project, frame, quality, productionCanvas), background = await worker.render(project, frame, quality)
          rows.push({ easing, nested, frame, quality, seek: compareTitleProof(sequential[frame], seek), worker: compareTitleProof(seek, background),
            export: quality === 'full' ? compareTitleProof(seek, exported.frames[frame]) : null,
            contextsMatch: [seek, background, exported.frames[frame]].every((result) => matchesContexts(result, true)),
            clean: [seek, background, exported.frames[frame]].every(clean), exportClosed: exported.finalized && exported.leases === 13 && exported.closed === 13 })
        }
      }
    }
    return rows
  } finally { worker.close() }
}

export async function proveLegacyMaskAnimation(baseline: { compositeFrame: typeof compositeFrame; createVideoCompositionPlanner: typeof createVideoCompositionPlanner }) {
  const rows = []
  for (const family of TEXT_FONT_FAMILIES) {
    const project = titleProofProject(family, { name: 'legacy-animated-mask', text: { backgroundEnabled: true, backgroundColor: '#663399' } })
    const doc = project.sequences[0], clip = doc.tracks[0].clips[0]
    clip.sourceRange = { startFrame: 0, durationFrames: 13 }; clip.sourceTimeMap = defaultSourceTimeMap(0, 13); clip.timelineRange.durationFrames = 13
    clip.effects = [createMaskEffect('mask', 'rectangle')]
    clip.animation = { tracks: [], effectTracks: [{ effectId: 'mask', parameter: 'x', keyframes: [scalarKey(0, 0.1), scalarKey(12, 0.9)] }] }
    const before = JSON.stringify(project), upgrade = upgradeLegacyTextTitle(project, doc.id, clip.id, () => 'refused-element')
    if (upgrade.ok) throw new Error('Active legacy mask unexpectedly upgraded')
    for (const quality of qualityModes) for (const frame of [0, 6, 12]) {
      const original = await renderTitleProof(project, frame, quality, { compositor: baseline.compositeFrame, plan: baseline.createVideoCompositionPlanner(doc, new Map()).planFrame(frame) })
      const current = await renderTitleProof(project, frame, quality)
      rows.push({ family, quality, frame, baseline: compareTitleProof(original, current), preserved: JSON.stringify(project) === before, reason: upgrade.reason })
    }
  }
  return rows
}

export async function proveTitleFallbackParity() {
  const worker = proofWorker(), rows = []
  try {
    for (const family of TEXT_FONT_FAMILIES) {
      const legacy = titleProofProject(family, { name: 'explicit-fallback', text: { content: 'a\u0301 👩🏽‍💻 שלום\n日本語 中文 हिन्दी' } }), project = upgradeProofProject(legacy)
      const clip = project.sequences[0].tracks[0].clips[0], parsed = readTitleDefinition(clip.title)
      if (parsed.status !== 'supported') throw new Error('Expected title')
      clip.title = { version: 1, elements: parsed.title.elements.map((element) => ({ ...element, font: { family: 'Missing Title Font', fallbackFamily: family } })) }
      const wire = serializeProjectFile(createProjectFileSnapshot(project, [], [])), reopened = titleProjectFromFile(parseProjectFile(wire))
      for (const quality of qualityModes) {
        const original = await renderTitleProof(legacy, 0, quality, productionCanvas), restored = await renderTitleProof(reopened, 0, quality, productionCanvas), background = await worker.render(reopened, 0, quality)
        const exported = quality === 'full' ? await exportTitleProof(reopened, 'production') : null
        rows.push({ family, quality, retainedIntent: wire.includes('Missing Title Font'), fallback: compareTitleProof(original, restored), worker: compareTitleProof(restored, background),
          export: exported ? compareTitleProof(restored, exported.frames[0]) : null,
          contextsMatch: [original, restored, background, ...(exported?.frames ?? [])].every((result) => matchesContexts(result, true)), clean: [original, restored, background, ...(exported?.frames ?? [])].every(clean) })
      }
    }
    return rows
  } finally { worker.close() }
}

/** Real production bridge + worker lifecycle, observed through its transferred
 * presentation canvas. Line recordings belong to the independent worker proof.
 */
export async function proveProductionTitleWorker() {
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 })
  canvas.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px'
  document.body.append(canvas)
  const worker = createRenderWorker(), bridge = new RenderWorkerBridge(worker)
  const failures: string[] = [], rows = []
  bridge.onWorkerError = (message) => failures.push(message)
  bridge.init(canvas.transferControlToOffscreen())
  try {
    for (const nested of [false, true]) {
      const project = animatedTitleProofProject('cubic-bezier', nested), doc = project.sequences[0]
      const planner = createProjectVideoCompositionPlanner(project, doc.id, new Map())
      bridge.setDoc(doc)
      for (const quality of qualityModes) {
        const profile = resolvePresentationProfile(doc, { qualityMode: quality, reason: 'paused', viewport: null })
        bridge.setPresentationProfile(profile)
        for (const frame of [0, 12, 5]) {
          const result = await bridge.renderFrame(planner.planFrame(frame), 'seek')
          if (result.status !== 'drawn' || result.missingClipIds.length) throw new Error(JSON.stringify(result))
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          const capture = new OffscreenCanvas(profile.outputWidth, profile.outputHeight), ctx = capture.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!
          try {
            ctx.drawImage(canvas, 0, 0)
            const expected = await renderTitleProof(project, frame, quality, productionCanvas)
            const { differingBytes, maximumDelta } = compareTitleProof(expected, { ...expected, rgba: ctx.getImageData(0, 0, capture.width, capture.height).data })
            rows.push({ nested, frame, quality, differingBytes, maximumDelta, referenceContextsMatch: matchesContexts(expected, true) })
          } finally { capture.width = capture.height = 0 }
        }
      }
    }
    return { rows, failures }
  } finally { await bridge.dispose(); canvas.remove() }
}
