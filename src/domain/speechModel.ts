/** Exact supervisor-approved runtime09 candidate. No runtime or model acquisition. */
export const SPEECH_MODEL = Object.freeze({ id: 'ggerganov/whisper.cpp', file: 'ggml-tiny-q8_0.bin',
  revision: '5359861c739e955e79d9a303bcbc70fb988958b1', bytes: 43_537_433,
  sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca',
  bundleId: 'sha256:6f4ab890b02876493211844b95d622da99199d8abb56ec54f6e37ca425091370',
  manifestDigest: '5f103277604fce712a9824551ce4dbca76434d5c3eed3de36b8cdc68544a0c5a',
  runtimeVersion: '1.9.3-dev', cacheLimit: 96 * 1024 * 1024,
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny-q8_0.bin',
})
export const SPEECH_WASM = Object.freeze({ fileName: 'myrelith-whisper.wasm', bytes: 1_198_548,
  sha256: '2f05c1ba7a828ba93a5ab1c7dd752f0d055360d02aa23edc9b60572424e01ef2' })
export const SPEECH_GLUE = Object.freeze({ bytes: 22_350,
  sha256: 'db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7' })
export const SPEECH_CACHE_PREFIX = 'myrelith-speech-model-v1-'
export const SPEECH_REGISTRY = 'myrelith-speech-registry-v1'
export function validSpeechCacheName(value: unknown): value is string {
  return typeof value === 'string' && /^myrelith-speech-model-v1-[a-f0-9-]{36}$/u.test(value)
}
export function speechModelHeaders(): Record<string, string> {
  return { 'content-length': String(SPEECH_MODEL.bytes), 'x-sha256': SPEECH_MODEL.sha256,
    'x-model-bundle': SPEECH_MODEL.bundleId, 'x-source-revision': SPEECH_MODEL.revision,
    'x-source-repository': SPEECH_MODEL.id, 'x-upstream-path': SPEECH_MODEL.file,
    'x-candidate-manifest': SPEECH_MODEL.manifestDigest }
}
