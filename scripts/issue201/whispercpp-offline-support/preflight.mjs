// Only the runner's offline support contract changes. All runtime08 assets,
// model identities, source modules and limits remain frozen.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareRuntimeInputs as prepareFrozenInputs } from '../whispercpp-untimed-review/preflight.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function prepareRuntimeInputs(root) {
  const bytes = await readFile(path.join(root, 'docs/evidence/issue201/whispercpp-offline-runtime.json'))
  const checkpoint = JSON.parse(bytes)
  for (const pin of [...checkpoint.sourceFiles, ...checkpoint.referenceFiles]) {
    const actual = await readFile(path.join(root, pin.path))
    assert.equal(actual.length, pin.bytes, pin.path)
    assert.equal(hash(actual), pin.sha256, pin.path)
  }
  const inputs = await prepareFrozenInputs(root)
  assert.equal(inputs.checkpointSha256, checkpoint.frozenRuntimeCheckpoint)
  assert.deepEqual(inputs.assets.get('/manifest.json').bytes, inputs.manifestBytes)
  return { ...inputs, checkpoint, checkpointSha256: hash(bytes) }
}
