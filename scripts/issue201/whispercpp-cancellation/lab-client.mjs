import { modelCachePayload, verifyCandidate } from './candidate.mjs'
// Lab-only controller for observable acquisition/cache/worker/project generations.
const manifest = await (await fetch('/manifest.json')).json()
const events = []
const record = (event) => {
  if (events.length >= 5_000) throw new Error('Laboratory event budget exceeded')
  events.push({ at: performance.now(), ...event })
}
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
await verifyCandidate(manifest, digest)
const modelIdentity = await digest(new TextEncoder().encode(modelCachePayload(manifest)))
const registryName = 'myrelith-issue201-whispercpp-lab-registry'
const registryKey = `${location.origin}/model-registry`
let generation = 1
let acquisition = null
let owner = null
let requestSequence = 0
let operationSequence = 0
let phase = 'idle'
let lastCleanup = null
let admissionFailure = null
const state = () => ({ generation, phase, workerOwners: owner ? 1 : 0,
  acquisitionOwners: acquisition ? 1 : 0, admissionFailure, lastCleanup, events: events.slice() })
const zeroLedger = ledger => ledger?.modelOwners === 0 && ledger.inputOwners === 0
  && ledger.sampleOwners === 0 && ledger.pcmBytes === 0
  && Number.isSafeInteger(ledger.acquiredSamples) && ledger.acquiredSamples >= 0
  && ledger.acquiredSamples === ledger.closedSamples
function terminateOwner(current, mode, reason, started, ledger = null) {
  current.worker.terminate()
  const cooperativeZero = mode.startsWith('cooperative') && zeroLedger(ledger)
  if (!cooperativeZero) admissionFailure = 'Speech cleanup was not acknowledged. Reload before starting another speech job.'
  lastCleanup = { mode, reason, elapsedMs: performance.now() - started, cooperativeZero, ledger }
  record({ type: 'cleanup', ...lastCleanup })
  if (owner === current) owner = null
  phase = admissionFailure ? 'unavailable' : 'idle'
}

async function installedCache() {
  const registry = await caches.open(registryName)
  const response = await registry.match(registryKey)
  if (!response) throw new Error('No local speech model is installed')
  const record = await response.json()
  if (record.identity !== modelIdentity || record.bundleId !== manifest.model.bundleId || record.configurationRevision !== manifest.model.configurationRevision || record.bytes !== manifest.model.totalBytes) throw new Error('Model registry provenance mismatch')
  const cache = await caches.open(record.name)
  for (const file of manifest.model.files) {
    const entry = await cache.match(file.url)
    if (!entry || Number(entry.headers.get('content-length')) !== file.bytes || entry.headers.get('x-sha256') !== file.sha256
      || entry.headers.get('x-model-bundle') !== manifest.model.bundleId || entry.headers.get('x-source-revision') !== file.sourceRevision
      || entry.headers.get('x-source-repository') !== file.sourceRepository || entry.headers.get('x-upstream-path') !== file.upstreamPath) throw new Error('Model cache is incomplete')
    const bytes = await entry.arrayBuffer()
    if (bytes.byteLength !== file.bytes || await digest(bytes) !== file.sha256) throw new Error('Model cache digest mismatch')
  }
  return record
}

async function installModel({ byteLimit = manifest.thresholds.modelCacheByteLimit, delayMs = 0,
  pauseAt = null, pauseMs = 0, localFiles = null } = {}) {
  const operation = operationSequence + 1
  await cancel('new-acquisition')
  if (operation !== operationSequence) throw new Error('Acquisition superseded')
  if (admissionFailure) throw new Error(admissionFailure)
  if (localFiles !== null && (!Array.isArray(localFiles) || localFiles.length !== manifest.model.files.length
    || new Set(localFiles.map((entry) => entry.path)).size !== localFiles.length
    || localFiles.some((entry) => !(entry.file instanceof File) || !manifest.model.files.some((file) => file.path === entry.path && file.bytes === entry.file.size)))) throw new Error('Invalid local model selection')
  const token = { generation, abort: new AbortController(), promise: null }
  acquisition = token
  phase = 'acquisition'
  const name = `myrelith-issue201-whispercpp-lab-model-${crypto.randomUUID()}`
  token.promise = (async () => {
    const registry = await caches.open(registryName)
    const previousResponse = await registry.match(registryKey)
    const previous = previousResponse ? await previousResponse.json() : null
    // Account for old committed + full staged model before any write/eviction.
    if ((previous?.bytes ?? 0) + manifest.model.totalBytes > byteLimit) throw new Error('Model cache capacity is insufficient')
    const candidate = await caches.open(name)
    let published = false
    try {
      let bytesTotal = 0
      for (const file of manifest.model.files) {
        token.abort.signal.throwIfAborted()
        if (token.generation !== generation) throw new Error('Project changed during acquisition')
        record({ type: 'acquisition-file', file: file.path })
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        const local = localFiles?.find((entry) => entry.path === file.path)?.file
        const response = local ? new Response(local, { headers: { 'content-length': String(local.size) } })
          : await fetch(`/model/${file.path}`, { signal: token.abort.signal, cache: 'no-store' })
        if (!response.ok || Number(response.headers.get('content-length')) !== file.bytes) throw new Error('Model download length differs')
        const chunks = []
        let count = 0
        for await (const chunk of response.body) {
          count += chunk.byteLength
          if (count > file.bytes) throw new Error('Model stream exceeded its file bound')
          chunks.push(chunk)
        }
        const blob = new Blob(chunks)
        const bytes = await blob.arrayBuffer()
        if (count !== file.bytes || await digest(bytes) !== file.sha256) throw new Error('Model download digest differs')
        token.abort.signal.throwIfAborted()
        record({ type: 'cache-write', file: file.path })
        await candidate.put(file.url, new Response(blob, { headers: { 'content-length': String(count), 'x-sha256': file.sha256, 'x-model-bundle': manifest.model.bundleId, 'x-source-revision': file.sourceRevision, 'x-source-repository': file.sourceRepository, 'x-upstream-path': file.upstreamPath } }))
        if (pauseAt === 'cache-write') {
          phase = 'cache-write-pause'
          await new Promise((resolve) => setTimeout(resolve, pauseMs))
          token.abort.signal.throwIfAborted()
          phase = 'acquisition'
        }
        bytesTotal += count
      }
      token.abort.signal.throwIfAborted()
      if (token.generation !== generation) throw new Error('Project changed before model publication')
      phase = 'cache-commit'
      record({ type: 'cache-commit' })
      await registry.put(registryKey, new Response(JSON.stringify({ name, identity: modelIdentity, bundleId: manifest.model.bundleId, configurationRevision: manifest.model.configurationRevision, bytes: bytesTotal })))
      if (pauseAt === 'cache-commit') {
        phase = 'cache-commit-pause'
        await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
      // An abort racing the registry write must restore the old complete record.
      if (token.abort.signal.aborted || token.generation !== generation) {
        if (previous) await registry.put(registryKey, new Response(JSON.stringify(previous)))
        else await registry.delete(registryKey)
        throw new Error('Cancelled model publication rolled back')
      }
      published = true
      if (previous?.name && previous.name !== name) await caches.delete(previous.name)
      return { bytes: bytesTotal, name }
    } finally {
      if (!published) await caches.delete(name)
      if (acquisition === token) acquisition = null
      phase = 'idle'
    }
  })()
  try { return await token.promise }
  finally { if (acquisition === token) acquisition = null; phase = 'idle' }
}

async function closeWorker(reason) {
  const current = owner
  if (!current) return
  if (current.cleanupPromise) return current.cleanupPromise
  const started = performance.now()
  const wasIdle = current.idle
  const remainingPhaseMs = wasIdle ? 0 : Math.max(0, current.deadlineAt - started)
  current.retiring = true
  phase = 'disposing'
  // Reject the user's request now, but keep admission until native disposal.
  current.reject?.(new Error(`Speech cancelled: ${reason}`))
  current.cleanupPromise = new Promise((resolve) => {
    let settled = false
    const finish = (mode, ledger = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      terminateOwner(current, mode, reason, started, ledger)
      resolve()
    }
    // A running synchronous WASM call cannot handle cancellation until its
    // existing bounded window returns. Idle disposal retains the 100ms bound.
    const timer = setTimeout(() => finish('terminated-deadline'),
      remainingPhaseMs + manifest.thresholds.terminationFallbackMs)
    current.onDispose = (data) => finish(data.cooperativeZero === true && zeroLedger(data.ledger)
      ? 'cooperative' : 'terminated-unacknowledged', data.ledger)
    try { current.worker.postMessage({ type: wasIdle ? 'dispose' : 'cancel' }) }
    catch { finish('terminated-post-error') }
  }).finally(() => {
    if (owner === current) owner = null
  })
  return current.cleanupPromise
}

async function cancel(reason = 'cancel') {
  operationSequence++
  const current = acquisition
  if (current) {
    current.abort.abort(new DOMException(reason, 'AbortError'))
    await current.promise.catch(() => {})
  }
  await closeWorker(reason)
  phase = admissionFailure ? 'unavailable' : 'idle'
  return state()
}

async function transcribeFixture(name, { seconds, language, repeatSeconds = null } = {}) {
  const operation = operationSequence + 1
  await cancel('new-job')
  if (operation !== operationSequence) throw new Error('Speech request superseded')
  if (admissionFailure) throw new Error(admissionFailure)
  const boundGeneration = generation
  const installed = await installedCache()
  const fixture = manifest.fixtures.find((item) => item.name === name)
  if (!fixture && name !== 'silence' && name !== 'corrupt') throw new Error('Unknown lab fixture')
  let blob = await (await fetch(`/fixtures/${name}.wav`)).blob()
  if (repeatSeconds !== null) {
    if (name !== 'english' || repeatSeconds !== 300) throw new Error('Only the frozen 300-second English stress derivative is supported')
    blob = await (await fetch('/fixtures/english-300.wav')).blob()
  }
  if (boundGeneration !== generation || operation !== operationSequence) throw new Error('Stale source preparation')
  const worker = new Worker('/model-worker.mjs', { type: 'module' })
  const current = { worker, generation, idle: false, retiring: false, reject: null, onDispose: null, cleanupPromise: null,
    deadlineAt: performance.now() + manifest.thresholds.maxWindowWallMs }
  owner = current
  phase = 'worker-created'
  const requestId = ++requestSequence
  return new Promise((resolve, reject) => {
    current.reject = reject
    let completed = null
    let loadMs = null
    let phaseDeadline = null
    const deadline = setTimeout(() => { cancel('job-deadline').then(() => reject(new Error('Job deadline exceeded'))) }, 2_000_000)
    const fail = (error, recordParentError = true, acknowledgement = null) => {
      if (owner !== current) return
      if (current.retiring) { current.onDispose?.({ cooperativeZero: false, ledger: null }); return }
      clearTimeout(deadline)
      clearTimeout(phaseDeadline)
      error.code ??= loadMs === null ? 'initialization-failed' : 'worker-runtime-failed'
      error.phase ??= phase
      if (recordParentError) record({ type: 'error', origin: 'parent', code: error.code, phase: error.phase, message: error.message })
      const terminationStarted = performance.now()
      terminateOwner(current, acknowledgement?.cooperativeZero === true && zeroLedger(acknowledgement.ledger)
        ? 'cooperative-error' : 'terminated-error', error.code, terminationStarted, acknowledgement?.ledger)
      reject(error)
    }
    current.reject = (error) => { clearTimeout(deadline); clearTimeout(phaseDeadline); reject(error) }
    worker.onmessage = ({ data }) => {
      if (data.type === 'disposed') { current.onDispose?.(data); return }
      if (owner !== current || current.retiring || generation !== current.generation) { record({ type: 'late-message-rejected', messageType: data.type }); return }
      record(data)
      if (data.type === 'phase') {
        phase = data.phase
        clearTimeout(phaseDeadline)
        const phaseMs = ['infer', 'model-load'].includes(data.phase) ? manifest.thresholds.maxWindowWallMs : 10_000
        current.deadlineAt = performance.now() + phaseMs
        phaseDeadline = setTimeout(() => fail(new Error(`Worker ${data.phase} deadline exceeded`)),
          phaseMs)
      }
      if (data.type === 'ready') {
        loadMs = data.loadMs
        worker.postMessage({ type: 'transcribe', requestId, blob,
          seconds: repeatSeconds ?? seconds ?? fixture?.durationSeconds ?? 1,
          language: language ?? (name === 'french' ? 'french' : 'english') })
      }
      if (data.type === 'complete') completed = data
      if (data.type === 'idle' && completed) {
        clearTimeout(deadline)
        clearTimeout(phaseDeadline)
        current.idle = true
        phase = 'idle'
        resolve({ loadMs, ...completed, finalLedger: data.ledger })
      }
      if (data.type === 'error') {
        const error = new Error(data.message)
        error.code = data.code
        error.phase = data.phase
        fail(error, false, data)
      }
    }
    worker.onerror = (event) => fail(new Error(event.message))
    worker.onmessageerror = () => fail(new Error('Worker message decoding failed'))
    // Bound a worker whose module graph never loads or whose first reply never
    // arrives. Later phase deadlines retain the existing 10s/120s ceilings.
    phaseDeadline = setTimeout(() => fail(new Error('Worker startup deadline exceeded')), manifest.thresholds.maxWindowWallMs)
    worker.postMessage({ type: 'initialize', manifest, modelCache: installed.name, modelIdentity })
  })
}

async function replaceProject() {
  generation++
  await cancel('project-replaced')
  return state()
}
async function clearModel() {
  await cancel('clear-model')
  for (const name of await caches.keys()) if (name.startsWith('myrelith-issue201-whispercpp-lab-')) await caches.delete(name)
  return state()
}
async function cacheFacts() {
  const model = await installedCache().catch((error) => ({ error: error.message }))
  const estimate = await navigator.storage.estimate()
  return { model, estimate, cacheNames: (await caches.keys()).filter((name) => name.startsWith('myrelith-issue201-whispercpp-lab-')) }
}
globalThis.lab = { state, installModel, transcribeFixture, cancel, replaceProject, clearModel, cacheFacts,
  resetEvents() { events.length = 0 }, manifest }
document.querySelector('#status').textContent = 'Speech laboratory ready; no model action has run.'
