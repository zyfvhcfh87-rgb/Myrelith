import { TITLE_PROOF_CASES, titleProofProject, upgradeProofProject } from '../../../src/test/titleRenderProof'
import type { TextFontFamily } from '../../../src/domain/schema'

// One representative of every failing class, plus a passing control.
export const DIAGNOSTIC_CASES: readonly (readonly [TextFontFamily, string])[] = [
  ['sans-serif', 'plain'], ['sans-serif', 'combining-emoji'], ['sans-serif', 'crop-flip'],
  ['sans-serif', 'background'], ['sans-serif', 'outline-shadow'], ['monospace', 'caption-canary'],
  ['fantasy', 'fractional'], ['fantasy', 'anchor-zero'], ['fantasy', 'anchor-one'],
]
export function diagnosticFixtures() {
  return DIAGNOSTIC_CASES.map(([family, name]) => {
    const proof = TITLE_PROOF_CASES.find((entry) => entry.name === name)
    if (!proof) throw new Error(`Missing frozen fixture: ${name}`)
    const legacy = titleProofProject(family, proof)
    return { id: `${family}-${name}`, legacy, expanded: upgradeProofProject(legacy) }
  })
}
