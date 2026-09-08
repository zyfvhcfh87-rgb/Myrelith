import { createConnection } from 'node:net'
/** Independent overall watchdog. The browser driver never owns this deadline. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownedProcessRows, parseProcessRows, sameProcessIdentity } from '../continuation/process-identities.mjs'
import { superviseChild } from './lifecycle.mjs'
const directory = fileURLToPath(new URL('.', import.meta.url)), root = resolve(directory, '../../..')
if (process.argv.includes('--check')) {
  const check = spawnSync(process.execPath, [join(directory, 'execute.mjs'), '--check'], { cwd: root, stdio: 'inherit', timeout: 10000 })
  process.exit(check.status ?? 1)
}
assert.equal(process.argv[2], '--expected-head'); assert.match(process.argv[3] ?? '', /^[a-f0-9]{40}$/); assert.equal(process.argv.length, 4)
const out = `/private/tmp/issue199-g4/${new Date().toISOString().replaceAll(':', '-')}`; mkdirSync(out, { recursive: true })
const child = spawn(process.execPath, [join(directory, 'execute.mjs'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, ISSUE199_G4_OUTPUT: out } })
function rows() { const p = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 }); assert.equal(p.status, 0); return parseProcessRows(p.stdout) }
const identity = rows().find((p) => p.pid === child.pid); assert.ok(identity)
const report = { at: new Date().toISOString(), parentPid: process.pid, child: identity, maximumMilliseconds: 300000, forcedSignals: [] }
writeFileSync(join(out, 'supervisor.json'), JSON.stringify(report, null, 2) + '\n')
function observedOwned() {
  let recorded = []
  try { if (existsSync(join(out, 'result.json'))) recorded = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).processes.flatMap((p) => p.rows) } catch { /* A killed driver may leave an incomplete last write; live profile/tree identity remains authoritative. */ }
  return ownedProcessRows(rows(), join(out, 'chromium-profile'), [identity, ...recorded])
}
const listening = () => new Promise((resolve) => { const socket = createConnection({ host: '127.0.0.1', port: 5199 }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)); socket.setTimeout(500, () => { socket.destroy(); resolve(false) }) })
async function terminateOwned() {
  const known = observedOwned()
  writeFileSync(join(out, 'watchdog-expired.json'), JSON.stringify({ at: new Date().toISOString(), known }, null, 2) + '\n')
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const owned of [...known.filter((p) => p.pid !== identity.pid), identity]) {
      if (rows().some((p) => sameProcessIdentity(p, owned))) {
        assert.ok(![1, process.pid, process.ppid].includes(owned.pid)); try { process.kill(owned.pid, signal); report.forcedSignals.push({ signal, identity: owned }) } catch (e) { if (e.code !== 'ESRCH') throw e }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  report.remaining = ownedProcessRows(rows(), join(out, 'chromium-profile'), known)
}
try { report.result = await superviseChild(child, 300000, terminateOwned); process.exitCode = report.result.expired ? 1 : report.result.code ?? 1 }
catch (error) { report.error = String(error); await terminateOwned(); process.exitCode = 1 }
finally {
  try {
    if (observedOwned().length) await terminateOwned()
    report.finalRemaining = observedOwned(); report.port5199 = await listening()
    if (report.finalRemaining.length || report.port5199) process.exitCode = 1
  } catch (error) { report.cleanupError = String(error); process.exitCode = 1 }
  report.finishedAt = new Date().toISOString(); writeFileSync(join(out, 'supervisor.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Supervisor evidence: ${out}`) }
