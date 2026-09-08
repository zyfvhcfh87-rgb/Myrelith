// Exact source-only successor to the frozen candidate04 preparation.
// No network, package installation, model execution or alteration of graph bytes.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compositePreparation, hash } from './composite-preflight.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const result = await compositePreparation(root)
const bytes = Buffer.from(`${JSON.stringify(result.manifest, null, 2)}\n`)
// All components, runtime, fixtures and committed/staged bounds pass before writes.
for (const entry of result.writes) await writeFile(entry.filename, entry.bytes)
await writeFile(path.join(root, '.tmp/issue201-speech-lab/manifest.json'), bytes)
await writeFile(path.join(root, 'docs/evidence/issue201/replacement-manifest.json'), bytes)
const verification = { ...result.verification, manifestSha256: hash(bytes) }
await writeFile(path.join(root, 'docs/evidence/issue201/composite-preparation.json'), `${JSON.stringify(verification, null, 2)}\n`)
console.log(JSON.stringify(verification, null, 2))
