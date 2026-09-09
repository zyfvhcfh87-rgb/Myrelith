// Read/hash preparation only. No package imports, downloads, graph writes or inference.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CANDIDATE04_MANIFEST_SHA256, COMPOSITE_FILES, SINGLETON_ENCODER_POLICY, assertReviewedComposite,
  modelBundlePayload, verifyModelBundle } from './composite-model.mjs'

const LICENSE_SOURCES = [
  {
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/ce70c25689c3694faf5ec8206517cd53f0cfb03f/README.md",
    "path": "ce70c256-README.md",
    "bytes": 501,
    "sha256": "a48ee7058760c24866e78dbed2f5fc06c1d476680c5dd5c337e22cb254c5eb5e"
  },
  {
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/README.md",
    "path": "5332fcc3-README.md",
    "bytes": 1160,
    "sha256": "cdd395427d195f122aee69c00e34183f2fadd8bc217aef35ca7c43395b96d29d"
  },
  {
    "url": "https://huggingface.co/openai/whisper-tiny/resolve/ed50ab0ea2fc43b928969fd70d5fe21eefdd350f/README.md",
    "path": "openai-2023-05-README.md",
    "bytes": 19787,
    "sha256": "57a3bbbbf1e79369e4d1ced790812a1723b43a256c1b43fc70cc2f3339ae9881"
  }
]

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export async function verifiedFile(filename, expected, read = readFile) {
  const bytes = await read(filename)
  if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error(`Frozen component differs: ${filename}`)
  return bytes
}
export async function compositePreparation(root, read = readFile) {
  const evidence = path.join(root, 'docs/evidence/issue201'), labRoot = path.join(root, '.tmp/issue201-speech-lab')
  const baselineBytes = await read(path.join(evidence, 'encoder-fetch-candidate04-manifest.json'))
  if (hash(baselineBytes) !== CANDIDATE04_MANIFEST_SHA256) throw new Error('Preserved candidate04 manifest changed')
  const baseline = JSON.parse(baselineBytes)
  // Prove the six retained files AND the original encoder remain intact.
  for (const file of baseline.model.files) await verifiedFile(path.join(root, '.tmp/issue201-package-probe/model', file.path), file, read)
  for (const file of COMPOSITE_FILES) await verifiedFile(path.join(root, file.localPath), file, read)
  for (const asset of [...baseline.runtime.artifacts, ...baseline.runtime.notices]) await verifiedFile(path.join(labRoot, 'assets', asset.name), asset, read)
  for (const fixture of baseline.fixtures) await verifiedFile(path.join(labRoot, 'fixtures', `${fixture.name}.wav`), fixture, read)
  for (const fixture of baseline.derivatives) await verifiedFile(path.join(labRoot, 'fixtures', fixture.name), fixture, read)

  const notices = []
  const writes = []
  for (const source of LICENSE_SOURCES) {
    const sourceName = source.path
    const bytes = await verifiedFile(path.join(root, '.tmp/issue201-model-alternatives', sourceName), source, read)
    const name = `model-${sourceName}`
    notices.push({ name, url: source.url, bytes: bytes.length, sha256: hash(bytes) })
    writes.push({ filename: path.join(labRoot, 'assets', name), bytes })
  }
  // The existing pinned text is the unmodified Apache-2.0 template, including
  // its placeholder appendix. Model attribution/history is stated separately.
  const apache = baseline.runtime.notices.find((file) => file.name === 'transformers-LICENSE.txt')
  const apacheBytes = await verifiedFile(path.join(labRoot, 'assets', apache.name), apache, read)
  const name = 'model-Apache-2.0.txt'
  notices.push({ name, source: 'Unmodified Apache-2.0 license text, identical to the pinned transformers-LICENSE.txt; not a model-specific copyright claim.', bytes: apacheBytes.length, sha256: hash(apacheBytes) })
  writes.push({ filename: path.join(labRoot, 'assets', name), bytes: apacheBytes })

  const model = { kind: 'local-composite-v1', id: baseline.model.id, configurationRevision: baseline.model.revision,
    totalBytes: COMPOSITE_FILES.reduce((sum, file) => sum + file.bytes, 0), files: COMPOSITE_FILES,
    licenseProvenance: { originalModel: 'openai/whisper-tiny', originalRevision: 'ed50ab0ea2fc43b928969fd70d5fe21eefdd350f',
      originalDeclaredLicense: 'apache-2.0', historicalConverterDeclaredLicense: null,
      currentConverterDeclaredLicense: 'apache-2.0',
      scope: 'Historical Xenova card has no license field. Original OpenAI card predates the export; current Xenova declaration is recorded separately. No exporter source revision or numerical equivalence is claimed.', notices } }
  model.bundleId = `sha256:${hash(new TextEncoder().encode(modelBundlePayload(model)))}`
  const manifest = { ...baseline, kind: 'issue201-speech-lab-assets-v2', preparedAt: '2026-09-08',
    qualification: 'Reviewed encoder-only local composite source preparation. No inference, numerical parity, RSS or production enablement verdict.',
    runtime: { ...baseline.runtime, encoderFetchPolicy: SINGLETON_ENCODER_POLICY }, model }
  assertReviewedComposite(manifest)
  await verifyModelBundle(model, hash)
  const committedPlusStagedBytes = baseline.model.totalBytes + model.totalBytes
  if (committedPlusStagedBytes > baseline.thresholds.modelCacheByteLimit || model.totalBytes * 2 > baseline.thresholds.modelCacheByteLimit) throw new Error('Composite cache admission exceeds the unchanged limit')
  return { manifest, writes, verification: { preservedCandidate04Sha256: hash(baselineBytes), bundleId: model.bundleId,
    modelBytes: model.totalBytes, candidate04PlusStagedBytes: committedPlusStagedBytes, compositePlusStagedBytes: model.totalBytes * 2,
    cacheByteLimit: baseline.thresholds.modelCacheByteLimit, unchangedRuntimeAndNotices: baseline.runtime.artifacts.length + baseline.runtime.notices.length,
    unchangedFixtures: baseline.fixtures.length + baseline.derivatives.length, retainedCurrentComponents: 6,
    originalEncoderPreserved: true, nativeExecution: false } }
}

/** Runner preflight uses exactly the same composition, before starting a server. */
export async function verifyPreparedComposite(root, manifest) {
  const prepared = await compositePreparation(root)
  if (JSON.stringify(manifest) !== JSON.stringify(prepared.manifest)) throw new Error('Frozen composite manifest differs from the reviewed preparation')
  for (const notice of manifest.model.licenseProvenance.notices) await verifiedFile(path.join(root, '.tmp/issue201-speech-lab/assets', notice.name), notice)
  return prepared.verification
}
