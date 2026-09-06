# Gate 6: final issue acceptance

Issue #197 is implemented locally on `codex/issue197`. Gates 1–5 are separately
committed; this final gate records integration follow-ups and full validation.

## Final integration follow-ups

Current-schema fixtures and the benchmark document now include explicit empty
video stacks. `addTrack` initializes the same fields as project creation, so
in-memory and portable snapshots agree. Historical migration tests continue to
start at their original schemas and assert migration to schema 21.

Compound creation keeps video buses on the enclosing parent, without copying
ids or applying them a second time inside the child. The child's master is
empty. Selecting multiple video tracks with their own bus intent cannot retain
those distinct scopes in one shared child picture; domain and visible UI reject
that operation and explain how to create separate compounds. Native Chromium
checks unchanged rendered pixels for the opaque imported-image fixture, one
history entry, and the rejection at 1280x720. Unknown/disabled bus intent follows the same ownership rule.

Program reserves bus readback/scratch before worker dispatch while retaining
its initialization blocker until normal render scheduling. A regression test
checks that reservation ordering and exact release. The existing recovery test
now targets its timeline track badge explicitly, avoiding a name collision with
the new video-track selector.

Known invalid bus parameters keep their `invalid` status and remain bypassed.
Their controls show the preserved problem rather than invalid numeric inputs;
Reset repairs registered defaults in one edit while retaining unknown keys.
A native UI fixture verifies the repair and a clean console.

## Validation

- **4,093 Vitest tests in 299 files pass**, plus all **17** repository runner checks.
- Build/typecheck and lint pass. The existing large-chunk advisory remains.
- Production `npm audit --omit=dev --audit-level=high` reports zero vulnerabilities.
- **All 13 issue-specific Chromium checks pass** in the final full run.
- Full Chromium: **32 passed, 8 failed, 3 opt-in skips**, in 5.7 minutes.
  Every failure is reproduced on the unchanged baseline below; the broad suite
  is explicitly not reported as green.
- All **36** final pixel timing/scratch rows meet the original preregistered
  ceilings. `pixel-candidate-measurements-final.json` retains every sample.
- The final nested lens/mask/caption comparison and plugin export/cancellation
  evidence are in `production-nested-buses-final.json` and
  `production-plugin-bus-export-final.json`; original Gate 5 evidence is intact.
- Native narrow-panel screenshots were reviewed; `git diff --check` passes.

The application and source-test patch was hashed before and after the final
browser run and is identical. Tests ran with Node 26.8.1 and muted headless
Chromium on darwin arm64. No source files changed during that run.

Application/source-test patch SHA-256 and result metadata are in
`final-acceptance.json`. Earlier Gate 3/4 measurements remain intact; final
pixel timings are stored separately. Unit tests are not evidence of native GPU
or codec behavior; those claims come from the Chromium cases described in
Gate 5 and the final run.

## Broader browser failures on the unchanged baseline

Reproduced using `git archive 573cb4531374e05c40cfbdf9da8b406a4bd4c238` in an
isolated directory with the same installed dependencies and muted Chromium.
No baseline source or test was edited. These are not passing acceptance checks:

| Check | Reproduced result |
| --- | --- |
| Command palette target sizing | Existing disabled multicam button is 23px tall. |
| Issue #188 ramped audio | Encoded duration 1.0453333333s versus 1.001s expected. |
| OS file drop | Fixture generation cannot launch `ffmpeg` (`ENOENT`). |
| Project setup, 1440x900 / 1050 / 1051 / 1100 / 390x720 | Immediate wheel-scroll assertion reads `scrollTop = 0`. |

The first nine-case baseline run had seven failures and two passes (recovery
and desktop setup). Three additional repetitions of desktop/mobile scroll
checks failed in all six executions on unchanged baseline, confirming that the
desktop failure also occurs there. The current recovery selector collision was
fixed and passes its native follow-up. The final full suite retains its actual
counts, including any variability in those pre-existing scroll assertions.

The suite also has three existing opt-in skips: recorded audio alignment,
recorded camera multicam, and native-window lifecycle. Their fixture/opt-in
inputs were not provided; the native-window case is intentionally not enabled
for this muted headless run.

## Delivered behavior and limits

- Attribute copy/paste/reset is atomic across selected clips, remaps effect ids
  and source-time animation intent, and rejects stale/locked/over-budget targets.
- Version-1 local presets capture static values; they contain no media, runtime,
  package or trust authority. No preset file import/export is shipped.
- Box blur, sharpen, vignette, drop shadow and outline share documented pixel
  math across preview/export; darken, lighten, difference and exclusion follow
  concrete-context blend capability and fallback.
- Track/master parameters are static. Adjustment items provide range-based
  processing. Mask/chroma, source geometry/lens and current plugins remain
  source-stage effects, while unknown descriptors remain preserved and bypassed.
- Nested composition requires the existing same-settings opaque-instance
  contract. New alpha-reducing post stages need a fresh ownership design.
- Bus readback/scratch and source-sized lens allocations must fit the existing
  render ceiling. This is not a total browser-memory cap or a 4K real-time claim.

The work is local and reviewable. Publication and merge were not requested.
