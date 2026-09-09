import { describe, expect, test } from 'vitest'
import { animatedTitleProofProject, TEXT_FONT_FAMILIES, TITLE_PROOF_CASES, titleProofProject, upgradeProofProject } from './titleRenderProof'
import { createProjectFileSnapshot, serializeProjectFile, parseProjectFile } from '../domain/projectFile'
import { projectTitleExportError } from '../domain/titleExport'

describe('G2 browser fixture admission before the exclusive browser slot', () => {
  test('all six-family legacy/upgrade cases survive actual portable validation', () => {
    for (const family of TEXT_FONT_FAMILIES) for (const proof of TITLE_PROOF_CASES) {
      const original = titleProofProject(family, proof), upgraded = upgradeProofProject(original)
      for (const project of [original, upgraded]) {
        const wire = serializeProjectFile(createProjectFileSnapshot(project, [], []))
        expect(parseProjectFile(wire).sequences).toHaveLength(1)
        expect(projectTitleExportError(project, project.rootSequenceId)).toBeNull()
      }
    }
  })
  test('every animated and nested case has valid exact source ticks, element values and effect ownership', () => {
    for (const easing of ['linear', 'hold', 'cubic-bezier'] as const) for (const nested of [false, true]) {
      const project = animatedTitleProofProject(easing, nested)
      const wire = serializeProjectFile(createProjectFileSnapshot(project, [], []))
      expect(parseProjectFile(wire).sequences).toHaveLength(nested ? 2 : 1)
      expect(projectTitleExportError(project, project.rootSequenceId)).toBeNull()
    }
  })
})
