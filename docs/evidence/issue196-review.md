# PR #225 catalog refresh review — 2026-09-08

This follow-up fixes one confirmed runtime defect and adds regression coverage
for one report that does not reproduce. It supersedes the initial acceptance
snapshot at `fa8b84e` where sources or totals differ. The [original report](issue196-acceptance.md)
and baseline/browser limitations remain available.

## Transactional runtime replacement

[Review thread](https://github.com/zyfvhcfh87-rgb/Myrelith/pull/225#discussion_r3955625370):
`setCatalog` previously published a new catalog before decoding completed, then
cleared all catalog facts when replacement failed. Cancellation or malformed
payloads could therefore remove the previous valid lookup from that owner.

The runtime now keeps its published catalog and facts until all candidate tables
and a final currentness check succeed. Only derived buffers are cleared before
materialization, so old and new decoded caches never overlap outside the existing
2 MiB allowance. On failure, candidate buffers are dropped; a later frame can
rebuild the old lookup without another catalog message. Disposal remains terminal
and never restores closed state. Serialization, color formulas, lookup limits
and the supported file subset do not change.

Three new tests fail on the original runtime: cancellation after partial decode,
malformed replacement data and cancellation at the final publication check.
The fixed tests verify the same published context, correct old pixels without
resending the old catalog, retry with a changed table, bounded ownership and
zero terminal resources. See the [original failure log](issue196-review/reproduction.txt)
and [focused result](issue196-review/focused.txt).

## Same-table application report

[Review thread](https://github.com/zyfvhcfh87-rgb/Myrelith/pull/225#discussion_r3955625383):
the suggested same-LUT budget failure is not reproducible for a valid project.
`applyColorLutToProject` creates a new sequence object before calling
`replaceProjectSequence`; that helper compares object identity, not structural
equality. The candidate therefore reaches the existing JSON-equality no-op check
and returns the original project. The earlier budget guard still rejects actual
invalid candidates.

Four new tests pass before any production change, covering clip, adjustment,
track and master targets. Reusing either the same table identity or identical
table data under a different incoming id returns the existing project, consumes
no new ids and preserves past/future history. This finding is closed with evidence;
the production domain operation is unchanged.

## Fresh verification

| Check | Result |
| --- | --- |
| Focused runtime/catalog/worker/bridge/pixel/controller suite | 204 cases in six files + 17 runner checks pass |
| Full final suite | 4,207 cases in 304 files + 17 runner checks pass |
| Production build/typecheck and lint | Pass; existing bundle-size warning retained |
| Production dependency audit | Zero vulnerabilities |
| Chromium | All nine functional grading flows and the 45-cell CPU proof pass (ten Playwright tests) |

The final full-suite run includes the strengthened assertion that old pixels
render without resending their catalog. Raw [unit](issue196-review/unit.txt),
[build](issue196-review/build.txt), [lint](issue196-review/lint.txt),
[audit](issue196-review/audit.json) and [browser](issue196-review/browser.txt)
results are retained. Source and log hashes are in
[review-verification.json](issue196-review-verification.json).

The fresh [timing samples and source hashes](issue196-review-runtime.json) retain
the original two warmups, ten measured samples and all preregistered ceilings.

| Raster | Worst single-stage p95 | Worst eight-stage p95 | Allowed single/eight |
| --- | ---: | ---: | ---: |
| 720p | 18.1 ms | 154.8 ms | 40 / 320 ms |
| 1080p | 40.4 ms | 347.1 ms | 90 / 720 ms |
| 4K | 162.2 ms | 1287.4 ms | 360 / 2,880 ms |

Cold catalog preparation is 22.0 ms. Delivered cancellation settles in 0.2 ms.
Peak lookup storage is 1,080,480 bytes; final bytes, entries, ports and pending
requests are zero. Production runtime source remained fixed throughout the
browser run, with no concurrent unit/build timing load. Headless Chromium,
single-host CPU and native-memory limitations remain the same as initial acceptance.
RGB parade is still deferred. The broader eight baseline-reproduced failures
are not reclassified or included among these passing issue cases.

Reproduce the focused suite with:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
NODE_OPTIONS=--no-experimental-webstorage npm test -- \
  src/pipeline/colorGradingRuntime.test.ts src/domain/colorLutCatalog.test.ts \
  src/workers/render.worker.test.ts src/engine/render-bridge.test.ts \
  src/pipeline/render.pixels.test.ts src/app/colorLutController.test.ts
```

Full checks use the commands in the initial report. The browser rerun explicitly
selects all `issue-196-*.spec.ts` files, including the timing proof. Terminal color
escapes and trailing whitespace are removed from retained logs; results are
otherwise unchanged. GitHub PR state and CI on the pushed revision remain the
authority for final merge readiness.
