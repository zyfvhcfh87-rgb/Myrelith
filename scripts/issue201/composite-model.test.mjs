import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { COMPOSITE_FILES, CANDIDATE04_MANIFEST_SHA256, assertReviewedComposite, modelBundlePayload, modelCachePayload, verifyModelBundle } from './composite-model.mjs'
import { compositePreparation, hash, verifiedFile, verifyPreparedComposite } from './composite-preflight.mjs'
import { pinnedModelFileLookup, LAB_CASE_NAMES } from './lab-contract.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifestPath = path.join(root, 'docs/evidence/issue201/replacement-manifest.json')
const manifest = JSON.parse(await readFile(manifestPath))
const baselineBytes = await readFile(path.join(root, 'docs/evidence/issue201/encoder-fetch-candidate04-manifest.json'))
const baseline = JSON.parse(baselineBytes)

test('exact composite replaces only the historical encoder and retains six current components, runtime and thresholds', async () => {
  assert.equal(hash(baselineBytes), CANDIDATE04_MANIFEST_SHA256)
  assertReviewedComposite(manifest)
  await verifyModelBundle(manifest.model, hash)
  assert.equal(manifest.model.totalBytes, 43_610_465)
  assert.equal(manifest.model.totalBytes * 2, 87_220_930)
  assert.equal(manifest.model.totalBytes + baseline.model.totalBytes, 87_232_592)
  assert.equal(manifest.thresholds.modelCacheByteLimit, 100_663_296)
  assert.equal(manifest.thresholds.maxIncrementalResidentBytes, 1_073_741_824)
  assert.deepEqual(manifest.thresholds, baseline.thresholds)
  assert.deepEqual(manifest.fixtures, baseline.fixtures)
  assert.deepEqual(manifest.derivatives, baseline.derivatives)
  assert.deepEqual({ ...manifest.runtime, encoderFetchPolicy: null }, { ...baseline.runtime, encoderFetchPolicy: null })
  assert.equal(LAB_CASE_NAMES.length, 23)
  for (const file of manifest.model.files) {
    const old = baseline.model.files.find((entry) => entry.path === file.path)
    assert.ok(old)
    if (file.path.includes('encoder_model')) {
      assert.equal(file.sourceRevision, 'ce70c25689c3694faf5ec8206517cd53f0cfb03f')
      assert.notEqual(file.sha256, old.sha256)
    } else {
      assert.equal(file.sourceRevision, baseline.model.revision)
      assert.equal(file.bytes, old.bytes)
      assert.equal(file.sha256, old.sha256)
    }
  }
  assert.equal(manifest.model.licenseProvenance.historicalConverterDeclaredLicense, null)
  assert.equal(manifest.model.licenseProvenance.originalRevision, 'ed50ab0ea2fc43b928969fd70d5fe21eefdd350f')
})

test('every per-file source, logical/local path and byte identity is bound to bundle/cache identity', async () => {
  for (const index of manifest.model.files.keys()) {
    for (const key of ['sourceRevision', 'path', 'localPath', 'sha256', 'bytes']) {
      const changed = structuredClone(manifest)
      const file = changed.model.files[index]
      if (key === 'sourceRevision') {
        file.sourceRevision = 'f'.repeat(40)
        file.url = `https://huggingface.co/${file.sourceRepository}/resolve/${file.sourceRevision}/${file.upstreamPath}`
      } else if (key === 'sha256') file.sha256 = '0'.repeat(64)
      else if (key === 'bytes') { file.bytes++; changed.model.totalBytes++ }
      else file[key] += '-different'
      assert.notEqual(modelBundlePayload(changed.model), modelBundlePayload(manifest.model))
      assert.notEqual(modelCachePayload(changed), modelCachePayload(manifest))
      await assert.rejects(verifyModelBundle(changed.model, hash), /bundle identity differs/)
      assert.throws(() => assertReviewedComposite(changed), /Unreviewed/)
    }
  }
  const unknown = structuredClone(manifest.model)
  unknown.revision = baseline.model.revision
  assert.throws(() => modelBundlePayload(unknown), /explicit model composition/)
})

test('rejects missing/duplicate/extra component fields, unsafe paths and fabricated current-revision encoder URLs', () => {
  const candidates = []
  const missing = structuredClone(manifest); missing.model.files.pop(); candidates.push(missing)
  const duplicate = structuredClone(manifest); duplicate.model.files[1] = duplicate.model.files[0]; candidates.push(duplicate)
  for (const badPath of ['/tmp/outside', '../outside', 'a/../outside', './outside']) {
    const changed = structuredClone(manifest); changed.model.files[0].localPath = badPath; candidates.push(changed)
  }
  const extra = structuredClone(manifest); extra.model.files[0].fallback = true; candidates.push(extra)
  const dishonest = structuredClone(manifest)
  dishonest.model.files.find((file) => file.path.includes('encoder_model')).url = baseline.model.files.find((file) => file.path.includes('encoder_model')).url
  candidates.push(dishonest)
  for (const candidate of candidates) assert.throws(() => modelBundlePayload(candidate.model))
  const lookup = pinnedModelFileLookup(manifest.model, 'http://127.0.0.1:5201')
  const encoder = manifest.model.files.find((file) => file.path.includes('encoder_model'))
  assert.equal(lookup.get(encoder.url), encoder)
  assert.equal(lookup.get(`/models/${manifest.model.id}/${encoder.path}`), encoder)
  assert.equal(lookup.get(baseline.model.files.find((file) => file.path.includes('encoder_model')).url), undefined)
})

test('source-only preparation and runner preflight rehash all actual components without modifying any input or manifest', async () => {
  const before = await readFile(manifestPath)
  const prepared = await compositePreparation(root)
  assert.deepEqual(prepared.manifest, manifest)
  assert.equal(prepared.verification.nativeExecution, false)
  assert.equal(prepared.verification.originalEncoderPreserved, true)
  assert.equal(prepared.verification.unchangedRuntimeAndNotices, 11)
  assert.equal(prepared.verification.unchangedFixtures, 5)
  assert.deepEqual(await verifyPreparedComposite(root, manifest), prepared.verification)
  assert.deepEqual(await readFile(manifestPath), before)
  assert.equal(prepared.writes.length, 4)
})

test('missing and tampered components reject preparation before any proposed writes', async () => {
  for (const file of COMPOSITE_FILES) {
    await assert.rejects(verifiedFile(file.localPath, file, async () => { throw new Error('Missing selected component') }), /Missing/)
    await assert.rejects(verifiedFile(file.localPath, file, async () => Buffer.from([0])), /Frozen component differs/)
  }
  const filename = path.join(root, COMPOSITE_FILES[0].localPath)
  const original = await readFile(filename), tampered = Buffer.from(original)
  tampered[0] ^= 1
  const before = await readFile(manifestPath)
  await assert.rejects(compositePreparation(root, (name) => name === filename ? Promise.resolve(tampered) : readFile(name)), /Frozen component differs/)
  assert.deepEqual(await readFile(manifestPath), before)
  assert.deepEqual(await readFile(filename), original)
})
