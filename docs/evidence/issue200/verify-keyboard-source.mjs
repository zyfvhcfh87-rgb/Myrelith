/** Freeze the assigned integrated editor and this separate keyboard diagnostic. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [mode, output] = process.argv.slice(2)
const baseline = '47272362c6d65a1f0a75d4527642d0c8e3de6816'
const root = '/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue200'
if (!['record', 'verify'].includes(mode) || !output?.startsWith('/private/tmp/issue200-')) throw new Error('Use record|verify and a fresh external /private/tmp/issue200-* manifest')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
if (process.cwd() !== root || git('branch', '--show-current') !== 'codex/issue200') throw new Error('Wrong keyboard worktree/branch')
if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Keyboard checkpoint must be clean')
const allowed = new Set([
  'tests/diagnostics/issue200/keyboard.gate.ts',
])
const changed = git('diff', '--name-only', baseline, '--', 'src', 'tests', 'package.json', 'package-lock.json', 'vite.config.ts', 'playwright.issue200.config.ts',
  'docs/evidence/issue200/run-g3-browser.py', 'docs/evidence/issue200/verify-g3-source.mjs', 'docs/evidence/issue200/g3-authoring-protocol.md',
  'docs/evidence/issue200/run-first-paint-browser.py', 'docs/evidence/issue200/verify-first-paint-source.mjs', 'docs/evidence/issue200/first-paint-executable-protocol.md').split('\n').filter(Boolean)
for (const file of changed) if (!allowed.has(file)) throw new Error(`Assigned production/prior evidence source changed: ${file}`)
const files = git('ls-files', '-z').split('\0').filter(Boolean)
const hashes = files.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])
const manifest = { version: 1, baseline, head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), hashes }
if (mode === 'record') writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
else if (JSON.stringify(manifest) !== JSON.stringify(JSON.parse(readFileSync(output, 'utf8')))) throw new Error('Keyboard checkpoint or source changed')
console.log(JSON.stringify({ verified: mode === 'verify', head: manifest.head, files: hashes.length,
  digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }))
