import { expect, test } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { diagnosticFixtures } from './fixtures'
import type { DiagnosticSample } from './sample'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

test('diagnose frozen title pixels by canvas kind, realm, renderer and context policy', async ({ page, browser }, info) => {
  test.setTimeout(240_000)
  const fixtures = diagnosticFixtures()
  const pins = JSON.parse(await readFile('docs/evidence/issue200/canvas-diagnostic-fixture-pins.json', 'utf8'))
  expect(fixtures.map(({ id, legacy, expanded }) => ({ id, legacy: hash(JSON.stringify(legacy)), expanded: hash(JSON.stringify(expanded)) }))).toEqual(pins.fixtures)
  const warnings: string[] = [], errors: string[] = [], pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text())
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const samples = info.outputPath('samples'); await mkdir(samples, { recursive: true })
  await writeFile(info.outputPath('fixtures.json'), JSON.stringify(fixtures, null, 2))
  let sampleCount = 0
  await page.exposeFunction('persistTitleCanvasDiagnostic', async (id: string, sample: Omit<DiagnosticSample, 'pixels'> & { pixels: Omit<DiagnosticSample['pixels'], 'rgba'>; rgbaBase64: string }) => {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid diagnostic sample ID')
    const { rgbaBase64, ...metadata } = sample, rgba = Buffer.from(rgbaBase64, 'base64')
    expect(rgba.length, id).toBe(metadata.pixels.width * metadata.pixels.height * 4)
    const fixturePin = pins.fixtures.find((pin: { id: string }) => id.startsWith(`${pin.id}-`))
    expect(fixturePin, id).toBeDefined()
    expect(metadata.fixtureSha256, id).toBe(id.includes('-expanded-') || id.includes('-export-') ? fixturePin.expanded : fixturePin.legacy)
    // wx preserves partial evidence if a sample ID ever repeats unexpectedly.
    await writeFile(join(samples, `${id}.rgba.gz`), gzipSync(rgba), { flag: 'wx' })
    await writeFile(join(samples, `${id}.json`), JSON.stringify({ ...metadata, rgbaSha256: hash(rgba), rgbaBytes: rgba.length }, null, 2), { flag: 'wx' })
    sampleCount++
  })
  await page.goto('/')
  let result: unknown
  try {
    result = await page.evaluate(async (fixturesJson) => {
      const fixtures = JSON.parse(fixturesJson) as ReturnType<typeof diagnosticFixtures>
      const clientPath = '/tests/diagnostics/issue200/client.ts'
      const { diagnosticSample, openDiagnosticWorker } = await import(clientPath) as typeof import('./client')
      const proofPath = '/src/test/titleRenderProof.ts'
      const { compareTitleProof } = await import(proofPath) as typeof import('../../../src/test/titleRenderProof')
      const worker = openDiagnosticWorker()
      const comparisons: { id: string; scope: string; differingBytes: number; maximumDelta: number; sameLines: boolean }[] = []
      let completedSamples = 0, disposalAcknowledged = false
      const persist = (globalThis as unknown as { persistTitleCanvasDiagnostic(id: string, sample: unknown): Promise<void> }).persistTitleCanvasDiagnostic
      function compare(id: string, scope: string, a: DiagnosticSample, b: DiagnosticSample) {
        const value = { id, scope, ...compareTitleProof(a.pixels, b.pixels) }
        comparisons.push(value)
        return value.differingBytes === 0 && value.maximumDelta === 0 && value.sameLines
      }
      async function save(id: string, sample: DiagnosticSample) {
        const { rgba, ...pixels } = sample.pixels
        let bytes = ''
        for (let offset = 0; offset < rgba.length; offset += 8192) bytes += String.fromCharCode(...rgba.subarray(offset, offset + 8192))
        await persist(id, { ...sample, pixels, rgbaBase64: btoa(bytes) })
        completedSamples++
        if (!pixels.scratchCleared || pixels.requests !== 0 || pixels.liveCanvases !== 0 || pixels.peakCanvases > 3) throw new Error(`Ownership failure: ${id}`)
        if (sample.exportOwnership && (sample.exportOwnership.leases !== 1 || sample.exportOwnership.closed !== 1 || !sample.exportOwnership.finalized)) throw new Error(`Export ownership failure: ${id}`)
      }
      try {
        for (const fixture of fixtures) for (const quality of ['full', 'half', 'quarter'] as const) {
          const policies = new Map<string, Map<string, DiagnosticSample>>()
          for (const canvasPolicy of ['proof', 'production'] as const) {
            const first = new Map<string, DiagnosticSample>(); policies.set(canvasPolicy, first)
            for (const repeat of [0, 1]) {
              const current = new Map<string, DiagnosticSample>()
              for (const variant of ['baseline', 'compact', 'expanded'] as const) for (const host of ['html', 'offscreen', 'worker'] as const) {
                const request = { project: variant === 'expanded' ? fixture.expanded : fixture.legacy,
                  renderer: variant === 'baseline' ? 'baseline' as const : 'current' as const, quality, offscreen: host !== 'html', canvasPolicy }
                const id = `${fixture.id}-${quality}-${canvasPolicy}-${variant}-${host}-${repeat}`
                const sample = host === 'worker' ? await worker.sample(request) : await diagnosticSample(request)
                await save(id, sample); current.set(`${variant}-${host}`, sample)
                if (repeat === 0) first.set(`${variant}-${host}`, sample)
                else if (!compare(id, 'repeat', first.get(`${variant}-${host}`)!, sample)) throw new Error(`Nondeterministic sample: ${id}`)
              }
              // Persist all samples in this cell before stopping on a newly measured renderer regression.
              for (const host of ['html', 'offscreen', 'worker']) {
                const id = `${fixture.id}-${quality}-${canvasPolicy}-${host}-${repeat}`
                if (!compare(`${id}-baseline-compact`, 'same-host-renderer', current.get(`baseline-${host}`)!, current.get(`compact-${host}`)!)) throw new Error(`Baseline/current mismatch: ${id}`)
                if (!compare(`${id}-compact-expanded`, 'same-host-upgrade', current.get(`compact-${host}`)!, current.get(`expanded-${host}`)!)) throw new Error(`Upgrade mismatch: ${id}`)
              }
              for (const variant of ['baseline', 'compact', 'expanded']) {
                const id = `${fixture.id}-${quality}-${canvasPolicy}-${variant}-${repeat}`
                compare(`${id}-html-offscreen`, 'same-realm-canvas-kind', current.get(`${variant}-html`)!, current.get(`${variant}-offscreen`)!)
                compare(`${id}-offscreen-worker`, 'same-kind-realm', current.get(`${variant}-offscreen`)!, current.get(`${variant}-worker`)!)
              }
              if (quality === 'full') {
                const id = `${fixture.id}-${quality}-${canvasPolicy}-export-${repeat}`
                const exported = await diagnosticSample({ project: fixture.expanded, renderer: 'current', quality, offscreen: true, canvasPolicy, export: true })
                await save(id, exported)
                if (repeat === 0) first.set('export', exported)
                else if (!compare(id, 'export-repeat', first.get('export')!, exported)) throw new Error(`Nondeterministic export: ${id}`)
                for (const host of ['html', 'offscreen', 'worker']) compare(`${id}-${host}`, 'finite-export', current.get(`expanded-${host}`)!, exported)
              }
            }
          }
          for (const [key, original] of policies.get('proof')!) compare(`${fixture.id}-${quality}-${key}-policy`, 'context-policy', original, policies.get('production')!.get(key)!)
        }
      } finally {
        try { await worker.close(); disposalAcknowledged = true } finally {
          // Even an early integrity/renderer stop retains the comparisons already made.
          await (globalThis as unknown as { persistTitleCanvasDiagnosticSummary(value: unknown): Promise<void> }).persistTitleCanvasDiagnosticSummary({ comparisons, completedSamples, disposalAcknowledged })
        }
      }
      return { comparisons, completedSamples, disposalAcknowledged }
    }, JSON.stringify(fixtures))
  } finally {
    const body = await page.locator('body').innerText()
    const identity = { url: page.url(), title: await page.title(), viewport: page.viewportSize(), bodyTextLength: body.trim().length,
      bodyBounds: await page.locator('body').boundingBox(), viteErrorOverlays: await page.locator('vite-error-overlay').count() }
    await page.screenshot({ path: info.outputPath('diagnostic-page.png') })
    await writeFile(info.outputPath('browser-observations.json'), JSON.stringify({ browser: browser.version(), platform: process.platform, arch: process.arch, identity, warnings, errors, pageErrors, sampleCount }, null, 2))
    expect(identity.url).toBe('http://127.0.0.1:5200/')
    expect(identity.title).toMatch(/Myrelith/); expect(identity.bodyTextLength).toBeGreaterThan(50)
    expect(identity.bodyBounds?.height).toBeGreaterThan(0); expect(identity.viteErrorOverlays).toBe(0)
  }
  const completed = result as { comparisons: { differingBytes: number; maximumDelta: number; sameLines: boolean }[]; completedSamples: number; disposalAcknowledged: boolean }
  expect(completed.comparisons).toHaveLength(2160); expect(completed.completedSamples).toBe(1008); expect(sampleCount).toBe(1008); expect(completed.disposalAcknowledged).toBe(true)
  expect(errors).toEqual([]); expect(pageErrors).toEqual([])
  // A completed diagnostic is never silently promoted to a parity pass.
  expect(completed.comparisons.filter((row) => row.differingBytes !== 0 || row.maximumDelta !== 0 || !row.sameLines), 'Exact-zero diagnostic discrepancies; see saved raw samples').toEqual([])
})

test.beforeEach(async ({ page }, info) => {
  await page.exposeFunction('persistTitleCanvasDiagnosticSummary', async (value: unknown) => {
    await writeFile(info.outputPath('diagnostic-comparisons.json'), JSON.stringify(value, null, 2))
  })
})
