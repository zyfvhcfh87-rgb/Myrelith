// Laboratory-only exact candidate identity. No factory, worker or WASM is created here.
export const CANDIDATE_MANIFEST_SHA256 = 'e548074185b61b0ad0c996368af7be7de4a29b7b2bf57ca8325267b08f87d3d5'
export const WASM_IDENTITY = Object.freeze({ fileName: 'myrelith-whisper.wasm', bytes: 1198861,
  sha256: '9df26c6b690de120e6f1fb5ce17a25ebb2b016a73f0477b24376f558ee00ce72' })
export const GLUE_IDENTITY = Object.freeze({ fileName: 'myrelith-whisper.mjs', bytes: 22350,
  sha256: 'db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7' })
export async function verifyCandidate(manifest, hash) {
  if (await hash(new TextEncoder().encode(JSON.stringify(manifest))) !== CANDIDATE_MANIFEST_SHA256) throw new Error('Unreviewed whisper.cpp candidate manifest')
  await verifyModelBundle(manifest.model, hash)
}
export function modelCachePayload(manifest) {
  return JSON.stringify({ candidate: CANDIDATE_MANIFEST_SHA256, modelBundle: modelBundlePayload(manifest.model),
    bundleId: manifest.model.bundleId, runtime: manifest.runtime, thresholds: manifest.thresholds, sampling: manifest.sampling })
}
const revision = /^[0-9a-f]{40}$/u
const digest = /^[0-9a-f]{64}$/u
const relative = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/u
const keys = ['path', 'sourceRepository', 'sourceRevision', 'upstreamPath', 'localPath', 'url', 'bytes', 'sha256']
/** Stable source identity, independent of caller key order. No basename fallback. */
export function modelBundlePayload(model) {
  if (model?.kind !== 'local-composite-v1' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(model.id)
    || !revision.test(model.configurationRevision) || !Array.isArray(model.files) || !model.files.length || model.files.length > 7
    || Object.hasOwn(model, 'revision')) throw new Error('Malformed explicit model composition')
  if (Object.keys(model).some((key) => !['kind', 'id', 'configurationRevision', 'totalBytes', 'files', 'licenseProvenance', 'bundleId'].includes(key))) throw new Error('Unknown model composition metadata')
  const seen = new Set()
  const files = model.files.map((file) => {
    if (Object.keys(file).length !== keys.length || keys.some((key) => !Object.hasOwn(file, key))
      || !relative.test(file.path) || !relative.test(file.upstreamPath) || !relative.test(file.localPath)
      || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(file.sourceRepository) || !revision.test(file.sourceRevision)
      || file.url !== `https://huggingface.co/${file.sourceRepository}/resolve/${file.sourceRevision}/${file.upstreamPath}`
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !digest.test(file.sha256) || seen.has(file.path)) throw new Error('Malformed model component identity')
    seen.add(file.path)
    return Object.fromEntries(keys.map((key) => [key, file[key]]))
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (files.reduce((sum, file) => sum + file.bytes, 0) !== model.totalBytes) throw new Error('Model composition byte total differs')
  return JSON.stringify({ kind: model.kind, id: model.id, configurationRevision: model.configurationRevision, totalBytes: model.totalBytes,
    files, licenseProvenance: model.licenseProvenance })
}
export async function verifyModelBundle(model, hash) {
  const actual = `sha256:${await hash(new TextEncoder().encode(modelBundlePayload(model)))}`
  if (model.bundleId !== actual) throw new Error('Model bundle identity differs from the complete file/source table')
  return actual
}
