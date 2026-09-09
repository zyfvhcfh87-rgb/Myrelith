# Milestone 9 combined validation

Local accepted source: `34540a6`. The subsequent merge `c82c3c8` adds only
reviewed isolated speech research/scripts/evidence; `src`, dependencies and
build configuration are identical. The user approved publishing the completed
batch with #201 remaining open for transcription. Normal PR checks, review and
merge still govern publication. This delivery does not close the milestone.

| Check | Result |
| --- | --- |
| Canonical full test runner, two workers | 5,195 tests in 377 files; all 17 runner checks pass; 85.23 seconds for Vitest |
| Production build / TypeScript | Pass; existing large-chunk advisory remains |
| Lint | Exit 0; three no-this-alias warnings in caption test ownership observers |
| Production dependency audit | Zero vulnerabilities; reused audit because dependencies are unchanged |
| Git diff whitespace check | Pass across the complete milestone comparison |

Commands use `DEVELOPER_DIR=/Library/Developer/CommandLineTools` and tests use
`NODE_OPTIONS=--no-experimental-webstorage` on Node 26. The first combined run
had two failures: old attribute-paste fixtures omitted required portable media
descriptors. Correct fixtures exposed a lost clip-count confirmation; the
production message now again reports the number of pasted clips. All 11 focused
cases and 17 runner checks passed, followed by the complete passing suite above.
No failure was labeled an unrelated baseline failure.

Root logs are retained under `/private/tmp/milestone9-final-integration-tests-02.log`,
`milestone9-final-build.log` and `milestone9-final-lint-02.log`; original failures
remain in `milestone9-final-integration-tests.log` and `milestone9-paste-fixture-check.log`.
The lint warnings capture actual FileReader/canvas instances to assert cleanup;
they do not come from production code. No architecture or cleanup gate is waived.

Feature-browser evidence is staged and reviewed, not a rerun of the entire
browser suite on one final hash:

- [Mask lifecycle](../issue198/export-lifecycle-attempt2.md): nine export/cancel/retry
  attempts, 27 exact actual pre-encode comparisons and 24 encoded mean checks.
  The historical encoded maximum-12 rule still fails 18 targets; retain the
  explicit lossy-codec qualification.
- [Mixed animation/title/audio](../issue199/g4-completion.md): all nine checkpoints,
  real encoded WebM/decode and zero final resource owners.
- [Title keyboard/dialogs](../issue200/keyboard-results.md): final three cases plus
  the preserved wide-controls pass. Native Mac font-popup selection is unverified.
- [Captions](caption-workflows.md): two passing native flows for batch editing,
  Undo/Redo, Save/Open, reviewed ASS import, downloads and narrow dialog focus.
- [HDR](../issue202/final-decision.md): accepted research no-go; no product HDR path.

[Transcription runtime06](../issue201/WHISPER_CPP_RUNTIME_RUN_06.md) passes 18 cases
but stops at the fixed resident-memory limit before long-audio inference. Four
remaining offline/reopen/removal cases and production app wiring are incomplete.
All owned lab processes and its private profile are released. The code inspection
finds no existing active-worker cleanup acknowledgement that makes rapid restart
safe; a cancellation-protocol change needs its own measured validation. #201
must remain open unless that required work is subsequently completed.
