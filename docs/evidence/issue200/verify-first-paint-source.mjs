/** Separate immutable diagnostic checkpoint; historical guards are not changed. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [mode, output] = process.argv.slice(2)
const baseline = '3d5b39fab76354f2a30f3d834cda3e40ba5461f7'
const root = '/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue200'
if (!['record', 'verify'].includes(mode) || !output?.startsWith('/private/tmp/issue200-')) throw new Error('Use record|verify and an external /private/tmp/issue200-* manifest')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
if (process.cwd() !== root || git('branch', '--show-current') !== 'codex/issue200') throw new Error('Wrong first-paint worktree/branch')
if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('First-paint checkpoint must be clean')
const allowed = new Set([
  'src/test/titleFirstPaintDiagnostic.test.ts', 'src/test/titleFirstPaintObserver.test.ts',
  ...['model.ts', 'client.ts', 'reference.ts', 'runner_test.py'].map((name) => `tests/diagnostics/issue200/first-paint-${name}`),
  'tests/diagnostics/issue200/first-paint.gate.ts', 'tests/diagnostics/issue200/first-paint.playwright.config.ts',
])
const changed = git('diff', '--name-only', baseline, '--', 'src', 'tests', 'package.json', 'package-lock.json', 'vite.config.ts', 'playwright.issue200.config.ts',
  'docs/evidence/issue200/run-g3-browser.py', 'docs/evidence/issue200/verify-g3-source.mjs', 'docs/evidence/issue200/g3-authoring-protocol.md').split('\n').filter(Boolean)
for (const file of changed) if (!allowed.has(file)) throw new Error(`Frozen product/G3 source changed: ${file}`)
const files = git('ls-files', '-z').split('\0').filter(Boolean)
const hashes = files.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])
const manifest = { version: 1, baseline, head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), hashes }
if (mode === 'record') writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
else if (JSON.stringify(manifest) !== JSON.stringify(JSON.parse(readFileSync(output, 'utf8')))) throw new Error('First-paint checkpoint or source changed')
console.log(JSON.stringify({ verified: mode === 'verify', head: manifest.head, files: hashes.length,
  digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }))
