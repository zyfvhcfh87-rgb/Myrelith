# Issue 199 — mechanical continuation repin after accepted mode fix

Product source is the accepted
`75b89ef6b70460a03ea99ca44d888b5ec06373ec`. Root authorized one gestures-only
run after this mechanical repin is committed, clean, and hash-verified. The
existing muted headless/private profile, scoped awake guard, first-failure stop,
trusted capture-loss assertions and owned cleanup protocol are unchanged.

The observation module changes only its product SHA and two diagnostic source
labels. Replacing those identity values with their prior values reproduces the
reviewed file byte-for-byte. The runner, actions, assertions, portable helper,
process helpers, fixture generator and all four fixture bytes remain unchanged.
No product/configuration diff exists against accepted 75b89ef.

The source manifest now carries the accepted 242-file hash snapshot. The
checkpoint manifest updates source/provenance hashes and includes this repin
evidence. Exact prior source/checkpoint manifests are preserved under
`mode-repin/`; prior committed evidence and both failed native attempts are
untouched. Fixture generation manifests retain their original provenance,
including b33b753 for the supplemental fixture. No fixture was regenerated.

`mode-repin/verification.json` records source hashes, normalized observation
equality, unchanged runner/helper/fixture hashes, syntax and diff checks. This is
metadata/source verification, not a new browser result. The new harness commit
must be recorded in the owned report before launch. Only gestures is authorized;
editing, large, export, full-suite and native follow-on remain gated.
