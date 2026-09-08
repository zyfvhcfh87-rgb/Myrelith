import { expect, test } from '@playwright/test'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { arch, cpus, platform, release } from 'node:os'

test('bounded CPU grading timing matrix includes real task yields, 4K work and delivered cancellation', async ({ page, browser }) => {
  test.setTimeout(300_000)
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) problems.push(message.text()) })
  await page.goto('/')
  const proof = await page.evaluate(async () => {
    const runtimePath = '/src/pipeline/colorGradingRuntime.ts', lutPath = '/src/domain/colorLut.ts'
    const curvesPath = '/src/domain/colorCurves.ts', wheelsPath = '/src/domain/colorWheels.ts'
    const { ColorGradingRuntime, ColorGradingCancelledError } = await import(runtimePath)
    const { portableColorLut } = await import(lutPath)
    const { DEFAULT_COLOR_CURVES } = await import(curvesPath)
    const { DEFAULT_COLOR_WHEELS } = await import(wheelsPath)
    const samples = (kind: '1d' | '3d', size: number) => {
      const values = new Float64Array((kind === '1d' ? size : size ** 3) * 3)
      for (let i = 0; i < values.length; i += 3) {
        const row = i / 3, r = row % size / (size - 1)
        const g = kind === '1d' ? r : Math.floor(row / size) % size / (size - 1)
        const b = kind === '1d' ? r : Math.floor(row / size ** 2) / (size - 1)
        values[i] = 0.1 + 0.8 * g + 0.05 * b
        values[i + 1] = 0.9 * r + 0.06 * b
        values[i + 2] = 0.05 + 0.75 * b + 0.1 * r * g
      }
      return values
    }
    const catalog = [['1d', 2], ['1d', 4096], ['3d', 2], ['3d', 17], ['3d', 33]].map(([kind, size]) => portableColorLut(`${kind}-${size}`, `${kind}-${size}`, {
      kind, size, title: '', domainMin: [0, 0, 0], domainMax: [1, 1, 1], samples: samples(kind as '1d' | '3d', size as number),
    }))
    const curve = { kind: 'rgb-curves', params: { ...DEFAULT_COLOR_CURVES, master: JSON.stringify(Array.from({ length: 16 }, (_, i) => [i / 15, i % 2 ? 0.9 : 0.1])), strength: 0.8 } }
    const wheel = { kind: 'lift-gamma-gain', params: { ...DEFAULT_COLOR_WHEELS, liftR: -0.2, liftB: 0.3, gammaR: 0.25, gammaG: 4, gainR: 4, gainB: 0.4 } }
    const candidates = [...catalog.map((entry: { id: string }) => ({ name: entry.id, effect: { kind: 'cube-lut', params: { lutId: entry.id, strength: 0.75 } } })), { name: 'curves-16', effect: curve }, { name: 'wheels', effect: wheel }]
    const runtime = new ColorGradingRuntime()
    const coldAt = performance.now(); runtime.setCatalog(catalog)
    const coldCatalogMs = performance.now() - coldAt
    const rows: { size: string; kind: string; stages: number; samplesMs: number[]; p95: number; ceiling: number; passed: boolean }[] = []
    let cancellation: { latencyMs: number; cancelled: boolean } | null = null
    try {
      for (const [width, height, ceiling] of [[1280, 720, 40], [1920, 1080, 90], [3840, 2160, 360]]) {
        const source = new Uint8ClampedArray(width * height * 4), pixels = new Uint8ClampedArray(source.length)
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          source[i] = x % 256; source[i + 1] = y % 256; source[i + 2] = (x * 13 + y * 71) % 256
          source[i + 3] = x < 4 || y < 4 ? 0 : x % 7 ? 255 : 128
        }
        const geometry = { surfaceWidth: width, surfaceHeight: height, projectWidth: width, projectHeight: height }
        for (const candidate of candidates) for (const count of [1, 8]) {
          const effects = Array(count).fill(candidate.effect), measured: number[] = []
          for (let sample = 0; sample < 12; sample++) {
            pixels.set(source)
            const start = performance.now(); await runtime.apply(pixels, effects, geometry)
            if (sample >= 2) measured.push(performance.now() - start)
          }
          const p95 = [...measured].sort((a, b) => a - b)[Math.ceil(measured.length * 0.95) - 1]
          rows.push({ size: `${width}x${height}`, kind: candidate.name, stages: count, samplesMs: measured, p95, ceiling: ceiling * count, passed: p95 <= ceiling * count })
        }
        const mixed = [candidates[4].effect, curve, wheel, candidates[1].effect, wheel, curve, candidates[2].effect, candidates[4].effect]
        const measured: number[] = []
        for (let sample = 0; sample < 12; sample++) {
          pixels.set(source); const start = performance.now(); await runtime.apply(pixels, mixed, geometry)
          if (sample >= 2) measured.push(performance.now() - start)
        }
        const p95 = [...measured].sort((a, b) => a - b)[9]
        rows.push({ size: `${width}x${height}`, kind: 'mixed', stages: 8, samplesMs: measured, p95, ceiling: ceiling * 8, passed: p95 <= ceiling * 8 })
        if (width === 3840) {
          let cancelled = false, requestedAt = 0, observed = false
          const timer = setTimeout(() => { requestedAt = performance.now(); cancelled = true }, 10)
          try { await runtime.apply(pixels, mixed, geometry, () => { if (cancelled) throw new ColorGradingCancelledError() }) }
          catch (cause) { if (!(cause instanceof ColorGradingCancelledError)) throw cause; observed = true }
          clearTimeout(timer)
          cancellation = { latencyMs: performance.now() - requestedAt, cancelled: observed && requestedAt > 0 }
        }
      }
    } finally { runtime.dispose() }
    return { rows, coldCatalogMs, cancellation, finalLedger: runtime.ledger(), userAgent: navigator.userAgent }
  })
  const sources = Object.fromEntries(await Promise.all([
    'src/pipeline/colorGradingRuntime.ts', 'src/domain/colorLut.ts', 'src/domain/colorCurves.ts', 'src/domain/colorWheels.ts', 'src/domain/colorGradingEffects.ts',
  ].map(async (path) => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  await writeFile('/tmp/myrelith-196-grading-proof.json', JSON.stringify({ ...proof, sources, browser: browser.version(), host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model }, problems }, null, 2))
  expect(proof.rows.filter((row) => !row.passed), 'See /tmp/myrelith-196-grading-proof.json for all measured samples').toEqual([])
  expect(proof.cancellation).toMatchObject({ cancelled: true })
  expect(proof.cancellation!.latencyMs).toBeLessThanOrEqual(250)
  expect(proof.finalLedger).toMatchObject({ bytes: 0, entries: 0, active: false, ports: 0, pendingTasks: 0 })
  expect(problems).toEqual([])
})
