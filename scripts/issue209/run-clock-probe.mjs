#!/usr/bin/env node
/** Disposable headed Chromium runner for the Issue #209 clock proof. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const directory = dirname(fileURLToPath(import.meta.url))
const files = new Map([
  ['/', ['clock-probe.html', 'text/html; charset=utf-8']],
  ['/clock-probe.mjs', ['clock-probe.mjs', 'text/javascript; charset=utf-8']],
  ['/clock-probe-worklet.js', ['clock-probe-worklet.js', 'text/javascript; charset=utf-8']],
])
const server = createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://127.0.0.1').pathname)
  if (!entry) { response.writeHead(404).end(); return }
  try {
    const bytes = await readFile(join(directory, entry[0]))
    response.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' }).end(bytes)
  } catch { response.writeHead(500).end() }
})

const headless = process.argv.includes('--headless')
const audible = process.argv.includes('--audible')
const revoke = process.argv.includes('--revoke')
const microphone = process.env.ISSUE209_MICROPHONE ?? ''
const speaker = process.env.ISSUE209_SPEAKER ?? ''
const stallMs = process.env.ISSUE209_STALL_MS ?? '120'
let browser
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless, channel: 'chromium' })
  const context = await browser.newContext()
  await context.grantPermissions(['microphone'], { origin })
  const page = await context.newPage()
  const params = new URLSearchParams({ microphone, speaker, audible: audible ? '1' : '0', stallMs })
  await page.goto(`${origin}/?${params}`)
  await page.getByRole('button', { name: 'Run microphone clock probe' }).click()
  let revocation = null
  if (revoke) {
    revocation = new Promise((resolve) => setTimeout(resolve, 900))
      .then(() => context.clearPermissions())
  }
  await page.waitForFunction(() => window.__probeDone === true, null, { timeout: 25_000 })
  await revocation
  const result = await page.evaluate(() => window.__probeResult)
  if (revoke) result.permissionRevocationAttempted = true
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result?.error) process.exitCode = 1
  await context.close()
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
