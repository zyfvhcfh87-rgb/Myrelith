import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test('production nested buses match explicit child composition with captions, adjustments, masks and lens correction', async ({ page }, info) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const a = '/src/test/clipAttributeFixtures.ts', settings = '/src/domain/projectSettings.ts', planner = '/src/domain/projectVideoCompositionPlan.ts'
    const r = '/src/pipeline/render.ts', e = '/src/domain/effectStack.ts', p = '/src/domain/effectPixels.ts'
    const lensPath = '/src/pipeline/lensRemapWebgl.ts', modelPath = '/src/domain/lensCorrection.ts'
    const { attributeClip } = await import(a), { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } = await import(settings)
    const { createProjectVideoCompositionPlanner } = await import(planner), { compositeFrame } = await import(r)
    const { createColorAdjustEffect, createMaskEffect, resolvePostCompositeEffectStack } = await import(e), { applyOrderedPixelEffectsToRgba } = await import(p)
    const { WebGl2LensRemapBackend, createDocumentLensRemapProvider } = await import(lensPath), { DEFAULT_MANUAL_LENS_CORRECTION } = await import(modelPath)
    const width = 160, height = 90, surfaces: OffscreenCanvas[] = [], images = new Map<string, ImageBitmap>()
    let backend: InstanceType<typeof WebGl2LensRemapBackend> | null = null, lensUnavailable: string | null = null
    const surface = () => { const canvas = new OffscreenCanvas(width, height); surfaces.push(canvas); return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! } }
    const effect = (id: string, type: string, params: Record<string, number>) => ({ id, type: `builtin.${type}`, version: 1, enabled: true, params })
    const color = (id: string, exposure: number) => { const effect = createColorAdjustEffect(id); effect.params.exposure = exposure; return effect }
    const clip = (id: string, assetId: string) => ({ ...attributeClip(id), assetId })
    const track = (id: string, clips: unknown[] = []) => ({ id, kind: 'video', name: id, clips, transitions: [], sequenceInstances: [], multicamInstances: [], adjustments: [], hidden: false, muted: false, solo: false, locked: false })
    const sequence = (id: string) => ({ ...structuredClone(createTimelineDoc(id, DEFAULT_PROJECT_SETTINGS, id)), width, height, tracks: [], captionTracks: [], masterVideoEffects: [] })
    const caption = (id: string, text: string) => ({ id, name: id, language: 'en', role: 'subtitles', stylePreset: 'minimal', hidden: false, items: [{ id: `${id}-cue`, range: { startFrame: 0, durationFrames: 60 }, text }] })
    const post = (target: ReturnType<typeof surface>, effects: unknown[]) => {
      const data = target.ctx.getImageData(0, 0, width, height)
      applyOrderedPixelEffectsToRgba(data.data, resolvePostCompositeEffectStack(effects, true).pixelEffects, { surfaceWidth: width, surfaceHeight: height, projectWidth: width, projectHeight: height })
      target.ctx.putImageData(data, 0, 0)
    }
    const catalog = new Map(['plate', 'red', 'blue', 'overlay', 'child-picture'].map((id) => [id, { video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1_000_000_000 }, audio: null }]))
    let lensProvider: ReturnType<typeof createDocumentLensRemapProvider> = null
    const render = async (documents: Array<{ id: string }>, root: string) => {
      const doc = documents.find((doc) => doc.id === root)
      const project = { id: 'proof', name: 'Proof', rootSequenceId: root, sequences: documents, multicams: [] }
      const output = surface(), leg = surface(), group = surface()
      const plan = createProjectVideoCompositionPlanner(project, root, catalog).planFrame(2)
      await compositeFrame(doc, plan, output.ctx, { getFrame: async (id: string) => images.get(id) ?? null }, { get: () => ({ leg, group }) }, undefined, lensProvider)
      return { output, plan, leg, group }
    }
    try {
      for (const [id, fill] of [['plate', '#286048'], ['red', '#f03020'], ['blue', '#2040e0'], ['overlay', '#a0b080']]) {
        const source = surface(); source.ctx.fillStyle = fill; source.ctx.fillRect(0, 0, width, height)
        source.ctx.fillStyle = '#ffffff80'; source.ctx.fillRect(width / 3, height / 5, width / 4, height / 2)
        images.set(id, await createImageBitmap(source.canvas))
      }
      const child = sequence('child'), from = clip('from', 'red'), to = clip('to', 'blue')
      from.timelineRange = { startFrame: 0, durationFrames: 2 }; from.opacity = 0.6; from.blendMode = 'multiply'
      to.timelineRange = { startFrame: 2, durationFrames: 58 }; to.opacity = 0.4; to.blendMode = 'multiply'
      const fade = { ...track('child-fade', [from, to]), transitions: [{ id: 'fade', type: 'crossfade', fromClipId: from.id, toClipId: to.id, durationFrames: 1, audio: { enabled: false, curve: 'equal-power' } }], videoEffects: [color('child-track', 0.7)] }
      child.tracks = [track('child-lower', [clip('child-base', 'plate')]), fade, { ...track('adjustment'), adjustments: [{ kind: 'adjustment', id: 'adjustment', name: 'Adjustment', timelineRange: { startFrame: 0, durationFrames: 60 }, enabled: true, opacity: 0.3, animation: { tracks: [], effectTracks: [] }, effects: [color('adjustment-color', -0.4)] }], videoEffects: [color('must-not-run-on-adjustment', 2)] }]
      child.captionTracks = [caption('child-captions', 'Child')]
      child.masterVideoEffects = [effect('child-master', 'vignette', { strength: 0.6, radius: 0.2, softness: 0.8 })]
      const root = sequence('root'), overlay = clip('overlay-clip', 'overlay')
      overlay.opacity = 0.35; overlay.blendMode = 'screen'; overlay.transform.rotation = 7
      overlay.visual.crop = { left: 0.05, right: 0.1, top: 0.1, bottom: 0 }
      const mask = createMaskEffect('overlay-mask', 'ellipse'); mask.params.width = 0.7; mask.params.feather = 0.08
      overlay.effects = [mask]
      overlay.lensCorrection = { ...DEFAULT_MANUAL_LENS_CORRECTION, k1: 0.03 }
      const parentTrack = { ...track('parent-child'), sequenceInstances: [{ kind: 'sequence', id: 'child-use', name: 'Child', sequenceId: 'child', sourceStartFrame: 0, timelineRange: { startFrame: 0, durationFrames: 60 } }], videoEffects: [effect('parent-track-blur', 'box-blur', { radius: 2 })] }
      root.tracks = [track('root-lower', [clip('root-base', 'blue')]), parentTrack, { ...track('root-overlay', [overlay]), videoEffects: [color('overlay-track', -0.3)] }]
      root.captionTracks = [caption('root-captions', 'Parent')]; root.masterVideoEffects = [color('root-master', -0.4)]
      try { backend = new WebGl2LensRemapBackend() } catch (error) { lensUnavailable = String(error) }
      lensProvider = createDocumentLensRemapProvider(root, backend, width, height, false)
      if (lensUnavailable) {
        let error = ''
        try { await render([root, child], 'root') } catch (cause) { error = String(cause) }
        return { lensUnavailable, lensRejected: /lens|WebGL2/i.test(error), maxDifference: null }
      }
      const actual = await render([root, child], 'root')
      const childReference = { ...child, masterVideoEffects: [] }
      const isolated = await render([childReference], 'child')
      post(isolated.output, child.masterVideoEffects); post(isolated.output, parentTrack.videoEffects)
      images.set('child-picture', await createImageBitmap(isolated.output.canvas))
      const rootReference = { ...root, masterVideoEffects: [], tracks: [root.tracks[0], track('explicit-child', [clip('explicit-child', 'child-picture')]), root.tracks[2]] }
      const reference = await render([rootReference], 'root')
      post(reference.output, root.masterVideoEffects)
      const actualPixels = actual.output.ctx.getImageData(0, 0, width, height).data, referencePixels = reference.output.ctx.getImageData(0, 0, width, height).data
      let maxDifference = 0
      for (let i = 0; i < actualPixels.length; i++) maxDifference = Math.max(maxDifference, Math.abs(actualPixels[i] - referencePixels[i]))
      // Fail-closed bus readback errors still release borrowed transition pixels.
      const failedOutput = surface(), failedLeg = surface(), failedGroup = surface()
      const get = failedGroup.ctx.getImageData.bind(failedGroup.ctx)
      failedGroup.ctx.getImageData = () => { throw new Error('injected bus readback failure') }
      let failure = ''
      const simple = sequence('failure'); simple.tracks = [{ ...track('failing-track', [clip('failing', 'plate')]), videoEffects: [color('failing-bus', 1)] }]
      const plan = createProjectVideoCompositionPlanner({ id: 'failure', rootSequenceId: simple.id, sequences: [simple] }, simple.id, catalog).planFrame(2)
      try { await compositeFrame(simple, plan, failedOutput.ctx, { getFrame: async () => images.get('plate') }, { get: () => ({ leg: failedLeg, group: failedGroup }) }) }
      catch (cause) { failure = String(cause) }
      failedGroup.ctx.getImageData = get
      const cleared = [...get(0, 0, width, height).data].every((byte) => byte === 0)
      return { lensUnavailable, maxDifference, failure, cleared, scopes: actual.plan.items.filter((item: { kind: string }) => item.kind === 'video-bus') }
    } finally {
      backend?.dispose()
      images.forEach((image) => image.close()); images.clear()
      for (const canvas of surfaces) canvas.width = canvas.height = 0
    }
  })
  if (result.lensUnavailable) expect(result.lensRejected).toBe(true)
  else { expect(result.maxDifference).toBeLessThanOrEqual(2); expect(result.failure).toContain('Video-bus pixel processing failed'); expect(result.cleared).toBe(true) }
  const evidencePath = info.outputPath('nested-bus-lens-mask-compositor.json')
  await writeFile(evidencePath, JSON.stringify(result, null, 2))
  await info.attach('nested-bus-lens-mask-compositor', { path: evidencePath, contentType: 'application/json' })
})
