# Caption style, rendering and review integration

Accepted caption source through `078be7be7c9e64caee554dfbc8afba15fd9badc3` merges
without conflicts into integration `580de54f85c877d1d746c9a5b201b1aa4ac3ef4d`.
All 23 changed source/test files initially matched the reviewed issue checkpoint
exactly. The only subsequent source change removes an extra final blank line in
`sequenceFrameCoverage.ts`; executable tokens are unchanged.

The integration includes supported caption style resolution and rendering,
export eligibility and ASS style mapping, reading/layout diagnostics, and the
app-owned batch/style review controller. Review shows actual before/after values
and inheritance, preserves distinct fields in mixed cue selections, and requires
acceptance before replacing unavailable intent. Fresh Apply stays one undoable
edit. Unknown bounded descriptors retain their stored intent.

The combined selection passed **467 tests in 26 suites plus 17 runner checks**
in 5.96 seconds. It covers captions, file/style/history admission, reentrancy,
review cancellation, layout, composition and export/render seams. One requested
filename, `titleExport.test.ts`, does not exist and contributed no tests; the
reported count comes from the 26 real suites. Title eligibility is covered by
caption export, composition and render tests. Production TypeScript/build and
lint passed; Vite reports its existing large-chunk advisory. No full-suite,
combined browser, caption UI or working speech inference claim is made.

Initial whitespace validation found historical log whitespace and one extra
source blank line. The [original-preserving archive and manifest](caption-evidence-hygiene/manifest.json)
retain all 15 original files and separately hash their readable copies. Original
issue checkpoint hashes refer to those frozen issue-branch bytes. Final whole-base
staged whitespace validation passes. Validation streams, including the initial
whitespace failure, are retained in the [integration evidence](caption-review-integration/manifest.json).

Caption UI wiring, browser/pixel/export acceptance, optional local transcription,
remaining feature gates and the final combined validation are still pending.
This is a local integration; nothing has been pushed or proposed for master yet.
