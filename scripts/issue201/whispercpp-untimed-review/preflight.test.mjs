import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareRuntimeInputs } from './preflight.mjs'
import { verifyCandidate } from './candidate.mjs'

test('browser-served manifest and returned candidate bytes agree after frozen-input substitution; no runtime executes', async () => {
  const inputs = await prepareRuntimeInputs(fileURLToPath(new URL('../../../', import.meta.url)))
  const asset = inputs.assets.get('/manifest.json')
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.deepEqual(asset.bytes, inputs.manifestBytes)
  assert.equal(asset.sha256, hash(inputs.manifestBytes))
  await verifyCandidate(JSON.parse(asset.bytes), hash)
  assert.deepEqual(JSON.parse(asset.bytes), inputs.manifest)
  assert.equal(inputs.assets.size, 17)
  assert.equal(inputs.factoryExecuted, false)
  assert.equal(inputs.wasmExecuted, false)
})
