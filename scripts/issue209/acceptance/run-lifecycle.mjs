#!/usr/bin/env node
/**
 * Issue #209 Step 12 — real page-lifecycle interruption through the product UI.
 *
 * Playwright pages always report `visible` (its instrumentation forces it), so
 * this runner drives Chrome for Testing over raw CDP: a genuine background tab
 * (the owner's visibility path). It opens ONE visible window briefly (an explicit
 * exception to the no-visible-window QA rule), keeps output muted, uses the
 * real default microphone, and deletes every recording before exiting.
 *   node scripts/issue209/acceptance/run-lifecycle.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const port = 41_735
const origin = `http://127.0.0.1:${port}`
const microphone = process.env.ISSUE209_MICROPHONE ?? 'HyperX QuadCast'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const server = spawn('npx', ['vite', '--config', 'scripts/issue209/acceptance/vite.no-hmr.config.ts',
  '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const profile = await mkdtemp(join(tmpdir(), 'myrelith-209-lifecycle-'))
let browser = null
let exitCode = 0
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite did not start')), 60_000)
    server.stdout.on('data', (chunk) => { if (String(chunk).includes(String(port))) { clearTimeout(timer); resolve() } })
  })
  browser = spawn(chromium.executablePath(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--mute-audio', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve) => browser.stderr.on('data', (chunk) => {
    const match = /DevTools listening on (ws:\S+)/.exec(String(chunk))
    if (match) resolve(match[1])
  }))
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  let nextId = 0
  const waiting = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    waiting.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result))
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  await send('Browser.grantPermissions', { origin, permissions: ['audioCapture'] })
  const { targetId } = await send('Target.createTarget', { url: origin })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return result.result.value
  }
  const until = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await evaluate(expression).catch(() => null)
      if (value) return value
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${expression}`)
  }
  const click = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')]
    .find((el) => el.textContent.trim() === ${JSON.stringify(text)} || el.getAttribute('aria-label') === ${JSON.stringify(text)});
    if (!b) throw new Error('No button ' + ${JSON.stringify(text)}); b.click(); return true })()`)
  const status = () => evaluate(`import('/src/state/voiceoverCaptureStore.ts').then(({ useVoiceoverCaptureStore: s }) => {
    const v = s.getState(); return { phase: v.session?.phase ?? null, interruption: v.session?.interruption ?? null,
      capturedSamples: v.capturedSamples, diagnostic: v.diagnostic } })`)

  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Start a new project'))`)
  await click('Start a new project')
  await until(`[...document.querySelectorAll('input')].some((i) => i.labels?.[0]?.textContent.includes('Project name'))`)
  await evaluate(`(() => { const input = [...document.querySelectorAll('input')].find((i) => i.labels?.[0]?.textContent.includes('Project name'))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Step 12 lifecycle'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await click('Create project')
  await until(`[...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Record')`)
  // Grant once so device labels exist, then open the panel.
  await evaluate(`navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return true })`)
  await click('Record')
  await until(`[...document.querySelectorAll('.voiceover-setup select option')].some((o) => o.textContent.includes(${JSON.stringify(microphone)}))`)
  await evaluate(`(() => {
    const selects = [...document.querySelectorAll('.voiceover-setup select')]
    const choose = (select, predicate) => { const option = [...select.options].find(predicate)
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, option.value); select.dispatchEvent(new Event('change', { bubbles: true })) }
    for (const select of selects) {
      if ([...select.options].some((o) => o.textContent.includes(${JSON.stringify(microphone)}))) choose(select, (o) => o.textContent.includes(${JSON.stringify(microphone)}))
      if ([...select.options].some((o) => o.textContent === 'Off')) choose(select, (o) => o.textContent === 'Off')
    }
    return true })()`)
  await click('Record at playhead')
  await until(`Number(document.querySelector('.voiceover-elapsed')?.textContent?.replace(/[^\\d]/g, '') ?? 0) >= 35`)

  // Focus emulation (needed for the Record precondition) also pins visibility; release it.
  await send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId)
  const background = await send('Target.createTarget', { url: 'about:blank' })
  await send('Target.activateTarget', { targetId: background.targetId })
  await sleep(300)
  const hiddenState = await evaluate('document.visibilityState')
  // CDP's forced freeze leaves Runtime.evaluate on a stale context after resume,
  // so this runner exercises the genuine background-tab path only.
  const frozen = 'not attempted'
  await sleep(1_500)
  await send('Target.activateTarget', { targetId })
  await until(`import('/src/state/voiceoverCaptureStore.ts').then(({ useVoiceoverCaptureStore: s }) => s.getState().session?.phase === 'review')`)
    .catch(async (cause) => { console.error('stuck at', JSON.stringify(await status()), 'hidden:', hiddenState, 'frozen:', frozen); throw cause })
  const reviewed = await status()
  await evaluate('window.__lifecycleMarker = true')
  const lifecycleResult = { scenario: 'hidden-tab', hiddenState, frozen, ...reviewed,
    wholeCheckpoints: (reviewed.capturedSamples * 2) % (256 * 1024) === 0 }
  process.stdout.write(`ISSUE209_RESULT ${JSON.stringify(lifecycleResult)}\n`)
  if (reviewed.interruption !== 'hidden' || !lifecycleResult.wholeCheckpoints || hiddenState !== 'hidden') exitCode = 1

  await click('Discard')
  await until(`import('/src/state/voiceoverCaptureStore.ts').then(({ useVoiceoverCaptureStore: s }) => s.getState().session?.phase === 'cancelled')`)
    .catch(async (cause) => { console.error('discard stuck at', JSON.stringify(await status()),
      await evaluate(`[...document.querySelectorAll('.voiceover-panel button')].map((b) => b.textContent + (b.disabled ? '(disabled)' : '')).join(' | ')`)); throw cause })
  const removed = await evaluate(`(async () => { const root = await navigator.storage.getDirectory(); let n = 0
    try { const d = await root.getDirectoryHandle('myrelith-recordings-v1'); const names = []
      for await (const e of d.values()) names.push(e.name); for (const name of names) { await d.removeEntry(name); n++ } } catch {}
    return n })()`)
  const sameDocument = await evaluate('window.__lifecycleMarker === true')
  process.stdout.write(`ISSUE209_RESULT ${JSON.stringify({ scenario: 'hidden-tab-cleanup', removed, sameDocument })}\n`)
  socket.close()
} catch (cause) {
  console.error(cause)
  exitCode = 1
} finally {
  browser?.kill()
  server.kill()
  await rm(profile, { recursive: true, force: true })
  process.exit(exitCode)
}
