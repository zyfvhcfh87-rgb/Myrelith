# Caption style review identity correction

On the accepted schema24 owner/session foundation, an unchanged style request
still produced a candidate and an Apply review. Empty selections also bypassed
style validation. The focused reproducer recorded five failures and three passes
before correction. This is independently authorized Caption G3 source work after
the reviewed renderer integration; no speech or browser slot is involved.

`CaptionEditSession.prepareStyle` now returns `null` for unchanged intent or an
empty valid selection, clears a previous review through the existing guarded
owner-reduction path, and preserves project/document/past/future references.
A mixed selection copies and counts only cues whose stored descriptors change.
Selection membership uses bounded sets instead of repeated full cue scans.
Styles are validated before the no-op decision, including empty selections;
rejection retains the previous review and its owners.

Equality uses the existing opaque-envelope authority: parameter ordering does
not change intent, and unknown future fields are neither interpreted nor lost.
Explicit empty overrides and inheritance remain distinct authored states.
Current rendering equivalence does not erase an explicit override. Existing
callers of the nullable result were migrated; at this checkpoint they are test
fixtures using known changed descriptors. Product style UI is still future work.

Validation: **91 tests across five focused files**, plus **8 architecture tests**,
production typecheck/build and whole-project lint pass. The existing Vite large
chunk advisory remains. Eight new regressions cover unchanged track and cue
intent, empty selection, opaque future intent, partial changes, explicit empty
versus removal, invalid selections and empty-selection validation. Four added
subscriber cases exercise no-op style owner reduction during project replacement,
disposal, a throwing subscriber and a nested review attempt.

The first production typecheck caught an incorrectly shaped new `it.each` table;
it was corrected to named object rows and the focused checks/build were rerun.
The first focused invocation named the architecture test at an incorrect path,
so architecture was then run separately at `src/test/architecture.test.ts` and
passed 8/8. Exact earlier failure and final logs are preserved in
[`caption-style-review/checkpoint.json`](caption-style-review/checkpoint.json).
No browser, painter, full-suite, speech runtime or production speech acceptance
is claimed by this controller correction.
