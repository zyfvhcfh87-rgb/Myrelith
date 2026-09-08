import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createDiagnosticVite, diagnosticOptions, readDiagnosticInput, verifyDiagnosticInput } from './run-export-diagnostic.mjs'

test('diagnostic options pin a full SHA and cannot add another input, segment or retry', () => {
  assert.throws(() => diagnosticOptions([]), /full/)
  for (const key of ['--source', '--segment', '--retry', '--port']) assert.throws(() => diagnosticOptions(['--expected-sha', 'a'.repeat(40), key, 'changed']), /Unknown/)
  assert.deepEqual(diagnosticOptions(['--expected-sha', 'a'.repeat(40)]), { expectedSha: 'a'.repeat(40), output: null })
})
test('immutable byte identity rejects equal-sized mutation and a changed length', async () => {
  const bytes = Buffer.from([9, 8, 7, 6]), expected = { name: 'source.mp4', bytes: 4, sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.equal(verifyDiagnosticInput(bytes, expected).sha256, expected.sha256)
  assert.throws(() => verifyDiagnosticInput(Buffer.from([9, 8, 7, 5]), expected), /changed/)
  const path = await mkdtemp(join(tmpdir(), 'issue198-pinned-diagnostic-')), file = join(path, 'source.mp4')
  try {
    await writeFile(file, bytes); assert.deepEqual(await readDiagnosticInput(file, expected), bytes)
    await writeFile(file, Buffer.alloc(8)); await assert.rejects(readDiagnosticInput(file, expected), /size changed/)
    await writeFile(file, Buffer.from([9, 8, 7, 5])); await assert.rejects(readDiagnosticInput(file, expected), /changed/)
  } finally { await rm(path, { recursive: true, force: true }) }
})

// Inert model of Vite8.1.2's observed configureServer -> HTML fallback ->
// post hooks -> terminal indexHTML/notFound order. No server or socket opens.
async function routingFixture() {
  const handlers = [], files = new Map([
    ['source.mp4', Buffer.from([9, 8, 7, 6])],
    ['export-complete-0.mp4', Buffer.from([1, 2, 3, 4, 5])],
  ])
  let mediaRequests = 0, fallbackResponses = 0
  const server = { middlewares: { use: (handler) => handlers.push(handler) } }
  const actual = await createDiagnosticVite('/owned-root', files, () => ++mediaRequests, async (options) => {
    assert.equal(options.root, '/owned-root')
    assert.deepEqual(options.server, { host: '127.0.0.1', port: 5198, strictPort: true })
    const postHooks = []
    for (const plugin of options.plugins ?? []) postHooks.push(await plugin.configureServer(server))
    handlers.push((req, _res, next) => { if (req.method === 'GET' || req.method === 'HEAD') req.url = '/index.html'; next() })
    for (const hook of postHooks) if (hook) await hook()
    handlers.push((req, res, next) => {
      if (req.url !== '/index.html') return next()
      fallbackResponses++; res.setHeader('Content-Type', 'text/html'); res.end('<html>fallback</html>')
    })
    handlers.push((_req, res) => { fallbackResponses++; res.statusCode = 404; res.end('not found') })
    return server
  })
  assert.equal(actual, server)
  const request = (url, method = 'GET') => {
    const req = { url, method, headers: { accept: '*/*' } }, headers = new Map()
    let ended = false, body, index = 0
    const res = { statusCode: 200, setHeader: (name, value) => headers.set(name.toLowerCase(), String(value)),
      end(value) { assert.equal(ended, false); ended = true; body = value } }
    const next = () => { assert.equal(ended, false); const handler = handlers[index++]; assert.ok(handler); handler(req, res, next) }
    next(); assert.equal(ended, true)
    return { status: res.statusCode, headers, body }
  }
  return { request, files, counts: () => ({ mediaRequests, fallbackResponses }) }
}

test('actual diagnostic routing returns both exact binary responses before the SPA fallback', async () => {
  const routing = await routingFixture()
  for (const [name, bytes] of routing.files) {
    const response = routing.request(`/__issue198_diagnostic/${name}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(bytes.byteLength))
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.body, bytes)
  }
  assert.deepEqual(routing.counts(), { mediaRequests: 2, fallbackResponses: 0 })
  const refused = routing.request('/__issue198_diagnostic/source.mp4')
  assert.equal(refused.status, 400)
  assert.equal(refused.body, 'Invalid immutable input request')
  assert.deepEqual(routing.counts(), { mediaRequests: 3, fallbackResponses: 0 })
})

test('actual diagnostic handler rejects nonexact paths and methods without consuming admitted requests', async () => {
  const routing = await routingFixture()
  for (const [url, method] of [
    ['/__issue198_diagnostic/source.mp4', 'HEAD'], ['/__issue198_diagnostic/source.mp4', 'POST'],
    ['/__issue198_diagnostic/missing.mp4', 'GET'], ['/__issue198_diagnostic/source.mp4?extra=1', 'GET'],
    ['/__issue198_diagnostic/%73ource.mp4', 'GET'], ['/__issue198_diagnostic/../source.mp4', 'GET'],
  ]) {
    const response = routing.request(url, method)
    assert.equal(response.status, 400)
    assert.equal(response.body, 'Invalid immutable input request')
  }
  assert.deepEqual(routing.counts(), { mediaRequests: 0, fallbackResponses: 0 })
  assert.equal(routing.request('/scripts/issue198/mask-performance-gate.html').body, '<html>fallback</html>')
  assert.deepEqual(routing.counts(), { mediaRequests: 0, fallbackResponses: 1 })
  for (const [name, bytes] of routing.files) assert.equal(routing.request(`/__issue198_diagnostic/${name}`).body, bytes)
  assert.deepEqual(routing.counts(), { mediaRequests: 2, fallbackResponses: 1 })
})
