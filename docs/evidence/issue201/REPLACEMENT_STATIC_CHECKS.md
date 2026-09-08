# Issue #201 replacement preflight: static checks

Date: 2026-09-08. This evidence does not include model execution.

- `node scripts/issue201/prepare-speech-lab.mjs`: passed exact archive-integrity,
  selected import/source inventory, public notice/advisory, pinned fixture and
  existing model digest checks. It created the final replacement manifest and
  ignored local lab assets without importing the runtime/model.
- `node --check` on all four `scripts/issue201/*.mjs` files and the adjusted
  historical measurement script: passed.
- Independent read/hash/size verification of **23** runtime, notice, model and
  fixture files against the final manifest: passed.
- Local links in the plan, model decision and replacement preflight: resolved.
- `npm run lint`: passed with no warnings after replacing null-terminated tar
  header regexes with equivalent string splits in the two measurement scripts.
- `DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run build`: typecheck and
  production build passed. Vite reported its existing large-chunk warning; the
  lab is not imported into the product and no production dependency was added.
- `git diff --check`: passed before staging; staged check is required at commit.

Final manifest SHA-256:
`ee3043df0f8d04d895fb1c2c90a32c905c733e4ae53bbfd2516798db8d6582dd`.
The runner records the committed manifest/script hashes itself before execution.

The initial unchanged-caption baseline remains 5 files/34 tests plus 17 repository
runner checks, as recorded in `caption-baseline.txt`. No full suite or model
browser/inference/memory run was used to produce this preflight. Product speech
enablement remains NO-GO pending the separate measured Gate 1 and its review.
