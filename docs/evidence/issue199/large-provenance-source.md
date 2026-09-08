# Issue 199 — separate fixture generation and executing product identities

The large segment's supplemental fixture was canonically generated at
`b33b7531027979b8886f5db979d57cd96b96175d`. Its executing product is now
`75b89ef6b70460a03ea99ca44d888b5ec06373ec`. Comparing these identities for equality
would reject the preserved fixture before its first case.

The authorized correction changes only the generation guard to require the exact
historical b33 identity and adds `report.largeFixtureSources`, recording both
`generationProductSource` and `executingProductSource`. Existing independent
runtime guards still require the executing 75b product, clean source and all
frozen source/checkpoint hashes. Every other action, assertion and limit is
byte-identical to the reviewed harness.

No fixture, supplemental manifest or generator was regenerated or rewritten.
The intervening product diff contains only `AnimationWorkspace.tsx` and its test,
the accepted cancellation fix; domain and generator code did not change. The
four original portable fixtures, supplemental generation provenance and playback
fixture bytes remain intact.

`large-provenance/verification.json` records exact source-replacement verification,
all 242 product hashes, the prior 55 checkpoint files, all 13 pinned fixture and
generator files, both identities and the two intervening product paths. Only
observations and protocol differed among those prior checkpoint files. The prior
manifest is preserved in `large-provenance/previous-checkpoint-hashes.json` before
mechanical repinning. Syntax, explicit script lint and diff checks pass.

Observation SHA-256 after the reviewed correction:
`68b2bba0f06f09e8377bd8953bcd7679767209246c448f7dfa4849497297f7c6`.

This evidence establishes source/provenance preparation only. No fixture
generation, native browser run, build, full suite, export, performance run or
integration sync occurred during preparation. The parent reviewed the exact
two-line correction and protocol, then conditionally granted one large segment
after a clean commit, full hash verification and SHA recording before launch.
Any additional action/assertion/product change requires separate review.
