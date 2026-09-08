/** Pin both the dirty candidate and every archived baseline source byte. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dirtyFingerprint } from '../../../scripts/performance/run-benchmark.mjs'

const baseline = 'ce91074c276ca6892a74addb7dd673b9a19c7eeb'
const root = process.cwd()
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const tree = git(['ls-tree', '-rz', baseline, '--', 'src']).split('\0').filter(Boolean)
const baselineHash = createHash('sha256')
for (const entry of tree) {
  const [metadata, path] = entry.split('\t'), [mode, kind, expected] = metadata.split(' ')
  if (kind !== 'blob' || !['100644', '100755'].includes(mode) || !path.startsWith('src/')) throw new Error(`Unexpected baseline entry: ${entry}`)
  const bytes = await readFile(resolve(root, '.tmp/issue200-baseline', path))
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`Baseline bytes differ: ${path}`)
  baselineHash.update(entry).update('\0')
}
const commit = git(['rev-parse', 'HEAD']).trim()
const current = { commit, branch: git(['branch', '--show-current']).trim(), ...await dirtyFingerprint(root, commit),
  baseline, baselineFiles: tree.length, baselineTree: `sha256:${baselineHash.digest('hex')}` }
const [mode, file] = process.argv.slice(2)
if (!file || !['capture', 'verify'].includes(mode)) throw new Error('Use capture|verify followed by a manifest file path.')
if (mode === 'capture') await writeFile(resolve(file), `${JSON.stringify(current, null, 2)}\n`)
else {
  const initial = JSON.parse(await readFile(resolve(file), 'utf8'))
  if (JSON.stringify(initial) !== JSON.stringify(current)) throw new Error('G2 source changed after the browser source capture.')
}
console.log(JSON.stringify({ mode, ...current }))
