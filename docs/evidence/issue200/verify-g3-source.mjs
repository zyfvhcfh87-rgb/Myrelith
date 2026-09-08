/** Exact current G3 checkpoint guard. The historical G2/diagnostic pins remain unchanged. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [mode, output] = process.argv.slice(2)
if (!['record', 'verify'].includes(mode) || !output?.startsWith('/private/tmp/issue200-')) throw new Error('Use record|verify and an external /private/tmp/issue200-* manifest')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('G3 browser checkpoints must have a clean working tree')
const files = git('ls-files', '--', 'src', 'tests', 'package.json', 'package-lock.json', 'vite.config.ts', 'playwright.issue200.config.ts', 'docs/evidence/issue200/run-g3-browser.py', 'docs/evidence/issue200/verify-g3-source.mjs', 'docs/evidence/issue200/g3-authoring-protocol.md').split('\n').filter(Boolean)
const hashes = files.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])
const manifest = { version: 1, head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), hashes }
if (mode === 'record') writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
else if (JSON.stringify(manifest) !== JSON.stringify(JSON.parse(readFileSync(output, 'utf8')))) throw new Error('G3 source or checkpoint changed')
console.log(JSON.stringify({ verified: mode === 'verify', head: manifest.head, files: hashes.length, digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }))
