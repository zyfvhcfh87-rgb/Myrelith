import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

test('measure spatial effects against the preregistered pixel and stack ceilings', async ({ page, browser }, info) => {
  test.setTimeout(240_000)
  const sourceSha256 = Object.fromEntries(await Promise.all([
    'src/domain/spatialEffectPixels.ts', 'src/domain/spatialEffectDefinitions.ts',
    'src/domain/effectPixels.ts', 'src/pipeline/videoEffectStageExecution.ts',
    'tests/browser/issue-197-pixel-candidates.spec.ts',
  ].map(async (path) => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const pixelPath = '/src/domain/effectPixels.ts', definitionPath = '/src/domain/spatialEffectDefinitions.ts'
    const stagePath = '/src/pipeline/videoEffectStageExecution.ts'
    const { applyOrderedPixelEffectsToRgba } = await import(pixelPath)
    const { spatialEffectParams } = await import(definitionPath)
    const { applyVideoEffectStagePlanToRgba } = await import(stagePath)
    const candidates = [
      { kind: 'box-blur', representative: { radius: 8 }, maximum: { radius: 32 } },
      { kind: 'sharpen', representative: { amount: 0.5 }, maximum: { amount: 2 } },
      { kind: 'vignette', representative: { strength: 0.5, radius: 0.5, softness: 0.5 }, maximum: { strength: 1, radius: 0, softness: 0.01 } },
      { kind: 'drop-shadow', representative: { radius: 8, offsetX: 8, offsetY: 8, opacity: 0.5 }, maximum: { radius: 32, offsetX: 64, offsetY: 64, opacity: 1 } },
      { kind: 'outline', representative: { width: 4, opacity: 0.5 }, maximum: { width: 32, opacity: 1 } },
    ]
    const rows: unknown[] = []
    for (const [width, height, ceiling] of [[1280, 720, 40], [1920, 1080, 90], [3840, 2160, 360]]) {
      const geometry = { surfaceWidth: width, surfaceHeight: height, projectWidth: width, projectHeight: height }
      const fixture = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? [0, 64, 128, 255][Math.floor(i / 4) % 4] : i * 71 % 256)
      for (const candidate of candidates) for (const setting of ['representative', 'maximum'] as const) {
        const effect = { kind: candidate.kind, params: spatialEffectParams(candidate.kind, candidate[setting]) }
        const samples: number[] = []
        const work = { maskScanlineEdgeTests: 0, maskDistanceSamples: 0, spatialScratchBytesPeak: 0, spatialPixelVisits: 0 }
        for (let i = -2; i < 10; i++) {
          const rgba = fixture.slice(), begin = performance.now()
          applyOrderedPixelEffectsToRgba(rgba, [effect], geometry, work)
          const elapsed = performance.now() - begin
          if (i >= 0) samples.push(elapsed)
        }
        const ordered = [...samples].sort((a, b) => a - b), p95 = ordered[Math.ceil(samples.length * 0.95) - 1]
        rows.push({ width, height, candidate: candidate.kind, setting, parameters: effect.params, samplesMs: samples, p95Ms: p95, ceilingMs: ceiling,
          scratchBytesPeak: work.spatialScratchBytesPeak, scratchCeilingBytes: 1024 * 1024, passed: p95 <= ceiling && work.spatialScratchBytesPeak <= 1024 * 1024 })
      }
      const maxEffects = candidates.map((entry) => ({ kind: entry.kind, params: spatialEffectParams(entry.kind, entry.maximum) }))
      for (const kind of ['eight-blurs', 'mixed-echo-stages']) {
        const effects = kind === 'eight-blurs' ? Array.from({ length: 8 }, () => maxEffects[0]) : maxEffects
        const samples: number[] = []
        const stages = effects.map((pixelEffect, i) => ({ kind: 'builtin', effect: { id: `effect-${i}` }, status: 'ready', pixelEffect }))
        if (kind === 'mixed-echo-stages') for (const at of [1, 3, 5]) stages.splice(at, 0, { kind: 'plugin', effect: { id: `echo-${at}` }, status: 'ready', execution: { benchmark: true } } as never)
        const context = { ...geometry, timelineFrame: 0, frameRate: { num: 30, den: 1 } }
        const executor = { applyPluginEffect: async (request: { rgba: Uint8Array }) => ({ status: 'applied', rgba: new Uint8Array(request.rgba) }) }
        for (let i = -2; i < 10; i++) {
          const rgba = fixture.slice(), begin = performance.now()
          if (kind === 'eight-blurs') applyOrderedPixelEffectsToRgba(rgba, effects, geometry)
          else await applyVideoEffectStagePlanToRgba(rgba, { requiresOrderedPixelPath: true, stages }, executor, context)
          const elapsed = performance.now() - begin
          if (i >= 0) samples.push(elapsed)
        }
        const p95 = [...samples].sort((a, b) => a - b)[9]
        rows.push({ width, height, candidate: kind, samplesMs: samples, p95Ms: p95, ceilingMs: ceiling * 8,
          passed: p95 <= ceiling * 8, note: kind === 'mixed-echo-stages' ? 'Three byte-echo stand-ins exercise shared stage copies, not installed plugin acceptance. Caller plus transactional working/input/output = four RGBA buffers; canvases and plugin runtime excluded.' : 'Eight sequential maximum-radius blur stages; scratch is reused in lifetime, not multiplied by stack length.' })
      }
    }
    return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, rows }
  })
  const evidence = info.outputPath('pixel-candidate-measurements.json')
  await writeFile(evidence, JSON.stringify({ recordedAt: new Date().toISOString(), sourceSha256, chromium: browser.version(), nodePlatform: process.platform, nodeArch: process.arch, ...result }, null, 2) + '\n')
  await info.attach('pixel-candidate-measurements', { path: evidence, contentType: 'application/json' })
  expect((result.rows as { passed: boolean }[]).filter((row) => !row.passed), 'Keep failed results; do not raise preregistered ceilings.').toEqual([])
})
