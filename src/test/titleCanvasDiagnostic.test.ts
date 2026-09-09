import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { diagnosticFixtures, DIAGNOSTIC_CASES } from '../../tests/diagnostics/issue200/fixtures'
import { projectTitleExportError } from '../domain/titleExport'
import { CURRENT_TIMELINE_SCHEMA_VERSION, createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from '../domain/projectFile'
import type { SequenceProject } from '../domain/projectSequences'

// These byte pins describe the original G2 observation at schema 23. Keep the
// historical evidence fixed while testing current-schema admission separately.
const HISTORICAL_DIAGNOSTIC_SCHEMA_VERSION = 23
function historicalDiagnosticProject(project: SequenceProject): SequenceProject {
  return { ...project, sequences: project.sequences.map((sequence) => ({ ...sequence, schemaVersion: HISTORICAL_DIAGNOSTIC_SCHEMA_VERSION })) }
}

test('historical diagnostic bytes stay pinned to all eight observed failure classes and a passing control', () => {
  const pins = JSON.parse(readFileSync('docs/evidence/issue200/canvas-diagnostic-fixture-pins.json', 'utf8'))
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const fixtures = diagnosticFixtures()
  expect(fixtures.map(({ id, legacy, expanded }) => ({ id,
    legacy: hash(historicalDiagnosticProject(legacy)), expanded: hash(historicalDiagnosticProject(expanded)),
  }))).toEqual(pins.fixtures)
  expect(new Set(DIAGNOSTIC_CASES.map(([, name]) => name))).toEqual(new Set(['plain', 'combining-emoji', 'crop-flip', 'background', 'outline-shadow', 'caption-canary', 'fractional', 'anchor-zero', 'anchor-one']))
})

test.each(diagnosticFixtures())('$id admits current fixtures and migrates historical files without changing title or caption intent', (fixture) => {
  for (const project of [fixture.legacy, fixture.expanded]) {
    expect(project.sequences.every((sequence) => sequence.schemaVersion === CURRENT_TIMELINE_SCHEMA_VERSION)).toBe(true)
    expect(projectTitleExportError(project, project.rootSequenceId)).toBeNull()
    expect(project.sequences[0].tracks[0].clips[0].timelineRange).toEqual({ startFrame: 0, durationFrames: 1 })
    const snapshot = createProjectFileSnapshot(project, [], [])
    expect(parseProjectFile(serializeProjectFile(snapshot)).sequences).toEqual(project.sequences)
    const historical = { ...snapshot, sequences: historicalDiagnosticProject(project).sequences }
    expect(parseProjectFile(JSON.stringify(historical)).sequences).toEqual(project.sequences)
  }
})
