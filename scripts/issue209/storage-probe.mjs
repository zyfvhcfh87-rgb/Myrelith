// Disposable browser harness. The recording path never assembles the whole WAV in JS memory.
let worker
let id = 0
const pending = new Map()
let inFlight = 0
let peakInFlight = 0
const LIMIT = 64 * 1024
const BATCH = 16 * 1024

function start() {
  worker = new Worker('/storage-probe-worker.js')
  worker.onmessage = ({ data }) => {
    const operation = pending.get(data.id)
    if (!operation) return
    pending.delete(data.id)
    inFlight -= operation.bytes
    if (data.error) operation.reject(Object.assign(new Error(data.error.message), { name: data.error.name }))
    else operation.resolve(data.result)
  }
  worker.onerror = (error) => {
    for (const operation of pending.values()) operation.reject(new Error(error.message))
    pending.clear(); inFlight = 0
  }
}

function command(command, args = {}, buffer) {
  const bytes = buffer?.byteLength ?? 0
  if (inFlight + bytes > LIMIT) throw new Error('BackpressureOverrun')
  inFlight += bytes
  peakInFlight = Math.max(inFlight, peakInFlight)
  const nextId = ++id
  return new Promise((resolve, reject) => {
    pending.set(nextId, { resolve, reject, bytes })
    worker.postMessage({ id: nextId, command, ...args, buffer }, buffer ? [buffer] : [])
  })
}

function batch(index) {
  const buffer = new ArrayBuffer(BATCH)
  const samples = new Int16Array(buffer)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(2 * Math.PI * 440 * (index * samples.length + i) / 48000) * 4000)
  return buffer
}

async function verify(name, expected) {
  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle('issue209-storage-probe')
  const file = await (await directory.getFileHandle(`${name}.wav`)).getFile()
  if (file.size !== expected + 44) throw new Error(`Length ${file.size} != ${expected + 44}`)
  // Decoder verification only for this small disposable fixture; production must stream inspection.
  const context = new AudioContext({ sampleRate: 48000 })
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer())
    if (decoded.numberOfChannels !== 1 || decoded.sampleRate !== 48000 || decoded.length !== expected / 2)
      throw new Error(`Decoded ${decoded.length} frames, expected ${expected / 2}`)
    return { fileBytes: file.size, decodedFrames: decoded.length, durationSeconds: decoded.duration }
  } finally { await context.close() }
}

async function remove(name) {
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('issue209-storage-probe')
  await directory.removeEntry(`${name}.wav`)
  await directory.removeEntry(`${name}.checkpoint`)
  return !(await Array.fromAsync(directory.keys())).some((entry) => entry.startsWith(name))
}

window.probe = {
  start,
  command,
  batch,
  verify,
  remove,
  get metrics() { return { peakInFlight, pending: pending.size, inFlight } },
  terminate() { worker.terminate(); pending.clear(); inFlight = 0; worker = null },
  async estimate() { const { usage, quota } = await navigator.storage.estimate(); return { usage, quota } },
}
