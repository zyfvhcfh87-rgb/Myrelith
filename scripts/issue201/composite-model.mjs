// Pure identities for the exact reviewed encoder-only laboratory composition.
export const CANDIDATE04_MANIFEST_SHA256 = '4aebb4adbd8c0a00615065f4dd3c0d1da5259e2daf5a37f71489e0c5732470e7'
export const COMPOSITE_FILES = Object.freeze([
  {
    "path": "config.json",
    "sourceRepository": "Xenova/whisper-tiny",
    "sourceRevision": "5332fcc35e32a33b86612b9a57a89be7906102b1",
    "upstreamPath": "config.json",
    "localPath": ".tmp/issue201-package-probe/model/config.json",
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/config.json",
    "bytes": 2248,
    "sha256": "2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94"
  },
  {
    "path": "generation_config.json",
    "sourceRepository": "Xenova/whisper-tiny",
    "sourceRevision": "5332fcc35e32a33b86612b9a57a89be7906102b1",
    "upstreamPath": "generation_config.json",
    "localPath": ".tmp/issue201-package-probe/model/generation_config.json",
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/generation_config.json",
    "bytes": 3716,
    "sha256": "68ac791fcb4999461a313472125042934656240ba1cba7d1c2627fcbb19ac24c"
  },
  {
    "path": "preprocessor_config.json",
    "sourceRepository": "Xenova/whisper-tiny",
    "sourceRevision": "5332fcc35e32a33b86612b9a57a89be7906102b1",
    "upstreamPath": "preprocessor_config.json",
    "localPath": ".tmp/issue201-package-probe/model/preprocessor_config.json",
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/preprocessor_config.json",
    "bytes": 339,
    "sha256": "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d"
  },
  {
    "path": "tokenizer.json",
    "sourceRepository": "Xenova/whisper-tiny",
    "sourceRevision": "5332fcc35e32a33b86612b9a57a89be7906102b1",
    "upstreamPath": "tokenizer.json",
    "localPath": ".tmp/issue201-package-probe/model/tokenizer.json",
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/tokenizer.json",
    "bytes": 2480466,
    "sha256": "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566"
  },
  {
    "path": "tokenizer_config.json",
    "sourceRepository": "Xenova/whisper-tiny",
    "sourceRevision": "5332fcc35e32a33b86612b9a57a89be7906102b1",
    "upstreamPath": "tokenizer_config.json",
    "localPath": ".tmp/issue201-package-probe/model/tokenizer_config.json",
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/tokenizer_config.json",
    "bytes": 282683,
    "sha256": "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce"
  },
  {
    "path": "onnx/encoder_model_quantized.onnx",
    "sourceRepository": "Xenova/whisper-tiny",
    "sourceRevision": "ce70c25689c3694faf5ec8206517cd53f0cfb03f",
    "upstreamPath": "onnx/encoder_model_quantized.onnx",
    "localPath": ".tmp/issue201-model-alternatives/encoder-2023-07.onnx",
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/ce70c25689c3694faf5ec8206517cd53f0cfb03f/onnx/encoder_model_quantized.onnx",
    "bytes": 10113248,
    "sha256": "ca9d7bb2836193704b7e2435e3bbadbed985ac3a79ab7406b244b8865ab1a5c0"
  },
  {
    "path": "onnx/decoder_model_merged_quantized.onnx",
    "sourceRepository": "Xenova/whisper-tiny",
    "sourceRevision": "5332fcc35e32a33b86612b9a57a89be7906102b1",
    "upstreamPath": "onnx/decoder_model_merged_quantized.onnx",
    "localPath": ".tmp/issue201-package-probe/model/onnx/decoder_model_merged_quantized.onnx",
    "url": "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/onnx/decoder_model_merged_quantized.onnx",
    "bytes": 30727765,
    "sha256": "6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0"
  }
].map((file) => Object.freeze(file)))
export const SINGLETON_ENCODER_POLICY = Object.freeze({ sessionKey: 'model', inputNames: Object.freeze(['input_features']),
  expectedOutputNames: Object.freeze(['last_hidden_state']), fetchNames: Object.freeze(['last_hidden_state']) })

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
export function modelCachePayload(manifest) {
  return JSON.stringify({ modelBundle: modelBundlePayload(manifest.model), bundleId: manifest.model.bundleId,
    runtime: manifest.runtime.transformerVersion, ort: manifest.runtime.ortVersion, common: manifest.runtime.commonVersion,
    device: manifest.runtime.device, dtype: manifest.runtime.dtype, threads: manifest.runtime.threads,
    artifacts: manifest.runtime.artifacts?.map(({ name, sha256 }) => ({ name, sha256 })),
    sessionOptions: manifest.runtime.sessionOptions, encoderFetchPolicy: manifest.runtime.encoderFetchPolicy })
}
/** Worker-side pin guard, before runtime import; runtime allocation still needs measurement. */
export function assertReviewedComposite(manifest) {
  const expected = COMPOSITE_FILES
  if (manifest.model.id !== 'Xenova/whisper-tiny' || manifest.model.configurationRevision !== '5332fcc35e32a33b86612b9a57a89be7906102b1'
    || JSON.stringify(manifest.model.files) !== JSON.stringify(expected)
    || manifest.model.totalBytes !== 43_610_465
    || JSON.stringify(manifest.runtime.encoderFetchPolicy) !== JSON.stringify(SINGLETON_ENCODER_POLICY)) throw new Error('Unreviewed encoder composition or IO contract')
  modelBundlePayload(manifest.model)
}
