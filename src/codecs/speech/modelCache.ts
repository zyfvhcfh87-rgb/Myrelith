/** Exact origin-local model transaction; caller owns acquisition cancellation. */
import { SPEECH_MODEL, SPEECH_CACHE_PREFIX, SPEECH_REGISTRY, speechModelHeaders, validSpeechCacheName } from '../../domain/speechModel'
export interface InstalledSpeechModel { name: string; manifestDigest: string; bundleId: string; revision: string; bytes: number }
const registryKey = () => new URL('speech-model-registry-v1', location.origin).href
export const hashSpeechBytes = async (bytes: ArrayBuffer): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
/** One fixed allocation; forged headers cannot expand the read or chunk-object count. */
export async function readBoundedSpeechResponse(response: Response, limit: number, exact = true,
  signal?: AbortSignal, progress: (fraction: number) => void = () => {}): Promise<ArrayBuffer> {
  if (!response.ok || !response.body) throw new Error('Speech asset body is unavailable')
  const bytes = new Uint8Array(limit), reader = response.body.getReader()
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  let count = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const step = await reader.read()
      if (step.done) break
      if (step.value.byteLength > limit - count) throw new Error('Speech asset body exceeds its byte bound')
      bytes.set(step.value, count); count += step.value.byteLength
      progress(count / limit)
    }
    signal?.throwIfAborted()
    if (exact && count !== limit) throw new Error('Speech asset body is truncated')
    return exact || count === limit ? bytes.buffer : bytes.buffer.slice(0, count)
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
async function registryRecord(response: Response): Promise<InstalledSpeechModel> {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedSpeechResponse(response, 2048, false))) as InstalledSpeechModel
}
export async function readSpeechModel(name: string): Promise<ArrayBuffer> {
  if (!validSpeechCacheName(name)) throw new Error('Unexpected speech model cache identity')
  const cache = await caches.open(name), response = await cache.match(SPEECH_MODEL.url)
  if (!response || Object.entries(speechModelHeaders()).some(([key, expected]) => response.headers.get(key) !== expected)) throw new Error('The cached speech model is incomplete or has different provenance. Remove and reinstall it.')
  const bytes = await readBoundedSpeechResponse(response, SPEECH_MODEL.bytes)
  if (bytes.byteLength !== SPEECH_MODEL.bytes || await hashSpeechBytes(bytes) !== SPEECH_MODEL.sha256) throw new Error('The cached speech model failed its integrity check. Remove and reinstall it.')
  return bytes
}
export async function installedSpeechModel(): Promise<InstalledSpeechModel | null> {
  if (!(await caches.keys()).includes(SPEECH_REGISTRY)) return null
  const response = await (await caches.open(SPEECH_REGISTRY)).match(registryKey())
  if (!response) return null
  const value = await registryRecord(response)
  if (!validSpeechCacheName(value.name) || value.manifestDigest !== SPEECH_MODEL.manifestDigest || value.bundleId !== SPEECH_MODEL.bundleId
    || value.revision !== SPEECH_MODEL.revision || value.bytes !== SPEECH_MODEL.bytes) throw new Error('The speech model registry has different provenance. Remove and reinstall it.')
  const entry = await (await caches.open(value.name)).match(SPEECH_MODEL.url)
  if (!entry || Object.entries(speechModelHeaders()).some(([key, expected]) => entry.headers.get(key) !== expected)) throw new Error('The installed speech model is incomplete. Remove and reinstall it.')
  return value
}
export async function installSpeechModel(file: File | null, signal: AbortSignal, progress: (fraction: number) => void): Promise<InstalledSpeechModel> {
  if (file && (file.name !== SPEECH_MODEL.file || file.size !== SPEECH_MODEL.bytes)) throw new Error(`Select the exact ${SPEECH_MODEL.file} (${SPEECH_MODEL.bytes} bytes).`)
  signal.throwIfAborted()
  const registry = await caches.open(SPEECH_REGISTRY), previousResponse = await registry.match(registryKey())
  const previous = previousResponse ? await registryRecord(previousResponse.clone()) : null
  const names = (await caches.keys()).filter(validSpeechCacheName)
  // Count every owned staged/committed file, including an interrupted earlier install.
  if ((names.length + 1) * SPEECH_MODEL.bytes > SPEECH_MODEL.cacheLimit) throw new Error('Speech cache capacity is insufficient. Remove the existing model before retrying.')
  const name = `${SPEECH_CACHE_PREFIX}${crypto.randomUUID()}`
  let published = false
  try {
    const response = file ? new Response(file) : await fetch(SPEECH_MODEL.url, { signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok || !response.body) throw new Error('The speech model could not be downloaded')
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) !== SPEECH_MODEL.bytes) throw new Error('Speech model download length differs')
    const bytes = await readBoundedSpeechResponse(response, SPEECH_MODEL.bytes, true, signal, progress)
    if (await hashSpeechBytes(bytes) !== SPEECH_MODEL.sha256) throw new Error('Speech model integrity check failed')
    const count = bytes.byteLength
    const blob = new Blob([bytes])
    signal.throwIfAborted()
    await (await caches.open(name)).put(SPEECH_MODEL.url, new Response(blob, { headers: speechModelHeaders() }))
    signal.throwIfAborted()
    const record: InstalledSpeechModel = { name, manifestDigest: SPEECH_MODEL.manifestDigest, bundleId: SPEECH_MODEL.bundleId,
      revision: SPEECH_MODEL.revision, bytes: count }
    await registry.put(registryKey(), new Response(JSON.stringify(record)))
    if (signal.aborted) {
      if (previousResponse) await registry.put(registryKey(), previousResponse)
      else await registry.delete(registryKey())
      signal.throwIfAborted()
    }
    published = true
    if (previous && validSpeechCacheName(previous.name) && previous.name !== name) await caches.delete(previous.name)
    return record
  } finally { if (!published) await caches.delete(name) }
}
export async function removeSpeechModel(): Promise<void> {
  for (const name of await caches.keys()) if (name === SPEECH_REGISTRY || validSpeechCacheName(name)) {
    if (!await caches.delete(name)) throw new Error('The speech model cache could not be removed')
  }
}
