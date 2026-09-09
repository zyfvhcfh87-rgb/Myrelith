/** Exact source/asset bytes only. No server, browser, generated factory or WASM. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { verifyCandidate } from '../whispercpp-short-output-run/candidate.mjs'
import { inspectTinyQ8 } from '../whispercpp/model-format.mjs'
import { inspectBinary } from '../whispercpp-review/inspect-binary.mjs'
import { inspectGlue } from '../whispercpp-short-output-run/inspect-glue.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function prepareRuntimeInputs(root, { verifyCheckpoint = true } = {}) {
  const evidencePath = 'docs/evidence/issue201/whispercpp-bounded-support-runtime'
  const manifestBytes = await readFile(path.join(root, evidencePath, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  await verifyCandidate(manifest, hash)
  let checkpoint = null, checkpointSha256 = null
  if (verifyCheckpoint) {
    const bytes = await readFile(path.join(root, evidencePath, 'checkpoint.json'))
    checkpointSha256 = hash(bytes); checkpoint = JSON.parse(bytes)
    for (const receipt of [...checkpoint.sourceFiles, ...checkpoint.referenceFiles]) {
      const actual = await readFile(path.join(root, receipt.path))
      assert.equal(actual.length, receipt.bytes, receipt.path)
      assert.equal(hash(actual), receipt.sha256, receipt.path)
    }
    for (const receipt of checkpoint.records) {
      const actual = await readFile(path.join(root, evidencePath, receipt.path))
      assert.equal(actual.length, receipt.bytes, receipt.path)
      assert.equal(hash(actual), receipt.sha256, receipt.path)
    }
  }
  const assets = new Map()
  const put = (url, bytes, receipt, contentType, immutable) => {
    assert.equal(bytes.length, receipt.bytes, url)
    assert.equal(hash(bytes), receipt.sha256, url)
    assets.set(url, { bytes, contentType, immutable, sha256: receipt.sha256 })
  }
  for (const artifact of manifest.runtime.artifacts) {
    const bytes = artifact.packedPath
      ? gunzipSync(await readFile(path.join(root, artifact.packedPath)), { maxOutputLength: 16 * 1024 * 1024 })
      : await readFile(path.join(root, artifact.localPath))
    put('/assets/' + artifact.name, bytes, artifact, artifact.name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', true)
  }
  const binary = inspectBinary(assets.get('/assets/myrelith-whisper.wasm').bytes)
  inspectGlue(assets.get('/assets/myrelith-whisper.mjs').bytes.toString('utf8'), binary)
  for (const file of manifest.model.files) {
    const bytes = await readFile(path.join(root, file.localPath))
    put('/model/' + file.path, bytes, file, 'application/octet-stream', false)
    inspectTinyQ8(bytes)
  }
  for (const fixture of [...manifest.fixtures.map(f => ({ ...f, name: f.name + '.wav' })), ...manifest.derivatives]) {
    put('/fixtures/' + fixture.name, await readFile(path.join(root, '.tmp/issue201-speech-lab/fixtures', fixture.name)), fixture, 'audio/wav', true)
  }
  const modules = {
    'lab-client.mjs': 'whispercpp-diagnostic-run/lab-client.mjs', 'model-worker.mjs': 'whispercpp-diagnostic-run/model-worker.mjs',
    'candidate.mjs': 'whispercpp-short-output-run/candidate.mjs', 'lab-contract.mjs': 'lab-contract.mjs',
    'observe-module.mjs': 'whispercpp-diagnostic/observe-module.mjs',
    'worker-protocol.mjs': 'whispercpp/worker-protocol.mjs', 'model-format.mjs': 'whispercpp/model-format.mjs',
  }
  for (const [url, file] of Object.entries(modules)) {
    const bytes = await readFile(path.join(root, 'scripts/issue201', file))
    if (url === 'observe-module.mjs') put('/' + url, bytes, manifest.runtime.diagnostics, 'text/javascript', true)
    else assets.set('/' + url, { bytes, contentType: 'text/javascript', immutable: true, sha256: hash(bytes) })
  }
  assets.set('/manifest.json', { bytes: manifestBytes, contentType: 'application/json', immutable: true, sha256: hash(manifestBytes) })
  return { manifest, manifestBytes, checkpoint, checkpointSha256, assets,
    receipts: [...assets].map(([url, { bytes, sha256 }]) => ({ url, bytes: bytes.length, sha256 })),
    factoryExecuted: false, wasmExecuted: false }
}
