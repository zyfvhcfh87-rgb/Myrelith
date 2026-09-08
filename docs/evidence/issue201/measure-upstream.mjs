/** Pin source/notice facts and the upstream browser dependency lock closure. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const scratch = path.join(root, '.tmp/issue201-package-probe')
await mkdir(scratch, { recursive: true })
const hash = (data) => createHash('sha256').update(data).digest('hex')
async function read(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  let length = 0
  const chunks = []
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > 2_000_000) throw new Error('Source exceeds cap')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
const urls = [
  'https://raw.githubusercontent.com/huggingface/transformers.js/3.8.1/package-lock.json',
  'https://raw.githubusercontent.com/huggingface/transformers.js/3.8.1/LICENSE',
  'https://raw.githubusercontent.com/microsoft/onnxruntime/89f8206ba4/LICENSE',
  'https://raw.githubusercontent.com/microsoft/onnxruntime/89f8206ba4/ThirdPartyNotices.txt',
  'https://huggingface.co/Xenova/whisper-tiny/raw/5332fcc35e32a33b86612b9a57a89be7906102b1/README.md',
]
const sources = []
let lock
for (const url of urls) {
  const bytes = await read(url)
  sources.push({ url, bytes: bytes.length, sha256: hash(bytes) })
  if (url.endsWith('package-lock.json')) {
    lock = JSON.parse(bytes)
    await writeFile(path.join(scratch, 'upstream-package-lock.json'), bytes)
  }
}
function resolveDependency(parent, name) {
  let scope = parent
  for (;;) {
    const key = `${scope ? `${scope}/` : ''}node_modules/${name}`
    if (lock.packages[key]) return key
    if (!scope) throw new Error(`Missing lock resolution: ${parent} -> ${name}`)
    const marker = scope.lastIndexOf('/node_modules/')
    scope = marker < 0 ? '' : scope.slice(0, marker)
  }
}
const queue = ['@huggingface/jinja', 'onnxruntime-web'].map((name) => ({ name, key: resolveDependency('', name) }))
const seen = new Set()
const dependencies = []
for (let index = 0; index < queue.length; index++) {
  if (queue.length > 100) throw new Error('Unexpected browser dependency closure size')
  const { name, key } = queue[index]
  if (seen.has(key)) continue
  seen.add(key)
  const node = lock.packages[key]
  const metadataUrl = `https://registry.npmjs.org/${name}/${node.version}`
  const bytes = await read(metadataUrl)
  const metadata = JSON.parse(bytes)
  const children = Object.entries(node.dependencies ?? {}).map(([child, range]) => ({ name: child, range, key: resolveDependency(key, child) }))
  dependencies.push({ name, path: key, version: node.version, integrity: node.integrity,
    license: metadata.license ?? null, metadataUrl, metadataSha256: hash(bytes),
    dependencies: children })
  queue.push(...children)
}
const result = { checkedAt: new Date().toISOString(),
  scope: 'Upstream locked browser-root dependency closure, including declared type-only dependencies; not an executed-import proof or security audit.',
  sources, dependencies }
await writeFile(path.join(root, 'docs/evidence/issue201/upstream-provenance.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ sources, dependencies: dependencies.map(({ name, version, license, path }) => ({ name, version, license, path })) }, null, 2))
