// Public LibriSpeech recording (CC BY 4.0): https://www.openslr.org/12
// Fetch only for explicit local browser QA; no recording is bundled with the app.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = process.argv[2]
if (!output) throw new Error('Usage: node scripts/issue194/fetch-speech-fixture.mjs /tmp/issue194-speech.wav')
const path = resolve(output)
const digest = '4798e34d9a323ed835ae6055172236f8965dd5ccf146c25758711023ecc8b2e6'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const existing = await readFile(path).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; return null })
if (existing) {
  if (hash(existing) !== digest) throw new Error('Destination already contains a different file')
} else {
  async function boundedFetch(url, limit) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok || !response.body) throw new Error('Public fixture download failed')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw new Error('Public fixture exceeded its read limit')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  const index = JSON.parse((await boundedFetch(
    'https://datasets-server.huggingface.co/first-rows?dataset=hf-internal-testing%2Flibrispeech_asr_dummy&config=clean&split=validation',
    512_000,
  )).toString('utf8'))
  const row = index.rows?.find((item) => item.row_idx === 4)?.row
  const url = new URL(row?.audio?.[0]?.src)
  const revision = '5be91486e11a2d616f4ec5db8d3fd248585ac07a'
  const expectedPath = `/assets/hf-internal-testing/librispeech_asr_dummy/--/${revision}/--/clean/validation/4/audio/audio.wav`
  if (row.id !== '1272-128104-0004' || url.origin !== 'https://datasets-server.huggingface.co' || url.pathname !== expectedPath) {
    throw new Error('Public recording identity changed; review the fixture before updating it')
  }
  const bytes = await boundedFetch(url, 2_000_000)
  if (hash(bytes) !== digest) throw new Error('Public recording bytes changed; expected the documented SHA-256')
  await writeFile(path, bytes, { flag: 'wx' })
}
process.stdout.write(`Verified LibriSpeech 1272-128104-0004: ${path}\nSHA-256: ${digest}\n`)
