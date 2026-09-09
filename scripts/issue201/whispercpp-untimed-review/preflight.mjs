// Reuse runtime07's frozen inputs. Substitute only the reviewed source modules
// and new adapter WASM; derive the manifest without duplicating its inventory.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { prepareRuntimeInputs as prepareFrozenInputs } from '../whispercpp-cancellation/preflight.mjs'
import { inspectBinary } from '../whispercpp-review/inspect-binary.mjs'
import { inspectGlue } from '../whispercpp-short-output-run/inspect-glue.mjs'
import { verifyCandidate } from './candidate.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function prepareRuntimeInputs(root) {
  const bytes = await readFile(path.join(root, 'docs/evidence/issue201/whispercpp-untimed-runtime.json'))
  const checkpoint = JSON.parse(bytes)
  for (const pin of [...checkpoint.sourceFiles, ...checkpoint.referenceFiles]) {
    const actual = await readFile(path.join(root, pin.path))
    assert.equal(actual.length, pin.bytes, pin.path)
    assert.equal(hash(actual), pin.sha256, pin.path)
  }
  const inputs = await prepareFrozenInputs(root)
  assert.equal(inputs.checkpointSha256, checkpoint.frozenRuntimeCheckpoint)
  for (const name of ['model-worker.mjs', 'worker-protocol.mjs', 'candidate.mjs']) {
    const source = await readFile(path.join(root, 'scripts/issue201/whispercpp-untimed-review', name))
    inputs.assets.set('/' + name, { bytes: source, contentType: 'text/javascript', immutable: true, sha256: hash(source) })
  }
  const wasm = gunzipSync(await readFile(path.join(root, checkpoint.wasm.packedPath)), { maxOutputLength: 16 * 1024 * 1024 })
  assert.equal(wasm.length, checkpoint.wasm.bytes)
  assert.equal(hash(wasm), checkpoint.wasm.sha256)
  const binary = inspectBinary(wasm)
  inspectGlue(inputs.assets.get('/assets/myrelith-whisper.mjs').bytes.toString('utf8'), binary)
  inputs.assets.set('/assets/myrelith-whisper.wasm', { bytes: wasm, contentType: 'application/wasm', immutable: true, sha256: hash(wasm) })
  const manifest = structuredClone(inputs.manifest)
  manifest.runtime.generatedCheckpoint = checkpoint.adapterSourceCommit
  Object.assign(manifest.runtime.artifacts.find(artifact => artifact.name === 'myrelith-whisper.wasm'), checkpoint.wasm)
  await verifyCandidate(manifest, hash)
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  inputs.assets.set('/manifest.json', { bytes: manifestBytes, contentType: 'application/json', immutable: true, sha256: hash(manifestBytes) })
  return { ...inputs, manifest, manifestBytes, checkpoint, checkpointSha256: hash(bytes),
    receipts: [...inputs.assets].map(([url, asset]) => ({ url, bytes: asset.bytes.length, sha256: asset.sha256 })) }
}
