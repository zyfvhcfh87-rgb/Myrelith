import { describe, expect, test } from 'vitest'
import {
  LOCAL_ACCESS_EXPLANATION,
  localAccessChoiceDescription,
  localAccessChoiceLabel,
} from './localAccessCopy'

describe('local access copy', () => {
  test('uses the same remember and once nouns for every local-file action', () => {
    expect(localAccessChoiceLabel('Open', 'remember')).toBe('Open & remember')
    expect(localAccessChoiceLabel('Import', 'once')).toBe('Import once')
    expect(localAccessChoiceLabel('Relink folder', 'remember'))
      .toBe('Relink folder & remember')
    expect(localAccessChoiceDescription('once')).toContain('Do not save')
    expect(LOCAL_ACCESS_EXPLANATION).toContain('never copies or uploads')
    expect(LOCAL_ACCESS_EXPLANATION).toContain('browser-only')
  })
})
