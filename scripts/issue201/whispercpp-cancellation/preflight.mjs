// Reuse the frozen runtime06 preflight; replace only the two reviewed modules.
// No generated factory, WASM, browser or server is created here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareRuntimeInputs as prepareFrozenInputs } from '../whispercpp-bounded-support-run/preflight.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function prepareRuntimeInputs(root) {
  const bytes = await readFile(path.join(root, 'docs/evidence/issue201/whispercpp-cancellation-runtime.json'))
  const checkpoint = JSON.parse(bytes)
  for (const pin of [...checkpoint.sourceFiles, ...checkpoint.referenceFiles]) {
    const actual = await readFile(path.join(root, pin.path))
    assert.equal(actual.length, pin.bytes, pin.path)
    assert.equal(hash(actual), pin.sha256, pin.path)
  }
  const inputs = await prepareFrozenInputs(root)
  assert.equal(inputs.checkpointSha256, checkpoint.frozenRuntimeCheckpoint)
  for (const name of ['lab-client.mjs', 'model-worker.mjs']) {
    const source = await readFile(path.join(root, 'scripts/issue201/whispercpp-cancellation', name))
    inputs.assets.set('/' + name, { bytes: source, contentType: 'text/javascript', immutable: true, sha256: hash(source) })
  }
  return { ...inputs, checkpoint, checkpointSha256: hash(bytes),
    receipts: [...inputs.assets].map(([url, asset]) => ({ url, bytes: asset.bytes.length, sha256: asset.sha256 })) }
}
