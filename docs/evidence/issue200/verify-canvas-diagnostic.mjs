/** Test/evidence-only checkpoint over the frozen product, plus original baseline guard. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { rolldown } from 'rolldown'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const product = '54581222b3c46208efea47f71a0d865f52778bc9'
const allowed = new Set([
  'src/test/titleRenderProof.ts', 'src/test/architecture.test.ts', 'src/test/titleCanvasDiagnostic.test.ts',
  ...['fixtures.ts', 'sample.ts', 'worker.ts', 'client.ts', 'diagnostic.spec.ts', 'playwright.config.ts', 'tsconfig.json'].map((name) => `tests/diagnostics/issue200/${name}`),
  ...['verify-canvas-diagnostic.mjs', 'run-canvas-diagnostic.py', 'canvas-diagnostic-fixture-pins.json',
    'canvas-diagnostic-protocol.md', 'canvas-diagnostic-first-run.md', 'canvas-diagnostic-source-checks.log'].map((name) => `docs/evidence/issue200/${name}`),
])
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const changed = [...new Set([...git(['diff', '--name-only', product]).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean))]
const unexpected = changed.filter((path) => !allowed.has(path))
if (unexpected.length) throw new Error(`Frozen product or unexpected path changed: ${unexpected.join(', ')}`)
const pins = JSON.parse(await readFile('docs/evidence/issue200/canvas-diagnostic-fixture-pins.json', 'utf8'))
if (pins.productCommit !== product || pins.baselineCommit !== 'ce91074c276ca6892a74addb7dd673b9a19c7eeb') throw new Error('Unexpected source pins')
// Bundle only the fixture factory for Node verification; no browser/server is launched.
const output = resolve('.tmp/issue200-diagnostic-fixtures.mjs')
const bundle = await rolldown({ input: 'tests/diagnostics/issue200/fixtures.ts', platform: 'node' })
try { await bundle.write({ file: output, format: 'esm' }) } finally { await bundle.close() }
const { diagnosticFixtures } = await import(pathToFileURL(output).href)
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fixtures = diagnosticFixtures().map(({ id, legacy, expanded }) => ({ id, legacy: sha(legacy), expanded: sha(expanded) }))
if (JSON.stringify(fixtures) !== JSON.stringify(pins.fixtures)) throw new Error('Pinned fixture data changed')
const [mode, manifest] = process.argv.slice(2)
if (!['capture', 'verify'].includes(mode) || !manifest) throw new Error('Use capture|verify followed by a manifest path')
if (mode === 'verify' && git(['status', '--porcelain'])) throw new Error('Diagnostic launch requires a clean committed source')
execFileSync(process.execPath, ['docs/evidence/issue200/verify-g2-source.mjs', mode, manifest], { stdio: 'inherit' })
console.log(JSON.stringify({ product, productUnchanged: true, changedPaths: changed, fixturePins: fixtures.length }))
