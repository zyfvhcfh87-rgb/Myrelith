#!/usr/bin/env node
/** Disposable isolated Chromium runner for the Issue #209 OPFS proof. */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const directory = dirname(fileURLToPath(import.meta.url))
const files = new Map([
  ['/', ['storage-probe.html', 'text/html; charset=utf-8']],
  ['/storage-probe.mjs', ['storage-probe.mjs', 'text/javascript; charset=utf-8']],
  ['/storage-probe-worker.js', ['storage-probe-worker.js', 'text/javascript; charset=utf-8']],
])
const server = createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://127.0.0.1').pathname)
  if (!entry) { response.writeHead(404).end(); return }
  try { response.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' }).end(await readFile(join(directory, entry[0]))) }
  catch { response.writeHead(500).end() }
})
const take = `take-${crypto.randomUUID()}`
const profile = await mkdtemp(join(tmpdir(), 'myrelith-issue209-opfs-'))
let browser
let context
let page
const result = { browser: null, streaming: null, fullLimit: null, recovery: null, processCrash: null, faults: {}, cleanup: null }

async function run(expression, arg) { return page.evaluate(expression, arg) }
async function restart() { await run(() => window.probe.terminate()); await run(() => window.probe.start()) }
async function recover(name) {
  await restart()
  return run((file) => window.probe.command('recover', { name: file }), name)
}
async function fault(name, kind) {
  await restart()
  await run((file) => window.probe.command('open', { name: file }), name)
  await run(async () => {
    for (let i = 0; i < 16; i++) await window.probe.command('append', {}, window.probe.batch(i))
  })
  await run((type) => window.probe.command('fault', { kind: type }), kind)
  const error = await run(async () => {
    try { await window.probe.command('append', {}, window.probe.batch(17)); return null }
    catch (failure) { return { name: failure.name, message: failure.message } }
  })
  const state = await recover(name)
  const decode = await run(([file, bytes]) => window.probe.verify(file, bytes), [name, 256 * 1024])
  return { error, state, decode }
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium' })
  browser = context.browser()
  page = await context.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => Boolean(window.probe))
  result.browser = await browser.version()
  const storage = await run(() => window.probe.estimate())
  result.estimate = { quotaMiB: Math.floor(storage.quota / 2 ** 20), usageMiB: Math.ceil(storage.usage / 2 ** 20) }
  await run(() => window.probe.start())
  await run((name) => window.probe.command('open', { name }), take)
  const streaming = await run(async () => {
    const offered = Array.from({ length: 4 }, (_, i) => window.probe.command('append', { slowMs: 20 }, window.probe.batch(i)))
    let overrun
    try { window.probe.command('append', {}, window.probe.batch(4)) } catch (error) { overrun = error.message }
    await Promise.all(offered)
    const started = performance.now()
    for (let i = 4; i < 256; i++) await window.probe.command('append', {}, window.probe.batch(i))
    return { overrun, elapsedMs: performance.now() - started, metrics: window.probe.metrics }
  })
  const verified = await run((name) => window.probe.verify(name, 4 * 1024 * 1024), take)
  result.streaming = { ...streaming, verified }
  const partial = `${take}-partial`
  await restart()
  await run((name) => window.probe.command('open', { name }), partial)
  await run(async () => {
    for (let i = 0; i < 16; i++) await window.probe.command('append', {}, window.probe.batch(i))
    await window.probe.command('append', {}, window.probe.batch(16))
    await window.probe.command('corruptHeader')
  })
  await run(() => window.probe.terminate())
  await page.reload() // same origin/context: actual OPFS survives page + worker termination
  await page.waitForFunction(() => Boolean(window.probe))
  await run(() => window.probe.start())
  result.recovery = await run((name) => window.probe.command('recover', { name }), partial)
  result.recovery.verified = await run((name) => window.probe.verify(name, 256 * 1024), partial)
  const torn = `${take}-torn`
  await restart()
  await run((name) => window.probe.command('open', { name }), torn)
  await run(async () => {
    for (let i = 0; i < 32; i++) await window.probe.command('append', {}, window.probe.batch(i))
    await window.probe.command('corruptLatestSlot')
  })
  result.faults.tornCheckpoint = await recover(torn)
  result.faults.tornCheckpoint.verified = await run((name) => window.probe.verify(name, 256 * 1024), torn)
  result.faults.short = await fault(`${take}-short`, 'short')
  result.faults.quota = await fault(`${take}-quota`, 'quota')
  const full = `${take}-limit`
  await restart()
  await run((name) => window.probe.command('open', { name }), full)
  result.fullLimit = await run(async (name) => {
    const bytes = 60 * 60 * 48000 * 2
    const started = performance.now()
    for (let written = 0; written < bytes;) {
      const size = Math.min(16384, bytes - written)
      await window.probe.command('append', {}, new ArrayBuffer(size))
      written += size
    }
    await window.probe.command('checkpoint')
    let limitError
    try { await window.probe.command('append', {}, new ArrayBuffer(2)) }
    catch (error) { limitError = error.message }
    await window.probe.command('close')
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('issue209-storage-probe')
    const file = await (await directory.getFileHandle(`${name}.wav`)).getFile()
    const view = new DataView(await file.slice(0, 44).arrayBuffer())
    return { bytes, fileBytes: file.size, headerBytes: view.getUint32(40, true),
      elapsedMs: performance.now() - started, limitError, metrics: window.probe.metrics }
  }, full)
  const crashed = `${take}-process`
  await restart()
  await run((name) => window.probe.command('open', { name }), crashed)
  await run(async () => {
    for (let i = 0; i < 17; i++) await window.probe.command('append', {}, window.probe.batch(i))
    await window.probe.command('corruptHeader')
  })
  const cdp = await browser.newBrowserCDPSession()
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
  const browserPid = processInfo.find((entry) => entry.type === 'browser')?.id
  if (!Number.isInteger(browserPid)) throw new Error('Cannot identify temporary browser process')
  const disconnected = new Promise((resolve) => browser.once('disconnected', resolve))
  globalThis.process.kill(browserPid, 'SIGKILL')
  await disconnected
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium' })
  browser = context.browser()
  page = await context.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => Boolean(window.probe))
  await run(() => window.probe.start())
  result.processCrash = await run((name) => window.probe.command('recover', { name }), crashed)
  result.processCrash.verified = await run((name) => window.probe.verify(name, 256 * 1024), crashed)
  await run(() => window.probe.terminate())
  result.cleanup = await run(async (names) => {
    const removed = await Promise.all(names.map((name) => window.probe.remove(name)))
    return { removed, all: removed.every(Boolean) }
  }, [take, partial, torn, `${take}-short`, `${take}-quota`, full, crashed])
  if (streaming.overrun !== 'BackpressureOverrun' || streaming.metrics.peakInFlight !== 65536 ||
      result.recovery.recoveredBytes !== 262144 || result.recovery.physicalBefore <= result.recovery.physicalAfter ||
      result.faults.tornCheckpoint.recoveredBytes !== 262144 ||
      result.processCrash.recoveredBytes !== 262144 ||
      result.fullLimit.fileBytes !== result.fullLimit.bytes + 44 ||
      result.fullLimit.headerBytes !== result.fullLimit.bytes ||
      result.fullLimit.limitError !== 'TakeLimitExceeded' ||
      !result.faults.short.error?.message.startsWith('ShortWrite') ||
      result.faults.quota.error?.name !== 'QuotaExceededError' || !result.cleanup.all) throw new Error('Probe assertions failed')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  await context.close()
} finally {
  await context?.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
  await rm(profile, { recursive: true, force: true })
}
