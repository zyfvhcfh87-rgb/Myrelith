import { bounded, cleanupInOrder } from './lifecycle.mjs'
/** Explicitly granted standalone mixed-media diagnostic; no automatic build or other segment. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProcessRows, ownedProcessRows, sameProcessIdentity } from '../continuation/process-identities.mjs'
import { SAMPLE_FRAMES, LIMITS, verifyEncoded, verifyDrained } from './oracles.mjs'
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url))), git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim()
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const paths = git('ls-files', 'src', 'scripts/issue199/g4', 'scripts/issue199/continuation/process-identities.mjs', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json').split('\n')
const sourceHashes = Object.fromEntries(paths.map((p) => [p, hash(readFileSync(join(root, p)))]))
if (process.argv.includes('--check')) { console.log(JSON.stringify({ sourceFiles: paths.length, limits: LIMITS, frames: SAMPLE_FRAMES, executesBrowser: false })); process.exit(0) }
assert.equal(process.argv.length, 4, 'Run only after parent grant: node scripts/issue199/g4/run.mjs --expected-head FULL_SHA')
assert.equal(process.argv[2], '--expected-head'); const head = process.argv[3]
assert.match(head, /^[a-f0-9]{40}$/); assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain'), '')
const pin = () => { assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain'), ''); for (const [p, expected] of Object.entries(sourceHashes)) assert.equal(hash(readFileSync(join(root, p))), expected, p) }
const out = process.env.ISSUE199_G4_OUTPUT; assert.ok(out?.startsWith('/private/tmp/issue199-g4/')); const profile = join(out, 'chromium-profile')
mkdirSync(out, { recursive: true }); const { chromium } = await import('@playwright/test')
const report = { format: 'issue199-g4-v1', head, startedAt: new Date().toISOString(), status: 'preflight', sourceHashes, limits: LIMITS, steps: [], problems: [], processes: [], cleanup: {}, qualification: 'Source-module diagnostic against production implementations, Vite dev server; not ordinary production bundle/first-paint, performance or OS Save-picker acceptance.' }
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n')
const delay = (ms) => new Promise((r) => setTimeout(r, ms)), known = []
const listening = () => new Promise((r) => { const s = createConnection({ host: '127.0.0.1', port: 5199 }); s.once('connect', () => { s.destroy(); r(true) }); s.once('error', () => r(false)); s.setTimeout(500, () => { s.destroy(); r(false) }) })
function processRows() { const p = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 }); assert.equal(p.status, 0, p.stderr); return parseProcessRows(p.stdout) }
function sample(label) { const rows = ownedProcessRows(processRows(), profile, known); for (const row of rows) if (!known.some((r) => sameProcessIdentity(r, row))) known.push(row); report.processes.push({ label, at: new Date().toISOString(), rows }); save(); return rows }
let server, awake, context, page, serverLog = '', current = 'preflight'
const call = (name, arg) => page.evaluate(async ({ name, arg }) => { const module = await import('/scripts/issue199/g4/scenario.ts'); return module[name](name === 'decodeOutput' ? (value) => globalThis.__issue199Evidence(value) : arg) }, { name, arg })
async function step(name, action) {
  current = name; console.log(`START ${name}`); sample(`before ${name}`)
  let timer
  try {
    const detail = await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: 90 second deadline`)), 90000) })])
    await bounded('post-step settle', 5000, () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))))
    const stem = `step-${String(report.steps.length + 1).padStart(2, '0')}`
    await bounded('post-step screenshot', 5000, () => page.screenshot({ path: join(out, `${stem}.png`) })); writeFileSync(join(out, `${stem}-dom.txt`), await bounded('post-step DOM', 5000, () => page.locator('body').innerText()))
    assert.deepEqual(report.problems, []); report.steps.push({ name, status: 'passed', detail }); sample(`after ${name}`); save(); console.log(`PASS ${name}`)
  } finally { clearTimeout(timer) }
}
try {
  pin(); assert.equal(await listening(), false, 'Port 5199 belongs to another owner')
  awake = spawn('/usr/bin/caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' })
  server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (data) => { serverLog += data }); server.stderr.on('data', (data) => { serverLog += data })
  for (const pid of [awake.pid, server.pid]) { const identity = processRows().find((p) => p.pid === pid); assert.ok(identity); known.push(identity) }
  report.runner = processRows().find((p) => p.pid === process.pid); sample('native startup')
  for (let n = 0; n < 100 && !(await listening()); n++) await delay(100)
  assert.equal(await listening(), true)
  context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--mute-audio'], viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  report.chromium = context.browser().version(); await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  page = context.pages()[0]; page.setDefaultTimeout(15000)
  await page.exposeFunction('__issue199Evidence', (partial) => writeFileSync(join(out, 'partial-decode.json'), JSON.stringify(partial, null, 2) + '\n'))
  page.on('pageerror', (e) => report.problems.push({ step: current, type: 'pageerror', text: e.stack }))
  page.on('console', (m) => { if (['warning', 'error'].includes(m.type())) report.problems.push({ step: current, type: m.type(), text: m.text() }) })
  page.on('dialog', async (d) => { if (d.type() === 'confirm' && d.message() === 'This project has unsaved changes. Leave them behind and return to Projects?') await d.accept(); else { report.problems.push({ step: current, type: 'dialog', text: d.message() }); await d.dismiss() } })
  await step('bounded encoded fixture, canonical retime/split and undo', async () => {
    await page.goto('http://127.0.0.1:5199'); await page.getByRole('button', { name: 'Start a new project', exact: true }).click()
    await page.getByLabel('Project name').fill('Mixed encoded Animation G4'); await page.getByLabel('Resolution', { exact: true }).selectOption('720')
    await page.getByRole('button', { name: 'Create project', exact: true }).click(); await page.getByRole('button', { name: 'Commands', exact: true }).waitFor()
    return call('prepare')
  })
  await step('native shared title Set key, numeric value, copy and paste', async () => {
    await page.getByRole('button', { name: 'Animation', exact: true }).click()
    const workspace = page.getByRole('region', { name: 'Animation workspace', exact: true })
    await workspace.getByLabel('Filter animation lanes', { exact: true }).fill('Rectangle')
    await workspace.getByRole('rowheader', { name: /Rectangle, Position Y, 2 keys/ }).click()
    await call('titleKeyFrame', 14)
    await workspace.getByRole('button', { name: 'Set key at playhead', exact: true }).click()
    await workspace.getByTestId('animation-key-value').fill('-120'); await workspace.getByTestId('animation-key-value').press('Enter')
    await workspace.getByRole('button', { name: 'Copy', exact: true }).click(); await call('titleKeyFrame', 20)
    await workspace.getByRole('button', { name: 'Paste', exact: true }).click()
    const facts = await call('verifyTitleKeyEdit')
    await workspace.getByRole('button', { name: 'Back to Timeline', exact: true }).click(); return facts
  })
  await step('muted native playback uses silent live audio', async () => {
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.waitForFunction(async () => { const { useTransportStore } = await import('/src/state/transportStore.ts'); return useTransportStore.getState().playheadFrame >= 8 })
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    const saved = await call('installOracleAndSave'); writeFileSync(join(out, 'mixed.myrelith'), saved.portable)
    for (const f of saved.files) { const bytes = Buffer.from(f.bytes, 'base64'); assert.equal(hash(bytes), f.sha256); writeFileSync(join(out, f.name), bytes) }
    return { portableSha256: hash(saved.portable), files: saved.files.map(({ bytes: _bytes, ...metadata }) => metadata) }
  })
  await step('portable reopen and exact media relink', async () => {
    await page.getByRole('button', { name: 'Projects', exact: true }).click(); await page.getByRole('button', { name: 'Open a project', exact: true }).click()
    await page.locator('input[type="file"][accept=".myrelith,.webcut"]').setInputFiles(join(out, 'mixed.myrelith'))
    await page.getByRole('button', { name: 'Open with 2 offline', exact: true }).click()
    for (const name of ['g4-source.webm', 'g4-oracle.wav']) await page.getByLabel(`Relink ${name} once`, { exact: true }).setInputFiles(join(out, name))
    await page.waitForFunction(async () => { const { useMediaStore } = await import('/src/state/mediaStore.ts'); return useMediaStore.getState().assets.size === 2 })
    const result = await call('verifyReopened'); assert.equal(result.retainedUnknownEffect, true); return result
  })
  await step('Animation workspace 1440/720 layout and focus', async () => {
    await page.getByRole('button', { name: 'Animation', exact: true }).click()
    const workspace = page.getByRole('region', { name: 'Animation workspace', exact: true })
    const results = []
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 900 }); await workspace.getByLabel('Filter animation lanes', { exact: true }).fill('g4')
      await workspace.getByRole('button', { name: 'Dope sheet', exact: true }).click()
      results.push(await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth })))
      assert.ok(results.at(-1).documentWidth <= width + 1)
    }
    await workspace.getByRole('button', { name: 'Back to Timeline', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Animation', exact: true }).evaluate((e) => e === document.activeElement), true)
    await page.setViewportSize({ width: 1440, height: 900 }); return results
  })
  await step('missing named font refuses strict export before output', async () => {
    const facts = await call('rejectMissingFont')
    if (facts.bytes) writeFileSync(join(out, 'unexpected-missing-font-export.webm'), Buffer.from(facts.bytes, 'base64'))
    assert.ok(!facts.unexpected && /font|fallback/i.test(facts.reason)); return facts
  })
  await step('settled mixed Program references at boundary and interior frames', async () => {
    const rows = []; for (const frame of SAMPLE_FRAMES) { const reference = await call('capture', frame); writeFileSync(join(out, `reference-${frame}-rgb.json`), JSON.stringify(reference) + '\n'); rows.push({ frame, glyph: reference.glyph }); await page.screenshot({ path: join(out, `reference-${frame}.png`) }) } return rows
  })
  await step('real VP9/Opus export, reopen decode and frozen pixel/PCM predicates', async () => {
    const output = await call('exportEncoded')
    const buffer = Buffer.from(output.bytes, 'base64'); writeFileSync(join(out, 'mixed-export.webm'), buffer)
    writeFileSync(join(out, 'encoded-output.json'), JSON.stringify({ bytes: buffer.length, sha256: hash(buffer) }) + '\n'); assert.equal(hash(buffer), output.sha256); assert.equal(output.projectUnchanged, true)
    const { bytes: _bytes, ...facts } = await call('decodeOutput')
    facts.frames = facts.frames.map(({ decodedPng, ...frame }) => { writeFileSync(join(out, `decoded-${frame.frame}.png`), Buffer.from(decodedPng, 'base64')); return frame })
    writeFileSync(join(out, 'decoded-facts.json'), JSON.stringify(facts, null, 2) + '\n'); verifyEncoded(facts); return facts
  })
  await step('drain all owned media', async () => {
    const admission = await call('dispose')
    writeFileSync(join(out, 'final-admission.json'), JSON.stringify(admission, null, 2) + '\n')
    verifyDrained(admission); return admission
  })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = { step: current, error: error.stack }; process.exitCode = 1; save()
  if (page) try { await bounded('failure screenshot', 3000, () => page.screenshot({ path: join(out, 'failure.png') })); writeFileSync(join(out, 'failure-dom.txt'), await bounded('failure DOM', 3000, () => page.locator('body').innerText())) } catch (e) { report.failure.captureError = String(e) }
} finally {
  if (context) await cleanupInOrder([
    ['trace', async () => { sample('before closing'); await context.tracing.stop({ path: join(out, 'trace.zip') }) }],
    ['context', async () => { await context.close(); report.cleanup.contextClosed = true }],
  ], 5000, report.cleanup)
  for (const child of [server, awake]) if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), delay(3000)]) }
  try {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const remaining = sample(`cleanup ${signal}`)
      for (const identity of remaining) if (processRows().some((row) => sameProcessIdentity(row, identity))) { assert.ok(![1, process.pid, process.ppid].includes(identity.pid)); process.kill(identity.pid, signal); (report.cleanup.signals ??= []).push({ signal, identity }) }
      for (let n = 0; n < 20 && ownedProcessRows(processRows(), profile, known).length; n++) await delay(100)
    }
    report.cleanup.remaining = sample('final'); report.cleanup.port5199 = await listening(); report.cleanup.at = new Date().toISOString()
    assert.deepEqual(report.cleanup.remaining, []); assert.equal(report.cleanup.port5199, false); assert.deepEqual(report.problems, []); pin()
  } catch (e) { report.status = 'failed'; report.cleanup.error = e.stack; process.exitCode = 1 }
  writeFileSync(join(out, 'server.log'), serverLog); report.finishedAt = new Date().toISOString(); save()
  writeFileSync(join(out, 'artifacts.json'), JSON.stringify({ head, resultSha256: hash(readFileSync(join(out, 'result.json'))), qualification: 'Other raw artifacts retained; parent packaging will hash all top-level artifacts without editing originals.' }, null, 2) + '\n')
  console.log(`Evidence: ${out}`)
}
