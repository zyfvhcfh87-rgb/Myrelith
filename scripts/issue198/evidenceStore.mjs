import { createHash } from 'node:crypto'
import { open, readdir, readFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const BINARY_NAME = /^(?:source|export-(?:complete|retry)-[0-2])\.mp4$/
export const MAX_BINARY_BYTES = 128 * 1024 * 1024
export const MAX_RECORD_BYTES = 2 * 1024 * 1024
const json = (value) => JSON.stringify(value, (_key, entry) => typeof entry === 'number' && !Number.isFinite(entry)
  ? { nonFiniteNumber: String(entry) } : entry, 2) + '\n'

/** Exclusive files plus fsync: an observed event is durable before its ACK. */
export async function createEvidenceStore(directory) {
  await mkdir(directory, { recursive: false })
  let sequence = 0, closed = false, closing = false, writes = Promise.resolve()
  let closeTask
  const binaries = new Map()
  function enqueue(operation) {
    if (closing || closed) return Promise.reject(new Error('Evidence store is closed'))
    const pending = writes.then(operation)
    writes = pending.catch(() => {})
    return pending
  }
  async function writeRecord(value) {
    if (closed) throw new Error('Evidence store is closed')
    if (sequence >= 20_000) throw new Error('Evidence record count exceeded its bound')
    const content = json({ ...value, sequence, receivedAt: new Date().toISOString() })
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new Error('Evidence record exceeds its byte bound')
    const name = `${String(sequence++).padStart(5, '0')}.json`
    const handle = await open(join(directory, name), 'wx')
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    return name
  }
  async function writeBinary(part) {
    if (closed || !BINARY_NAME.test(part?.name ?? '')) throw new Error('Invalid binary evidence name')
    if (!Number.isSafeInteger(part.totalBytes) || part.totalBytes <= 0 || part.totalBytes > MAX_BINARY_BYTES
      || !Number.isSafeInteger(part.offset) || part.offset < 0 || !Array.isArray(part.bytes)
      || part.bytes.length === 0 || part.bytes.length > 65_536
      || part.bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('Invalid binary evidence chunk')
    let current = binaries.get(part.name)
    if (!current) {
      if (part.offset !== 0) throw new Error('First binary chunk must start at zero')
      current = { offset: 0, totalBytes: part.totalBytes, hash: createHash('sha256'),
        handle: await open(join(directory, `${part.name}.part`), 'wx'), complete: false }
      binaries.set(part.name, current)
    }
    if (current.complete || current.offset !== part.offset || current.totalBytes !== part.totalBytes
      || current.offset + part.bytes.length > current.totalBytes) throw new Error('Binary evidence chunk order/length differs')
    const bytes = Buffer.from(part.bytes)
    let written = 0
    while (written < bytes.length) {
      const result = await current.handle.write(bytes, written, bytes.length - written, current.offset + written)
      if (!result.bytesWritten) throw new Error('Binary evidence write made no progress')
      written += result.bytesWritten
    }
    current.hash.update(bytes); current.offset += bytes.length
    await current.handle.sync()
    if (current.offset === current.totalBytes) {
      await current.handle.close(); current.complete = true
      await rename(join(directory, `${part.name}.part`), join(directory, part.name))
      await writeRecord({ kind: 'binary-complete', name: part.name, bytes: current.offset, sha256: current.hash.digest('hex') })
    }
  }
  async function finalize() {
    await writes
    const partial = []
    for (const [name, value] of binaries) if (!value.complete) {
      await value.handle.sync(); await value.handle.close()
      partial.push({ name, persistedBytes: value.offset, expectedBytes: value.totalBytes })
    }
    await writeRecord({ kind: 'evidence-closed', partial })
    closed = true
    const entries = []
    for (const name of (await readdir(directory)).sort()) {
      const bytes = await readFile(join(directory, name))
      entries.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    const handle = await open(join(directory, 'manifest.json'), 'wx')
    try { await handle.writeFile(json(entries)); await handle.sync() } finally { await handle.close() }
  }
  function close() {
    if (!closeTask) { closing = true; closeTask = finalize() }
    return closeTask
  }
  return { record: (value) => enqueue(() => writeRecord(value)), binary: (part) => enqueue(() => writeBinary(part)), close }
}
