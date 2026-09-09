# HDR research acceptance and combined mask regression

The orchestrator accepted issue #202 research at
`f0aeeabb5307c4650f234f59f511e6bedce09dff`. Its supported outcome is **no-go for
production managed 10-bit/HDR**. See the [six-criterion decision](../issue202/final-decision.md)
and [completed-draw measurements](../issue202/r3-completed-results.md). This merge
adds only research documentation, fixtures and laboratory code; production
imports, dependencies, schemas, UI and SDR behavior are unchanged.

The parent reviewed the final decision, correction source, manifests and
verifiers, independently hashing 109 historical entries and auditing 1,399
corrected timing samples, 80 frozen numerical comparisons and 20 terminal
resource ledgers. The original preview timings measured submission because
Chromium's `gl.finish` implementation flushed commands; those six preview
claims remain explicitly unqualified. The corrected run waits for a final
pixel readback. Its first 4K candidate repetition stopped after 79 frames at the
predeclared missed-deadline threshold. The absolute no-go result and incomplete
paired comparison are separate outcomes. No physical HDR display, native GPU
performance, codec-inclusive export or native-memory safety claim follows.

The frozen final audit passed 26 manifest entries and 23 local links using:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node docs/evidence/issue202/verify-r4.mjs
```

Run that command in the retained clean `codex/issue202` checkout at the exact
accepted SHA above. Its intentional checks require that research branch and
unchanged baseline product hashes; it is not an integration-product verifier.
Do not weaken those checks to accommodate later feature merges. No additional
native run was needed to accept this research outcome.

Separately, the combined product checkpoint
`4340f9675ad56aa320f2498cf107fd55f8819568` passed the existing five quiet Chromium
mask flows in 14.4 seconds, using one worker on port 5198. These cover rectangle
pixel preview/one edit/undo/redo/Escape, Bezier pointer/numeric/keyboard edits,
ellipse resize cancellation, temporary open-path closure and held-path keys.
All six screenshots were inspected, including the smaller monitor layout.
Console and page-error assertions passed. The test process exited successfully;
the owned server, browser processes and listener were confirmed closed.

The run log is preserved at
`/private/tmp/milestone9-schema23-animation-mask-browser.log`, with six local
screenshots under the integration worktree's
`.tmp/milestone9-4340f96-browser/`. This result follows the 187 focused tests,
17 runner checks, build/typecheck and lint recorded in
[the animation/title integration review](animation-title-integration.md).
The current merge changes no product or browser-test source relative to that
checkpoint. Final full-suite, export and cross-feature acceptance remain open
until the four feature issues are complete.
