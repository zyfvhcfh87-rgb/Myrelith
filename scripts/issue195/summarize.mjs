#!/usr/bin/env node
/** Preserve reviewable evidence without duplicating large Program/RSS traces. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { evaluateCell, terminalIsZero } from './decision.mjs'

const paths = process.argv.slice(2)
if (!paths.length) throw new Error('Supply raw Issue 195 JSON artifact paths')
const destination = resolve('docs/evidence/issue195')
mkdirSync(destination, { recursive: true })
for (const path of paths) {
  const bytes = readFileSync(path), raw = JSON.parse(bytes.toString('utf8'))
  assert.equal(raw.source.unchangedDuringRun, true, 'Cannot publish an unstable measured tree')
  const baselines = new Map()
  const runs = raw.runs.map((cell) => {
    const key = `${cell.profile}:${cell.representation}:${cell.repeat}`
    if (!cell.count) baselines.set(key, cell)
    else assert.deepEqual(evaluateCell(cell, baselines.get(key)), cell.decision, 'Stored gate decision drifted')
    const { telemetry: _telemetry, drained: _drained, ...program } = cell.program
    const { memory, ...measurement } = cell
    const rssTotalsKiB = (memory ?? []).flatMap((sample) => {
      if (!sample.rssKiBByProcess) return []
      const sizes = sample.rssKiBByProcess.split('\n').map((line) => Number(line.trim().split(/\s+/)[1]))
      return sizes.every(Number.isFinite) ? [sizes.reduce((a, b) => a + b, 0)] : []
    })
    return { ...measurement, program, terminalZero: cell.count ? terminalIsZero(cell.cleanup) : null,
      browserRss: { samples: rssTotalsKiB.length, minKiB: rssTotalsKiB.length ? Math.min(...rssTotalsKiB) : null,
        maxKiB: rssTotalsKiB.length ? Math.max(...rssTotalsKiB) : null,
        caveat: 'Entire isolated browser; includes shared pages. Not physical RAM or wall-only native memory.' } }
  })
  const faults = raw.faults.map(({ before: _before, stats: _stats, ...fault }) => ({
    ...fault, terminalZero: terminalIsZero(fault.cleanup),
  }))
  const compact = { ...raw, runs, faults, projection: {
    rawFile: basename(path), rawSha256: createHash('sha256').update(bytes).digest('hex'),
    omitted: ['per-run detailed Program telemetry', 'per-second process list/RSS', 'fault before/stats snapshots'],
    note: 'Automatic retirement and terminal-zero are separate facts; neither alone proves every fault passed.',
  } }
  const output = resolve(destination, basename(path))
  writeFileSync(output, `${JSON.stringify(compact, null, 2)}\n`)
  process.stdout.write(`${output}: ${runs.length} measured rows, ${faults.length} fault observations\n`)
}
