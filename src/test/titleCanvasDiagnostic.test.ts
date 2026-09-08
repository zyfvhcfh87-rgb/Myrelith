import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { diagnosticFixtures, DIAGNOSTIC_CASES } from '../../tests/diagnostics/issue200/fixtures'
import { projectTitleExportError } from '../domain/titleExport'

test('diagnostic fixture bytes stay pinned to all eight observed failure classes and a passing control', () => {
  const pins = JSON.parse(readFileSync('docs/evidence/issue200/canvas-diagnostic-fixture-pins.json', 'utf8'))
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const fixtures = diagnosticFixtures()
  expect(fixtures.map(({ id, legacy, expanded }) => ({ id, legacy: hash(legacy), expanded: hash(expanded) }))).toEqual(pins.fixtures)
  expect(new Set(DIAGNOSTIC_CASES.map(([, name]) => name))).toEqual(new Set(['plain', 'combining-emoji', 'crop-flip', 'background', 'outline-shadow', 'caption-canary', 'fractional', 'anchor-zero', 'anchor-one']))
  for (const fixture of fixtures) for (const project of [fixture.legacy, fixture.expanded]) {
    expect(projectTitleExportError(project, project.rootSequenceId)).toBeNull()
    expect(project.sequences[0].tracks[0].clips[0].timelineRange).toEqual({ startFrame: 0, durationFrames: 1 })
  }
})
