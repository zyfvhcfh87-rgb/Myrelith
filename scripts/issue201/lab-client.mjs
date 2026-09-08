// Lab-only controller for observable acquisition/cache/worker/project generations.
const manifest = await (await fetch('/manifest.json')).json()
const events = []
const record = (event) => {
  if (events.length >= 5_000) throw new Error('Laboratory event budget exceeded')
  events.push({ at: performance.now(), ...event })
}
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
const modelIdentity = await digest(new TextEncoder().encode(JSON.stringify({ model: manifest.model.id,
  revision: manifest.model.revision, files: manifest.model.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  runtime: manifest.runtime.transformerVersion, ort: manifest.runtime.ortVersion })))
const registryName = 'myrelith-issue201-lab-registry'
const registryKey = `${location.origin}/model-registry`
let generation = 1
let acquisition = null
let owner = null
let requestSequence = 0
let operationSequence = 0
let phase = 'idle'
let lastCleanup = null
const state = () => ({ generation, phase, workerOwners: owner ? 1 : 0,
  acquisitionOwners: acquisition ? 1 : 0, lastCleanup, events: events.slice() })

async function installedCache() {
  const registry = await caches.open(registryName)
  const response = await registry.match(registryKey)
  if (!response) throw new Error('No local speech model is installed')
  const record = await response.json()
  if (record.identity !== modelIdentity || record.revision !== manifest.model.revision || record.bytes !== manifest.model.totalBytes) throw new Error('Model registry provenance mismatch')
  const cache = await caches.open(record.name)
  for (const file of manifest.model.files) {
    const entry = await cache.match(file.url)
    if (!entry || Number(entry.headers.get('content-length')) !== file.bytes || entry.headers.get('x-sha256') !== file.sha256) throw new Error('Model cache is incomplete')
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
  if (localFiles !== null && (!Array.isArray(localFiles) || localFiles.length !== manifest.model.files.length
    || new Set(localFiles.map((entry) => entry.path)).size !== localFiles.length
    || localFiles.some((entry) => !(entry.file instanceof File) || !manifest.model.files.some((file) => file.path === entry.path && file.bytes === entry.file.size)))) throw new Error('Invalid local model selection')
  const token = { generation, abort: new AbortController(), promise: null }
  acquisition = token
  phase = 'acquisition'
  const name = `myrelith-issue201-lab-model-${crypto.randomUUID()}`
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
        await candidate.put(file.url, new Response(blob, { headers: { 'content-length': String(count), 'x-sha256': file.sha256 } }))
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
      await registry.put(registryKey, new Response(JSON.stringify({ name, identity: modelIdentity, revision: manifest.model.revision, bytes: bytesTotal })))
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
  if (!current.idle) {
    current.worker.terminate()
    current.reject?.(new Error(`Worker terminated: ${reason}`))
    lastCleanup = { mode: 'terminated-active', reason, elapsedMs: performance.now() - started, cooperativeZero: false }
    record({ type: 'cleanup', ...lastCleanup })
    if (owner === current) owner = null
    return
  }
  current.cleanupPromise = new Promise((resolve) => {
    let settled = false
    const finish = (mode, ledger = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      current.worker.terminate()
      lastCleanup = { mode, reason, elapsedMs: performance.now() - started,
        cooperativeZero: mode === 'cooperative' && ledger.modelOwners === 0 && ledger.inputOwners === 0 && ledger.sampleOwners === 0 && ledger.pcmBytes === 0, ledger }
      record({ type: 'cleanup', ...lastCleanup })
      resolve()
    }
    const timer = setTimeout(() => finish('terminated-deadline'), manifest.thresholds.terminationFallbackMs)
    current.onDispose = (ledger) => finish('cooperative', ledger)
    try { current.worker.postMessage({ type: 'dispose' }) }
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
  phase = 'idle'
  return state()
}

async function transcribeFixture(name, { seconds, language, repeatSeconds = null } = {}) {
  const operation = operationSequence + 1
  await cancel('new-job')
  if (operation !== operationSequence) throw new Error('Speech request superseded')
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
  const current = { worker, generation, idle: false, reject: null, onDispose: null, cleanupPromise: null }
  owner = current
  phase = 'worker-created'
  const requestId = ++requestSequence
  return new Promise((resolve, reject) => {
    current.reject = reject
    let completed = null
    let loadMs = null
    let phaseDeadline = null
    const deadline = setTimeout(() => { cancel('job-deadline').then(() => reject(new Error('Job deadline exceeded'))) }, 2_000_000)
    const fail = (error) => {
      clearTimeout(deadline)
      clearTimeout(phaseDeadline)
      worker.terminate()
      if (owner === current) owner = null
      phase = 'idle'
      reject(error)
    }
    current.reject = (error) => { clearTimeout(deadline); clearTimeout(phaseDeadline); reject(error) }
    worker.onmessage = ({ data }) => {
      if (data.type === 'disposed') { current.onDispose?.(data.ledger); return }
      if (owner !== current || generation !== current.generation) { record({ type: 'late-message-rejected', messageType: data.type }); return }
      record(data)
      if (data.type === 'phase') {
        phase = data.phase
        clearTimeout(phaseDeadline)
        phaseDeadline = setTimeout(() => fail(new Error(`Worker ${data.phase} deadline exceeded`)),
          ['infer', 'model-load'].includes(data.phase) ? manifest.thresholds.maxWindowWallMs : 10_000)
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
      if (data.type === 'error') fail(new Error(data.message))
    }
    worker.onerror = (event) => fail(new Error(event.message))
    worker.onmessageerror = () => fail(new Error('Worker message decoding failed'))
    worker.postMessage({ type: 'initialize', manifest, modelCache: installed.name })
  })
}

async function replaceProject() {
  generation++
  await cancel('project-replaced')
  return state()
}
async function clearModel() {
  await cancel('clear-model')
  for (const name of await caches.keys()) if (name.startsWith('myrelith-issue201-lab-')) await caches.delete(name)
  return state()
}
async function cacheFacts() {
  const model = await installedCache().catch((error) => ({ error: error.message }))
  const estimate = await navigator.storage.estimate()
  return { model, estimate, cacheNames: (await caches.keys()).filter((name) => name.startsWith('myrelith-issue201-lab-')) }
}
globalThis.lab = { state, installModel, transcribeFixture, cancel, replaceProject, clearModel, cacheFacts,
  resetEvents() { events.length = 0 }, manifest }
document.querySelector('#status').textContent = 'Speech laboratory ready; no model action has run.'
