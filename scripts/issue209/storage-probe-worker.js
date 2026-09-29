// Disposable Issue #209 OPFS/WAV recovery proof. This is not production code.
const DIRECTORY = 'issue209-storage-probe'
const RATE = 48000
const HEADER = 44
const SLOT = 32
const CHECKPOINT = 256 * 1024
const MAX_BYTES = 60 * 60 * RATE * 2
let audio
let journal
let committed = 0
let length = 0
let generation = 0
let fault = null

function wavHeader(bytes) {
  const header = new ArrayBuffer(HEADER)
  const view = new DataView(header)
  const label = (at, value) => [...value].forEach((character, index) => view.setUint8(at + index, character.charCodeAt(0)))
  label(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); label(8, 'WAVE')
  label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true)
  view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, bytes, true)
  return new Uint8Array(header)
}

function checkedWrite(handle, bytes, at, injectShort = false) {
  const written = handle.write(injectShort ? bytes.subarray(0, bytes.length / 2) : bytes, { at })
  if (written !== bytes.length) throw new Error(`ShortWrite: ${written}/${bytes.length}`)
}

function slotBytes(sequence, bytes) {
  const result = new Uint8Array(SLOT)
  const view = new DataView(result.buffer)
  view.setUint32(0, 0x32303949, true)
  view.setUint32(4, 1, true)
  view.setUint32(8, sequence, true)
  view.setUint32(12, bytes, true)
  view.setUint32(16, checksum(result.subarray(0, 16)), true)
  view.setUint32(20, 0xfeed2090, true)
  return result
}

function checksum(bytes) {
  let hash = 2166136261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return hash
}

function readSlot(at) {
  const bytes = new Uint8Array(SLOT)
  if (journal.read(bytes, { at }) !== SLOT) return null
  const view = new DataView(bytes.buffer)
  const sequence = view.getUint32(8, true)
  const size = view.getUint32(12, true)
  if (view.getUint32(0, true) !== 0x32303949 || view.getUint32(4, true) !== 1 ||
      view.getUint32(16, true) !== checksum(bytes.subarray(0, 16)) ||
      view.getUint32(20, true) !== 0xfeed2090 || size % 2 || size > audio.getSize() - HEADER) return null
  return { sequence, size }
}

function checkpoint() {
  audio.flush()
  const next = generation + 1
  checkedWrite(journal, slotBytes(next, length), (next % 2) * SLOT)
  journal.flush()
  committed = length
  generation = next
  checkedWrite(audio, wavHeader(committed), 0)
  audio.flush()
}

function close() {
  try { audio?.close() } finally { journal?.close(); audio = null; journal = null }
}

async function open(name, recover) {
  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle(DIRECTORY, { create: true })
  const media = await directory.getFileHandle(`${name}.wav`, { create: !recover })
  const metadata = await directory.getFileHandle(`${name}.checkpoint`, { create: !recover })
  audio = await media.createSyncAccessHandle()
  try { journal = await metadata.createSyncAccessHandle() } catch (error) { close(); throw error }
  if (!recover) {
    audio.truncate(0); journal.truncate(0)
    checkedWrite(audio, wavHeader(0), 0); audio.flush()
    checkedWrite(journal, slotBytes(0, 0), 0); journal.flush()
    committed = length = generation = 0
    return { size: audio.getSize() }
  }
  const candidates = [readSlot(0), readSlot(SLOT)].filter(Boolean).sort((a, b) => b.sequence - a.sequence)
  if (!candidates.length) throw new Error('NoValidCheckpoint')
  const latest = candidates[0]
  const physicalBefore = audio.getSize()
  committed = length = latest.size
  generation = latest.sequence
  audio.truncate(HEADER + committed)
  checkedWrite(audio, wavHeader(committed), 0)
  audio.flush()
  return { recoveredBytes: committed, generation, physicalBefore, physicalAfter: audio.getSize() }
}

onmessage = async ({ data }) => {
  try {
    let result
    if (data.command === 'open') result = await open(data.name, false)
    if (data.command === 'recover') result = await open(data.name, true)
    if (data.command === 'fault') { fault = data.kind; result = { fault } }
    if (data.command === 'append') {
      const bytes = new Uint8Array(data.buffer)
      if (bytes.length > 16 * 1024 || bytes.length % 2) throw new Error('InvalidBatch')
      if (length + bytes.length > MAX_BYTES) throw new Error('TakeLimitExceeded')
      if (fault === 'quota') throw new DOMException('Injected quota failure', 'QuotaExceededError')
      checkedWrite(audio, bytes, HEADER + length, fault === 'short')
      length += bytes.length
      if (data.slowMs) { const until = performance.now() + data.slowMs; while (performance.now() < until) { /* worker-only stall */ } }
      if (length - committed >= CHECKPOINT) checkpoint()
      result = { length, committed }
    }
    if (data.command === 'checkpoint') { checkpoint(); result = { length, committed } }
    if (data.command === 'corruptHeader') {
      checkedWrite(audio, new Uint8Array([0, 0, 0, 0]), 0); audio.flush()
      result = { corrupted: true }
    }
    if (data.command === 'corruptLatestSlot') {
      checkedWrite(journal, new Uint8Array(8), (generation % 2) * SLOT); journal.flush()
      result = { corrupted: true }
    }
    if (data.command === 'close') { close(); result = { closed: true } }
    postMessage({ id: data.id, result })
  } catch (error) {
    postMessage({ id: data.id, error: { name: error.name, message: error.message } })
  }
}
