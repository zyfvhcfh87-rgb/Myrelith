# Keyboard executable source validation

This checkpoint is ready for source review, not native acceptance. The accepted
[proposal](keyboard-focus-proposal.md) is implemented by the separate
[executable protocol](keyboard-executable-protocol.md). No keyboard browser case,
production build, full suite, encoded export or benchmark has run in this phase.

The supervisor assigned exact integration
`580de54f85c877d1d746c9a5b201b1aa4ac3ef4d`. The independent draft was preserved at
`d7efdde`, then merged without conflicts at
`5bca9bf8041f6dd25d64de2acd87046e13000f4d`. All production source matches that
integration. The only additional file under `src` is the pure diagnostic unit test;
other additions belong to tests/diagnostics and evidence. Accepted G3 and first-paint
source, original artifacts and guards remain unchanged.

| Source check | Observed result |
| --- | --- |
| Affected title/overlay/Animation workspace and initial diagnostic after sync | 4 suites / 66 tests passed in 5.41 seconds at the merge checkpoint |
| Final diagnostic rejection predicates and architecture | 2 suites / 15 tests passed in 1.45 seconds |
| Accepted runner's inert timeout/identity/manifest suite under keyboard names | 12 tests passed in 0.006 seconds; no processes launched |
| Application and diagnostic TypeScript | Passed; diagnostic check repeated after the final Preview assertion review |
| Lint, Python/Node syntax and diff hygiene | Passed |
| Playwright discovery only | Exactly four cases in one file; no web server or Chromium launch |
| Runner/test/config equivalence | Byte-exact after the three documented name substitutions |

The seven pure diagnostic tests reject empty/nonfinite/clipped rectangles, both
traversal-budget violations, identical low-contrast paint, omitted nested opacity,
unknown color/background evidence, transient session failure or overflow, and
missing/synthetic/truncated native-key ledgers. Eight architecture checks pass.
These tests validate evidence predicates, not the unexecuted user interface flows.

[Validation manifest](keyboard-source-validation/manifest.json) records checks,
exact source hashes and all 14 retained raw logs. Its
[raw log archive](keyboard-source-validation/raw-logs.tar.gz) includes earlier
draft/sync results and final source checks, with every member independently hashed.
The source guard will separately freeze HEAD and all tracked files after commit.

The later native gate retains its reviewed bounds, exact state/history and cleanup
requirements. Computed contrast includes actual ancestor colors/opacity; UA auto
focus paint and canvas-overlay backgrounds also need the retained visual review.
Surrounding workspace clipping remains separately owned by the supervisor.
No product correction or native execution is implied by this source result.
